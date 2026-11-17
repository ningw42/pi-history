import assert from "node:assert/strict";
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import {
	defaultSessionDir,
	type Harness,
	Keys,
	minutesAfterT0,
	needsStub,
	settle,
	useHarness,
	windowsSkip,
} from "./harness.ts";

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
		// Registered first, so it runs before the harness is removed: Windows cannot remove the current directory.
		const previous = process.cwd();
		t.after(() => process.chdir(previous));
		const h = useHarness(t);
		process.chdir(h.cwd); // where a relative directory would resolve to the current one
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

	test("recognises a repository made by git init, from a subdirectory", async (t) => {
		const h = useHarness(t, { cwd: "code/app/src" });
		h.gitInit("code/app");
		promptIn(h, "code/app", "at the repository root", 1);
		promptIn(h, "code/app/src", "in the current directory", 2);
		promptIn(h, "code", "above the repository", 3);
		await h.start();

		await open(h);

		assert.deepEqual(h.modalList(), ["  at the repository root", "› in the current directory"]);
	});

	test(
		"recognises a repository whose HEAD is a symbolic link to an unborn branch",
		windowsSkip("symbolic links need extra privileges on Windows"),
		async (t) => {
			const h = useHarness(t, { cwd: "code/app/src" });
			const app = h.gitInit("code/app");
			rmSync(join(app, ".git", "HEAD"));
			symlinkSync("refs/heads/unborn", join(app, ".git", "HEAD"));
			promptIn(h, "code/app", "at the repository root", 1);
			promptIn(h, "code/app/src", "in the current directory", 2);
			await h.start();

			await open(h);

			assert.deepEqual(h.modalList(), ["  at the repository root", "› in the current directory"]);
		},
	);

	test("outside a git repository covers exactly the current directory", async (t) => {
		const h = useHarness(t, { cwd: "scratch/project" });
		// Neither an empty .git directory nor one holding only HEAD is a repository, for git as for the extension.
		mkdirSync(h.path("scratch/project/.git"), { recursive: true });
		mkdirSync(h.path("scratch/.git"), { recursive: true });
		writeFileSync(h.path("scratch/.git/HEAD"), "ref: refs/heads/main\n");
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
		assert.match(h.modalTitle() ?? "", /^╭── History · global ─+╮$/);
		assert.match(h.modalHints().join("  "), /^ctrl\+r switch to repo {2}/);
		assert.deepEqual(h.modalList(), ["  app one", "  other repository", "  outside any repository", "› app two"]);

		h.press(Keys.ctrlR);
		await h.loaded();
		assert.match(h.modalTitle() ?? "", /^╭── History · repo ─+╮$/);
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
		// Were the switched-away global load not cancelled, this large prompt would make it finish after
		// the repo load and replace its records: with it, removing the cancellation fails this test on
		// every run; without it, the two loads race and the test usually passes anyway. With the
		// cancellation in place, the large file is never read.
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
		assert.match(h.modalHints().join("  "), /^ctrl\+t switch to global {2}/);

		h.press(Keys.ctrlR); // not the search key: switches nothing, and is not text for the query
		await settle();
		assert.match(h.modalTitle() ?? "", /History · repo/);
		assert.equal(h.modalQuery(), ">");

		h.press(Keys.ctrlT);
		await h.loaded();
		assert.match(h.modalTitle() ?? "", /History · global/);
		assert.match(h.modalHints().join("  "), /^ctrl\+t switch to repo {2}/);
		assert.deepEqual(h.notifications, []);
	});

	test("a search key configured onto a list key keeps the list action, and the modal and a warning say so", async (t) => {
		const h = twoRepositories(t);
		h.writeConfig({ searchKey: "Up" }); // any case: Pi's default for tui.select.up is "up"
		await h.start();
		h.press(Keys.up);
		await h.loaded();
		assert.match(h.modalHints().join("  "), /^Up move selection up \(scope switch unavailable\) {2}/);

		h.press(Keys.up);
		await settle();
		assert.match(h.modalTitle() ?? "", /History · repo/);
		assert.deepEqual(h.modalList(), ["› app one", "  app two"]);
		h.press(Keys.escape);
		await h.flush();
		assert.deepEqual(h.overlayLines(), []);

		h.press(Keys.up); // the same conflict on a later open is not reported again
		await h.loaded();
		assert.equal(h.notifications.length, 1);
		assert.equal(h.notifications[0]?.type, "warning");
		assert.match(h.notifications[0]?.message ?? "", /search key "Up" also acts as tui\.select\.up \(Move selection up\)/);
	});

	test("a search key the terminal sends as Enter (Ctrl+M without the Kitty protocol) keeps confirming", async (t) => {
		const h = twoRepositories(t);
		h.writeConfig({ searchKey: "ctrl+m" });
		await h.start();
		h.type("draft");
		h.press(Keys.ctrlMLegacy); // what a terminal without the Kitty protocol sends for Ctrl+M: a carriage return
		await h.loaded();
		h.press(Keys.clearLine);
		assert.match(h.modalHints().join("  "), /^ctrl\+m confirm selection \(scope switch unavailable\) {2}/);
		assert.equal(h.notifications.length, 1);
		assert.match(h.notifications[0]?.message ?? "", /search key "ctrl\+m" also acts as tui\.select\.confirm \(Confirm selection\)/);

		h.press(Keys.ctrlMLegacy);
		await h.flush();

		assert.deepEqual(h.overlayLines(), []);
		assert.equal(h.editorText(), "app two");
		assert.deepEqual(h.submissions, []);
	});

	test("a search key the terminal sends as Escape (Ctrl+[ without the Kitty protocol) keeps dismissing", async (t) => {
		const h = twoRepositories(t);
		h.writeConfig({ searchKey: "ctrl+[" });
		await h.start();
		h.type("draft");
		h.press(Keys.escape); // what a terminal without the Kitty protocol sends for Ctrl+[
		await h.loaded();
		assert.match(h.modalHints().join("  "), /^ctrl\+\[ cancel selection \(scope switch unavailable\) {2}/);
		assert.equal(h.notifications.length, 1);
		assert.match(h.notifications[0]?.message ?? "", /search key "ctrl\+\[" also acts as tui\.select\.cancel \(Cancel selection\)/);

		h.press(Keys.escape);
		await h.flush();

		assert.deepEqual(h.overlayLines(), []);
		assert.equal(h.editorText(), "draft");
	});

	test("with the Kitty protocol, Ctrl+M is its own key: it switches scope, and Enter still confirms", async (t) => {
		const h = twoRepositories(t);
		h.writeConfig({ searchKey: "ctrl+m" });
		await h.start();
		h.press(Keys.ctrlMKitty);
		await h.loaded();
		assert.match(h.modalHints().join("  "), /^ctrl\+m switch to global {2}/);

		h.press(Keys.ctrlMKitty);
		await h.loaded();
		assert.match(h.modalTitle() ?? "", /History · global/);
		h.press(Keys.enter);
		await h.flush();

		assert.deepEqual(h.overlayLines(), []);
		assert.equal(h.editorText(), "app two");
		assert.deepEqual(h.notifications, []);
	});

	test("a Pi keybinding that gives the search key to a list action is honoured, and the modal and a warning say so", async (t) => {
		const h = twoRepositories(t, { keybindings: { "tui.select.up": "ctrl+r" } });
		await h.start();
		await open(h);
		assert.match(h.modalHints().join("  "), /^ctrl\+r move selection up \(scope switch unavailable\) {2}/);

		h.press(Keys.ctrlR);
		await settle();
		assert.match(h.modalTitle() ?? "", /History · repo/);
		assert.deepEqual(h.modalList(), ["› app one", "  app two"]);
		h.press(Keys.escape);
		await h.flush();

		assert.deepEqual(h.overlayLines(), []);
		assert.equal(h.notifications.length, 1);
		assert.match(h.notifications[0]?.message ?? "", /search key "ctrl\+r" also acts as tui\.select\.up \(Move selection up\)/);
	});
});

describe("a configured session directory", () => {
	const settingPath = "../../agent/sessions/custom"; // from the harness's working directory, work/project
	for (const [how, noSession, viaSetting] of [
		["PI_CODING_AGENT_SESSION_DIR in a persisted session", false, false],
		["the sessionDir setting in a persisted session", false, true],
		["PI_CODING_AGENT_SESSION_DIR in an ephemeral session", true, false],
		["the sessionDir setting in an ephemeral session", true, true],
	] as const) {
		test(`is the only storage read, even inside Pi's default session root (${how})`, async (t) => {
			const h = useHarness(t, {
				customSessionDir: "agent/sessions/custom",
				noSession,
				settings: viaSetting ? { sessionDir: settingPath } : {},
			});
			if (!viaSetting) h.setEnv("PI_CODING_AGENT_SESSION_DIR", h.sessionDir);
			promptIn(h, "work/project", "configured history", 1);
			h.writeSession({
				cwd: h.cwd,
				dir: defaultSessionDir(h.agentDir, h.cwd),
				prompts: [{ text: "default layout history", timestamp: minutesAfterT0(2) }],
			});
			await h.start();

			await open(h);
			assert.deepEqual(h.modalList(), ["› configured history"]);
			h.press(Keys.ctrlR);
			await h.loaded();
			assert.deepEqual(h.modalList(), ["› configured history"]);
		});
	}

	test("gives way to the directory a persisted session reports, as with a --session-dir flag", async (t) => {
		const h = useHarness(t, { customSessionDir: "flag-sessions" });
		h.setEnv("PI_CODING_AGENT_SESSION_DIR", h.path("agent/sessions/configured"));
		promptIn(h, "work/project", "from the reported directory", 1);
		h.writeSession({
			cwd: h.cwd,
			dir: h.path("agent/sessions/configured"),
			prompts: [{ text: "from the configured directory", timestamp: minutesAfterT0(2) }],
		});
		await h.start();

		await open(h);
		assert.deepEqual(h.modalList(), ["› from the reported directory"]);
		h.press(Keys.ctrlR);
		await h.loaded();
		assert.deepEqual(h.modalList(), ["› from the reported directory"]);
	});
});

describe("the scope indicator", () => {
	test("the modal opens in repo scope, and the hint names global as the scope the search key switches to", async (t) => {
		const h = useHarness(t);
		await h.start();

		h.press(Keys.ctrlR);
		await h.loaded();

		assert.match(h.modalTitle() ?? "", /^╭── History · repo ─+╮$/);
		assert.match(h.modalHints().join("  "), /^ctrl\+r switch to global {2}/);
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

	test("a narrow modal truncates the title and wraps the key hints whole", async (t) => {
		const h = useHarness(t);
		await h.start();
		await open(h);

		h.press(Keys.ctrlR);
		await h.loaded();

		assert.equal(h.modalTitle(16), "╭── History… ──╮");
		assert.equal(h.modalHints(16).join(" "), "ctrl+r switch to repo ↑↓ navigate enter confirm escape cancel");
	});
});
