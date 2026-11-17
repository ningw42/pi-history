import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { defaultSessionDir, type Harness, Keys, minutesAfterT0, needsStub, settle, useHarness } from "./harness.ts";

/** Write a session recorded in `relative` (below the harness root) holding one prompt, `n` minutes after T0. */
function promptIn(h: Harness, relative: string, text: string, n: number): void {
	h.writeSession({ cwd: h.path(relative), prompts: [{ text, timestamp: minutesAfterT0(n) }] });
}

/** Open the modal on an empty draft and wait for its records. */
async function open(h: Harness): Promise<void> {
	h.press(Keys.ctrlR);
	await h.loaded();
}

describe("repo scope", () => {
	test("covers the whole repository when Pi starts in a subdirectory, and nothing outside it", async (t) => {
		const h = useHarness(t, { cwd: "code/app/packages/web" });
		h.makeGitRepo("code/app");
		h.makeGitRepo("code/other");
		promptIn(h, "code/app", "at the repository root", 1);
		promptIn(h, "code/app/packages/web", "in the current directory", 2);
		promptIn(h, "code/app/docs/guide", "in another subdirectory", 3);
		promptIn(h, "code/other", "in another repository", 4);
		promptIn(h, "code/app-fork", "in a directory whose name extends the root's", 5);
		promptIn(h, "code", "above the repository", 6);
		await h.start();

		await open(h);

		assert.deepEqual(h.modalList(), ["  at the repository root", "  in the current directory", "› in another subdirectory"]);
	});

	test("treats linked worktrees as separate repositories, also one checked out inside the main worktree", async (t) => {
		const h = useHarness(t, { cwd: "code/app" });
		const app = h.makeGitRepo("code/app");
		h.makeGitWorktree("code/app-feature", app);
		h.makeGitWorktree("code/app/.worktrees/fix", app);
		promptIn(h, "code/app", "in the main worktree", 1);
		promptIn(h, "code/app/.worktrees", "beside the nested worktree", 2);
		promptIn(h, "code/app-feature", "in the sibling worktree", 3);
		promptIn(h, "code/app/.worktrees/fix", "in the nested worktree", 4);
		promptIn(h, "code/app/.worktrees/fix/src", "below the nested worktree", 5);
		await h.start();

		await open(h);

		assert.deepEqual(h.modalList(), ["  in the main worktree", "› beside the nested worktree"]);
	});

	test("from inside a nested worktree covers that worktree only", async (t) => {
		const h = useHarness(t, { cwd: "code/app/.worktrees/fix/src" });
		const app = h.makeGitRepo("code/app");
		h.makeGitWorktree("code/app/.worktrees/fix", app);
		promptIn(h, "code/app", "in the main worktree", 1);
		promptIn(h, "code/app/.worktrees/fix", "in the nested worktree", 2);
		promptIn(h, "code/app/.worktrees/fix/src", "below the nested worktree", 3);
		await h.start();

		await open(h);

		assert.deepEqual(h.modalList(), ["  in the nested worktree", "› below the nested worktree"]);
	});

	test("from a sibling linked worktree covers that worktree only", async (t) => {
		const h = useHarness(t, { cwd: "code/app-feature/src" });
		const app = h.makeGitRepo("code/app");
		h.makeGitWorktree("code/app-feature", app);
		promptIn(h, "code/app", "in the main worktree", 1);
		promptIn(h, "code/app-feature", "in the sibling worktree", 2);
		promptIn(h, "code/app-feature/src", "below the sibling worktree", 3);
		await h.start();

		await open(h);

		assert.deepEqual(h.modalList(), ["  in the sibling worktree", "› below the sibling worktree"]);
	});

	test("treats a submodule checked out inside the repository as a separate repository", async (t) => {
		const h = useHarness(t, { cwd: "code/app" });
		const app = h.makeGitRepo("code/app");
		h.makeGitSubmodule("code/app/vendor/lib", app);
		promptIn(h, "code/app", "in the superproject", 1);
		promptIn(h, "code/app/vendor", "beside the submodule", 2);
		promptIn(h, "code/app/vendor/lib", "in the submodule", 3);
		await h.start();

		await open(h);

		assert.deepEqual(h.modalList(), ["  in the superproject", "› beside the submodule"]);
	});

	test("never covers a session recorded with a relative working directory, or none", async (t) => {
		const h = useHarness(t);
		const previous = process.cwd();
		process.chdir(h.cwd); // where a relative directory would resolve to the current one
		t.after(() => process.chdir(previous));
		promptIn(h, "work/project", "in the current directory", 1);
		h.writeSession({ cwd: ".", prompts: [{ text: "recorded as .", timestamp: minutesAfterT0(2) }] });
		writeFileSync(
			join(h.sessionDir, "2026-11-01T09-03-00-000Z_no-cwd.jsonl"),
			[
				{ type: "session", version: 3, id: "no-cwd", timestamp: new Date(minutesAfterT0(3)).toISOString() },
				{
					type: "message",
					id: "m1",
					parentId: null,
					timestamp: new Date(minutesAfterT0(3)).toISOString(),
					message: { role: "user", content: "recorded without a directory", timestamp: minutesAfterT0(3) },
				},
			]
				.map((entry) => `${JSON.stringify(entry)}\n`)
				.join(""),
		);
		await h.start();

		await open(h);
		assert.deepEqual(h.modalList(), ["› in the current directory"]);

		h.press(Keys.ctrlR);
		await h.loaded();
		assert.deepEqual(h.modalList(), ["  in the current directory", "  recorded as .", "› recorded without a directory"]);
	});

	test("outside a git repository covers exactly the current directory", async (t) => {
		const h = useHarness(t, { cwd: "scratch/project" });
		// An empty .git directory is not a repository, for git as for Pi.
		mkdirSync(h.path("scratch/.git"), { recursive: true });
		promptIn(h, "scratch/project", "in the current directory", 1);
		promptIn(h, "scratch/project/sub", "in a subdirectory", 2);
		promptIn(h, "scratch", "in the parent directory", 3);
		await h.start();

		await open(h);

		assert.deepEqual(h.modalList(), ["› in the current directory"]);
	});
});

describe("switching scope", () => {
	/** Sessions in two repositories and a directory outside any; Pi runs in the first repository. */
	function twoRepositories(t: Parameters<typeof useHarness>[0], options: Parameters<typeof useHarness>[1] = {}): Harness {
		const h = useHarness(t, { cwd: "code/app", ...options });
		h.makeGitRepo("code/app");
		h.makeGitRepo("code/other");
		promptIn(h, "code/app", "app one", 1);
		promptIn(h, "code/other", "other repository", 2);
		promptIn(h, "notes", "outside any repository", 3);
		promptIn(h, "code/app/src", "app two", 4);
		return h;
	}

	test("the search key switches to global scope, which covers every session, and back", async (t) => {
		const h = twoRepositories(t);
		await h.start();
		await open(h);
		assert.deepEqual(h.modalList(), ["  app one", "› app two"]);

		h.press(Keys.ctrlR);
		await h.loaded();
		assert.match(h.modalTitle() ?? "", /^╭─ History · global ─+╮$/);
		assert.match(h.modalHint() ?? "", /^╰─ ctrl\+r switch to repo ─+╯$/);
		assert.deepEqual(h.modalList(), ["  app one", "  other repository", "  outside any repository", "› app two"]);

		h.press(Keys.ctrlR);
		await h.loaded();
		assert.match(h.modalTitle() ?? "", /^╭─ History · repo ─+╮$/);
		assert.deepEqual(h.modalList(), ["  app one", "› app two"]);
	});

	test("global scope covers every session in a custom session directory", async (t) => {
		const h = twoRepositories(t, { customSessionDir: "custom-sessions" });
		promptIn(h, "elsewhere", "recorded elsewhere", 5);
		// Pi's default layout is not read while a custom directory is in use.
		h.writeSession({
			cwd: h.path("code/app"),
			dir: defaultSessionDir(h.agentDir, h.path("code/app")),
			prompts: [{ text: "in the default layout", timestamp: minutesAfterT0(6) }],
		});
		await h.start();
		await open(h);
		assert.deepEqual(h.modalList(), ["  app one", "› app two"]);

		h.press(Keys.ctrlR);
		await h.loaded();

		assert.deepEqual(h.modalList(), [
			"  app one",
			"  other repository",
			"  outside any repository",
			"  app two",
			"› recorded elsewhere",
		]);
	});

	test("global scope covers every session directory of Pi's default layout in an ephemeral (--no-session) session", async (t) => {
		const h = twoRepositories(t, { noSession: true });
		await h.start();
		await open(h);
		assert.deepEqual(h.modalList(), ["  app one", "› app two"]);

		h.press(Keys.ctrlR);
		await h.loaded();

		assert.deepEqual(h.modalList(), ["  app one", "  other repository", "  outside any repository", "› app two"]);
	});

	test("keeps the query, matches the new scope's records and selects the best candidate", needsStub, async (t) => {
		const h = twoRepositories(t, {
			stubMatcher: {
				responses: [
					{ query: "p", input: "other repository", output: ["other repository", "app one", "outside any repository"] },
				],
			},
		});
		await h.start();
		h.type("p");
		h.press(Keys.ctrlR);
		await h.waitFor(() => h.modalList().join() === "  app one,› app two", "repo results for p");
		h.press(Keys.up);

		h.press(Keys.ctrlR);
		await h.waitFor(() => h.modalList().length === 3, "global results for p");

		assert.equal(h.modalQuery(), "> p");
		assert.deepEqual(h.modalList(), ["  outside any repository", "  app one", "› other repository"]);
		assert.deepEqual(
			h.matcherCalls().map((call) => call.input),
			[
				["app two", "app one"],
				["app two", "outside any repository", "other repository", "app one"],
			],
		);
	});

	test("an empty query lists the new scope newest first without starting the matcher", async (t) => {
		const h = twoRepositories(t);
		await h.start();
		await open(h);
		h.press(Keys.up);

		h.press(Keys.ctrlR);
		await h.loaded();
		await settle();

		assert.deepEqual(h.modalList(), ["  app one", "  other repository", "  outside any repository", "› app two"]);
		assert.deepEqual(h.matcherCalls(), []);
	});

	test("a slow search in the previous scope is never shown after switching, and its matcher is killed", needsStub, async (t) => {
		const h = twoRepositories(t, {
			stubMatcher: {
				responses: [
					{ input: "other repository", output: ["other repository"] },
					{ output: ["app one"], delayMs: 500 },
				],
			},
		});
		await h.start();
		h.type("o");
		h.press(Keys.ctrlR);
		await h.waitFor(() => h.matcherCalls().length === 1, "the repo search to start");

		h.press(Keys.ctrlR);
		await h.waitFor(() => h.modalList().join() === "› other repository", "global results");
		await new Promise((resolve) => setTimeout(resolve, 700)); // past the slow run's delay

		assert.deepEqual(h.modalList(), ["› other repository"]);
		assert.deepEqual(
			h.matcherCalls().map((call) => call.finished),
			[false, true],
		);
	});

	test("records still loading for the previous scope are never shown after switching back", async (t) => {
		const h = twoRepositories(t);
		// A large prompt in another repository makes the global scope much slower to load than the repo scope.
		promptIn(h, "code/other", `large ${"x".repeat(8 * 1024 * 1024)}`, 0);
		await h.start();
		await open(h);

		h.press(Keys.ctrlR, Keys.ctrlR); // to global and straight back, in one input batch
		await h.loaded();
		await new Promise((resolve) => setTimeout(resolve, 1000)); // long past the global load

		assert.match(h.modalTitle() ?? "", /History · repo/);
		assert.deepEqual(h.modalList(), ["  app one", "› app two"]);
	});

	test("every open starts in repo scope", async (t) => {
		const h = twoRepositories(t);
		await h.start();
		await open(h);
		h.press(Keys.ctrlR);
		await h.loaded();
		assert.match(h.modalTitle() ?? "", /History · global/);
		h.press(Keys.escape);
		await h.flush();

		await open(h);

		assert.match(h.modalTitle() ?? "", /History · repo/);
		assert.deepEqual(h.modalList(), ["  app one", "› app two"]);
	});

	test("dismissing after switches and query edits leaves the draft and cursor exactly as they were", async (t) => {
		const h = twoRepositories(t);
		await h.start();
		h.type("first line");
		h.press("\n");
		h.type("second line");
		h.press(Keys.up, Keys.left, Keys.left);
		const before = { text: h.editorText(), cursor: h.editorCursor() };

		h.press(Keys.ctrlR);
		await h.loaded();
		h.press(Keys.clearLine, Keys.ctrlR);
		await h.loaded();
		h.type("app");
		h.press(Keys.ctrlR, Keys.ctrlR);
		await h.loaded();
		h.press(Keys.escape);
		await h.flush();

		assert.deepEqual(h.overlayLines(), []);
		assert.deepEqual({ text: h.editorText(), cursor: h.editorCursor() }, before);
		assert.deepEqual(h.submissions, []);
	});

	test("the configured search key switches scope and is the one the hint names", async (t) => {
		const h = twoRepositories(t);
		h.writeConfig({ searchKey: "ctrl+t" });
		await h.start();
		h.press(Keys.ctrlT);
		await h.loaded();
		assert.match(h.modalHint() ?? "", /^╰─ ctrl\+t switch to global ─+╯$/);

		h.press(Keys.ctrlR); // not the search key: switches nothing, and is not text for the query
		await settle();
		assert.match(h.modalTitle() ?? "", /History · repo/);
		assert.equal(h.modalQuery(), ">");

		h.press(Keys.ctrlT);
		await h.loaded();
		assert.match(h.modalTitle() ?? "", /History · global/);
		assert.match(h.modalHint() ?? "", /^╰─ ctrl\+t switch to repo ─+╯$/);
	});
});

describe("the scope indicator", () => {
	test("the modal opens in repo scope, and the hint names global as the scope the search key switches to", async (t) => {
		const h = useHarness(t);
		await h.start();

		h.press(Keys.ctrlR);
		await h.loaded();

		assert.match(h.modalTitle() ?? "", /^╭─ History · repo ─+╮$/);
		assert.match(h.modalHint() ?? "", /^╰─ ctrl\+r switch to global ─+╯$/);
	});

	test("the frame and title share one colour per scope, different between the scopes", async (t) => {
		const h = useHarness(t);
		promptIn(h, "work/project", "a prompt", 1);
		await h.start();
		await open(h);
		const repo = h.modalColours();

		h.press(Keys.ctrlR);
		await h.loaded();
		const global = h.modalColours();

		assert.equal(repo.frame.length, 1);
		assert.equal(global.frame.length, 1);
		assert.equal(repo.title, repo.frame[0]);
		assert.equal(global.title, global.frame[0]);
		assert.notEqual(repo.frame[0], global.frame[0]);
	});

	test("title and hint fit a narrow modal", async (t) => {
		const h = useHarness(t);
		await h.start();
		await open(h);

		h.press(Keys.ctrlR);
		await h.loaded();

		assert.deepEqual(
			[h.modalTitle(16), h.modalHint(16)],
			["╭─ History · g…╮", "╰─ ctrl+r swit…╯"],
		);
	});
});
