import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import {
	assertModalShown,
	assertNoModal,
	Harness,
	Keys,
	minutesAfterT0,
	needsPosixPermissions,
	useHarness,
} from "./harness.ts";

/** Open the modal and clear the query the draft started it with, to browse every record newest first. */
function openToBrowse(h: Harness): void {
	h.press(Keys.ctrlR, Keys.clearLine);
}

/** One session in the current directory with prompts "one", "two", "three", oldest first. */
function writeThreePrompts(h: Harness): void {
	h.writeSession({
		cwd: h.cwd,
		prompts: ["one", "two", "three"].map((text, i) => ({ text, timestamp: minutesAfterT0(i + 1) })),
	});
}

describe("Ctrl+R opens the history modal", () => {
	test("opens on an empty input bar", async (t) => {
		const h = useHarness(t);
		await h.start();
		h.press(Keys.ctrlR);
		await h.flush();
		assertModalShown(h);
	});

	test("opens with the cursor in the middle of a multi-line draft", async (t) => {
		const h = useHarness(t);
		await h.start();
		h.type("first line");
		h.press("\n");
		h.type("second line");
		h.press(Keys.up, Keys.left, Keys.left);
		h.press(Keys.ctrlR);
		await h.flush();
		assertModalShown(h);
	});

	test("takes precedence over an editor binding on the same key", async (t) => {
		const h = useHarness(t, { keybindings: { "tui.editor.cursorLineStart": "ctrl+r" } });
		await h.start();
		h.type("draft");

		h.press(Keys.ctrlR);
		await h.flush();
		assertModalShown(h);
		h.press(Keys.escape);
		await h.flush();

		assert.deepEqual(h.editorCursor(), { line: 0, col: "draft".length });
	});

	test("shows a loading state before records arrive, then the records", async (t) => {
		const h = useHarness(t);
		h.writeSession({ cwd: h.cwd, prompts: [{ text: "hello", timestamp: minutesAfterT0(1) }] });
		await h.start();
		h.press(Keys.ctrlR);
		await h.flush();
		assert.deepEqual(h.modalList(), ["Loading history…"]);
		await h.loaded();
		assert.deepEqual(h.modalList(), ["› hello"]);
	});

	test("an empty history says so", async (t) => {
		const h = useHarness(t);
		await h.start();
		h.press(Keys.ctrlR);
		await h.loaded();
		assert.deepEqual(h.modalList(), ["No history yet"]);
	});
});

describe("history records", () => {
	test("are the user prompts of sessions recorded in exactly the current directory, newest at the bottom", async (t) => {
		const h = useHarness(t);
		h.writeSession({
			cwd: h.cwd,
			prompts: [
				{ text: "oldest", timestamp: minutesAfterT0(1) },
				{ text: "middle", timestamp: minutesAfterT0(2) },
			],
		});
		h.writeSession({ cwd: h.cwd, prompts: [{ text: "newest", timestamp: minutesAfterT0(3) }] });
		h.writeSession({ cwd: h.path("work/other"), prompts: [{ text: "other project", timestamp: minutesAfterT0(4) }] });
		h.writeSession({ cwd: join(h.cwd, "sub"), prompts: [{ text: "subdirectory", timestamp: minutesAfterT0(5) }] });
		await h.start();

		h.press(Keys.ctrlR);
		await h.loaded();

		assert.deepEqual(h.modalList(), ["  oldest", "  middle", "› newest"]);
	});

	test("follow the working directory recorded in the session, not the storage directory name", async (t) => {
		const h = useHarness(t, { cwd: "work/project" });
		// "/…/work-project" encodes to the same storage directory name as "/…/work/project".
		h.writeSession({
			cwd: h.path("work-project"),
			dir: h.sessionDir,
			prompts: [{ text: "colliding directory", timestamp: minutesAfterT0(2) }],
		});
		h.writeSession({ cwd: h.cwd, prompts: [{ text: "this project", timestamp: minutesAfterT0(1) }] });
		await h.start();

		h.press(Keys.ctrlR);
		await h.loaded();

		assert.deepEqual(h.modalList(), ["› this project"]);
	});

	test("skip empty and whitespace-only prompts", async (t) => {
		const h = useHarness(t);
		h.writeSession({
			cwd: h.cwd,
			prompts: [
				{ text: "kept", timestamp: minutesAfterT0(1) },
				{ text: "", timestamp: minutesAfterT0(2) },
				{ text: "  \n\t ", timestamp: minutesAfterT0(3) },
			],
		});
		await h.start();

		h.press(Keys.ctrlR);
		await h.loaded();

		assert.deepEqual(h.modalList(), ["› kept"]);
	});

	test("keep their text untrimmed", async (t) => {
		const h = useHarness(t);
		h.writeSession({ cwd: h.cwd, prompts: [{ text: "   indented prompt", timestamp: minutesAfterT0(1) }] });
		await h.start();

		h.press(Keys.ctrlR);
		await h.loaded();
		h.press(Keys.enter);
		await h.flush();

		assert.equal(h.editorText(), "   indented prompt");
	});

	test("appear once, at their most recent use", async (t) => {
		const h = useHarness(t);
		h.writeSession({
			cwd: h.cwd,
			prompts: [
				{ text: "repeated", timestamp: minutesAfterT0(1) },
				{ text: "between", timestamp: minutesAfterT0(2) },
			],
		});
		h.writeSession({ cwd: h.cwd, prompts: [{ text: "repeated", timestamp: minutesAfterT0(3) }] });
		await h.start();

		h.press(Keys.ctrlR);
		await h.loaded();

		assert.deepEqual(h.modalList(), ["  between", "› repeated"]);
	});

	test("come from a custom session directory when Pi uses one", async (t) => {
		const h = useHarness(t, { customSessionDir: "custom-sessions" });
		h.writeSession({ cwd: h.cwd, prompts: [{ text: "from custom dir", timestamp: minutesAfterT0(1) }] });
		h.writeSession({ cwd: h.path("work/other"), prompts: [{ text: "other project", timestamp: minutesAfterT0(2) }] });
		await h.start();

		h.press(Keys.ctrlR);
		await h.loaded();

		assert.deepEqual(h.modalList(), ["› from custom dir"]);
	});

	test("come from the sessionDir setting in an ephemeral (--no-session) session", async (t) => {
		// The cwd is <root>/work/project, so this relative setting names <root>/custom-sessions.
		const h = useHarness(t, {
			customSessionDir: "custom-sessions",
			noSession: true,
			settings: { sessionDir: "../../custom-sessions" },
		});
		h.writeSession({ cwd: h.cwd, prompts: [{ text: "from custom dir", timestamp: minutesAfterT0(1) }] });
		await h.start();

		h.press(Keys.ctrlR);
		await h.loaded();

		assert.deepEqual(h.modalList(), ["› from custom dir"]);
	});

	test("come from PI_CODING_AGENT_SESSION_DIR, ahead of the setting, in an ephemeral session", async (t) => {
		const h = useHarness(t, {
			customSessionDir: "env-sessions",
			noSession: true,
			settings: { sessionDir: "../../settings-sessions" },
		});
		h.setEnv("PI_CODING_AGENT_SESSION_DIR", h.sessionDir);
		h.writeSession({ cwd: h.cwd, prompts: [{ text: "from env dir", timestamp: minutesAfterT0(1) }] });
		h.writeSession({
			cwd: h.cwd,
			dir: h.path("settings-sessions"),
			prompts: [{ text: "from settings dir", timestamp: minutesAfterT0(2) }],
		});
		await h.start();

		h.press(Keys.ctrlR);
		await h.loaded();

		assert.deepEqual(h.modalList(), ["› from env dir"]);
	});

	test("still load when neighbouring session files are malformed", async (t) => {
		const h = useHarness(t);
		h.writeSession({ cwd: h.cwd, prompts: [{ text: "valid prompt", timestamp: minutesAfterT0(1) }] });
		writeFileSync(join(h.sessionDir, "2026-11-01T09-02-00-000Z_garbage.jsonl"), "not json at all\n{{{\n");
		writeFileSync(
			join(h.sessionDir, "2026-11-01T09-03-00-000Z_headerless.jsonl"),
			`${JSON.stringify({ type: "message", id: "m1", parentId: null, timestamp: new Date(minutesAfterT0(3)).toISOString(), message: { role: "user", content: "no header", timestamp: minutesAfterT0(3) } })}\n`,
		);
		await h.start();

		h.press(Keys.ctrlR);
		await h.loaded();

		assert.deepEqual(h.modalList(), ["› valid prompt"]);
	});

	test("still load when a neighbouring session file is unreadable", needsPosixPermissions, async (t) => {
		const h = useHarness(t);
		h.writeSession({ cwd: h.cwd, prompts: [{ text: "valid prompt", timestamp: minutesAfterT0(1) }] });
		const unreadable = h.writeSession({ cwd: h.cwd, prompts: [{ text: "unreadable", timestamp: minutesAfterT0(4) }] });
		chmodSync(unreadable, 0);
		try {
			await h.start();
			h.press(Keys.ctrlR);
			await h.loaded();
			assert.deepEqual(h.modalList(), ["› valid prompt"]);
		} finally {
			chmodSync(unreadable, 0o600);
		}
	});

	test("show a multi-line prompt as one row", async (t) => {
		const h = useHarness(t);
		h.writeSession({ cwd: h.cwd, prompts: [{ text: "line one\nline two", timestamp: minutesAfterT0(1) }] });
		await h.start();

		h.press(Keys.ctrlR);
		await h.loaded();

		assert.deepEqual(h.modalList(), ["› line one ↵ line two"]);
	});
});

describe("selection", () => {
	async function openWithThree(t: Parameters<typeof useHarness>[0]) {
		const h = useHarness(t);
		writeThreePrompts(h);
		await h.start();
		h.press(Keys.ctrlR);
		await h.loaded();
		return h;
	}

	test("starts on the newest record", async (t) => {
		const h = await openWithThree(t);
		assert.deepEqual(h.modalList(), ["  one", "  two", "› three"]);
	});

	test("Up moves to older records and stops at the oldest", async (t) => {
		const h = await openWithThree(t);
		h.press(Keys.up);
		assert.deepEqual(h.modalList(), ["  one", "› two", "  three"]);
		h.press(Keys.up, Keys.up, Keys.up);
		assert.deepEqual(h.modalList(), ["› one", "  two", "  three"]);
	});

	test("Down moves back toward newer records and stops at the newest", async (t) => {
		const h = await openWithThree(t);
		h.press(Keys.up, Keys.up, Keys.down);
		assert.deepEqual(h.modalList(), ["  one", "› two", "  three"]);
		h.press(Keys.down, Keys.down);
		assert.deepEqual(h.modalList(), ["  one", "  two", "› three"]);
	});

	test("scrolls when the selection moves past the visible rows", async (t) => {
		const h = useHarness(t, { terminalRows: 15 }); // leaves room for 3 list rows
		h.writeSession({
			cwd: h.cwd,
			prompts: ["p1", "p2", "p3", "p4", "p5"].map((text, i) => ({ text, timestamp: minutesAfterT0(i) })),
		});
		await h.start();
		h.press(Keys.ctrlR);
		await h.loaded();
		assert.deepEqual(h.modalList(), ["  p3", "  p4", "› p5"]);

		h.press(Keys.up, Keys.up, Keys.up);
		assert.deepEqual(h.modalList(), ["› p2", "  p3", "  p4"]);

		h.press(Keys.up, Keys.down, Keys.down, Keys.down);
		assert.deepEqual(h.modalList(), ["  p2", "  p3", "› p4"]);
	});
});

describe("confirming", () => {
	test("Enter replaces the whole draft with the selected record and puts the cursor at the end", async (t) => {
		const h = useHarness(t);
		h.writeSession({
			cwd: h.cwd,
			prompts: [
				{ text: "older prompt\nwith two lines", timestamp: minutesAfterT0(1) },
				{ text: "newer prompt", timestamp: minutesAfterT0(2) },
			],
		});
		await h.start();
		h.type("draft to be replaced");
		h.press(Keys.left, Keys.left);

		openToBrowse(h);
		await h.loaded();
		h.press(Keys.up, Keys.enter);
		await h.flush();

		assertNoModal(h);
		assert.equal(h.editorText(), "older prompt\nwith two lines");
		assert.deepEqual(h.editorCursor(), { line: 1, col: "with two lines".length });
	});

	test("a stored record with tabs and CR/CRLF line endings is recalled the way Pi's editor stores text", async (t) => {
		// Approved contract: Pi's editor turns CRLF and CR into LF and a tab into four spaces.
		const h = useHarness(t);
		const file = h.writeSession({
			cwd: h.cwd,
			prompts: [{ text: "first\tcolumn\r\nsecond\tcolumn\rthird", timestamp: minutesAfterT0(1) }],
		});
		const stored = readFileSync(file, "utf8");
		await h.start();
		h.type("draft");

		openToBrowse(h);
		await h.loaded();
		h.press(Keys.enter);
		await h.flush();

		assert.equal(h.editorText(), "first    column\nsecond    column\nthird");
		assert.deepEqual(h.editorCursor(), { line: 2, col: "third".length });
		assert.deepEqual(h.submissions, []);
		assert.equal(readFileSync(file, "utf8"), stored);
	});

	test("nothing is submitted", async (t) => {
		const h = useHarness(t);
		h.writeSession({ cwd: h.cwd, prompts: [{ text: "recalled", timestamp: minutesAfterT0(1) }] });
		await h.start();

		h.press(Keys.ctrlR);
		await h.loaded();
		h.press(Keys.enter);
		await h.flush();

		assert.equal(h.editorText(), "recalled");
		assert.deepEqual(h.submissions, []);
	});

	test("Enter with an empty list does nothing and keeps the modal open", async (t) => {
		const h = useHarness(t);
		await h.start();
		h.type("my draft");

		h.press(Keys.ctrlR);
		await h.loaded();
		h.press(Keys.enter);
		await h.flush();

		assertModalShown(h);
		h.press(Keys.escape);
		await h.flush();
		assert.equal(h.editorText(), "my draft");
	});

	test("Enter while still loading does nothing", async (t) => {
		const h = useHarness(t);
		h.writeSession({ cwd: h.cwd, prompts: [{ text: "recalled", timestamp: minutesAfterT0(1) }] });
		await h.start();
		h.type("my draft");

		h.press(Keys.ctrlR, Keys.enter);
		await h.flush();

		assertModalShown(h);
		await h.loaded();
		assert.equal(h.editorText(), "my draft");
		assert.deepEqual(h.submissions, []);
	});

	test("Enter arriving in the same input batch as Ctrl+R does not submit the draft", async (t) => {
		const h = useHarness(t);
		h.writeSession({ cwd: h.cwd, prompts: [{ text: "recalled", timestamp: minutesAfterT0(1) }] });
		await h.start();
		h.type("draft that must not be submitted");

		h.press(Keys.ctrlR, Keys.enter); // one batch, before the overlay is mounted
		await h.flush();

		assert.deepEqual(h.submissions, []);
		assert.equal(h.editorText(), "draft that must not be submitted");
		assertModalShown(h);
	});

	test("a second Enter in the same input batch as the confirming Enter submits nothing", async (t) => {
		const h = useHarness(t);
		h.writeSession({ cwd: h.cwd, prompts: [{ text: "recalled", timestamp: minutesAfterT0(1) }] });
		await h.start();
		h.type("draft that must not be submitted");
		openToBrowse(h);
		await h.loaded();

		h.press(Keys.enter, Keys.enter); // one batch: the second Enter reaches the editor before the result is applied
		await h.flush();

		assert.deepEqual(h.submissions, []);
		assert.equal(h.editorText(), "recalled");
		assertNoModal(h);
	});
});

describe("dismissing", () => {
	test("Escape leaves a multi-line draft and a mid-text cursor exactly as they were", async (t) => {
		const h = useHarness(t);
		h.writeSession({ cwd: h.cwd, prompts: [{ text: "recalled", timestamp: minutesAfterT0(1) }] });
		await h.start();
		h.type("first line");
		h.press("\n");
		h.type("second line");
		h.press(Keys.up, "\x01", Keys.right, Keys.right, Keys.right); // up, ctrl+a, 3x right
		const before = { text: h.editorText(), cursor: h.editorCursor() };
		assert.deepEqual(before, { text: "first line\nsecond line", cursor: { line: 0, col: 3 } });

		h.press(Keys.ctrlR);
		await h.loaded();
		h.press(Keys.up, Keys.down, Keys.escape);
		await h.flush();

		assertNoModal(h);
		assert.deepEqual({ text: h.editorText(), cursor: h.editorCursor() }, before);
	});

	test("Escape leaves a collapsed paste collapsed and its content intact", async (t) => {
		const h = useHarness(t);
		h.writeSession({ cwd: h.cwd, prompts: [{ text: "recalled", timestamp: minutesAfterT0(1) }] });
		await h.start();
		const pasted = Array.from({ length: 15 }, (_, i) => `pasted line ${i + 1}`).join("\n");
		h.type("before ");
		h.press(`\x1b[200~${pasted}\x1b[201~`);
		const before = { text: h.editorText(), cursor: h.editorCursor() };
		assert.equal(before.text, "before [paste #1 +15 lines]");

		h.press(Keys.ctrlR);
		await h.loaded();
		h.press(Keys.escape);
		await h.flush();

		assert.deepEqual({ text: h.editorText(), cursor: h.editorCursor() }, before);
		assert.equal(h.editor.getExpandedText?.(), `before ${pasted}`);
	});

	test("Escape while still loading closes the modal", async (t) => {
		const h = useHarness(t);
		h.writeSession({ cwd: h.cwd, prompts: [{ text: "recalled", timestamp: minutesAfterT0(1) }] });
		await h.start();
		h.type("my draft");

		h.press(Keys.ctrlR, Keys.escape);
		await h.flush();
		assertNoModal(h);

		// Loading was cancelled: nothing shows up or changes once it would have finished.
		await new Promise((resolve) => setTimeout(resolve, 50));
		assertNoModal(h);
		assert.equal(h.editorText(), "my draft");
		assert.deepEqual(h.submissions, []);
	});

	test("keys after Escape in the same input batch do not reach the draft", async (t) => {
		const h = useHarness(t);
		h.writeSession({ cwd: h.cwd, prompts: [{ text: "recalled", timestamp: minutesAfterT0(1) }] });
		await h.start();
		h.type("my draft");
		h.press(Keys.ctrlR);
		await h.loaded();

		h.press(Keys.escape, Keys.enter, Keys.escape); // one batch
		await h.flush();

		assertNoModal(h);
		assert.equal(h.editorText(), "my draft");
		assert.deepEqual(h.submissions, []);
	});

	test("the input bar works normally again after the modal closes", async (t) => {
		const h = useHarness(t);
		await h.start();
		h.press(Keys.ctrlR, Keys.escape);
		await h.flush();

		h.type("typed after");

		assert.equal(h.editorText(), "typed after");
	});
});

describe("keybindings", () => {
	test("rebound confirm, cancel and list-navigation keys are honoured", async (t) => {
		const h = useHarness(t, {
			keybindings: {
				"tui.select.confirm": "ctrl+o",
				"tui.select.cancel": "ctrl+g",
				"tui.select.up": "ctrl+k",
				"tui.select.down": "ctrl+j",
			},
		});
		writeThreePrompts(h);
		await h.start();
		h.type("draft");

		openToBrowse(h);
		await h.loaded();
		h.press("\x0b", "\x0b", "\x0a"); // ctrl+k, ctrl+k, ctrl+j
		assert.deepEqual(h.modalList(), ["  one", "› two", "  three"]);
		h.press(Keys.enter, Keys.escape); // default keys no longer confirm or cancel
		await h.flush();
		assertModalShown(h);
		h.press("\x0f"); // ctrl+o
		await h.flush();
		assert.equal(h.editorText(), "two");

		h.press(Keys.ctrlR);
		await h.loaded();
		h.press("\x07"); // ctrl+g
		await h.flush();
		assertNoModal(h);
		assert.equal(h.editorText(), "two");
	});
});

describe("session files", () => {
	test("are never written", async (t) => {
		const h = useHarness(t);
		const file = h.writeSession({
			cwd: h.cwd,
			prompts: [
				{ text: "one", timestamp: minutesAfterT0(1) },
				{ text: "two", timestamp: minutesAfterT0(2) },
			],
		});
		const before = { content: readFileSync(file, "utf8"), mtimeMs: statSync(file).mtimeMs };
		const filesBefore = readdirSync(h.sessionDir);
		await h.start();

		h.press(Keys.ctrlR);
		await h.loaded();
		h.press(Keys.up, Keys.enter);
		await h.flush();
		h.press(Keys.ctrlR);
		await h.loaded();
		h.press(Keys.escape);
		await h.flush();

		assert.deepEqual({ content: readFileSync(file, "utf8"), mtimeMs: statSync(file).mtimeMs }, before);
		assert.deepEqual(readdirSync(h.sessionDir), filesBefore);
	});
});

describe("outside TUI mode", () => {
	for (const mode of ["print", "json", "rpc"] as const) {
		test(`registers nothing and installs no editor in ${mode} mode`, async (t) => {
			const h = useHarness(t, { mode });
			h.writeSession({ cwd: h.cwd, prompts: [{ text: "hello", timestamp: minutesAfterT0(1) }] });

			await h.start();

			assert.equal(h.editorFactoryInstalls, 0);
			assert.deepEqual(h.registrations, []);
			assert.deepEqual(h.overlayRequests, []);
			assert.deepEqual(h.notifications, []);
		});
	}
});

describe("test harness", () => {
	test("ignores a PI_CODING_AGENT_SESSION_DIR inherited from the host and restores it afterwards", async () => {
		const sentinel = mkdtempSync(join(tmpdir(), "pi-history-sentinel-"));
		const previous = process.env.PI_CODING_AGENT_SESSION_DIR;
		process.env.PI_CODING_AGENT_SESSION_DIR = sentinel;
		const h = new Harness({
			customSessionDir: "custom-sessions",
			noSession: true,
			settings: { sessionDir: "../../custom-sessions" },
		});
		try {
			h.writeSession({ cwd: h.cwd, prompts: [{ text: "from custom dir", timestamp: minutesAfterT0(1) }] });
			h.writeSession({ cwd: h.cwd, dir: sentinel, prompts: [{ text: "from the host", timestamp: minutesAfterT0(2) }] });
			await h.start();

			h.press(Keys.ctrlR);
			await h.loaded();

			assert.deepEqual(h.modalList(), ["› from custom dir"]);
		} finally {
			h.dispose();
			assert.equal(process.env.PI_CODING_AGENT_SESSION_DIR, sentinel);
			if (previous === undefined) delete process.env.PI_CODING_AGENT_SESSION_DIR;
			else process.env.PI_CODING_AGENT_SESSION_DIR = previous;
			rmSync(sentinel, { recursive: true, force: true });
		}
	});

	for (const name of ["fzf", "sk"]) {
		test(`can put a scripted ${name} on PATH that records its invocations`, async (t) => {
			const h = useHarness(t, { stubMatcher: { responses: [{ query: "q", output: ["b"], exitCode: 0 }] } });

			// Only fixed test arguments go through cmd.exe; Windows cannot exec a .cmd directly.
			const output = process.platform === "win32"
				? execFileSync(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", `${name} --filter q --read0 --print0`], { input: "a\0b\0" })
				: execFileSync(name, ["--filter", "q", "--read0", "--print0"], { input: "a\0b\0" });

			assert.equal(output.toString(), "b\0");
			const calls = h.matcherCalls().map(({ argv, input }) => ({ argv, input }));
			assert.deepEqual(calls, [{ argv: ["--filter", "q", "--read0", "--print0"], input: ["a", "b"] }]);
		});
	}
});
