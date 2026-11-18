/**
 * Extension-boundary test harness.
 *
 * Loads the real extension entry point against a fake Pi API and UI context, with Pi's real
 * editor component, wired as Pi wires it: given an autocomplete provider (completing the files
 * below the current directory), and handed every prompt Pi submits and, at each session
 * start, the live session's prompts for its in-bar history. Other extensions can be loaded ahead of
 * this one (`extensionsBefore`), for example to install an editor of their own first, and Pi's
 * working status can be shown as while the agent works (`showWorkingStatus()`). History loading can
 * be held open until a test releases it (`holdHistoryLoading()`).
 *
 * History comes from synthetic session files in a temporary agent directory
 * (`writeSession()`, or `writeSessionEntries()` for branches, compactions and content blocks) and
 * from a fake live session that Pi's session manager holds in memory (`liveEntries`,
 * `livePrompt()`); no real prompt history is ever read. The extension's configuration file is read from that
 * agent directory too (`writeConfig()`), so the user's real configuration never applies. The fake mirrors Pi's overlay lifecycle: the overlay is
 * mounted and focused asynchronously, and closing it gives focus back to the editor before the
 * result promise settles. Git repositories are synthetic too (`makeGitRepo()`, `makeGitWorktree()`,
 * `makeGitSubmodule()`), laid out as git leaves them, or made by the real `git init` (`gitInit()`);
 * the harness refuses to run in a temporary directory inside a git repository, where every test
 * directory would share one repo scope.
 *
 * Tests drive keys, to whatever has focus (`press()`) or to the input bar under an open overlay
 * (`pressInInputBar()`), and assert on what a user sees: the input bar's text and cursor, its rendered
 * lines with any autocomplete popup (`editorLines()`), and the
 * rendered overlay lines (`overlayLines()`, `modalTitle()`, `modalList()`, `modalLastUsed()`,
 * `modalPreview()`, `modalQuery()`, `modalHint()`, `modalHints()`; empty or undefined when no overlay is shown), the
 * colours of the modal's frame and title (`modalColours()`) and of each list row
 * (`modalListColours()`), and whether and where the modal places the terminal cursor (`modalShowsCursor()`, `modalCursor()`).
 * The terminal can be resized (`resize()`), and times are shown in UTC unless a test sets `TZ`. Like Pi,
 * the harness tells a focusable overlay when it gains or loses focus (`setOverlayFocus()` moves Pi's
 * focus away and back). The one allowed exception is a narrow set of checks at the extension's external
 * boundaries, for behaviour that has no visible output: prompts handed to Pi for submission
 * (`submissions`), what the extension registered or installed and when (`registrations`,
 * `editorFactoryInstalls`, `lateEditorFactoryInstalls`, `overlayRequests`, `notifications`), the session files on disk, and what
 * the matcher process was given and whether it was killed (`matcherCalls()`). Never assert on the
 * extension's private state.
 *
 * A scripted stub is always on PATH as `fzf` and `sk`, so on Linux and macOS no harness test
 * reaches a real matcher. Its responses are chosen by query and, optionally, by a record its input
 * must hold, so a run over one scope's records can be told from a run over the other's. On Windows the extension cannot start the stub's `.cmd` launcher: tests
 * that need the stub's answers are skipped there, and a test that opens the modal with a draft may
 * start whatever fzf is on PATH, without depending on its outcome.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
	closeSync,
	constants,
	existsSync,
	mkdirSync,
	mkdtempSync,
	openSync,
	readFileSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { open } from "node:fs/promises";
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
	CombinedAutocompleteProvider,
	CURSOR_MARKER,
	type Component,
	type EditorComponent,
	type EditorTheme,
	type Focusable,
	type KeybindingsConfig,
	KeybindingsManager,
	setKeybindings,
	TUI_KEYBINDINGS,
	visibleWidth,
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
	ctrlW: "\x17",
	/** Ctrl+M as a terminal without the Kitty keyboard protocol sends it: the same carriage return as Enter. */
	ctrlMLegacy: "\r",
	/** Ctrl+M under the Kitty keyboard protocol: a key of its own. */
	ctrlMKitty: "\x1b[109;5u",
	/** Ctrl+U, Pi's delete-to-line-start: clears a line whose cursor is at its end. */
	clearLine: "\x15",
	/** Ctrl+A, Pi's cursor-to-line-start. */
	lineStart: "\x01",
	/** Ctrl+E, Pi's cursor-to-line-end. */
	lineEnd: "\x05",
	tab: "\t",
	altP: "\x1bp",
	altN: "\x1bn",
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

/** A session entry as Pi stores it, one per line of a session file. */
export type SessionEntry = { type: string; id: string; parentId: string | null; timestamp: string } & Record<string, unknown>;

/** A session entry of `type` with the fields every entry has, and its own `fields`. */
function sessionEntry(type: string, id: string, parentId: string | null, timestamp: number, fields: Record<string, unknown>): SessionEntry {
	return { type, id, parentId, timestamp: new Date(timestamp).toISOString(), ...fields };
}

/** A user message entry. `content` is a string or Pi's content blocks (text, image, …). */
export function userEntry(id: string, parentId: string | null, content: string | unknown[], timestamp: number): SessionEntry {
	return sessionEntry("message", id, parentId, timestamp, { message: { role: "user", content, timestamp } });
}

/** An assistant reply entry. */
export function assistantEntry(id: string, parentId: string | null, timestamp: number): SessionEntry {
	return sessionEntry("message", id, parentId, timestamp, {
		message: { role: "assistant", content: [{ type: "text", text: "ok" }], stopReason: "stop", timestamp },
	});
}

/**
 * A prompt (`<id>u`) after the last of `entries`, answered by the assistant (`<id>a`) a millisecond
 * later, appended to `entries`: how the harness models a conversation, on disk and in memory.
 */
function appendExchange(entries: SessionEntry[], id: string, text: string, timestamp: number): void {
	entries.push(userEntry(`${id}u`, entries.at(-1)?.id ?? null, text, timestamp));
	entries.push(assistantEntry(`${id}a`, `${id}u`, timestamp + 1));
}

/** A compaction entry: the model's context keeps only the entries from `firstKeptEntryId` on, the file keeps them all. */
export function compactionEntry(id: string, parentId: string, firstKeptEntryId: string, timestamp: number): SessionEntry {
	return sessionEntry("compaction", id, parentId, timestamp, {
		summary: "summary of the earlier conversation",
		firstKeptEntryId,
		tokensBefore: 1000,
	});
}

/** Pi's session file name: the session's start time, then its id. */
function sessionFileName(timestamp: string, id: string): string {
	return `${timestamp.replace(/[:.]/g, "-")}_${id}.jsonl`;
}

/** The fake live session's header: started an hour before T0, in the harness's working directory. */
function liveHeaderIn(cwd: string) {
	return { type: "session", version: 3, id: "live", timestamp: new Date(minutesAfterT0(-60)).toISOString(), cwd };
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
	/** Other extensions Pi loads ahead of pi-history at every session start, in this order. */
	extensionsBefore?: ((pi: ExtensionAPI) => void)[];
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
	/**
	 * The running session's entries as Pi holds them in memory, every branch included; Pi's session
	 * manager reports them through `getEntries()`. Tests append to it (`livePrompt()`) to model
	 * prompts submitted while Pi runs. The harness never writes them to disk; `writeSessionEntries()`
	 * with `liveSessionFile` does.
	 */
	readonly liveEntries: SessionEntry[] = [];
	/** The file Pi keeps the running session in (it may not exist yet); undefined in an ephemeral session. */
	readonly liveSessionFile: string | undefined;
	editorFactoryInstalls = 0;
	/**
	 * Editor factories installed other than synchronously inside a `session_start` handler: after
	 * asynchronous work, when Pi would dismiss a selector the user opened in the meantime.
	 */
	lateEditorFactoryInstalls = 0;
	/** The working status Pi shows outside the input bar, when the editor does not embed it (see `showWorkingStatus()`). */
	workingStatusOutsideEditor: string | undefined;

	private readonly options: HarnessOptions;
	/** Set while a `session_start` handler runs synchronously. */
	private inSessionStart = false;
	/** Unblock whatever waits on a pipe that `holdHistoryLoading()` set up and the test did not release. */
	private readonly heldLoads: (() => void)[] = [];
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
		const liveHeader = liveHeaderIn(this.cwd);
		this.liveSessionFile = options.noSession ? undefined : join(this.sessionDir, sessionFileName(liveHeader.timestamp, liveHeader.id));
		this.matcherLog = join(this.root, "matcher-log.jsonl");
		this.setEnv("PI_CODING_AGENT_DIR", this.agentDir);
		// Pi's session-directory override must not leak in from the host: it would point the
		// extension at real history. Tests that need it set it explicitly with setEnv().
		this.setEnv("PI_CODING_AGENT_SESSION_DIR", undefined);
		// Times are shown in local time; a fixed zone makes them the same on every machine. Node
		// applies an assignment to TZ at once, on Windows too (since Node 16.2).
		this.setEnv("TZ", "UTC");
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

	/**
	 * Write a synthetic session file of one conversation, each prompt answered by the assistant.
	 * Stored in Pi's default per-cwd directory unless `dir` is given.
	 */
	writeSession(spec: SessionSpec): string {
		const entries: SessionEntry[] = [];
		spec.prompts.forEach((prompt, i) => appendExchange(entries, `p${i}`, prompt.text, prompt.timestamp));
		return this.writeSessionEntries({ cwd: spec.cwd, entries, dir: spec.dir });
	}

	/**
	 * Write a synthetic session file holding `entries` after its header, as Pi lays them out: one
	 * JSON line each. Stored at `path`, or in `dir`, or in Pi's default per-cwd directory. Without a
	 * `cwd` the header records none, and the file is stored in the current session directory.
	 */
	writeSessionEntries(spec: { cwd?: string; entries: SessionEntry[]; dir?: string; path?: string }): string {
		const n = ++this.sessionCounter;
		const id = `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
		const first = spec.entries[0]?.timestamp ?? new Date(0).toISOString();
		const dir =
			spec.dir ??
			(this.options.customSessionDir || spec.cwd === undefined ? this.sessionDir : defaultSessionDir(this.agentDir, spec.cwd));
		const file = spec.path ?? join(dir, sessionFileName(first, id));
		mkdirSync(dirname(file), { recursive: true });
		const header = { type: "session", version: 3, id, timestamp: first, cwd: spec.cwd };
		writeFileSync(file, [header, ...spec.entries].map((entry) => `${JSON.stringify(entry)}\n`).join(""));
		return file;
	}

	/**
	 * Submit `text` in the running session: Pi appends it to the session in memory at once, answered
	 * by the assistant a moment later. Nothing is written to disk.
	 */
	livePrompt(text: string, timestamp: number): void {
		appendExchange(this.liveEntries, `live${this.liveEntries.length}`, text, timestamp);
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
	 * Start a session the way Pi does, at startup and again on `/new`, `/resume`, `/fork` and
	 * `/reload`: after startup, first emit `session_shutdown` to the outgoing extension, while its
	 * session is intact; then reset the extension UI (dropping the installed editor factory; the
	 * editor's text is carried over), switch the live session to `liveEntries` if given (as Pi's
	 * `/new`, `/resume` and `/fork` replace it; `/reload` keeps it), load the extension afresh
	 * through its real entry point, and emit `session_start`. Pi also re-imports the module each
	 * time, which the harness cannot do, so the extension must not rely on module state surviving
	 * between loads.
	 */
	async start(
		reason: "startup" | "new" | "resume" | "fork" | "reload" = "startup",
		{ liveEntries }: { liveEntries?: SessionEntry[] } = {},
	): Promise<void> {
		if (reason !== "startup") {
			for (const handler of this.handlers.get("session_shutdown") ?? []) {
				await handler({ type: "session_shutdown", reason }, this.fakeContext());
			}
		}
		this.editorFactory = undefined;
		this.handlers.clear();
		if (liveEntries) this.liveEntries.splice(0, this.liveEntries.length, ...liveEntries);
		for (const extension of this.options.extensionsBefore ?? []) extension(this.fakePi());
		piHistory(this.fakePi());
		for (const handler of this.handlers.get("session_start") ?? []) {
			let asyncRest: unknown; // what the handler leaves to do after its synchronous part
			this.inSessionStart = true;
			try {
				asyncRest = handler({ type: "session_start", reason }, this.fakeContext());
			} finally {
				this.inSessionStart = false;
			}
			await asyncRest;
		}
		// Pi renders the session's messages and hands its prompts to the editor's in-bar history.
		for (const entry of this.liveEntries) {
			const message = entry.message as { role?: string; content?: unknown } | undefined;
			if (message?.role === "user" && typeof message.content === "string") this.editorComponent?.addToHistory?.(message.content);
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

	/**
	 * Send raw key sequences to the input bar even while an overlay is shown: as when Pi focuses the
	 * input bar under an open overlay, which it does when a dialog it shows in the input bar's place
	 * closes (for example another extension's confirmation, while the agent works).
	 */
	pressInInputBar(...keys: string[]): void {
		for (const key of keys) this.editor.handleInput(key);
	}

	editorText(): string {
		return this.editor.getText();
	}

	/** The input bar as rendered, ANSI-stripped and right-trimmed: its borders, its text and any autocomplete popup below. */
	editorLines(width = 80): string[] {
		return this.editor.render(width).map((line) => stripAnsi(line).replace(CURSOR_MARKER, "").trimEnd());
	}

	editorCursor(): { line: number; col: number } {
		const editor = this.editor as EditorComponent & { getCursor(): { line: number; col: number } };
		return editor.getCursor();
	}

	/** The overlay as rendered on screen, ANSI-stripped and right-trimmed; empty when none is shown. */
	overlayLines(width = 80): string[] {
		return this.overlay?.component.render(width).map((line) => stripAnsi(line).trimEnd()) ?? [];
	}

	/** Rendered rows of the modal's list area (between the title and the rule above the preview), without frame characters. */
	modalList(width = 80): string[] {
		return this.modalSections(width).list;
	}

	/**
	 * Rendered rows of the modal's preview (between the list and the query line), without frame
	 * characters and with trailing empty rows dropped; empty when no modal is shown.
	 */
	modalPreview(width = 80): string[] {
		const { preview } = this.modalSections(width);
		while (preview.at(-1) === "") preview.pop();
		return preview;
	}

	/** The label on the rule above the preview (the selected record's last use); undefined when it has none. */
	modalLastUsed(width = 80): string | undefined {
		return this.modalSections(width).lastUsed;
	}

	/** The modal's query line as rendered, without frame characters; undefined when no modal is shown. */
	modalQuery(width = 80): string | undefined {
		return this.modalSections(width).query;
	}

	/** Whether the rendered modal places the terminal cursor (Pi's cursor marker), as on a focused text input. */
	modalShowsCursor(width = 80): boolean {
		return this.overlay?.component.render(width).some((line) => line.includes(CURSOR_MARKER)) ?? false;
	}

	/** The terminal cursor's rendered row and column in the modal, or undefined when it places none. */
	modalCursor(width = 80): { line: number; col: number } | undefined {
		const lines = this.overlay?.component.render(width) ?? [];
		for (const [line, text] of lines.entries()) {
			const marker = text.indexOf(CURSOR_MARKER);
			if (marker >= 0) return { line, col: visibleWidth(text.slice(0, marker)) };
		}
		return undefined;
	}

	/** The modal's top frame line (its title), ANSI-stripped; undefined when no modal is shown. */
	modalTitle(width = 80): string | undefined {
		return this.overlayLines(width)[0];
	}

	/** The modal's bottom frame line (its key hints, or their last row), ANSI-stripped; undefined when no modal is shown. */
	modalHint(width = 80): string | undefined {
		return this.overlayLines(width).at(-1);
	}

	/** Every row of the modal's key hints, without frame characters: rows above the bottom edge, then its label. */
	modalHints(width = 80): string[] {
		return this.modalSections(width).hints;
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

	/** For each rendered list row, every foreground colour its visible characters (frame and spaces aside) are drawn in. */
	modalListColours(width = 80): string[][] {
		const rows = this.modalList(width).length; // below the title
		const lines = (this.overlay?.component.render(width) ?? []).slice(1, 1 + rows).map(coloursOf);
		return lines.map((line) => [...new Set(line.slice(1, -1).flatMap(({ char, fg }) => (char.trim() === "" ? [] : [fg])))]);
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

	/**
	 * Show Pi's working status, as while the agent works. Like Pi, the harness embeds it in the input
	 * bar's top border when the editor embeds a working status, and otherwise shows it outside the
	 * input bar (`workingStatusOutsideEditor`).
	 */
	showWorkingStatus(text: string): void {
		const indicator = { renderInBorder: () => text, renderSpinnerInBorder: () => text.slice(0, 1) };
		const editor = this.editor as EditorComponent & { embedWorkingStatus?: boolean; setWorkingStatusIndicator?(indicator: unknown): void };
		const embedded = editor.embedWorkingStatus === true && typeof editor.setWorkingStatusIndicator === "function";
		if (embedded) editor.setWorkingStatusIndicator?.(indicator);
		this.workingStatusOutsideEditor = embedded ? undefined : text;
	}

	/**
	 * Hold history loading open until `release()`: makes the current directory a git repository
	 * whose `HEAD` is a named pipe, which the history source must read to resolve the repo scope, so
	 * a load waits there until the pipe is written. Then `HEAD` becomes a regular file, so later loads
	 * do not wait. POSIX only.
	 */
	holdHistoryLoading(): { release(): Promise<void> } {
		const gitDir = join(this.cwd, ".git");
		mkdirSync(join(gitDir, "objects"), { recursive: true });
		mkdirSync(join(gitDir, "refs"), { recursive: true });
		const head = join(gitDir, "HEAD");
		const content = "ref: refs/heads/main\n";
		execFileSync("mkfifo", [head]);
		let released = false;
		this.heldLoads.push(() => {
			if (released) return;
			// A load waiting to read the pipe gets an end of file at once (an invalid HEAD).
			try {
				closeSync(openSync(head, constants.O_WRONLY | constants.O_NONBLOCK));
			} catch {
				// No load is waiting.
			}
		});
		return {
			release: async () => {
				released = true;
				const writer = await open(head, "w"); // once a load has opened the pipe to read it
				rmSync(head);
				writeFileSync(head, content);
				await writer.writeFile(content);
				await writer.close();
			},
		};
	}

	/** Give the terminal `rows` rows, as a resize does; the next render reads them. (Tests choose the width at each render.) */
	resize(rows: number): void {
		this.tui.terminal.rows = rows;
	}

	/** Move Pi's focus off the shown overlay (as when another component takes it) or back onto it. */
	setOverlayFocus(focused: boolean): void {
		if (!this.overlay) throw new Error("no overlay is shown");
		setFocused(this.overlay.component, focused);
	}

	/**
	 * The overlay frame's rows, split at its two rules: the list above the first, the preview between
	 * them (the first rule's label is the selected record's last use), and below the second the query
	 * line, then the key hints: rows of their own when they do not fit the bottom edge, and its label.
	 */
	private modalSections(width: number): {
		list: string[];
		lastUsed: string | undefined;
		preview: string[];
		query: string | undefined;
		hints: string[];
	} {
		const lines = this.overlayLines(width);
		if (lines.length === 0) return { list: [], lastUsed: undefined, preview: [], query: undefined, hints: [] };
		const rules = lines.flatMap((line, index) => (line.startsWith("├") ? [index] : []));
		const [previewRule, queryRule] = rules;
		if (rules.length !== 2 || previewRule === undefined || queryRule === undefined) {
			throw new Error(`expected a list, a preview and a query line in the rendered modal:\n${lines.join("\n")}`);
		}
		const inner = (line: string) => line.replace(/^│ ?/, "").replace(/ ?│$/, "").trimEnd();
		// Keep list/query indicators, but remove the empty gutter from unmarked content.
		const plain = (line: string) => inner(line).slice(2);
		const label = (line: string | undefined, left: string, right: string) =>
			new RegExp(`^${left}─+ (.*?) ─*${right}$`, "u").exec(line ?? "")?.[1];
		const bottomLabel = label(lines.at(-1), "╰", "╯");
		const list = lines.slice(1, previewRule);
		return {
			list: list.map(list.some((line) => line.startsWith("│ › ")) ? inner : plain),
			lastUsed: label(lines[previewRule], "├", "┤"),
			preview: lines.slice(previewRule + 1, queryRule).map(plain),
			// Pi's Input is one line.
			query: inner(lines[queryRule + 1] ?? ""),
			hints: [...lines.slice(queryRule + 2, -1).map(plain), ...(bottomLabel === undefined ? [] : [bottomLabel])],
		};
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
		for (const unblock of this.heldLoads) unblock();
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
		const liveEntries = this.liveEntries;
		const liveSessionFile = this.liveSessionFile;
		const liveHeader = liveHeaderIn(cwd);
		const ui = {
			notify: (message: string, type?: string) => this.notifications.push({ message, type }),
			getEditorComponent: () => this.editorFactory,
			setEditorComponent: (factory: ((...args: never[]) => EditorComponent) | undefined) => {
				this.editorFactoryInstalls++;
				if (!this.inSessionStart) this.lateEditorFactoryInstalls++;
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
					editor.onSubmit = (submitted: string) => {
						this.submissions.push(submitted);
						// As Pi does with every prompt it submits, for its in-bar history.
						editor.addToHistory?.(submitted);
					};
					editor.setText(text);
					// Completing file paths below the current directory, as Pi's provider does.
					editor.setAutocompleteProvider?.(new CombinedAutocompleteProvider([], cwd, null));
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
			// Mirrors Pi's SessionManager: getEntries() returns a shallow copy of every entry, all branches.
			sessionManager: {
				getCwd: () => cwd,
				getSessionDir: () => (noSession ? "" : sessionDir),
				getSessionFile: () => liveSessionFile,
				getHeader: () => liveHeader,
				getEntries: () => [...liveEntries],
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

/** The history modal is shown. */
export function assertModalShown(h: Harness): void {
	assert.match(h.modalTitle() ?? "", /History/);
}

/** No overlay is shown. */
export function assertNoModal(h: Harness): void {
	assert.deepEqual(h.overlayLines(), []);
}

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

/** Test options skipping a test that makes a file unreadable: POSIX permissions do not stop root, nor apply on Windows. */
export const needsPosixPermissions = {
	skip: process.platform === "win32" || process.getuid?.() === 0 ? "POSIX read-permission test requires a non-root Unix user" : false,
};
