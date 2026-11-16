import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { harnessWithPrompts, Keys, needsStub, type StubMatcherCall, windowsSkip } from "./harness.ts";

/** Long enough for a debounced matcher run to have started, were one going to. */
const SETTLE_MS = 300;
const settle = () => new Promise((resolve) => setTimeout(resolve, SETTLE_MS));

/** The query a matcher invocation was given. */
function queryOf(call: StubMatcherCall): string | undefined {
	const at = call.argv.indexOf("--filter");
	return at === -1 ? undefined : call.argv[at + 1];
}

describe("the query line", () => {
	test("starts with the draft at the moment Ctrl+R is pressed", async (t) => {
		const h = harnessWithPrompts(t, ["one"]);
		await h.start();
		h.type("hello world");

		h.press(Keys.ctrlR);
		await h.loaded();

		assert.equal(h.modalQuery(), "> hello world");
	});

	test("edits never reach the draft, and dismissing discards them", async (t) => {
		const h = harnessWithPrompts(t, ["one"]);
		await h.start();
		h.type("draft");
		h.press(Keys.left, Keys.left);
		const before = { text: h.editorText(), cursor: h.editorCursor() };

		h.press(Keys.ctrlR);
		await h.loaded();
		h.type(" more");
		assert.equal(h.modalQuery(), "> draft more");
		h.press(Keys.escape);
		await h.flush();

		assert.deepEqual({ text: h.editorText(), cursor: h.editorCursor() }, before);
		h.press(Keys.ctrlR);
		await h.loaded();
		assert.equal(h.modalQuery(), "> draft");
	});

	test("holds a multi-line draft on one line, its line breaks as spaces", async (t) => {
		const h = harnessWithPrompts(t, ["one"]);
		await h.start();
		h.type("first");
		h.press("\n");
		h.type("second");

		h.press(Keys.ctrlR);
		await h.loaded();

		assert.equal(h.modalQuery(), "> first second");
		assert.equal(h.editorText(), "first\nsecond");
	});

	test("holds a collapsed paste in the draft by its content", async (t) => {
		const h = harnessWithPrompts(t, ["one"]);
		await h.start();
		const pasted = Array.from({ length: 15 }, (_, i) => `line ${i + 1}`);
		h.type("before ");
		h.press(`\x1b[200~${pasted.join("\n")}\x1b[201~`);
		assert.equal(h.editorText(), "before [paste #1 +15 lines]");

		h.press(Keys.ctrlR);
		await h.loaded();

		assert.equal(h.modalQuery(200), `> before ${pasted.join(" ")}`);
	});

	test("shows the terminal cursor only while the modal has Pi's focus", async (t) => {
		const h = harnessWithPrompts(t, ["one"]);
		await h.start();
		h.press(Keys.ctrlR);
		await h.loaded();
		assert.equal(h.modalShowsCursor(), true);

		h.setOverlayFocus(false);
		assert.equal(h.modalShowsCursor(), false);
		h.setOverlayFocus(true);
		assert.equal(h.modalShowsCursor(), true);
		h.type("x");
		assert.equal(h.modalQuery(), "> x");
	});
});

describe("keys in the same input batch as closing the modal", () => {
	test("after Escape they reach neither the draft nor the matcher", needsStub, async (t) => {
		const h = harnessWithPrompts(t, ["apple"]);
		await h.start();
		h.type("ap");
		h.press(Keys.ctrlR);
		await h.waitFor(() => h.modalList().join() === "› apple", "results for ap");

		h.press(Keys.escape, "x");
		await settle();

		assert.deepEqual(h.overlayLines(), []);
		assert.equal(h.editorText(), "ap");
		assert.deepEqual(h.matcherCalls().map(queryOf), ["ap"]);
	});

	test("after Enter they reach neither the confirmed text nor the matcher", needsStub, async (t) => {
		const h = harnessWithPrompts(t, ["apple"]);
		await h.start();
		h.press(Keys.ctrlR);
		await h.loaded();

		h.press(Keys.enter, "x");
		await settle();

		assert.equal(h.editorText(), "apple");
		assert.deepEqual(h.matcherCalls(), []);
	});
});

describe("an empty query", () => {
	for (const [name, draft] of [
		["an empty draft", ""],
		["a whitespace-only draft", "   "],
	] as const) {
		test(`from ${name} lists newest first without starting the matcher`, async (t) => {
			const h = harnessWithPrompts(t, ["one", "two", "three"]);
			await h.start();
			h.type(draft);

			h.press(Keys.ctrlR);
			await h.loaded();
			await settle();

			assert.equal(h.modalQuery(), ">");
			assert.deepEqual(h.modalList(), ["  one", "  two", "› three"]);
			assert.deepEqual(h.matcherCalls(), []);
		});
	}
});

describe("a non-empty query", () => {
	test("lists the matcher's ranking, best candidate selected next to the query line", needsStub, async (t) => {
		const h = harnessWithPrompts(t, ["fix bug", "rg foo", "refactor"], {
			stubMatcher: { responses: [{ query: "rg", output: ["rg foo", "refactor"] }] },
		});
		await h.start();
		h.type("rg");

		h.press(Keys.ctrlR);
		await h.waitFor(() => h.modalList().includes("› rg foo"), "ranked results");

		assert.deepEqual(h.modalList(), ["  refactor", "› rg foo"]);
		h.press(Keys.enter);
		await h.flush();
		assert.equal(h.editorText(), "rg foo");
		assert.deepEqual(h.submissions, []);
	});
});

describe("confirming during a search", () => {
	test("Enter does nothing while the list is still for an earlier query", needsStub, async (t) => {
		const h = harnessWithPrompts(t, ["rg foo", "newest"], {
			stubMatcher: { responses: [{ query: "rg", output: ["rg foo"] }] },
		});
		await h.start();
		h.press(Keys.ctrlR);
		await h.loaded();

		h.press("r", "g", Keys.enter); // one batch: the newest-first list is still on screen
		await h.flush();
		assert.equal(h.modalQuery(), "> rg");
		assert.equal(h.editorText(), "");

		await h.waitFor(() => h.modalList().join() === "› rg foo", "results for rg");
		h.press(Keys.enter);
		await h.flush();
		assert.equal(h.editorText(), "rg foo");
	});
});

describe("the fzf contract", () => {
	test("fzf filters the records NUL-delimited and newest first, with the query verbatim", needsStub, async (t) => {
		const h = harnessWithPrompts(t, ["oldest", "two\nlines", "has\0nul", "newest"]);
		await h.start();
		const query = "'exact ^start !not | either$";
		h.type(query);

		h.press(Keys.ctrlR);
		await h.waitFor(() => h.matcherCalls().length > 0, "the matcher to start");

		const [call] = h.matcherCalls();
		assert.deepEqual(call?.argv, ["--filter", query, "--read0", "--print0", "--scheme=history"]);
		// A record containing NUL cannot be delimited, so it is left out.
		assert.deepEqual(call?.input, ["newest", "two\nlines", "oldest"]);
	});

	test("fzf does not inherit FZF_DEFAULT_OPTS or FZF_DEFAULT_OPTS_FILE", needsStub, async (t) => {
		const h = harnessWithPrompts(t, ["one"]);
		h.setEnv("FZF_DEFAULT_OPTS", "--no-sort --tac");
		h.setEnv("FZF_DEFAULT_OPTS_FILE", h.path("fzf-options"));
		h.setEnv("FZF_PI_HISTORY_TEST", "inherited");
		await h.start();
		h.type("one");

		h.press(Keys.ctrlR);
		await h.waitFor(() => h.matcherCalls().length > 0, "the matcher to start");

		const env = h.matcherCalls()[0]?.env ?? {};
		assert.equal(env.FZF_PI_HISTORY_TEST, "inherited");
		assert.equal("FZF_DEFAULT_OPTS" in env, false);
		assert.equal("FZF_DEFAULT_OPTS_FILE" in env, false);
	});
});

describe("searching as you type", () => {
	test("typing searches for the latest query, and a later edit searches again", needsStub, async (t) => {
		const h = harnessWithPrompts(t, ["alpha", "beta"]);
		await h.start();
		h.press(Keys.ctrlR);
		await h.loaded();

		h.type("alp");
		await h.waitFor(() => h.modalList().join() === "› alpha", "results for alp");
		await settle();
		assert.deepEqual(h.matcherCalls().map(queryOf), ["alp"]);

		h.type("h");
		await h.waitFor(() => h.matcherCalls().length === 2, "a second run");
		await settle();
		assert.deepEqual(h.matcherCalls().map(queryOf), ["alp", "alph"]);
	});

	test("clearing the query lists every record newest first again", needsStub, async (t) => {
		const h = harnessWithPrompts(t, ["alpha", "beta"]);
		await h.start();
		h.type("alp");
		h.press(Keys.ctrlR);
		await h.waitFor(() => h.modalList().join() === "› alpha", "results for alp");

		h.press(Keys.clearLine);

		assert.deepEqual(h.modalList(), ["  alpha", "› beta"]);
	});

	test("a slow earlier query never replaces a newer one, and its process is killed", needsStub, async (t) => {
		const h = harnessWithPrompts(t, ["apple", "apricot"], {
			stubMatcher: {
				responses: [
					{ query: "a", output: ["apple"], delayMs: 500 },
					{ query: "ap", output: ["apricot"] },
				],
			},
		});
		await h.start();
		h.press(Keys.ctrlR);
		await h.loaded();

		h.type("a");
		await h.waitFor(() => h.matcherCalls().length === 1, "the first run to start");
		h.type("p");
		await h.flush();
		// The cancelled run shows nothing, not even its cancellation: the list waits for "ap".
		assert.deepEqual(h.modalList(), ["  apple", "› apricot"]);
		await h.waitFor(() => h.modalList().join() === "› apricot", "results for ap");
		await new Promise((resolve) => setTimeout(resolve, 700)); // past the slow run's delay

		assert.deepEqual(h.modalList(), ["› apricot"]);
		assert.deepEqual(
			h.matcherCalls().map((call) => ({ query: queryOf(call), finished: call.finished })),
			[
				{ query: "a", finished: false },
				{ query: "ap", finished: true },
			],
		);
	});

	test("dismissing the modal kills a running matcher", needsStub, async (t) => {
		const h = harnessWithPrompts(t, ["apple"], { stubMatcher: { responses: [{ output: ["apple"], delayMs: 500 }] } });
		await h.start();
		h.type("apple");
		h.press(Keys.ctrlR);
		await h.waitFor(() => h.matcherCalls().length === 1, "the run to start");

		h.press(Keys.escape);
		await new Promise((resolve) => setTimeout(resolve, 700));

		assert.equal(h.matcherCalls()[0]?.finished, false);
		assert.equal(h.editorText(), "apple");
	});

	test("dismissing the modal before the debounce ends starts no matcher", needsStub, async (t) => {
		const h = harnessWithPrompts(t, ["apple"]);
		await h.start();
		h.press(Keys.ctrlR);
		await h.loaded();

		h.press("a", Keys.escape);
		await settle();

		assert.deepEqual(h.matcherCalls(), []);
	});

	test("each new result list selects its best candidate", needsStub, async (t) => {
		const h = harnessWithPrompts(t, ["task one", "task two", "task three"]);
		await h.start();
		h.type("task");
		h.press(Keys.ctrlR);
		await h.waitFor(() => h.modalList().length === 3 && h.matcherCalls().length === 1, "results for task");
		h.press(Keys.up, Keys.up);
		assert.deepEqual(h.modalList(), ["› task one", "  task two", "  task three"]);

		h.type(" t");
		await h.waitFor(() => h.matcherCalls().length === 2 && h.modalList().length === 2, "results for task t");

		assert.deepEqual(h.modalList(), ["  task two", "› task three"]);
	});
});

describe("matcher outcomes", () => {
	test("the no-match status shows that nothing matched, and Enter then does nothing", needsStub, async (t) => {
		const h = harnessWithPrompts(t, ["one"]);
		await h.start();
		h.type("zzz");

		h.press(Keys.ctrlR);
		await h.waitFor(() => h.matcherCalls().length === 1 && !h.modalList().includes("Searching…"), "the search");

		assert.deepEqual(h.modalList(), ["No matches"]);
		h.press(Keys.enter);
		await h.flush();
		assert.equal(h.modalQuery(), "> zzz");
		assert.equal(h.editorText(), "zzz");
	});

	test("a query containing NUL is reported, since fzf cannot be given one", async (t) => {
		const h = harnessWithPrompts(t, ["one"]);
		await h.start();
		h.press(Keys.ctrlR);
		await h.loaded();

		h.press("\x1b[200~a\0b\x1b[201~"); // pasted into the query line
		await h.waitFor(() => h.modalList()[0]?.startsWith("Search failed") ?? false, "the failure");

		assert.deepEqual(h.modalList(), [
			"Search failed: a query cannot contain a NUL character",
			"Clear the query to browse recent prompts",
		]);
		assert.deepEqual(h.matcherCalls(), []);
	});

	test("a missing fzf is reported, and clearing the query still browses newest first", async (t) => {
		const h = harnessWithPrompts(t, ["one", "two"]);
		h.setEnv("PATH", h.path("no-matcher-here"));
		await h.start();
		h.type("one");

		h.press(Keys.ctrlR);
		await h.waitFor(() => h.modalList()[0]?.startsWith("Search failed") ?? false, "the failure");

		assert.deepEqual(h.modalList(), ["Search failed: fzf was not found", "Clear the query to browse recent prompts"]);
		h.press(Keys.clearLine);
		assert.deepEqual(h.modalList(), ["  one", "› two"]);
	});

	test("a failing fzf is reported with its exit status and error output", needsStub, async (t) => {
		const h = harnessWithPrompts(t, ["one"], {
			stubMatcher: { responses: [{ exitCode: 2, stderr: "unknown option: --scheme=history\nusage: fzf [options]\n" }] },
		});
		await h.start();
		h.type("one");

		h.press(Keys.ctrlR);
		await h.waitFor(() => h.modalList()[0]?.startsWith("Search failed") ?? false, "the failure");

		assert.deepEqual(h.modalList(), [
			"Search failed: fzf exited with status 2: unknown option: --scheme=history",
			"Clear the query to browse recent prompts",
		]);
	});

	test("a fzf ended by a signal is reported, and clearing the query still browses", needsStub, async (t) => {
		const h = harnessWithPrompts(t, ["one", "two"], { stubMatcher: { responses: [{ signal: "SIGKILL" }] } });
		await h.start();
		h.type("one");

		h.press(Keys.ctrlR);
		await h.waitFor(() => h.modalList()[0]?.startsWith("Search failed") ?? false, "the failure");

		assert.deepEqual(h.modalList(), ["Search failed: fzf was terminated by SIGKILL", "Clear the query to browse recent prompts"]);
		h.press(Keys.clearLine);
		assert.deepEqual(h.modalList(), ["  one", "› two"]);
	});

	test(
		"a fzf that cannot be executed is reported, and clearing the query still browses",
		windowsSkip("Windows files have no execute permission"),
		async (t) => {
			const h = harnessWithPrompts(t, ["one", "two"]);
			const bin = h.path("unexecutable bin");
			mkdirSync(bin);
			writeFileSync(join(bin, "fzf"), "#!/bin/sh\n", { mode: 0o644 });
			h.setEnv("PATH", bin);
			await h.start();
			h.type("one");

			h.press(Keys.ctrlR);
			await h.waitFor(() => h.modalList()[0]?.startsWith("Search failed") ?? false, "the failure");

			assert.deepEqual(h.modalList(), [
				"Search failed: could not run fzf: spawn fzf EACCES",
				"Clear the query to browse recent prompts",
			]);
			h.press(Keys.clearLine);
			assert.deepEqual(h.modalList(), ["  one", "› two"]);
		},
	);

	test(
		"a query too long to start fzf with is reported, and clearing the query still browses",
		windowsSkip("Windows limits the command line differently"),
		async (t) => {
			const h = harnessWithPrompts(t, ["one", "two"]);
			await h.start();
			h.press(Keys.ctrlR);
			await h.loaded();

			// Past Linux's per-argument limit (128 KiB) and macOS's whole-command-line limit (1 MiB):
			// Node then fails to start the process synchronously instead of reporting an error event.
			h.press(`\x1b[200~${"q".repeat(2 ** 21)}\x1b[201~`);
			await h.waitFor(() => h.modalList()[0]?.startsWith("Search failed") ?? false, "the failure");

			assert.deepEqual(h.modalList(), [
				"Search failed: could not run fzf: spawn E2BIG",
				"Clear the query to browse recent prompts",
			]);
			h.press(Keys.clearLine);
			assert.deepEqual(h.modalList(), ["  one", "› two"]);
		},
	);
});
