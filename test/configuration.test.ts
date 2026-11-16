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

		assert.deepEqual(call.argv, ["--filter=one", "--read0", "--print0", "--scheme=history"]);
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
		assert.deepEqual(call.argv, ["--filter=one", "--read0", "--print0", "--scheme=history"]);
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
		assert.deepEqual(call.argv, ["--filter=one", "--read0", "--print0", "--scheme=history"]);
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
					`"searchKey" must be a key Pi recognizes, such as "ctrl+t" (Escape takes no modifiers), using "ctrl+r"; ` +
					`"recordLimit" must be a positive integer, using 5000; ` +
					`"macher" is not a setting, ignored.`,
				type: "warning",
			},
		]);
		assert.deepEqual(call.argv, ["--filter=o", "--read0", "--print0", "--scheme=history"]);
		assert.deepEqual(call.input, ["two", "one"]);
	});

	for (const [what, value] of [
		["an unknown modifier", "hyper+r"],
		["an unknown key", "ctrl+rr"],
		["a modifier without a key", "ctrl+"],
		["a non-string", 18],
		["Escape with a modifier, which Pi never matches", "ctrl+escape"],
		["the Esc alias with a modifier, in capitals", "Shift+ESC"],
	] as const) {
		test(`with ${what} as the search key keeps Ctrl+R`, async (t) => {
			const h = harnessWithPrompts(t, ["one"]);
			h.writeConfig({ searchKey: value });
			await h.start();

			h.press(Keys.ctrlR);
			await h.loaded();

			assert.equal(h.notifications.length, 1);
			assert.match(h.notifications[0]?.message ?? "", /"searchKey" must be a key Pi recognizes/);
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

	test("is reported once, not again when /new, /resume, /fork or /reload load the extension afresh", async (t) => {
		const h = harnessWithPrompts(t, ["one"]);
		h.writeConfig({ matcher: "skim" });
		await h.start();

		await h.start("new");
		await h.start("resume");
		await h.start("fork");
		await h.start("reload");
		await h.start("reload");

		assert.equal(h.notifications.length, 1);
		h.press(Keys.ctrlR);
		await h.loaded();
		assert.deepEqual(h.modalList(), ["› one"]);
	});

	test("introduced or changed after startup is reported at the next session start", async (t) => {
		const h = harnessWithPrompts(t, ["one"]);
		h.writeConfig({ matcher: "sk" });
		await h.start();
		assert.equal(h.notifications.length, 0);

		h.writeConfig({ matcher: "skim" });
		await h.start("reload");
		h.writeConfig({ recordLimit: 0 });
		await h.start("new");

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

		assert.deepEqual(call.argv, ["--filter=one", "--read0", "--print0", "--tiebreak=score,index"]);
		await h.waitFor(() => h.modalList().join() === "› one", "the result");
	});

	test("containing NUL, which no executable path can, is reported and only it falls back", needsStub, async (t) => {
		const h = harnessWithPrompts(t, ["one", "two", "three"]);
		h.writeConfig({ matcher: "sk", matcherCommand: "sk\u0000", searchKey: "ctrl+t", recordLimit: 2 });
		await h.start();

		const call = await searchFor(h, "t", Keys.ctrlT);

		assert.deepEqual(h.notifications, [
			{
				message: `pi-history: invalid settings in ${h.configPath}: "matcherCommand" must be a command name or a path, using "sk".`,
				type: "warning",
			},
		]);
		assert.deepEqual(call.argv, ["--filter=t", "--read0", "--print0", "--tiebreak=score,index"]);
		assert.deepEqual(call.input, ["three", "two"]);
		await h.waitFor(() => h.modalList().join() === "  two,› three", "the results");
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
		assert.deepEqual(call.argv, ["--filter=one", "--read0", "--print0", "--tiebreak=score,index"]);
	});

	test("may start with ~/ for the home directory", needsStub, async (t) => {
		const h = harnessWithPrompts(t, ["one"]);
		h.setEnv("HOME", h.root);
		h.writeConfig({ matcherCommand: "~/matcher bin/fzf" });
		await h.start();

		const call = await searchFor(h, "one");

		assert.deepEqual(h.notifications, []);
		assert.deepEqual(call.argv, ["--filter=one", "--read0", "--print0", "--scheme=history"]);
	});
});

describe("the search key", () => {
	test("may be written in any case", async (t) => {
		const h = harnessWithPrompts(t, ["one"]);
		h.writeConfig({ searchKey: "Ctrl+T" });
		await h.start();

		h.press(Keys.ctrlT);
		await h.loaded();

		assert.deepEqual(h.notifications, []);
		assert.deepEqual(h.modalList(), ["› one"]);
	});

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
