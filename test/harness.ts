/**
 * Extension-boundary test harness.
 *
 * Loads the real extension entry point against a fake Pi API and UI context, with Pi's real
 * editor and text-input components. History comes from synthetic session files in a temporary
 * agent directory; no real prompt history is ever read. Tests drive keys and assert only on the
 * input bar's text/cursor and the modal's rendered lines.
 */
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
} as const;

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
}

export interface HarnessOptions {
	mode?: ExtensionMode;
	/** Current working directory, relative to the harness root (created on disk). Default "work/project". */
	cwd?: string;
	/** Use a custom session directory, relative to the harness root, instead of Pi's default layout. */
	customSessionDir?: string;
	/** User keybinding overrides, as in Pi's keybindings.json. */
	keybindings?: KeybindingsConfig;
	terminalRows?: number;
	/** Put a scripted stub on PATH as both `fzf` and `sk`. */
	stubMatcher?: { responses?: StubMatcherResponse[] };
}

export interface StubMatcherCall {
	argv: string[];
	env: Record<string, string>;
	input: string[];
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
		if (options.stubMatcher) this.installStubMatcher(options.stubMatcher);

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

	get modalOpen(): boolean {
		return this.overlay !== undefined;
	}

	/** Type text into whatever has focus. */
	type(text: string): void {
		for (const ch of text) this.press(ch);
	}

	/** Send raw key sequences to whatever has focus: the modal if open, else the input bar. */
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

	/** The open modal's rendered lines, ANSI-stripped and right-trimmed. */
	modalLines(width = 80): string[] {
		if (!this.overlay) throw new Error("modal is not open");
		return this.overlay.component.render(width).map((line) => stripAnsi(line).trimEnd());
	}

	/** Rendered list rows: lines inside the frame, without frame characters. */
	modalBody(width = 80): string[] {
		return this.modalLines(width)
			.slice(1, -1)
			.map((line) => line.replace(/^│ ?/, "").replace(/ ?│$/, "").trimEnd());
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

	/** Wait until the open modal has finished loading. */
	async loaded(): Promise<void> {
		await this.waitFor(() => !this.modalLines().some((line) => line.includes("Loading")), "history to load");
	}

	matcherCalls(): StubMatcherCall[] {
		if (!existsSync(this.matcherLog)) return [];
		return readFileSync(this.matcherLog, "utf8")
			.trim()
			.split("\n")
			.filter(Boolean)
			.map((line) => JSON.parse(line) as StubMatcherCall);
	}

	dispose(): void {
		this.overlay?.component.dispose?.();
		for (const [key, value] of this.savedEnv) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		rmSync(this.root, { recursive: true, force: true });
	}

	private setEnv(key: string, value: string): void {
		if (!this.savedEnv.has(key)) this.savedEnv.set(key, process.env[key]);
		process.env[key] = value;
	}

	private installStubMatcher(stub: { responses?: StubMatcherResponse[] }): void {
		const bin = join(this.root, "bin");
		mkdirSync(bin, { recursive: true });
		chmodSync(STUB_MATCHER, 0o755);
		for (const name of ["fzf", "sk"]) symlinkSync(STUB_MATCHER, join(bin, name));
		const config = join(this.root, "matcher-config.json");
		writeFileSync(config, JSON.stringify({ responses: stub.responses ?? [] }));
		this.setEnv("PATH", `${bin}:${process.env.PATH ?? ""}`);
		this.setEnv("STUB_MATCHER_CONFIG", config);
		this.setEnv("STUB_MATCHER_LOG", this.matcherLog);
	}

	private fakePi(): ExtensionAPI {
		const handlers = this.handlers;
		const registrations = this.registrations;
		return new Proxy({} as ExtensionAPI, {
			get(_target, property) {
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
					let request: OverlayRequest | undefined;
					const done = (result: T) => {
						if (this.overlay === request) this.overlay = undefined;
						request?.component.dispose?.();
						resolve(result);
					};
					const component = factory(this.tui, this.theme, this.keybindings, done);
					request = { component, options };
					this.overlayRequests.push(request);
					this.overlay = request;
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
				getSessionDir: () => sessionDir,
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

