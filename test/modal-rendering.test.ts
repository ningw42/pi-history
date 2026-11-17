import assert from "node:assert/strict";
import { join, sep } from "node:path";
import { describe, test } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
	type Harness,
	harnessWithPrompts,
	Keys,
	minutesAfterT0,
	needsStub,
	needsTimeZoneSetting,
	needsUtc,
	useHarness,
	userEntry,
} from "./harness.ts";

/** Make `dir` the home directory, on every platform. */
function setHome(h: Harness, dir: string): void {
	h.setEnv("HOME", dir);
	h.setEnv("USERPROFILE", dir);
}

/** Open the modal with the search key and wait for history to load. */
async function open(h: Harness): Promise<void> {
	h.press(Keys.ctrlR);
	await h.loaded();
}

describe("the modal's layout", () => {
	test("title, list with the best candidate at the bottom, last use, preview, query line, key hints", needsUtc, async (t) => {
		const h = useHarness(t);
		setHome(h, h.root);
		h.writeSession({
			cwd: h.cwd,
			prompts: [
				{ text: "older one-liner", timestamp: minutesAfterT0(1) },
				{ text: "fix the flaky test\nthen run the suite", timestamp: minutesAfterT0(2) },
			],
		});
		await h.start();

		await open(h);

		const home = join("~", "work", "project");
		assert.deepEqual(h.overlayLines(40), [
			"╭─ History · repo ─────────────────────╮",
			"│   older one-liner                    │",
			"│ › fix the flaky test ↵ then run the… │",
			`├─ 2026-11-01 09:02 · ${home} ──┤`,
			"│ fix the flaky test                   │",
			"│ then run the suite                   │",
			"│                                      │",
			"│                                      │",
			"├──────────────────────────────────────┤",
			"│ >                                    │",
			"╰─ ctrl+r switch to global  ↑↓ navigat…╯",
		]);
	});
});

describe("list rows", () => {
	test("are each drawn in one colour: matches are not highlighted", needsStub, async (t) => {
		const h = useHarness(t, {
			stubMatcher: { responses: [{ query: "fix", output: ["fix the flaky test", "prefix it"] }] },
		});
		h.writeSession({
			cwd: h.cwd,
			prompts: ["prefix it", "fix the flaky test"].map((text, i) => ({ text, timestamp: minutesAfterT0(i + 1) })),
		});
		await h.start();
		h.type("fix");
		h.press(Keys.ctrlR);
		await h.waitFor(() => h.modalList().join() === "  prefix it,› fix the flaky test", "the results for fix");

		assert.deepEqual(
			h.modalListColours().map((colours) => colours.length),
			[1, 1],
		);
	});
});

describe("a resized terminal", () => {
	test("re-renders the modal to fit, keeping the selection, query line and key hints on screen", async (t) => {
		const h = harnessWithPrompts(
			t,
			Array.from({ length: 20 }, (_, i) => `prompt ${i + 1}\nwith a second line`),
		);
		await h.start();
		await open(h);
		h.press(...Array.from({ length: 14 }, () => Keys.up)); // "prompt 6", the top row of 15

		const shown: Record<number, number> = {};
		for (const [rows, width] of [[40, 100], [24, 60], [15, 30], [12, 24], [40, 80]] as const) {
			h.resize(rows);
			const lines = h.overlayLines(width);
			const where = `${rows} rows, ${width} columns:\n${lines.join("\n")}`;
			// The overlay may take 80% of the terminal's rows; Pi drops its bottom lines beyond that.
			assert.ok(lines.length <= Math.floor(rows * 0.8), where);
			assert.deepEqual(
				lines.map((line) => visibleWidth(line)),
				lines.map(() => width),
				where,
			);
			assert.equal(h.modalQuery(width), ">", where);
			assert.match(h.modalHint(width) ?? "", /^╰─ ctrl\+r/, where);
			assert.ok(h.modalList(width).some((row) => row.startsWith("› prompt 6 ↵")), where);
			// "prompt 6", or "prompt 6 …" once the preview is down to one row.
			assert.match(h.modalPreview(width)[0] ?? "", /^prompt 6(?: …)?$/, where);
			shown[rows] = h.modalList(width).length;
		}
		assert.ok((shown[40] ?? 0) > (shown[24] ?? 0) && (shown[24] ?? 0) > (shown[15] ?? 0), JSON.stringify(shown));
	});
});

describe("the key hints", () => {
	test("name the scope the search key switches to, then navigating, confirming and cancelling", async (t) => {
		const h = useHarness(t);
		await h.start();
		await open(h);
		assert.match(h.modalHint(100) ?? "", /^╰─ ctrl\+r switch to global {2}↑↓ navigate {2}enter confirm {2}escape cancel ─+╯$/);

		await open(h); // the search key again, inside the modal

		assert.match(h.modalHint(100) ?? "", /^╰─ ctrl\+r switch to repo {2}↑↓ navigate {2}enter confirm {2}escape cancel ─+╯$/);
	});

	test("name the keys Pi's keybindings give confirming, cancelling and navigating", async (t) => {
		const h = useHarness(t, {
			keybindings: {
				"tui.select.confirm": "ctrl+o",
				"tui.select.cancel": ["ctrl+g", "escape"],
				"tui.select.up": "ctrl+k",
				"tui.select.down": "ctrl+j",
			},
		});
		await h.start();
		await open(h);

		assert.match(h.modalHint(100) ?? "", /^╰─ ctrl\+r switch to global {2}ctrl\+k\/ctrl\+j navigate {2}ctrl\+o confirm {2}ctrl\+g cancel ─+╯$/);
	});

	test("leave out a key that Pi's keybindings unbind", async (t) => {
		const h = useHarness(t, { keybindings: { "tui.select.confirm": [], "tui.select.up": [] } });
		await h.start();
		await open(h);

		assert.match(h.modalHint(100) ?? "", /^╰─ ctrl\+r switch to global {2}↓ navigate {2}escape cancel ─+╯$/);
	});
});

describe("long records", () => {
	const greek = "alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron pi rho sigma tau upsilon phi chi psi omega";

	test("are truncated in their row and wrapped in the preview, up to a few rows, at a narrow width", async (t) => {
		const h = harnessWithPrompts(t, [greek]);
		await h.start();
		await open(h);

		assert.deepEqual(h.modalList(30), ["› alpha beta gamma delta …"]);
		assert.deepEqual(h.modalPreview(30), [
			"alpha beta gamma delta",
			"epsilon zeta eta theta",
			"iota kappa lambda mu nu xi",
			"omicron pi rho sigma tau …",
		]);
	});

	test("show their first lines in the preview, with line breaks intact", async (t) => {
		const h = harnessWithPrompts(t, ["one\ntwo\n\nfour\nfive\nsix"]);
		await h.start();
		await open(h);

		assert.deepEqual(h.modalList(), ["› one ↵ two ↵ four ↵ five ↵ six"]);
		assert.deepEqual(h.modalPreview(), ["one", "two", "", "four …"]);
	});

	test("that fill the preview exactly show no ellipsis", async (t) => {
		const h = harnessWithPrompts(t, ["one\ntwo\nthree\nfour"]);
		await h.start();
		await open(h);

		assert.deepEqual(h.modalPreview(), ["one", "two", "three", "four"]);
	});

	test("never have a wide character split, in their row or the preview", async (t) => {
		const h = harnessWithPrompts(t, ["你好世界你好世界你好世界你好世界"]);
		await h.start();
		await open(h);

		const lines = h.overlayLines(21);
		assert.deepEqual(h.modalList(21), ["› 你好世界你好世…"]);
		assert.deepEqual(h.modalPreview(21), ["你好世界你好世界", "你好世界你好世界"]);
		assert.deepEqual(
			lines.map((line) => visibleWidth(line)),
			lines.map(() => 21),
		);
	});

	test("of megabytes, on one line or many, render as quickly as a short one", async (t) => {
		/** Median time to render the modal, opened with the record `text` selected. */
		const renderTime = async (text: string) => {
			const h = harnessWithPrompts(t, [text]);
			await h.start();
			await open(h);
			const samples: number[] = [];
			for (let i = 0; i < 7; i++) {
				const start = performance.now();
				h.overlayLines();
				samples.push(performance.now() - start);
			}
			return samples.sort((a, b) => a - b)[3] ?? Number.NaN;
		};
		const short = await renderTime("a short prompt");
		for (const [kind, text] of [
			["one line", "word ".repeat(800_000)],
			["many lines", "word word\n".repeat(400_000)],
		]) {
			const large = await renderTime(text ?? "");
			// Wrapping all of a 4 MB record takes about 330 ms, collapsing all of it into a row 30 to
			// 80 ms; a short one renders in well under a millisecond, hence the floor for timer noise.
			assert.ok(large < Math.max(2, short) * 5, `${kind}: ${short.toFixed(2)} ms short, ${large.toFixed(2)} ms at 4 MB`);
		}
	});

	test("whose lines are a thousand blank lines apart are still one whole row", async (t) => {
		const h = harnessWithPrompts(t, [`start${"\n".repeat(1000)}end`]);
		await h.start();
		await open(h);

		assert.deepEqual(h.modalList(), ["› start ↵ end"]);
		assert.deepEqual(h.modalPreview(), ["start", "", "", " …"]);
	});

	test("break lines at a lone carriage return too, as Pi's editor does", async (t) => {
		const h = harnessWithPrompts(t, ["first\rsecond\r\nthird"]);
		await h.start();
		await open(h);

		assert.deepEqual(h.modalList(), ["› first ↵ second ↵ third"]);
		assert.deepEqual(h.modalPreview(), ["first", "second", "third"]);
	});
});

describe("the preview", () => {
	test("follows the selection, with the selected record's last use", needsUtc, async (t) => {
		const h = useHarness(t);
		setHome(h, h.root);
		h.writeSession({
			cwd: h.cwd,
			prompts: [
				{ text: "first\nprompt", timestamp: minutesAfterT0(1) },
				{ text: "second prompt", timestamp: minutesAfterT0(62) },
			],
		});
		await h.start();
		await open(h);
		assert.deepEqual(h.modalPreview(), ["second prompt"]);
		assert.equal(h.modalLastUsed(), `2026-11-01 10:02 · ${join("~", "work", "project")}`);

		h.press(Keys.up);

		assert.deepEqual(h.modalPreview(), ["first", "prompt"]);
		assert.equal(h.modalLastUsed(), `2026-11-01 09:01 · ${join("~", "work", "project")}`);
	});

	test("names the last use in local time, and a directory outside home in full", needsTimeZoneSetting, async (t) => {
		const h = useHarness(t);
		h.setEnv("TZ", "Asia/Tokyo"); // UTC+9, without daylight saving time
		setHome(h, h.path("work/pro")); // merely starts with the home directory's name: not inside it
		h.writeSession({ cwd: h.cwd, prompts: [{ text: "a prompt", timestamp: minutesAfterT0(1) }] });
		await h.start();
		await open(h);

		assert.equal(h.modalLastUsed(200), `2026-11-01 18:01 · ${h.cwd}`);
	});

	test("names the home directory itself as ~", needsUtc, async (t) => {
		const h = useHarness(t);
		setHome(h, h.cwd);
		h.writeSession({ cwd: h.cwd, prompts: [{ text: "a prompt", timestamp: minutesAfterT0(1) }] });
		await h.start();
		await open(h);

		assert.equal(h.modalLastUsed(), "2026-11-01 09:01 · ~");
	});

	test("keeps the end of a long directory, which names the project, on a narrow terminal", needsUtc, async (t) => {
		const h = useHarness(t, { cwd: "code/some/deeply/nested/project" });
		setHome(h, h.root);
		h.writeSession({ cwd: h.cwd, prompts: [{ text: "a prompt", timestamp: minutesAfterT0(1) }] });
		await h.start();
		await open(h);

		assert.equal(h.modalLastUsed(40), `2026-11-01 09:01 · …${sep}${join("nested", "project")}`);
	});

	test("leaves out a time or directory the session did not record", needsUtc, async (t) => {
		const h = useHarness(t);
		const noTime = { type: "message", id: "m1", parentId: null, timestamp: "not a time", message: { role: "user", content: "no time" } };
		h.writeSessionEntries({ cwd: h.cwd, entries: [noTime] });
		h.writeSessionEntries({ entries: [userEntry("m1", null, "no directory", minutesAfterT0(2))] });
		await h.start();
		await open(h);
		await open(h); // global scope: a session without a directory is in no repo scope
		assert.deepEqual(h.modalList(), ["  no time", "› no directory"]);
		assert.equal(h.modalLastUsed(), "2026-11-01 09:02");

		h.press(Keys.up);

		assert.deepEqual(h.modalPreview(), ["no time"]);
		assert.equal(h.modalLastUsed(200), h.cwd);
	});

	test("is empty, and names no last use, while history loads and when it is empty", async (t) => {
		const h = useHarness(t);
		await h.start();
		h.press(Keys.ctrlR);
		await h.flush();
		assert.deepEqual(h.modalList(), ["Loading history…"]);
		assert.deepEqual([h.modalPreview(), h.modalLastUsed()], [[], undefined]);

		await h.loaded();
		assert.deepEqual(h.modalList(), ["No history yet"]);
		assert.deepEqual([h.modalPreview(), h.modalLastUsed()], [[], undefined]);
	});

	test("is empty, and names no last use, when nothing matches or the search fails", needsStub, async (t) => {
		const h = useHarness(t, {
			stubMatcher: { responses: [{ query: "none", exitCode: 1 }, { query: "broken", exitCode: 2, stderr: "bad query" }] },
		});
		h.writeSession({ cwd: h.cwd, prompts: [{ text: "a prompt", timestamp: minutesAfterT0(1) }] });
		await h.start();
		h.type("none");
		h.press(Keys.ctrlR);
		await h.waitFor(() => h.modalList().join() === "No matches", "no matches");
		assert.deepEqual([h.modalPreview(), h.modalLastUsed()], [[], undefined]);

		h.press(Keys.clearLine);
		h.type("broken");
		await h.waitFor(() => h.modalList()[0]?.startsWith("Search failed") ?? false, "the search to fail");
		assert.deepEqual([h.modalPreview(), h.modalLastUsed()], [[], undefined]);
	});
});
