/**
 * Extension-boundary test harness.
 *
 * Loads the real extension entry point against a fake Pi API and UI context, with Pi's real
 * editor component. History comes from synthetic session files in a temporary agent directory;
 * no real prompt history is ever read. The fake mirrors Pi's overlay lifecycle: the overlay is
 * mounted and focused asynchronously, and closing it gives focus back to the editor before the
 * result promise settles.
 *
 * Tests drive keys and assert on what a user sees: the input bar's text and cursor, and the
 * rendered overlay lines (`overlayLines()`, `modalList()`, `modalQuery()`; empty when no overlay is
 * shown). The one allowed exception is a narrow set of checks at the extension's external
 * boundaries, for behaviour that has no visible output: prompts handed to Pi for submission
 * (`submissions`), what the extension registered or installed (`registrations`,
 * `editorFactoryInstalls`, `overlayRequests`, `notifications`), the session files on disk, and what
 * the matcher process was given and whether it was killed (`matcherCalls()`). Never assert on the
 * extension's private state.
 *
 * A scripted stub is always on PATH as `fzf` and `sk`, so on Linux and macOS no harness test
 * reaches a real matcher. On Windows the extension cannot start the stub's `.cmd` launcher: tests
 * that need the stub's answers are skipped there, and a test that opens the modal with a draft may
 * start whatever fzf is on PATH, without depending on its outcome.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	type ExtensionAPI,
	type ExtensionContext,
	getSelectListTheme,
	initTheme,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import {
	type Component,
	type EditorComponent,
	type EditorTheme,
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
	/** Ctrl+U, Pi's delete-to-line-start: clears a line whose cursor is at its end. */
	clearLine: "\x15",
} as const;

const T0 = Date.UTC(2026, 10, 1, 9, 0, 0);
/** A timestamp for synthetic prompts: `n` minutes after a fixed point in time. */
export const minutesAfterT0 = (n: number) => T0 + n * 60_000;

const STUB_MATCHER = fileURLToPath(new URL("./fixtures/stub-matcher.mjs", import.meta.url));

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
	output?: string[];
	exitCode?: number;
	delayMs?: number;
	/** Written to the stub's standard error before it exits. */
	stderr?: string;
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

	/** Load the extension through its real entry point and emit `session_start`. */
	async start(): Promise<void> {
		if (this.handlers.size === 0) piHistory(this.fakePi());
		for (const handler of this.handlers.get("session_start") ?? []) {
			await handler({ type: "session_start", reason: "startup" }, this.fakeContext());
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
		const bin = join(this.root, "matcher bin");
		mkdirSync(bin, { recursive: true });
		for (const name of ["fzf", "sk"]) {
			if (process.platform === "win32") {
				// Windows cannot execute a shebang script and symlinks require extra privileges.
				writeFileSync(join(bin, `${name}.cmd`), `@echo off\r\n"${process.execPath}" "${STUB_MATCHER}" %*\r\n`);
			} else {
				symlinkSync(STUB_MATCHER, join(bin, name));
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
						if (request && this.overlay === request) this.overlay = undefined;
						request?.component.dispose?.();
						resolve(result);
					};
					const component = factory(this.tui, this.theme, this.keybindings, done);
					request = { component, options };
					this.overlayRequests.push(request);
					void Promise.resolve().then(() => {
						if (!closed) this.overlay = request;
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

/** Pi's default per-cwd session directory under the agent directory. */
export function defaultSessionDir(agentDir: string, cwd: string): string {
	return join(agentDir, "sessions", `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`);
}

export function stripAnsi(text: string): string {
	// CSI sequences, OSC/APC strings terminated by BEL or ST.
	// biome-ignore lint/suspicious/noControlCharactersInRegex: terminal escape sequences
	return text.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "").replace(/\x1b[\]_][^\x07\x1b]*(?:\x07|\x1b\\)/g, "");
}

function editorTheme(): EditorTheme {
	return { borderColor: (text) => text, selectList: getSelectListTheme() };
}

/** A theme that colours with distinct ANSI codes per token, so rendering stays realistic. */
function fakeTheme(): Theme {
	const code = (name: string) => 31 + ([...name].reduce((sum, ch) => sum + ch.charCodeAt(0), 0) % 6);
	return {
		fg: (color: string, text: string) => `\x1b[${code(color)}m${text}\x1b[39m`,
		bg: (_color: string, text: string) => `\x1b[44m${text}\x1b[49m`,
		bold: (text: string) => `\x1b[1m${text}\x1b[22m`,
		italic: (text: string) => `\x1b[3m${text}\x1b[23m`,
		underline: (text: string) => `\x1b[4m${text}\x1b[24m`,
		inverse: (text: string) => `\x1b[7m${text}\x1b[27m`,
		strikethrough: (text: string) => `\x1b[9m${text}\x1b[29m`,
	} as unknown as Theme;
}

/** Create a harness and dispose it after the test. */
export function useHarness(t: { after(fn: () => void): void }, options?: HarnessOptions): Harness {
	const harness = new Harness(options);
	t.after(() => harness.dispose());
	return harness;
}
