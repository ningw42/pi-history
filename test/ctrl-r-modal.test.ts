import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { Keys, useHarness } from "./harness.ts";

const T0 = Date.UTC(2026, 10, 1, 9, 0, 0);
const minutes = (n: number) => T0 + n * 60_000;

describe("Ctrl+R opens the history modal", () => {
	test("opens on an empty input bar", async (t) => {
		const h = useHarness(t);
		await h.start();
		h.press(Keys.ctrlR);
		assert.equal(h.modalOpen, true);
	});

	test("opens with the cursor in the middle of a multi-line draft", async (t) => {
		const h = useHarness(t);
		await h.start();
		h.type("first line");
		h.press("\n");
		h.type("second line");
		h.press(Keys.up, Keys.left, Keys.left);
		h.press(Keys.ctrlR);
		assert.equal(h.modalOpen, true);
	});

	test("takes precedence over an editor binding on the same key", async (t) => {
		const h = useHarness(t, { keybindings: { "tui.editor.cursorLineStart": "ctrl+r" } });
		await h.start();
		h.type("draft");

		h.press(Keys.ctrlR);
		assert.equal(h.modalOpen, true);
		h.press(Keys.escape);
		await h.flush();

		assert.deepEqual(h.editorCursor(), { line: 0, col: "draft".length });
	});

	test("shows a loading state before records arrive, then the records", async (t) => {
		const h = useHarness(t);
		h.writeSession({ cwd: h.cwd, prompts: [{ text: "hello", timestamp: minutes(1) }] });
		await h.start();
		h.press(Keys.ctrlR);
		assert.deepEqual(h.modalBody(), ["Loading history…"]);
		await h.loaded();
		assert.deepEqual(h.modalBody(), ["› hello"]);
	});

	test("an empty history says so", async (t) => {
		const h = useHarness(t);
		await h.start();
		h.press(Keys.ctrlR);
		await h.loaded();
		assert.deepEqual(h.modalBody(), ["No history yet"]);
	});
});

describe("history records", () => {
	test("are the user prompts of sessions recorded in exactly the current directory, newest at the bottom", async (t) => {
		const h = useHarness(t);
		h.writeSession({
			cwd: h.cwd,
			prompts: [
				{ text: "oldest", timestamp: minutes(1) },
				{ text: "middle", timestamp: minutes(2) },
			],
		});
		h.writeSession({ cwd: h.cwd, prompts: [{ text: "newest", timestamp: minutes(3) }] });
		h.writeSession({ cwd: h.path("work/other"), prompts: [{ text: "other project", timestamp: minutes(4) }] });
		h.writeSession({ cwd: join(h.cwd, "sub"), prompts: [{ text: "subdirectory", timestamp: minutes(5) }] });
		await h.start();

		h.press(Keys.ctrlR);
		await h.loaded();

		assert.deepEqual(h.modalBody(), ["  oldest", "  middle", "› newest"]);
	});

	test("follow the working directory recorded in the session, not the storage directory name", async (t) => {
		const h = useHarness(t, { cwd: "work/project" });
		// "/…/work-project" encodes to the same storage directory name as "/…/work/project".
		h.writeSession({
			cwd: h.path("work-project"),
			dir: h.sessionDir,
			prompts: [{ text: "colliding directory", timestamp: minutes(2) }],
		});
		h.writeSession({ cwd: h.cwd, prompts: [{ text: "this project", timestamp: minutes(1) }] });
		await h.start();

		h.press(Keys.ctrlR);
		await h.loaded();

		assert.deepEqual(h.modalBody(), ["› this project"]);
	});

	test("skip empty and whitespace-only prompts", async (t) => {
		const h = useHarness(t);
		h.writeSession({
			cwd: h.cwd,
			prompts: [
				{ text: "kept", timestamp: minutes(1) },
				{ text: "", timestamp: minutes(2) },
				{ text: "  \n\t ", timestamp: minutes(3) },
			],
		});
		await h.start();

		h.press(Keys.ctrlR);
		await h.loaded();

		assert.deepEqual(h.modalBody(), ["› kept"]);
	});

	test("keep their text untrimmed", async (t) => {
		const h = useHarness(t);
		h.writeSession({ cwd: h.cwd, prompts: [{ text: "   indented prompt", timestamp: minutes(1) }] });
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
				{ text: "repeated", timestamp: minutes(1) },
				{ text: "between", timestamp: minutes(2) },
			],
		});
		h.writeSession({ cwd: h.cwd, prompts: [{ text: "repeated", timestamp: minutes(3) }] });
		await h.start();

		h.press(Keys.ctrlR);
		await h.loaded();

		assert.deepEqual(h.modalBody(), ["  between", "› repeated"]);
	});

	test("come from a custom session directory when Pi uses one", async (t) => {
		const h = useHarness(t, { customSessionDir: "custom-sessions" });
		h.writeSession({ cwd: h.cwd, prompts: [{ text: "from custom dir", timestamp: minutes(1) }] });
		h.writeSession({ cwd: h.path("work/other"), prompts: [{ text: "other project", timestamp: minutes(2) }] });
		await h.start();

		h.press(Keys.ctrlR);
		await h.loaded();

		assert.deepEqual(h.modalBody(), ["› from custom dir"]);
	});

	test("show a multi-line prompt as one row", async (t) => {
		const h = useHarness(t);
		h.writeSession({ cwd: h.cwd, prompts: [{ text: "line one\nline two", timestamp: minutes(1) }] });
		await h.start();

		h.press(Keys.ctrlR);
		await h.loaded();

		assert.deepEqual(h.modalBody(), ["› line one ↵ line two"]);
	});
});

describe("selection", () => {
	async function openWithThree(t: Parameters<typeof useHarness>[0]) {
		const h = useHarness(t);
		h.writeSession({
			cwd: h.cwd,
			prompts: [
				{ text: "one", timestamp: minutes(1) },
				{ text: "two", timestamp: minutes(2) },
				{ text: "three", timestamp: minutes(3) },
			],
		});
		await h.start();
		h.press(Keys.ctrlR);
		await h.loaded();
		return h;
	}

	test("starts on the newest record", async (t) => {
		const h = await openWithThree(t);
		assert.deepEqual(h.modalBody(), ["  one", "  two", "› three"]);
	});

	test("Up moves to older records and stops at the oldest", async (t) => {
		const h = await openWithThree(t);
		h.press(Keys.up);
		assert.deepEqual(h.modalBody(), ["  one", "› two", "  three"]);
		h.press(Keys.up, Keys.up, Keys.up);
		assert.deepEqual(h.modalBody(), ["› one", "  two", "  three"]);
	});

	test("Down moves back toward newer records and stops at the newest", async (t) => {
		const h = await openWithThree(t);
		h.press(Keys.up, Keys.up, Keys.down);
		assert.deepEqual(h.modalBody(), ["  one", "› two", "  three"]);
		h.press(Keys.down, Keys.down);
		assert.deepEqual(h.modalBody(), ["  one", "  two", "› three"]);
	});

	test("scrolls when the selection moves past the visible rows", async (t) => {
		const h = useHarness(t, { terminalRows: 13 }); // leaves room for 3 list rows
		h.writeSession({
			cwd: h.cwd,
			prompts: ["p1", "p2", "p3", "p4", "p5"].map((text, i) => ({ text, timestamp: minutes(i) })),
		});
		await h.start();
		h.press(Keys.ctrlR);
		await h.loaded();
		assert.deepEqual(h.modalBody(), ["  p3", "  p4", "› p5"]);

		h.press(Keys.up, Keys.up, Keys.up);
		assert.deepEqual(h.modalBody(), ["› p2", "  p3", "  p4"]);

		h.press(Keys.up, Keys.down, Keys.down, Keys.down);
		assert.deepEqual(h.modalBody(), ["  p2", "  p3", "› p4"]);
	});
});

describe("confirming", () => {
	test("Enter replaces the whole draft with the selected record and puts the cursor at the end", async (t) => {
		const h = useHarness(t);
		h.writeSession({
			cwd: h.cwd,
			prompts: [
				{ text: "older prompt\nwith two lines", timestamp: minutes(1) },
				{ text: "newer prompt", timestamp: minutes(2) },
			],
		});
		await h.start();
		h.type("draft to be replaced");
		h.press(Keys.left, Keys.left);

		h.press(Keys.ctrlR);
		await h.loaded();
		h.press(Keys.up, Keys.enter);
		await h.flush();

		assert.equal(h.modalOpen, false);
		assert.equal(h.editorText(), "older prompt\nwith two lines");
		assert.deepEqual(h.editorCursor(), { line: 1, col: "with two lines".length });
	});

	test("nothing is submitted", async (t) => {
		const h = useHarness(t);
		h.writeSession({ cwd: h.cwd, prompts: [{ text: "recalled", timestamp: minutes(1) }] });
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

		assert.equal(h.modalOpen, true);
		h.press(Keys.escape);
		assert.equal(h.editorText(), "my draft");
	});

	test("Enter while still loading does nothing", async (t) => {
		const h = useHarness(t);
		h.writeSession({ cwd: h.cwd, prompts: [{ text: "recalled", timestamp: minutes(1) }] });
		await h.start();
		h.type("my draft");

		h.press(Keys.ctrlR, Keys.enter);

		assert.equal(h.modalOpen, true);
		await h.loaded();
		assert.equal(h.editorText(), "my draft");
	});
});

describe("dismissing", () => {
	test("Escape leaves a multi-line draft and a mid-text cursor exactly as they were", async (t) => {
		const h = useHarness(t);
		h.writeSession({ cwd: h.cwd, prompts: [{ text: "recalled", timestamp: minutes(1) }] });
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

		assert.equal(h.modalOpen, false);
		assert.deepEqual({ text: h.editorText(), cursor: h.editorCursor() }, before);
	});

	test("Escape leaves a collapsed paste collapsed and its content intact", async (t) => {
		const h = useHarness(t);
		h.writeSession({ cwd: h.cwd, prompts: [{ text: "recalled", timestamp: minutes(1) }] });
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
		h.writeSession({ cwd: h.cwd, prompts: [{ text: "recalled", timestamp: minutes(1) }] });
		await h.start();
		h.type("my draft");

		h.press(Keys.ctrlR, Keys.escape);

		assert.equal(h.modalOpen, false);
		assert.equal(h.editorText(), "my draft");
	});

	test("the input bar works normally again after the modal closes", async (t) => {
		const h = useHarness(t);
		await h.start();
		h.press(Keys.ctrlR, Keys.escape);

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
		h.writeSession({
			cwd: h.cwd,
			prompts: [
				{ text: "one", timestamp: minutes(1) },
				{ text: "two", timestamp: minutes(2) },
				{ text: "three", timestamp: minutes(3) },
			],
		});
		await h.start();
		h.type("draft");

		h.press(Keys.ctrlR);
		await h.loaded();
		h.press("\x0b", "\x0b", "\x0a"); // ctrl+k, ctrl+k, ctrl+j
		assert.deepEqual(h.modalBody(), ["  one", "› two", "  three"]);
		h.press(Keys.enter, Keys.escape); // default keys no longer confirm or cancel
		assert.equal(h.modalOpen, true);
		h.press("\x0f"); // ctrl+o
		await h.flush();
		assert.equal(h.editorText(), "two");

		h.press(Keys.ctrlR);
		await h.loaded();
		h.press("\x07"); // ctrl+g
		await h.flush();
		assert.equal(h.modalOpen, false);
		assert.equal(h.editorText(), "two");
	});
});

describe("session files", () => {
	test("are never written", async (t) => {
		const h = useHarness(t);
		const file = h.writeSession({
			cwd: h.cwd,
			prompts: [
				{ text: "one", timestamp: minutes(1) },
				{ text: "two", timestamp: minutes(2) },
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
			h.writeSession({ cwd: h.cwd, prompts: [{ text: "hello", timestamp: minutes(1) }] });

			await h.start();

			assert.equal(h.editorFactoryInstalls, 0);
			assert.deepEqual(h.registrations, []);
			assert.deepEqual(h.overlayRequests, []);
			assert.deepEqual(h.notifications, []);
		});
	}
});

describe("test harness", () => {
	test("can put a scripted stub matcher on PATH that records its invocations", async (t) => {
		const h = useHarness(t, { stubMatcher: { responses: [{ query: "q", output: ["b"], exitCode: 0 }] } });

		const output = execFileSync("fzf", ["--filter", "q", "--read0", "--print0"], { input: "a\0b\0" });

		assert.equal(output.toString(), "b\0");
		const calls = h.matcherCalls().map(({ argv, input }) => ({ argv, input }));
		assert.deepEqual(calls, [{ argv: ["--filter", "q", "--read0", "--print0"], input: ["a", "b"] }]);
	});
});
