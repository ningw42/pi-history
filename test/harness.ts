/**
 * Extension-boundary test harness.
 *
 * Loads the real extension entry point against a fake Pi API and UI context, with Pi's real
 * editor component. History comes from synthetic session files in a temporary agent directory;
 * no real prompt history is ever read. The extension's configuration file is read from that
 * agent directory too (`writeConfig()`), so the user's real configuration never applies. The fake mirrors Pi's overlay lifecycle: the overlay is
 * mounted and focused asynchronously, and closing it gives focus back to the editor before the
 * result promise settles. Git repositories are synthetic too (`makeGitRepo()`, `makeGitWorktree()`,
 * `makeGitSubmodule()`), laid out as git leaves them, or made by the real `git init` (`gitInit()`);
 * the harness refuses to run in a temporary directory inside a git repository, where every test
 * directory would share one repo scope.
 *
 * Tests drive keys and assert on what a user sees: the input bar's text and cursor, and the
 * rendered overlay lines (`overlayLines()`, `modalTitle()`, `modalList()`, `modalQuery()`,
 * `modalHint()`; empty or undefined when no overlay is shown), the colours of the modal's frame and
 * title (`modalColours()`), and whether the modal places the terminal cursor (`modalShowsCursor()`). Like Pi,
 * the harness tells a focusable overlay when it gains or loses focus (`setOverlayFocus()` moves Pi's
 * focus away and back). The one allowed exception is a narrow set of checks at the extension's external
 * boundaries, for behaviour that has no visible output: prompts handed to Pi for submission
 * (`submissions`), what the extension registered or installed (`registrations`,
 * `editorFactoryInstalls`, `overlayRequests`, `notifications`), the session files on disk, and what
 * the matcher process was given and whether it was killed (`matcherCalls()`). Never assert on the
 * extension's private state.
 *
 * A scripted stub is always on PATH as `fzf` and `sk`, so on Linux and macOS no harness test
 * reaches a real matcher. Its responses are chosen by query and, optionally, by a record its input
 * must hold, so a run over one scope's records can be told from a run over the other's. On Windows the extension cannot start the stub's `.cmd` launcher: tests
 * that need the stub's answers are skipped there, and a test that opens the modal with a draft may
 * start whatever fzf is on PATH, without depending on its outcome.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, delimiter, dirname, join, relative as relativePath, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
	type ExtensionAPI,
	type ExtensionContext,
	getSelectListTheme,
	initTheme,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import {
	CURSOR_MARKER,
	type Component,
	type EditorComponent,
	type EditorTheme,
	type Focusable,
	type KeybindingsConfig,
	KeybindingsManager,
	setKeybindings,
	TUI_KEYBINDINGS,
} from "@earendil-works/pi-tui";
import piHistory from "../src/index.ts";

type ExtensionMode = ExtensionContext["mode"];

// Raw terminal sequences for the keys tests press.
export const Keys = {
	up: "\x1b[A",
	down: "\x1b[B",
	left: "\x1b[D",
	right: "\x1b[C",
	enter: "\r",
	escape: "\x1b",
	ctrlR: "\x12",
	ctrlT: "\x14",
	/** Ctrl+M as a terminal without the Kitty keyboard protocol sends it: the same carriage return as Enter. */
	ctrlMLegacy: "\r",
	/** Ctrl+M under the Kitty keyboard protocol: a key of its own. */
	ctrlMKitty: "\x1b[109;5u",
	/** Ctrl+U, Pi's delete-to-line-start: clears a line whose cursor is at its end. */
	clearLine: "\x15",
} as const;

/** Wait long enough for a debounced matcher run to have started, were one going to. */
export const settle = () => new Promise((resolve) => setTimeout(resolve, 300));

const T0 = Date.UTC(2026, 10, 1, 9, 0, 0);
/** A timestamp for synthetic prompts: `n` minutes after a fixed point in time. */
export const minutesAfterT0 = (n: number) => T0 + n * 60_000;

const STUB_MATCHER = fileURLToPath(new URL("./fixtures/stub-matcher.mjs", import.meta.url));
/** Directory below the harness root holding the stub as `fzf` and `sk`; its name has a space on purpose. */
const STUB_MATCHER_BIN = "matcher bin";

export interface PromptSpec {
	text: string;
	/** Unix ms. */
	timestamp: number;
}

export interface SessionSpec {
	/** Working directory recorded in the session header. */
	cwd: string;
	prompts: PromptSpec[];
	/** Store under this directory instead of Pi's default per-cwd directory. */
	dir?: string;
}

export interface StubMatcherResponse {
	query?: string;
	/** Use this response only when the stub is given this record. */
	input?: string;
	output?: string[];
	exitCode?: number;
	delayMs?: number;
	/** Written to the stub's standard error before it exits. */
	stderr?: string;
	/** After its delay the stub ends by this signal instead of an exit status, writing nothing. */
	signal?: NodeJS.Signals;
}

export interface HarnessOptions {
	mode?: ExtensionMode;
	/** Current working directory, relative to the harness root (created on disk). Default "work/project". */
	cwd?: string;
	/** Use a custom session directory, relative to the harness root, instead of Pi's default layout. */
	customSessionDir?: string;
	/** Run as an ephemeral (`--no-session`) session: the session manager reports no directory. */
	noSession?: boolean;
	/** Effective Pi settings returned by `pi.getSettings()`. */
	settings?: Record<string, unknown>;
	/** User keybinding overrides, as in Pi's keybindings.json. */
	keybindings?: KeybindingsConfig;
	terminalRows?: number;
	/** Scripted responses for the stub that is always put on PATH as both `fzf` and `sk`. */
	stubMatcher?: { responses?: StubMatcherResponse[] };
}

export interface StubMatcherCall {
	argv: string[];
	env: Record<string, string>;
	input: string[];
	/** The stub outlived its scripted delay: it was not killed first. */
	finished: boolean;
}

interface OverlayRequest {
	component: Component & { dispose?(): void };
	options: unknown;
}

export class Harness {
	readonly root: string;
	readonly agentDir: string;
	readonly cwd: string;
	readonly sessionDir: string;
	readonly notifications: { message: string; type?: string }[] = [];
	readonly overlayRequests: OverlayRequest[] = [];
	/** Every ExtensionAPI method the extension called, other than `on`. */
	readonly registrations: string[] = [];
	readonly submissions: string[] = [];
	editorFactoryInstalls = 0;

	private readonly options: HarnessOptions;
	private readonly handlers = new Map<string, ((event: unknown, ctx: ExtensionContext) => unknown)[]>();
	private readonly keybindings: KeybindingsManager;
	private readonly theme: Theme;
	private readonly tui: { requestRender(): void; terminal: { rows: number; columns: number } };
	private editorFactory: ((...args: never[]) => EditorComponent) | undefined;
	private editorComponent: EditorComponent | undefined;
	private overlay: OverlayRequest | undefined;
	private readonly matcherLog: string;
	private readonly savedEnv = new Map<string, string | undefined>();
	private sessionCounter = 0;

	constructor(options: HarnessOptions = {}) {
		this.options = options;
		this.root = mkdtempSync(join(tmpdir(), "pi-history-test-"));
		assertOutsideGitRepository(this.root);
		this.agentDir = join(this.root, "agent");
		this.cwd = join(this.root, options.cwd ?? "work/project");
		mkdirSync(this.cwd, { recursive: true });
		this.sessionDir = options.customSessionDir
			? join(this.root, options.customSessionDir)
			: defaultSessionDir(this.agentDir, this.cwd);
		this.matcherLog = join(this.root, "matcher-log.jsonl");
		this.setEnv("PI_CODING_AGENT_DIR", this.agentDir);
		// Pi's session-directory override must not leak in from the host: it would point the
		// extension at real history. Tests that need it set it explicitly with setEnv().
		this.setEnv("PI_CODING_AGENT_SESSION_DIR", undefined);
		this.installStubMatcher(options.stubMatcher ?? {});

		initTheme("dark", false);
		this.keybindings = new KeybindingsManager(TUI_KEYBINDINGS, options.keybindings ?? {});
		setKeybindings(this.keybindings);
		this.theme = fakeTheme();
		this.tui = { requestRender() {}, terminal: { rows: options.terminalRows ?? 40, columns: 100 } };
	}

	/** Absolute path for a directory below the harness root. */
	path(relative: string): string {
		return join(this.root, relative);
	}

	/** Write a synthetic session file. Stored in Pi's default per-cwd directory unless `dir` is given. */
	writeSession(spec: SessionSpec): string {
		const dir = spec.dir ?? (this.options.customSessionDir ? this.sessionDir : defaultSessionDir(this.agentDir, spec.cwd));
		mkdirSync(dir, { recursive: true });
		const n = ++this.sessionCounter;
		const id = `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
		const first = spec.prompts[0]?.timestamp ?? 0;
		const lines: string[] = [
			JSON.stringify({ type: "session", version: 3, id, timestamp: new Date(first).toISOString(), cwd: spec.cwd }),
		];
		let parentId: string | null = null;
		spec.prompts.forEach((prompt, i) => {
			const userId = `u${n}x${i}`;
			lines.push(
				JSON.stringify({
					type: "message",
					id: userId,
					parentId,
					timestamp: new Date(prompt.timestamp).toISOString(),
					message: { role: "user", content: prompt.text, timestamp: prompt.timestamp },
				}),
			);
			const assistantId = `a${n}x${i}`;
			lines.push(
				JSON.stringify({
					type: "message",
					id: assistantId,
					parentId: userId,
					timestamp: new Date(prompt.timestamp + 1).toISOString(),
					message: {
						role: "assistant",
						content: [{ type: "text", text: "ok" }],
						stopReason: "stop",
						timestamp: prompt.timestamp + 1,
					},
				}),
			);
			parentId = assistantId;
		});
		const file = join(dir, `${new Date(first).toISOString().replace(/[:.]/g, "-")}_${id}.jsonl`);
		writeFileSync(file, `${lines.join("\n")}\n`);
		return file;
	}

	/** The extension's configuration file, in the agent directory Pi reports. */
	get configPath(): string {
		return join(this.agentDir, "pi-history.json");
	}

	/** Write the configuration file: a string verbatim, anything else as JSON. */
	writeConfig(content: unknown): void {
		mkdirSync(this.agentDir, { recursive: true });
		writeFileSync(this.configPath, typeof content === "string" ? content : JSON.stringify(content));
	}

	/** Absolute path of the scripted stub installed as `name` (also reachable through PATH). */
	stubMatcherPath(name: "fzf" | "sk"): string {
		return join(this.path(STUB_MATCHER_BIN), process.platform === "win32" ? `${name}.cmd` : name);
	}

	/**
	 * Start a session the way Pi 1.5.2 does, at startup and again on `/new`, `/resume`, `/fork` and
	 * `/reload`: reset the extension UI (dropping the installed editor factory; the editor's text is
	 * carried over), load the extension afresh through its real entry point, then emit
	 * `session_start`. Pi also re-imports the module each time, which the harness cannot do, so the
	 * extension must not rely on module state surviving between loads.
	 */
	async start(reason: "startup" | "new" | "resume" | "fork" | "reload" = "startup"): Promise<void> {
		this.editorFactory = undefined;
		this.handlers.clear();
		piHistory(this.fakePi());
		for (const handler of this.handlers.get("session_start") ?? []) {
			await handler({ type: "session_start", reason }, this.fakeContext());
		}
	}

	/** The input bar's editor, as built from the installed factory. */
	get editor(): EditorComponent {
		if (!this.editorComponent) throw new Error("no editor factory was installed");
		return this.editorComponent;
	}

	/** Type text into whatever has focus. */
	type(text: string): void {
		for (const ch of text) this.press(ch);
	}

	/**
	 * Send raw key sequences, each to whatever has focus at that moment: the overlay once mounted,
	 * else the input bar. Keys passed in one call model one terminal input batch: no promise
	 * callbacks (such as the overlay mount) run between them.
	 */
	press(...keys: string[]): void {
		for (const key of keys) (this.overlay?.component ?? this.editor).handleInput?.(key);
	}

	editorText(): string {
		return this.editor.getText();
	}

	editorCursor(): { line: number; col: number } {
		const editor = this.editor as EditorComponent & { getCursor(): { line: number; col: number } };
		return editor.getCursor();
	}

	/** The overlay as rendered on screen, ANSI-stripped and right-trimmed; empty when none is shown. */
	overlayLines(width = 80): string[] {
		return this.overlay?.component.render(width).map((line) => stripAnsi(line).trimEnd()) ?? [];
	}

	/** Rendered rows of the modal's list area (above the query line), without frame characters. */
	modalList(width = 80): string[] {
		return this.modalSections(width).list;
	}

	/** The modal's query line as rendered, without frame characters; undefined when no modal is shown. */
	modalQuery(width = 80): string | undefined {
		return this.modalSections(width).query;
	}

	/** Whether the rendered modal places the terminal cursor (Pi's cursor marker), as on a focused text input. */
	modalShowsCursor(width = 80): boolean {
		return this.overlay?.component.render(width).some((line) => line.includes(CURSOR_MARKER)) ?? false;
	}

	/** The modal's top frame line (its title), ANSI-stripped; undefined when no modal is shown. */
	modalTitle(width = 80): string | undefined {
		return this.overlayLines(width)[0];
	}

	/** The modal's bottom frame line (its key hint), ANSI-stripped; undefined when no modal is shown. */
	modalHint(width = 80): string | undefined {
		return this.overlayLines(width).at(-1);
	}

	/**
	 * Foreground colours as rendered (SGR sequences, "" for the terminal default): every colour used
	 * on the modal's frame characters, and the colour of its title text.
	 */
	modalColours(width = 80): { frame: string[]; title: string | undefined } {
		const lines = (this.overlay?.component.render(width) ?? []).map(coloursOf);
		const frame = new Set(lines.flat().flatMap(({ char, fg }) => (FRAME_CHARACTERS.includes(char) ? [fg] : [])));
		const top = lines[0] ?? [];
		const title = top[top.map(({ char }) => char).join("").indexOf("History")];
		return { frame: [...frame], title: title?.fg };
	}

	/** Make `relative` (below the harness root) the top-level directory of a git repository. */
	makeGitRepo(relative: string): string {
		const dir = this.path(relative);
		makeGitDirectory(join(dir, ".git"), "ref: refs/heads/main\n");
		return dir;
	}

	/** Make `relative` a git repository with the real `git init`, ignoring any `GIT_*` variables inherited (as in a Git hook). */
	gitInit(relative: string): string {
		const dir = this.path(relative);
		const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("GIT_")));
		execFileSync("git", ["init", "--quiet", dir], { env, stdio: "ignore" });
		return dir;
	}

	/**
	 * Make `relative` a linked worktree of the repository at `repo`, laid out as `git worktree add`
	 * leaves it: its `.git` is a file pointing into the main repository's `.git` directory.
	 */
	makeGitWorktree(relative: string, repo: string): string {
		const dir = this.path(relative);
		const gitDir = join(repo, ".git", "worktrees", basename(dir));
		mkdirSync(gitDir, { recursive: true });
		writeFileSync(join(gitDir, "HEAD"), "ref: refs/heads/feature\n");
		writeFileSync(join(gitDir, "commondir"), "../..\n");
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, ".git"), `gitdir: ${gitDir}\n`);
		return dir;
	}

	/**
	 * Make `relative` a submodule checked out inside the repository at `repo`, laid out as
	 * `git submodule add` leaves it: its `.git` is a file naming, relative to itself, the module's
	 * git directory inside the enclosing repository's `.git`.
	 */
	makeGitSubmodule(relative: string, repo: string): string {
		const dir = this.path(relative);
		const gitDir = join(repo, ".git", "modules", basename(dir));
		makeGitDirectory(gitDir, "ref: refs/heads/main\n");
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, ".git"), `gitdir: ${relativePath(dir, gitDir).split(sep).join("/")}\n`);
		return dir;
	}

	/** Move Pi's focus off the shown overlay (as when another component takes it) or back onto it. */
	setOverlayFocus(focused: boolean): void {
		if (!this.overlay) throw new Error("no overlay is shown");
		setFocused(this.overlay.component, focused);
	}

	/** The overlay frame's rows, split at the rule above the query line. */
	private modalSections(width: number): { list: string[]; query: string | undefined } {
		const lines = this.overlayLines(width);
		if (lines.length === 0) return { list: [], query: undefined };
		const rule = lines.findIndex((line) => line.startsWith("├"));
		if (rule === -1) throw new Error(`no query line in the rendered modal:\n${lines.join("\n")}`);
		const inner = (line: string) => line.replace(/^│ ?/, "").replace(/ ?│$/, "").trimEnd();
		return { list: lines.slice(1, rule).map(inner), query: lines.slice(rule + 1, -1).map(inner).join("\n") };
	}

	/** Let pending promise callbacks run (a confirmed record is applied once the overlay resolves). */
	async flush(): Promise<void> {
		await new Promise((resolve) => setImmediate(resolve));
	}

	/** Wait until `predicate` holds, polling the event loop. */
	async waitFor(predicate: () => boolean, what = "condition", timeoutMs = 3000): Promise<void> {
		const deadline = Date.now() + timeoutMs;
		while (!predicate()) {
			if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
			await new Promise((resolve) => setTimeout(resolve, 5));
		}
	}

	/** Wait until an overlay is shown and has finished loading. */
	async loaded(): Promise<void> {
		await this.waitFor(() => {
			const lines = this.overlayLines();
			return lines.length > 0 && !lines.some((line) => line.includes("Loading"));
		}, "history to load");
	}

	/** Every stub matcher invocation so far, in start order. */
	matcherCalls(): StubMatcherCall[] {
		if (!existsSync(this.matcherLog)) return [];
		const calls = new Map<number, StubMatcherCall>();
		for (const line of readFileSync(this.matcherLog, "utf8").split("\n")) {
			if (!line) continue;
			const { pid, finished, ...started } = JSON.parse(line) as Omit<StubMatcherCall, "finished"> & {
				pid: number;
				finished?: true;
			};
			if (finished) {
				const call = calls.get(pid);
				if (call) call.finished = true;
			} else {
				calls.set(pid, { ...started, finished: false });
			}
		}
		return [...calls.values()];
	}

	dispose(): void {
		this.overlay?.component.dispose?.();
		for (const [key, value] of this.savedEnv) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		rmSync(this.root, { recursive: true, force: true });
	}

	/** Set (or, with undefined, unset) an environment variable for the test's duration. */
	setEnv(key: string, value: string | undefined): void {
		if (!this.savedEnv.has(key)) this.savedEnv.set(key, process.env[key]);
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}

	private installStubMatcher(stub: { responses?: StubMatcherResponse[] }): void {
		const bin = this.path(STUB_MATCHER_BIN);
		mkdirSync(bin, { recursive: true });
		for (const name of ["fzf", "sk"] as const) {
			if (process.platform === "win32") {
				// Windows cannot execute a shebang script and symlinks require extra privileges.
				writeFileSync(this.stubMatcherPath(name), `@echo off\r\n"${process.execPath}" "${STUB_MATCHER}" %*\r\n`);
			} else {
				symlinkSync(STUB_MATCHER, this.stubMatcherPath(name));
			}
		}
		const config = join(this.root, "matcher-config.json");
		writeFileSync(config, JSON.stringify({ responses: stub.responses ?? [] }));
		this.setEnv("PATH", `${bin}${delimiter}${process.env.PATH ?? ""}`);
		this.setEnv("STUB_MATCHER_CONFIG", config);
		this.setEnv("STUB_MATCHER_LOG", this.matcherLog);
	}

	private fakePi(): ExtensionAPI {
		const handlers = this.handlers;
		const registrations = this.registrations;
		const settings = this.options.settings ?? {};
		return new Proxy({} as ExtensionAPI, {
			get(_target, property) {
				if (property === "getSettings") return () => structuredClone(settings);
				if (property === "on") {
					return (event: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) => {
						handlers.set(event, [...(handlers.get(event) ?? []), handler]);
						return () => {};
					};
				}
				return (..._args: unknown[]) => {
					registrations.push(String(property));
				};
			},
		});
	}

	private fakeContext(): ExtensionContext {
		const mode = this.options.mode ?? "tui";
		const sessionDir = this.sessionDir;
		const noSession = this.options.noSession ?? false;
		const cwd = this.cwd;
		const ui = {
			notify: (message: string, type?: string) => this.notifications.push({ message, type }),
			getEditorComponent: () => this.editorFactory,
			setEditorComponent: (factory: ((...args: never[]) => EditorComponent) | undefined) => {
				this.editorFactoryInstalls++;
				this.editorFactory = factory;
				const text = this.editorComponent?.getText() ?? "";
				// Mirrors Pi's setCustomEditorComponent wiring.
				const editor = factory
					? (factory as unknown as (tui: unknown, theme: EditorTheme, kb: KeybindingsManager) => EditorComponent)(
							this.tui,
							editorTheme(),
							this.keybindings,
						)
					: undefined;
				if (editor) {
					editor.onSubmit = (submitted: string) => this.submissions.push(submitted);
					editor.setText(text);
					this.editorComponent = editor;
				}
			},
			custom: <T>(
				factory: (tui: unknown, theme: Theme, kb: KeybindingsManager, done: (result: T) => void) => Component,
				options?: unknown,
			): Promise<T> =>
				new Promise<T>((resolve) => {
					// Mirrors Pi's showExtensionCustom: the factory runs synchronously, the overlay is
					// mounted (and focused) a microtask later, and done() removes it and restores the
					// editor's focus synchronously before the returned promise settles.
					let closed = false;
					let request: OverlayRequest | undefined;
					const done = (result: T) => {
						if (closed) return;
						closed = true;
						if (request && this.overlay === request) {
							this.overlay = undefined;
							setFocused(request.component, false);
						}
						request?.component.dispose?.();
						resolve(result);
					};
					const component = factory(this.tui, this.theme, this.keybindings, done);
					request = { component, options };
					this.overlayRequests.push(request);
					void Promise.resolve().then(() => {
						if (closed) return;
						this.overlay = request;
						setFocused(component, true);
					});
				}),
			setEditorText: () => {
				throw new Error("the extension must not write editor text through ctx.ui.setEditorText");
			},
		};
		return {
			mode,
			hasUI: mode === "tui" || mode === "rpc",
			cwd,
			ui,
			sessionManager: {
				getCwd: () => cwd,
				getSessionDir: () => (noSession ? "" : sessionDir),
			},
		} as unknown as ExtensionContext;
	}
}

/** Mirrors Pi's TUI.setFocus: a component with a `focused` property is told when it gains or loses focus. */
function setFocused(component: Component, focused: boolean): void {
	if ("focused" in component) (component as Component & Focusable).focused = focused;
}

/** Pi's default per-cwd session directory under the agent directory. */
export function defaultSessionDir(agentDir: string, cwd: string): string {
	return join(agentDir, "sessions", `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`);
}

/** Box-drawing characters of the modal's frame. */
const FRAME_CHARACTERS = ["╭", "╮", "╰", "╯", "│", "├", "┤", "─"];

/** Each visible character of a rendered line, with the foreground SGR sequence in effect ("" for the default). */
function coloursOf(line: string): { char: string; fg: string }[] {
	const characters: { char: string; fg: string }[] = [];
	let fg = "";
	// SGR sequences (captured), other CSI sequences, OSC/APC strings, or one visible character.
	// biome-ignore lint/suspicious/noControlCharactersInRegex: terminal escape sequences
	const tokens = /\x1b\[([0-9;]*)m|\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b[\]_][^\x07\x1b]*(?:\x07|\x1b\\)|([\s\S])/gu;
	for (const [sequence, sgr, char] of line.matchAll(tokens)) {
		if (char !== undefined) characters.push({ char, fg });
		else if (sgr === "" || sgr === "0" || sgr === "39") fg = "";
		else if (sgr !== undefined && /^(?:3[0-7]|9[0-7]|38;.*)$/.test(sgr)) fg = sequence;
	}
	return characters;
}

/** A synthetic git directory as git recognises one: `HEAD` naming a ref, and `objects` and `refs` directories. */
function makeGitDirectory(gitDir: string, head: string): void {
	mkdirSync(join(gitDir, "objects"), { recursive: true });
	mkdirSync(join(gitDir, "refs"), { recursive: true });
	writeFileSync(join(gitDir, "HEAD"), head);
}

/**
 * Fail fast when the temporary directory is inside a git repository (roughly: a `.git` directory
 * holding `HEAD`, `objects` and `refs`, or a `.git` file): every test directory would then share
 * its repo scope.
 */
function assertOutsideGitRepository(dir: string): void {
	for (let current = dir; ; current = dirname(current)) {
		const git = join(current, ".git");
		const gitDirectory = ["HEAD", "objects", "refs"].every((name) => existsSync(join(git, name)));
		if (gitDirectory || (existsSync(git) && statSync(git).isFile())) {
			throw new Error(`the test root ${dir} is inside the git repository at ${current}; set TMPDIR to a directory outside any repository`);
		}
		if (dirname(current) === current) return;
	}
}

export function stripAnsi(text: string): string {
	// CSI sequences, OSC/APC strings terminated by BEL or ST.
	// biome-ignore lint/suspicious/noControlCharactersInRegex: terminal escape sequences
	return text.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "").replace(/\x1b[\]_][^\x07\x1b]*(?:\x07|\x1b\\)/g, "");
}

function editorTheme(): EditorTheme {
	return { borderColor: (text) => text, selectList: getSelectListTheme() };
}

/** A theme that colours each token with its own 256-colour code, so rendering stays realistic and colours can be told apart. */
function fakeTheme(): Theme {
	const codes = new Map<string, number>();
	const code = (name: string) => {
		if (!codes.has(name)) codes.set(name, 16 + codes.size);
		return codes.get(name);
	};
	return {
		fg: (color: string, text: string) => `\x1b[38;5;${code(color)}m${text}\x1b[39m`,
		bg: (_color: string, text: string) => `\x1b[44m${text}\x1b[49m`,
		bold: (text: string) => `\x1b[1m${text}\x1b[22m`,
		italic: (text: string) => `\x1b[3m${text}\x1b[23m`,
		underline: (text: string) => `\x1b[4m${text}\x1b[24m`,
		inverse: (text: string) => `\x1b[7m${text}\x1b[27m`,
		strikethrough: (text: string) => `\x1b[9m${text}\x1b[29m`,
	} as unknown as Theme;
}

type TestContext = { after(fn: () => void): void };

/** Create a harness and dispose it after the test. */
export function useHarness(t: TestContext, options?: HarnessOptions): Harness {
	const harness = new Harness(options);
	t.after(() => harness.dispose());
	return harness;
}

/** A harness with one session in the current directory holding `prompts`, oldest first. */
export function harnessWithPrompts(t: TestContext, prompts: string[], options: HarnessOptions = {}): Harness {
	const h = useHarness(t, options);
	h.writeSession({ cwd: h.cwd, prompts: prompts.map((text, i) => ({ text, timestamp: minutesAfterT0(i + 1) })) });
	return h;
}

/** Test options skipping a test on Windows, for `reason`. */
export const windowsSkip = (reason: string) => ({ skip: process.platform === "win32" ? reason : false });

/** Node refuses to start the stub's `.cmd` launcher without a shell, and the matcher never uses one. */
export const needsStub = windowsSkip("the stub matcher cannot be started without a shell on Windows");
