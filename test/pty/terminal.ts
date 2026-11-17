import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { accessSync, constants, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { delimiter, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { TestContext } from "node:test";
import { fileURLToPath } from "node:url";

const repo = fileURLToPath(new URL("../../", import.meta.url));
const cli = join(repo, "node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js");
const supportedVersion = "1.5.2";

function executable(name: string): string {
	for (const directory of (process.env.PATH ?? "").split(delimiter)) {
		const path = resolve(directory, name);
		try {
			accessSync(path, constants.X_OK);
			return realpathSync(path);
		} catch { /* Try the next PATH entry. */ }
	}
	throw new Error(`PTY smoke suite requires ${name} on PATH (missing or not executable).`);
}

/** An isolated tmux server is both the controlling PTY and the terminal emulator. */
export async function launchPi(t: TestContext, options: { matcher: "fzf" | "sk"; customEditor?: boolean; skill?: boolean }) {
	assert.ok(process.platform === "linux" || process.platform === "darwin", "PTY smoke suite requires Linux or macOS.");
	const tmux = executable("tmux");
	const matchers = { fzf: executable("fzf"), sk: executable("sk") };
	// Unix socket paths are short on macOS; its default TMPDIR can already fill that limit.
	const root = realpathSync(mkdtempSync("/tmp/pih-pty-"));
	let closeTerminal: (() => Promise<void>) | undefined;
	t.after(async () => {
		try { await closeTerminal?.(); }
		finally { rmSync(root, { recursive: true, force: true }); }
	});
	const home = join(root, "home");
	const agent = join(home, ".pi/agent");
	const cwd = join(root, "repo");
	const sessions = join(root, "sessions");
	const submissions = join(root, "submissions.jsonl");
	for (const path of [agent, cwd, sessions, join(root, "tmp")]) mkdirSync(path, { recursive: true });
	writeFileSync(submissions, "");
	writeFileSync(join(agent, "auth.json"), "{}");
	writeFileSync(join(agent, "settings.json"), JSON.stringify({ quietStartup: true, lastChangelogVersion: supportedVersion }));
	writeFileSync(join(agent, "pi-history.json"), JSON.stringify({ matcher: options.matcher, matcherCommand: matchers[options.matcher] }));
	writeFileSync(join(sessions, "history.jsonl"), [
		{ type: "session", version: 3, id: "fixture", timestamp: "2026-01-01T00:00:00Z", cwd },
		...["older prompt", "newest prompt"].map((text, i) => ({
			type: "message", id: `m${i}`, parentId: i ? "m0" : null, timestamp: `2026-01-01T00:0${i}:00Z`,
			message: { role: "user", content: text, timestamp: Date.UTC(2026, 0, 1, 0, i) },
		})),
	].map((entry) => JSON.stringify(entry)).join("\n") + "\n");
	writeFileSync(join(sessions, "elsewhere.jsonl"), [
		{ type: "session", version: 3, id: "elsewhere", timestamp: "2026-01-01T00:02:00Z", cwd: join(root, "elsewhere") },
		{ type: "message", id: "e0", parentId: null, timestamp: "2026-01-01T00:02:00Z", message: { role: "user", content: "newest elsewhere", timestamp: Date.UTC(2026, 0, 1, 0, 2) } },
	].map((entry) => JSON.stringify(entry)).join("\n") + "\n");

	// Deliberate allowlist: no credentials, NODE_OPTIONS, Pi settings, shell hooks, or tmux session inherited.
	const env = {
		HOME: home, PI_CODING_AGENT_DIR: agent, PI_CODING_AGENT_SESSION_DIR: sessions,
		XDG_CONFIG_HOME: join(home, ".config"), XDG_CACHE_HOME: join(home, ".cache"), XDG_DATA_HOME: join(home, ".local/share"),
		TMPDIR: join(root, "tmp"), PATH: process.env.PATH!, SHELL: "/bin/sh", TERM: "xterm-256color", LANG: "en_US.UTF-8",
		PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0", PI_HARDWARE_CURSOR: "1",
		PTY_SUBMISSIONS: submissions,
	};
	const nodeArgs = [
		"--permission", "--allow-fs-read=*", `--allow-fs-write=${root}`,
		"--allow-child-process", "--allow-worker", "--allow-addons",
	]; // No --allow-net: even an accidental request is denied before connecting.
	const run = (command: string, args: string[]) => execFileSync(command, args, { env, cwd, encoding: "utf8", timeout: 10_000, stdio: ["ignore", "pipe", "pipe"] });
	const tmuxArgs = ["-u", "-S", join(root, "tmux.sock"), "-f", "/dev/null"];
	const terminal = (...args: string[]) => run(tmux, [...tmuxArgs, ...args]);
	const assertNoSubmissions = () => assert.equal(readFileSync(submissions, "utf8"), "", "recall must never submit a prompt");
	for (const [name, path] of Object.entries(matchers)) t.diagnostic(`${name}: ${run(path, ["--version"]).trim()}`);
	t.diagnostic(run(tmux, ["-V"]).trim());
	let version: string;
	try { version = run(process.execPath, [...nodeArgs, cli, "--version"]).trim(); }
	catch (error) { throw new Error("Pi CLI is missing or cannot run. Run npm ci --ignore-scripts.", { cause: error }); }
	assert.equal(version, supportedVersion, `PTY smoke suite supports Pi ${supportedVersion}, got ${version}`);
	if (options.skill) run(process.execPath, [...nodeArgs, join(repo, "test/pty/store-skill.ts")]);

	// Keep a crashed CLI's final screen available for diagnostics. A private config and socket
	// ensure this cannot load user tmux hooks or affect an existing server.
	const tmuxConfig = join(root, "tmux.conf");
	writeFileSync(tmuxConfig, "set -g remain-on-exit on\nset -g status off\n");
	tmuxArgs[tmuxArgs.length - 1] = tmuxConfig;
	closeTerminal = async () => {
		await delay(100); // also catch an accidental submission queued by the final key
		try {
			// kill-server returns before Pi finishes shutdown writes. Keep the PTY alive until
			// its child exits, then remove the server and only then the fixture directory.
			const pid = Number(terminal("display-message", "-p", "-t", "smoke:0.0", "#{pane_pid}").trim());
			const alive = () => terminal("display-message", "-p", "-t", "smoke:0.0", "#{pane_dead}").trim() === "0";
			for (const signal of ["SIGTERM", "SIGKILL"] as const) {
				if (!alive()) break;
				try { process.kill(pid, signal); } catch (error) {
					if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
				}
				const deadline = Date.now() + 5_000;
				while (alive() && Date.now() < deadline) await delay(30);
			}
			assert.ok(!alive(), "Pi did not exit during PTY cleanup");
			assertNoSubmissions();
		} finally { terminal("kill-server"); }
	};
	terminal("new-session", "-d", "-s", "smoke", "-x", "120", "-y", "40", "-c", cwd,
		process.execPath, ...nodeArgs, cli, "--offline", "--no-session", "--no-extensions", "--no-skills",
		"--no-prompt-templates", "--no-themes", "--no-context-files", "--no-mcp", "--no-tools", "--no-approve",
		"--model", "pty/smoke-alpha",
		"-e", join(repo, "test/pty/guard.ts"),
		...(options.customEditor ? ["-e", join(repo, "test/pty/marker-editor.ts")] : []),
		"-e", join(repo, "src/index.ts"),
		...(options.skill ? ["--skill", join(agent, "skills/pty-fixture/SKILL.md")] : []));
	const screen = () => terminal("capture-pane", "-p", "-t", "smoke:0.0");
	async function waitFor(predicate: (screen: string) => boolean): Promise<string> {
		const deadline = Date.now() + 15_000;
		let current = "";
		do {
			current = screen();
			const dead = terminal("display-message", "-p", "-t", "smoke:0.0", "#{pane_dead}").trim();
			assert.equal(dead, "0", `Pi exited unexpectedly:\n${current}`);
			if (predicate(current)) return current;
			await delay(30);
		} while (Date.now() < deadline);
		throw new Error(`Timed out waiting for terminal screen:\n${current}`);
	}
	await waitFor((value) => value.includes("PTY ready"));
	return {
		screen, waitFor, assertNoSubmissions,
		async stays(predicate: (screen: string) => boolean): Promise<void> {
			const deadline = Date.now() + 500;
			do {
				assert.ok(predicate(screen()), `Screen did not stay as expected:\n${screen()}`);
				await delay(30);
			} while (Date.now() < deadline);
		},
		cursor: () => terminal("display-message", "-p", "-t", "smoke:0.0", "#{cursor_x},#{cursor_y}").trim(),
		key: (...keys: string[]) => { terminal("send-keys", "-t", "smoke:0.0", ...keys); },
		text: (text: string) => { terminal("send-keys", "-t", "smoke:0.0", "-l", "--", text); },
	};
}
