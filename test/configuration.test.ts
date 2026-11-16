import assert from "node:assert/strict";
import { mkdirSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { type Harness, harnessWithPrompts, Keys, needsStub, type StubMatcherCall } from "./harness.ts";

function escapeRegExp(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Type `query` as the draft, open the modal with Ctrl+R and wait for the matcher to be started. */
async function searchFor(h: Harness, query: string, openKey: string = Keys.ctrlR): Promise<StubMatcherCall> {
	h.type(query);
	h.press(openKey);
	await h.waitFor(() => h.matcherCalls().length > 0, "the matcher to start");
	const [call] = h.matcherCalls();
	assert.ok(call);
	return call;
}

describe("without a configuration file", () => {
	test("Ctrl+R opens the modal, fzf ranks the results and nothing is reported", needsStub, async (t) => {
		const h = harnessWithPrompts(t, ["one"]);
		await h.start();

		const call = await searchFor(h, "one");

		assert.deepEqual(call.argv, ["--filter", "one", "--read0", "--print0", "--scheme=history"]);
		assert.deepEqual(h.notifications, []);
	});
});

describe("an invalid configuration file", () => {
	test("that is not JSON is reported once, and every default applies", needsStub, async (t) => {
		const h = harnessWithPrompts(t, ["one"]);
		h.writeConfig('{ "matcher": "sk", }');
		await h.start();

		const call = await searchFor(h, "one");

		assert.equal(h.notifications.length, 1);
		assert.equal(h.notifications[0]?.type, "warning");
		assert.match(
			h.notifications[0]?.message ?? "",
			new RegExp(`^pi-history: ignoring ${escapeRegExp(h.configPath)}, which is not valid JSON \\(.+\\); using the default settings\\.$`),
		);
		assert.deepEqual(call.argv, ["--filter", "one", "--read0", "--print0", "--scheme=history"]);
	});

	test("with one invalid value is reported once, and only that value's default applies", needsStub, async (t) => {
		const h = harnessWithPrompts(t, ["one"]);
		h.writeConfig({ matcher: "skim", searchKey: "ctrl+t" });
		await h.start();

		const call = await searchFor(h, "one", Keys.ctrlT);

		assert.deepEqual(h.notifications, [
			{
				message: `pi-history: invalid settings in ${h.configPath}: "matcher" must be "fzf" or "sk", using "fzf".`,
				type: "warning",
			},
		]);
		assert.deepEqual(call.argv, ["--filter", "one", "--read0", "--print0", "--scheme=history"]);
	});

	test("with every value invalid, and an unknown setting, is reported in one notification", needsStub, async (t) => {
		const h = harnessWithPrompts(t, ["one", "two"]);
		h.writeConfig({
			matcher: "skim",
			matcherCommand: "",
			searchKey: "ctrl+ctrl+t",
			recordLimit: 1.5,
			macher: "sk",
		});
		await h.start();

		const call = await searchFor(h, "o");

		assert.deepEqual(h.notifications, [
			{
				message:
					`pi-history: invalid settings in ${h.configPath}: ` +
					`"matcher" must be "fzf" or "sk", using "fzf"; ` +
					`"matcherCommand" must be a command name or a path, using "fzf"; ` +
					`"searchKey" must be a key in Pi's keybinding syntax, such as "ctrl+t", using "ctrl+r"; ` +
					`"recordLimit" must be a positive integer, using 5000; ` +
					`"macher" is not a setting, ignored.`,
				type: "warning",
			},
		]);
		assert.deepEqual(call.argv, ["--filter", "o", "--read0", "--print0", "--scheme=history"]);
		assert.deepEqual(call.input, ["two", "one"]);
	});

	for (const [what, value] of [
		["an unknown modifier", "hyper+r"],
		["an unknown key", "ctrl+rr"],
		["a modifier without a key", "ctrl+"],
		["a non-string", 18],
	] as const) {
		test(`with ${what} as the search key keeps Ctrl+R`, async (t) => {
			const h = harnessWithPrompts(t, ["one"]);
			h.writeConfig({ searchKey: value });
			await h.start();

			h.press(Keys.ctrlR);
			await h.loaded();

			assert.equal(h.notifications.length, 1);
			assert.match(h.notifications[0]?.message ?? "", /"searchKey" must be a key in Pi's keybinding syntax/);
		});
	}

	for (const [what, value] of [
		["zero", 0],
		["a negative number", -1],
		["a string", "100"],
	] as const) {
		test(`with ${what} as the record limit keeps the default`, async (t) => {
			const h = harnessWithPrompts(t, ["one", "two"]);
			h.writeConfig({ recordLimit: value });
			await h.start();

			h.press(Keys.ctrlR);
			await h.loaded();

			assert.deepEqual(h.modalList(), ["  one", "› two"]);
			assert.equal(h.notifications.length, 1);
			assert.match(h.notifications[0]?.message ?? "", /"recordLimit" must be a positive integer, using 5000/);
		});
	}

	for (const [what, content, why] of [
		["that holds an array", "[]", "does not hold a JSON object"],
		["that holds null", "null", "does not hold a JSON object"],
		["that is empty", "", "is not valid JSON"],
	] as const) {
		test(`${what} is reported once, and every default applies`, async (t) => {
			const h = harnessWithPrompts(t, ["one"]);
			h.writeConfig(content);
			await h.start();

			h.press(Keys.ctrlR);
			await h.loaded();

			assert.equal(h.notifications.length, 1);
			assert.ok(h.notifications[0]?.message.startsWith(`pi-history: ignoring ${h.configPath}, which ${why}`));
			assert.deepEqual(h.modalList(), ["› one"]);
		});
	}

	test("that cannot be read is reported once, and every default applies", async (t) => {
		const h = harnessWithPrompts(t, ["one"]);
		mkdirSync(h.configPath, { recursive: true }); // a directory where the file should be
		await h.start();

		h.press(Keys.ctrlR);
		await h.loaded();

		assert.equal(h.notifications.length, 1);
		assert.match(
			h.notifications[0]?.message ?? "",
			new RegExp(`^pi-history: ignoring ${escapeRegExp(h.configPath)}, which could not be read \\(.*EISDIR.*\\); using the default settings\\.$`),
		);
		assert.deepEqual(h.modalList(), ["› one"]);
	});

	test("is reported once, not again when /new, /resume or /fork load the extension afresh", async (t) => {
		const h = harnessWithPrompts(t, ["one"]);
		h.writeConfig({ matcher: "skim" });
		await h.start();

		await h.start("new");
		await h.start("resume");
		await h.start("fork");

		assert.equal(h.notifications.length, 1);
		h.press(Keys.ctrlR);
		await h.loaded();
		assert.deepEqual(h.modalList(), ["› one"]);
	});

	test("is reported again on /reload, which is how changes are applied", async (t) => {
		const h = harnessWithPrompts(t, ["one"]);
		h.writeConfig({ matcher: "skim" });
		await h.start();

		await h.start("reload");

		assert.equal(h.notifications.length, 2);
		assert.equal(h.notifications[1]?.message, h.notifications[0]?.message);
	});

	test("introduced or changed after startup is reported at the next session start", async (t) => {
		const h = harnessWithPrompts(t, ["one"]);
		h.writeConfig({ matcher: "sk" });
		await h.start();
		assert.equal(h.notifications.length, 0);

		h.writeConfig({ matcher: "skim" });
		await h.start("new");
		h.writeConfig({ recordLimit: 0 });
		await h.start("resume");

		assert.deepEqual(
			h.notifications.map((notification) => notification.message.replace(/^.*: "/, '"')),
			['"matcher" must be "fzf" or "sk", using "fzf".', '"recordLimit" must be a positive integer, using 5000.'],
		);
	});

	test("that was fixed and then made again is reported again", async (t) => {
		const h = harnessWithPrompts(t, ["one"]);
		h.writeConfig({ matcher: "skim" });
		await h.start();
		h.writeConfig({});
		await h.start("new");
		h.writeConfig({ matcher: "skim" });
		await h.start("new");

		assert.equal(h.notifications.length, 2);
	});
});

describe("the matcher command", () => {
	test("starts the configured executable instead of looking the matcher up on PATH", needsStub, async (t) => {
		const h = harnessWithPrompts(t, ["one"]);
		h.writeConfig({ matcher: "sk", matcherCommand: h.stubMatcherPath("sk") });
		// No matcher on PATH, only the node the stub script runs with.
		const nodeOnly = h.path("node only");
		mkdirSync(nodeOnly);
		symlinkSync(process.execPath, join(nodeOnly, "node"));
		h.setEnv("PATH", nodeOnly);
		await h.start();

		const call = await searchFor(h, "one");

		assert.deepEqual(call.argv, ["--filter", "one", "--read0", "--print0", "--tiebreak=score,index"]);
		await h.waitFor(() => h.modalList().join() === "› one", "the result");
	});

	test("a missing configured executable is reported by its path", async (t) => {
		const h = harnessWithPrompts(t, ["one"]);
		const missing = h.path("nowhere/fzf");
		h.writeConfig({ matcherCommand: missing });
		await h.start();
		h.type("one");

		h.press(Keys.ctrlR);
		await h.waitFor(() => h.modalList()[0]?.startsWith("Search failed") ?? false, "the failure");

		assert.equal(h.modalList(200)[0], `Search failed: ${missing} was not found`);
	});

	test("may be a path relative to the agent directory", needsStub, async (t) => {
		const h = harnessWithPrompts(t, ["one"]);
		mkdirSync(join(h.agentDir, "bin"), { recursive: true });
		symlinkSync(h.stubMatcherPath("sk"), join(h.agentDir, "bin", "my-sk"));
		h.writeConfig({ matcher: "sk", matcherCommand: "bin/my-sk" });
		await h.start();

		const call = await searchFor(h, "one");

		assert.deepEqual(h.notifications, []);
		assert.deepEqual(call.argv, ["--filter", "one", "--read0", "--print0", "--tiebreak=score,index"]);
	});

	test("may start with ~/ for the home directory", needsStub, async (t) => {
		const h = harnessWithPrompts(t, ["one"]);
		h.setEnv("HOME", h.root);
		h.writeConfig({ matcherCommand: "~/matcher bin/fzf" });
		await h.start();

		const call = await searchFor(h, "one");

		assert.deepEqual(h.notifications, []);
		assert.deepEqual(call.argv, ["--filter", "one", "--read0", "--print0", "--scheme=history"]);
	});
});

describe("the search key", () => {
	test("opens the modal with the draft as its query, and Ctrl+R no longer does", async (t) => {
		const h = harnessWithPrompts(t, ["one"]);
		h.writeConfig({ searchKey: "ctrl+t" });
		await h.start();
		h.type("draft");

		h.press(Keys.ctrlR);
		await h.flush();
		assert.deepEqual(h.overlayLines(), []);
		assert.equal(h.editorText(), "draft");

		h.press(Keys.ctrlT);
		await h.loaded();
		assert.equal(h.modalQuery(), "> draft");
	});
});

describe("the record limit", () => {
	test("keeps only the newest unique records", async (t) => {
		const h = harnessWithPrompts(t, ["one", "two", "three", "two"]);
		h.writeConfig({ recordLimit: 2 });
		await h.start();

		h.press(Keys.ctrlR);
		await h.loaded();

		assert.deepEqual(h.modalList(), ["  three", "› two"]);
	});
});

describe("the sk matcher", () => {
	test("filters NUL-delimited, ranking by score then input order, never with skim's history scheme", needsStub, async (t) => {
		const h = harnessWithPrompts(t, ["oldest", "two\nlines", "newest"]);
		h.writeConfig({ matcher: "sk" });
		await h.start();

		const call = await searchFor(h, "'exact ^start");

		assert.deepEqual(call.argv, ["--filter", "'exact ^start", "--read0", "--print0", "--tiebreak=score,index"]);
		assert.deepEqual(call.input, ["newest", "two\nlines", "oldest"]);
	});

	test("does not inherit SKIM_DEFAULT_OPTIONS or SKIM_OPTIONS_FILE", needsStub, async (t) => {
		const h = harnessWithPrompts(t, ["one"]);
		h.writeConfig({ matcher: "sk" });
		h.setEnv("SKIM_DEFAULT_OPTIONS", "--no-sort --tac");
		h.setEnv("SKIM_OPTIONS_FILE", h.path("skim-options"));
		h.setEnv("SKIM_PI_HISTORY_TEST", "inherited");
		await h.start();

		const { env } = await searchFor(h, "one");

		assert.equal(env.SKIM_PI_HISTORY_TEST, "inherited");
		assert.equal("SKIM_DEFAULT_OPTIONS" in env, false);
		assert.equal("SKIM_OPTIONS_FILE" in env, false);
	});

	test("its no-match status shows that nothing matched", needsStub, async (t) => {
		const h = harnessWithPrompts(t, ["one"], { stubMatcher: { responses: [{ exitCode: 1 }] } });
		h.writeConfig({ matcher: "sk" });
		await h.start();

		await searchFor(h, "zzz");
		await h.waitFor(() => !h.modalList().includes("Searching…"), "the search");

		assert.deepEqual(h.modalList(), ["No matches"]);
	});

	test("a failing sk is reported with its exit status and error output", needsStub, async (t) => {
		const h = harnessWithPrompts(t, ["one"], {
			stubMatcher: { responses: [{ exitCode: 2, stderr: "error: unexpected argument '--bogus' found\n\nUsage: sk\n" }] },
		});
		h.writeConfig({ matcher: "sk" });
		await h.start();

		await searchFor(h, "one");
		await h.waitFor(() => h.modalList()[0]?.startsWith("Search failed") ?? false, "the failure");

		assert.deepEqual(h.modalList(120), [
			"Search failed: sk exited with status 2: error: unexpected argument '--bogus' found",
			"Clear the query to browse recent prompts",
		]);
	});

	test("a missing sk is reported, and clearing the query still browses newest first", async (t) => {
		const h = harnessWithPrompts(t, ["one", "two"]);
		h.writeConfig({ matcher: "sk" });
		h.setEnv("PATH", h.path("no-matcher-here"));
		await h.start();
		h.type("one");

		h.press(Keys.ctrlR);
		await h.waitFor(() => h.modalList()[0]?.startsWith("Search failed") ?? false, "the failure");

		assert.deepEqual(h.modalList(), ["Search failed: sk was not found", "Clear the query to browse recent prompts"]);
		h.press(Keys.clearLine);
		assert.deepEqual(h.modalList(), ["  one", "› two"]);
	});
});
