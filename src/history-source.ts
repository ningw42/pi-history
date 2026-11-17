import { constants, type Dirent } from "node:fs";
import { access, lstat, open, readdir, readFile, readlink, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { type ExtensionContext, getAgentDir } from "@earendil-works/pi-coding-agent";

/** Pi's documented environment override for the session directory. */
const SESSION_DIR_ENV = "PI_CODING_AGENT_SESSION_DIR";

/**
 * Which sessions records are drawn from: repo, the sessions of the git repository containing the
 * current working directory (or of exactly that directory outside a repository), or global, every
 * session.
 */
export type Scope = "repo" | "global";

/** One unique user-typed prompt with the time and working directory of its most recent use. */
export interface HistoryRecord {
	text: string;
	/** Unix time in milliseconds of the most recent use. */
	timestamp: number;
	/** Working directory recorded in the session where the most recent use happened. */
	cwd: string;
}

/** What the history source needs to know about the running Pi session. */
export interface SessionContext {
	/** Pi's current working directory. */
	cwd: string;
	/** Where Pi keeps its session files. */
	storage: SessionStorage;
	/** The running session, as Pi holds it in memory. */
	live: LiveSession;
}

/**
 * The running session as Pi holds it in memory: every entry, on every branch, including prompts
 * submitted moments ago and those of an ephemeral (`--no-session`) session, which never reach disk.
 */
export interface LiveSession {
	/** The working directory the session records. */
	cwd: string;
	/** Every entry of the session, in the order Pi appended them. */
	entries: readonly unknown[];
	/** The file Pi keeps the session in, if it is persisted; it holds nothing the entries do not. */
	file: string | undefined;
}

/**
 * Where Pi keeps session files: in its default layout, one directory per working directory below a
 * root; with a custom session directory, that one directory, holding every session.
 */
export type SessionStorage = { layout: "default"; root: string } | { layout: "custom"; dir: string };

/**
 * The session context of a running Pi session. The custom session directory configured through
 * Pi's documented environment variable or `sessionDir` setting (in Pi's precedence order) is
 * custom storage wherever it is, even inside `<agent dir>/sessions`. A persisted session reports
 * the directory it actually uses, which wins: one directly inside `<agent dir>/sessions` that is
 * not the configured one means Pi's default layout; any other is custom (as with a
 * `--session-dir` flag, which extensions cannot see). An ephemeral (`--no-session`) session reports
 * none, so the configured directory applies, else the default layout.
 *
 * The live session is the session manager's in-memory state at the time of the call.
 */
export function sessionContextOf(
	ctx: Pick<ExtensionContext, "cwd" | "sessionManager">,
	settingsSessionDir: string | undefined,
): SessionContext {
	const { sessionManager } = ctx;
	const root = join(getAgentDir(), "sessions");
	const current = sessionManager.getSessionDir();
	const configured = process.env[SESSION_DIR_ENV] || settingsSessionDir;
	const configuredDir = configured ? resolveUserPath(configured, ctx.cwd) : undefined;
	let custom: string | undefined;
	if (!current) custom = configuredDir;
	else if (resolve(current) === configuredDir || resolve(dirname(current)) !== resolve(root)) custom = current;
	return {
		cwd: ctx.cwd,
		storage: custom ? { layout: "custom", dir: custom } : { layout: "default", root },
		live: {
			cwd: sessionManager.getHeader()?.cwd ?? sessionManager.getCwd(),
			entries: sessionManager.getEntries(),
			file: sessionManager.getSessionFile(),
		},
	};
}

/** Resolve a user-configured path the way Pi does: `~` expands to home, relative to `cwd`. */
function resolveUserPath(path: string, cwd: string): string {
	if (path === "~") return homedir();
	if (path.startsWith("~/")) return join(homedir(), path.slice(2));
	return resolve(cwd, path);
}

export interface HistorySource {
	/** The scope's records newest first, de-duplicated on their text, at most the record limit of them. */
	load(scope: Scope, context: SessionContext, signal?: AbortSignal): Promise<HistoryRecord[]>;
}

export interface HistorySourceOptions {
	/** How many unique records, newest first, a load returns at most. */
	recordLimit: number;
}

/**
 * History drawn from the live session, in every scope, and from the Pi session files in a scope.
 * The live session is read from Pi's memory, so its file is skipped. Every other session file in
 * Pi's storage is found by listing its directories, and the working directory recorded in each
 * file's header decides whether the session is in scope; only in-scope files are read further.
 * What is read from a file is cached until it changes (see `SessionFileCache`). Session files are
 * only ever read.
 */
export function createHistorySource({ recordLimit }: HistorySourceOptions): HistorySource {
	return {
		async load(scope, context, signal) {
			const inScope = scope === "global" ? async () => true : await inRepoScopeOf(context.cwd);
			const { live } = context;
			const occurrences = userPrompts(live.entries, live.cwd);
			for (const [path, file] of await currentSessionFiles(context.storage, live.file)) {
				signal?.throwIfAborted();
				try {
					if (file.cwd === undefined) file.cwd = await recordedCwd(path);
					if (file.cwd === null || !(await inScope(file.cwd))) continue;
					file.prompts ??= await readUserPrompts(path, file.cwd);
					occurrences.push(...file.prompts);
				} catch {
					// Unreadable for now: skipped, and read again at the next load.
				}
			}
			return dedupeNewestFirst(occurrences).slice(0, recordLimit);
		},
	};
}

/** What has been read from one session file, kept while the file is unchanged. */
interface CachedSessionFile {
	/** The file's identity and version when it was listed: device, inode, size and modification time. */
	version: string;
	/** The working directory its header records ("" for none), or null when it is not a session. Undefined until read. */
	cwd?: string | null;
	/** Its user prompts in file order. Undefined until read, which happens once the session is first in scope. */
	prompts?: HistoryRecord[];
}

/** Cached session files by path, for each session storage. */
type SessionFileCache = Map<string, Map<string, CachedSessionFile>>;

/**
 * The cache of what has been read from session files, kept for the life of the Pi process. Pi
 * re-imports the extension's module at every session start (`/new`, `/resume`, `/fork`, `/reload`),
 * so it lives in process-wide state, under a key versioned with the shape of its entries, so an
 * extension updated by `/reload` never reads entries an older one left behind.
 */
function sessionFileCache(): SessionFileCache {
	const processState = globalThis as typeof globalThis & Record<symbol, SessionFileCache | undefined>;
	const key = Symbol.for("pi-history.sessionFileCache.v1");
	processState[key] ??= new Map();
	return processState[key];
}

/**
 * The session files in `storage` now, other than the live session's, each with what is cached for
 * it: an unchanged file keeps its cached entry, a new or changed one starts empty, and the entries
 * of files no longer there are dropped from the cache.
 */
async function currentSessionFiles(
	storage: SessionStorage,
	liveFile: string | undefined,
): Promise<Map<string, CachedSessionFile>> {
	const live = liveFile && resolve(liveFile);
	const paths = (await sessionFiles(storage)).filter((path) => resolve(path) !== live);
	const versions = await Promise.all(paths.map(versionOf));
	const cache = sessionFileCache();
	const storageKey = storage.layout === "custom" ? `custom:${resolve(storage.dir)}` : `default:${resolve(storage.root)}`;
	const cached = cache.get(storageKey);
	const current = new Map<string, CachedSessionFile>();
	paths.forEach((path, i) => {
		const version = versions[i];
		if (version === undefined) return;
		const file = cached?.get(path);
		current.set(path, file?.version === version ? file : { version });
	});
	cache.set(storageKey, current);
	return current;
}

/** A file's identity and version, or undefined when it is not a regular file (or no longer there). */
async function versionOf(path: string): Promise<string | undefined> {
	try {
		const stats = await stat(path);
		return stats.isFile() ? `${stats.dev}:${stats.ino}:${stats.size}:${stats.mtimeMs}` : undefined;
	} catch {
		return undefined;
	}
}

/** Every session file in Pi's storage. A directory that cannot be listed holds none. */
async function sessionFiles(storage: SessionStorage): Promise<string[]> {
	const directories =
		storage.layout === "custom"
			? [storage.dir]
			: (await entriesOf(storage.root))
					.filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
					.map((entry) => join(storage.root, entry.name));
	const files = await Promise.all(
		directories.map(async (dir) =>
			(await entriesOf(dir)).filter((entry) => entry.name.endsWith(".jsonl")).map((entry) => join(dir, entry.name)),
		),
	);
	return files.flat();
}

async function entriesOf(dir: string): Promise<Dirent[]> {
	try {
		return await readdir(dir, { withFileTypes: true });
	} catch {
		return [];
	}
}

/** Pi bounds a session header line to this many bytes, too. */
const MAX_HEADER_BYTES = 1024 * 1024;
const HEADER_CHUNK_BYTES = 4096;

/**
 * The working directory recorded in a session file's header, its first line, read on its own: ""
 * when the header records none, and null when the file does not start with a session header (so it
 * is not a session). Rejects when the file cannot be read.
 */
async function recordedCwd(path: string): Promise<string | null> {
	const file = await open(path, "r");
	try {
		const chunks: Buffer[] = [];
		for (let position = 0; position < MAX_HEADER_BYTES; ) {
			const { bytesRead, buffer } = await file.read(Buffer.alloc(HEADER_CHUNK_BYTES), 0, HEADER_CHUNK_BYTES, position);
			const chunk = buffer.subarray(0, bytesRead);
			const newline = chunk.indexOf("\n");
			chunks.push(newline === -1 ? chunk : chunk.subarray(0, newline));
			if (bytesRead === 0 || newline !== -1) break;
			position += bytesRead;
		}
		const header = parseJson(Buffer.concat(chunks).toString("utf8"));
		if (!isObject(header) || header.type !== "session") return null;
		return typeof header.cwd === "string" ? header.cwd : "";
	} finally {
		await file.close();
	}
}

/**
 * A test of whether a session recorded in a given working directory is in the repo scope of `cwd`.
 * Inside a git repository, the recorded directory must be in that repository: its top-level
 * directory or below, but not inside another repository nested there (a linked worktree, a
 * submodule or any other clone checked out inside it), which is a separate repository. Outside any
 * repository it must be exactly `cwd`. Pi records absolute directories; any other recorded
 * directory, or none, is never in repo scope.
 */
async function inRepoScopeOf(cwd: string): Promise<(recorded: string) => Promise<boolean>> {
	const here = resolve(cwd);
	const root = await repositoryRoot(here);
	if (root === undefined) return async (recorded) => isAbsolute(recorded) && resolve(recorded) === here;
	const topLevels = new Map<string, Promise<boolean>>();
	const isTopLevel = (dir: string) => {
		if (!topLevels.has(dir)) topLevels.set(dir, isRepositoryTopLevel(dir));
		return topLevels.get(dir) as Promise<boolean>;
	};
	return async (recorded) => {
		if (!isAbsolute(recorded)) return false;
		const path = relative(root, resolve(recorded));
		if (path === ".." || path.startsWith(`..${sep}`) || isAbsolute(path)) return false;
		const parts = path === "" ? [] : path.split(sep);
		for (let depth = 1; depth <= parts.length; depth++) {
			if (await isTopLevel(join(root, ...parts.slice(0, depth)))) return false;
		}
		return true;
	};
}

/** The top-level directory of the git repository containing `dir`: the nearest top level at or above it. */
async function repositoryRoot(dir: string): Promise<string | undefined> {
	for (let current = dir; ; current = dirname(current)) {
		if (await isRepositoryTopLevel(current)) return current;
		if (dirname(current) === current) return undefined;
	}
}

const GITDIR_PREFIX = "gitdir: ";

/**
 * Whether `dir` is the top-level directory of a git repository: its `.git` is a git directory, or a
 * file (as in a linked worktree or a submodule) whose `gitdir:` line names one. Anything else, such
 * as an empty `.git` directory, is not a repository, and the search goes on above it, as git's does.
 */
async function isRepositoryTopLevel(dir: string): Promise<boolean> {
	const git = join(dir, ".git");
	try {
		const stats = await stat(git);
		if (stats.isDirectory()) return await isGitDirectory(git);
		if (!stats.isFile()) return false;
		const content = (await readFile(git, "utf8")).trim();
		if (!content.startsWith(GITDIR_PREFIX)) return false;
		return await isGitDirectory(resolve(dir, content.slice(GITDIR_PREFIX.length).trim()));
	} catch {
		return false;
	}
}

/**
 * Whether `dir` is a git directory, by the checks git makes itself (`is_git_directory`): its `HEAD`
 * names a ref or an object, and its common directory (the one its `commondir` file names, as in a
 * linked worktree, else itself) has `objects` and `refs` directories git can search.
 */
async function isGitDirectory(dir: string): Promise<boolean> {
	if (!(await isValidHead(join(dir, "HEAD")))) return false;
	const common = await readFile(join(dir, "commondir"), "utf8").then(
		(path) => resolve(dir, path.trim()),
		() => dir,
	);
	return (await isSearchable(join(common, "objects"))) && (await isSearchable(join(common, "refs")));
}

/**
 * git's `validate_headref`: `HEAD` is a symbolic link into `refs/` (its target need not exist yet,
 * as on an unborn branch), or a file holding `ref: refs/…` or an object id.
 */
async function isValidHead(path: string): Promise<boolean> {
	try {
		if ((await lstat(path)).isSymbolicLink() && (await readlink(path)).startsWith("refs/")) return true;
		const content = await readFile(path, "utf8");
		return /^ref:\s*refs\//.test(content) || /^[0-9a-f]{40}/i.test(content);
	} catch {
		return false;
	}
}

async function isSearchable(dir: string): Promise<boolean> {
	return access(dir, constants.X_OK).then(
		() => true,
		() => false,
	);
}

/**
 * Marks a line that may hold a user message (`"role":"user"`). Inside a JSON string, such as tool
 * output, the quotes are escaped, so the mark does not occur there.
 */
const USER_MARK = Buffer.from('"user"');
const NEWLINE = 0x0a;

/**
 * Every user prompt in one session file, in file order; a malformed line holds none. Rejects when
 * the file cannot be read. Only the lines holding `USER_MARK` are decoded and parsed: tool output
 * lines can be megabytes and never hold a prompt. The bytes are scanned rather than decoding and
 * splitting the whole file, which keeps the work done on Pi's main thread small.
 */
async function readUserPrompts(path: string, cwd: string): Promise<HistoryRecord[]> {
	const content = await readFile(path);
	const entries: unknown[] = [];
	for (let at = content.indexOf(USER_MARK); at !== -1; ) {
		const start = content.lastIndexOf(NEWLINE, at) + 1;
		const newline = content.indexOf(NEWLINE, at);
		const end = newline === -1 ? content.length : newline;
		entries.push(parseJson(content.toString("utf8", start, end)));
		at = content.indexOf(USER_MARK, end);
	}
	return userPrompts(entries, cwd);
}

/**
 * Every user prompt among a session's entries, in order: every user message, on every branch and
 * before any compaction, since a prompt that was typed is history.
 */
function userPrompts(entries: readonly unknown[], cwd: string): HistoryRecord[] {
	return entries.flatMap((entry) => userPromptOf(entry, cwd) ?? []);
}

function userPromptOf(entry: unknown, cwd: string): HistoryRecord | undefined {
	if (!isObject(entry) || entry.type !== "message" || !isObject(entry.message)) return undefined;
	const message = entry.message;
	if (message.role !== "user") return undefined;
	const text = userMessageText(message.content);
	if (text === undefined || text.trim() === "") return undefined;
	const timestamp =
		typeof message.timestamp === "number"
			? message.timestamp
			: typeof entry.timestamp === "string"
				? Date.parse(entry.timestamp)
				: Number.NaN;
	return { text, timestamp: Number.isNaN(timestamp) ? 0 : timestamp, cwd };
}

/** Text of a user message, with text blocks joined the way Pi's interactive mode joins them. */
function userMessageText(content: unknown): string | undefined {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return undefined;
	return content
		.filter((block): block is { type: "text"; text: string } => isObject(block) && block.type === "text" && typeof block.text === "string")
		.map((block) => block.text)
		.join("");
}

/** Keep the most recent use of each distinct text, newest first. */
function dedupeNewestFirst(occurrences: HistoryRecord[]): HistoryRecord[] {
	const newest = new Map<string, HistoryRecord>();
	for (const record of occurrences) {
		const existing = newest.get(record.text);
		if (!existing || record.timestamp > existing.timestamp) newest.set(record.text, record);
	}
	return [...newest.values()].sort((a, b) => b.timestamp - a.timestamp);
}

/** The value `text` holds as JSON, or undefined when it is not JSON. */
function parseJson(text: string): unknown {
	try {
		return JSON.parse(text);
	} catch {
		return undefined;
	}
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}
