import { constants, type Dirent } from "node:fs";
import { access, lstat, open, readdir, readFile, readlink, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { setImmediate as nextTurn } from "node:timers/promises";
import { type ExtensionContext, getAgentDir } from "@earendil-works/pi-coding-agent";
import { restoreSkillInvocation } from "./skill-restoration.ts";

/** Pi's documented environment override for the session directory. */
const SESSION_DIR_ENV = "PI_CODING_AGENT_SESSION_DIR";

/**
 * Which sessions records are drawn from: repo, the sessions of the git repository containing the
 * current working directory (or of exactly that directory outside a repository), or global, every
 * session.
 */
export type Scope = "repo" | "global";

/** One unique user-typed prompt, after restoration, with the time and working directory of its most recent use. */
export interface HistoryRecord {
	/** The prompt as stored, or the command it was typed as when it began with a skill invocation (see `restoreSkillInvocation`). */
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
	/** Whether the session is ephemeral (`--no-session`): saved to no file. */
	ephemeral: boolean;
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
			ephemeral: sessionManager.getSessionFile() === undefined,
		},
	};
}

/**
 * Keep the prompts of the live session as it ends (on `/new`, `/resume`, `/fork`, `/reload` or
 * quitting) for the life of the Pi process if it is ephemeral (`--no-session`): they are on no
 * disk, and Pi's `/new` and `/fork` replace them in memory. They are kept with the session storage
 * the session would have been saved in, standing in for its file, and later loads of that storage
 * include them in both scopes, as they did while the session ran. A persisted session's prompts
 * are left to its file, which stays the authority, so deleting the file still removes them.
 */
export function rememberEndingSession({ storage, live }: SessionContext): void {
	if (!live.ephemeral) return;
	const { endedEphemeralPrompts } = storageState(storage);
	for (const record of userPrompts(live.entries, live.cwd)) keepNewest(endedEphemeralPrompts, record);
}

/** Resolve a user-configured path the way Pi does: `~` expands to home, relative to `cwd`. */
function resolveUserPath(path: string, cwd: string): string {
	if (path === "~") return homedir();
	if (path.startsWith("~/")) return join(homedir(), path.slice(2));
	return resolve(cwd, path);
}

export interface HistorySource {
	/** The scope's records newest first, restored and then de-duplicated on their text, at most the record limit of them. */
	load(scope: Scope, context: SessionContext, signal?: AbortSignal): Promise<HistoryRecord[]>;
}

export interface HistorySourceOptions {
	/** How many unique records, newest first, a load returns at most. */
	recordLimit: number;
}

/**
 * History drawn, in every scope, from the live session in Pi's memory and the ephemeral sessions
 * that ended in this process (see `rememberEndingSession`), and from the Pi session files in a
 * scope. Every session file in Pi's storage, the live session's included (another Pi process may
 * append to it), is found by listing its directories, and the working directory recorded in each
 * file's header decides whether the session is in scope; only in-scope files are read further.
 * What is read from a file is cached until it changes (see `refreshSessionFileCache`). Session
 * files are only ever read.
 *
 * Loading runs on Pi's main thread in time slices (see `timeSlices`): parsing, de-duplicating and
 * ordering the records yield to the event loop between slices, so Pi keeps handling keys and
 * rendering however large the history is, and an aborted load stops at the next slice.
 */
export function createHistorySource({ recordLimit }: HistorySourceOptions): HistorySource {
	return {
		async load(scope, context, signal) {
			const slices = timeSlices(signal);
			const inScope = scope === "global" ? async () => true : await inRepoScopeOf(context.cwd);
			const { live, storage } = context;
			const newest = new Map<string, HistoryRecord>();
			const keepAll = async (records: Iterable<HistoryRecord>) => {
				for (const record of records) {
					keepNewest(newest, record);
					if (slices.due()) await slices.next();
				}
			};
			await keepAll(userPrompts(live.entries, live.cwd));
			await keepAll(storageState(storage).endedEphemeralPrompts.values());
			for (const [path, cached] of await refreshSessionFileCache(storage)) {
				signal?.throwIfAborted();
				if (slices.due()) await slices.next();
				let prompts: HistoryRecord[];
				try {
					if (cached.cwd === undefined) cached.cwd = await recordedCwd(path);
					if (cached.cwd === null || !(await inScope(cached.cwd))) continue;
					prompts = cached.prompts ??= await readUserPrompts(path, cached.cwd, slices);
				} catch {
					signal?.throwIfAborted();
					continue; // Unreadable for now: skipped, and read again at the next load.
				}
				await keepAll(prompts);
			}
			return newestFirst([...newest.values()], recordLimit, slices);
		},
	};
}

/** How long history work runs on Pi's main thread at a time before letting it handle keys and render. */
const SLICE_MS = 8;

/** Time slices for history work that would otherwise hold Pi's main thread. */
interface TimeSlices {
	/** Whether the current slice has run its time; checked between small units of work. */
	due(): boolean;
	/** Yield to the event loop, so Pi handles pending keys and renders, then start the next slice. Rejects once the load is aborted. */
	next(): Promise<void>;
}

function timeSlices(signal: AbortSignal | undefined): TimeSlices {
	let start = performance.now();
	return {
		due: () => performance.now() - start >= SLICE_MS,
		async next() {
			await nextTurn(undefined, { signal });
			start = performance.now();
		},
	};
}

/** Records sorted in runs of this many at a time, a few milliseconds of work each. */
const SORT_RUN = 1024;

/**
 * The newest `limit` of `records`, newest first, in time slices: sorted runs of `SORT_RUN` records
 * are merged pairwise, each merge stopping after `limit` records. Records used at the same time
 * keep their order, as with a stable sort.
 */
async function newestFirst(records: HistoryRecord[], limit: number, slices: TimeSlices): Promise<HistoryRecord[]> {
	let runs: HistoryRecord[][] = [];
	for (let start = 0; start < records.length; start += SORT_RUN) {
		runs.push(records.slice(start, start + SORT_RUN).sort((a, b) => b.timestamp - a.timestamp));
		if (slices.due()) await slices.next();
	}
	while (runs.length > 1) {
		const merged: HistoryRecord[][] = [];
		for (let i = 0; i < runs.length; i += 2) merged.push(await merge(runs[i] ?? [], runs[i + 1] ?? [], limit, slices));
		runs = merged;
	}
	return (runs[0] ?? []).slice(0, limit);
}

/** The newest `limit` records of two runs sorted newest first, merged; on a tie, `first`'s record comes first. */
async function merge(first: HistoryRecord[], second: HistoryRecord[], limit: number, slices: TimeSlices): Promise<HistoryRecord[]> {
	const run: HistoryRecord[] = [];
	for (let i = 0, j = 0; run.length < limit; ) {
		const [a, b] = [first[i], second[j]];
		const next = b === undefined || (a !== undefined && a.timestamp >= b.timestamp) ? a : b;
		if (next === undefined) break;
		run.push(next);
		if (next === a) i++;
		else j++;
		if (slices.due()) await slices.next();
	}
	return run;
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

/** What the history source keeps about one session storage for the life of the Pi process. */
interface StorageState {
	/** What has been read from the storage's session files, by path. */
	files: Map<string, CachedSessionFile>;
	/** The prompts of the ephemeral sessions that ended in this process, by text, at their most recent use. */
	endedEphemeralPrompts: Map<string, HistoryRecord>;
}

/** Process-wide state by session storage (`JSON.stringify` of it), as kept on `globalThis`. */
type StorageStates = Map<string, StorageState>;

/** The process-wide state of the current version: records hold restored skill invocations. */
const STORAGE_STATES = Symbol.for("pi-history.storageStates.v2");

/**
 * The process-wide state an extension up to issue #6 left behind: the same shape, but its records
 * hold prompts as stored, skill envelopes included.
 */
const STORAGE_STATES_V1 = Symbol.for("pi-history.storageStates.v1");

/**
 * The history source's state for `storage`, kept in process-wide state: Pi re-imports the
 * extension's module at every session start (`/new`, `/resume`, `/fork`, `/reload`), so it lives on
 * `globalThis`, under a key versioned with its shape and with what its records hold, so an
 * extension updated by `/reload` never reads state an older one left behind as its own. What the
 * older one kept of the storage is taken over instead (see `takeOverV1State`).
 */
function storageState(storage: SessionStorage): StorageState {
	const global = globalThis as typeof globalThis & Record<symbol, StorageStates | undefined>;
	const states = (global[STORAGE_STATES] ??= new Map());
	const key = JSON.stringify(storage);
	let state = states.get(key);
	if (!state) {
		state = { files: new Map(), endedEphemeralPrompts: takeOverV1State(key) };
		states.set(key, state);
	}
	return state;
}

/**
 * Take over what an extension that kept prompts as stored (state v1) left behind for the storage
 * `key`, as after an update and `/reload`: the prompts of the ephemeral sessions that ended in this
 * process, which are on no disk, restored and de-duplicated again, each command at its most recent
 * use. What it read from session files is dropped rather than restored, since those files are read
 * again. Its state for the storage is removed once taken over.
 */
function takeOverV1State(key: string): Map<string, HistoryRecord> {
	const global = globalThis as typeof globalThis & Record<symbol, StorageStates | undefined>;
	const states = global[STORAGE_STATES_V1];
	const endedEphemeralPrompts = new Map<string, HistoryRecord>();
	for (const record of states?.get(key)?.endedEphemeralPrompts.values() ?? []) {
		keepNewest(endedEphemeralPrompts, { ...record, text: restoreSkillInvocation(record.text) });
	}
	states?.delete(key);
	if (states?.size === 0) delete global[STORAGE_STATES_V1];
	return endedEphemeralPrompts;
}

/**
 * Bring the cache of `storage` up to date with the session files there now, and return its
 * entries: an unchanged file keeps its cached entry, a new or changed one starts empty, and the
 * entries of files no longer there are dropped.
 */
async function refreshSessionFileCache(storage: SessionStorage): Promise<Map<string, CachedSessionFile>> {
	const paths = await sessionFiles(storage);
	const versions = await Promise.all(paths.map(versionOf));
	const state = storageState(storage);
	const current = new Map<string, CachedSessionFile>();
	paths.forEach((path, i) => {
		const version = versions[i];
		if (version === undefined) return;
		const cached = state.files.get(path);
		current.set(path, cached?.version === version ? cached : { version });
	});
	state.files = current;
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

/**
 * Every session file in Pi's storage. A directory that cannot be listed holds none.
 * List files directly: SessionManager.list/listAll parse every line to build summaries we do not
 * use. Reading headers first avoids parsing out-of-scope sessions.
 */
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

/**
 * The top-level directory of the git repository containing `dir`: the nearest top level at or above it.
 * Preserve symlink spellings: `git rev-parse --show-toplevel` resolves them, which can make the root
 * differ from the cwd strings Pi records (for example /var versus /private/var on macOS).
 */
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
 * Marks a line that may hold a user message (`"role":"user"`). Inside a JSON string, such as a
 * tool's text output, the quotes are escaped, so the mark does not occur there; a line whose JSON
 * objects hold it as a key or value, such as a tool call's arguments, is parsed and yields nothing.
 */
const USER_MARK = Buffer.from('"user"');
const NEWLINE = 0x0a;

/**
 * Every user prompt in one session file, in file order; a malformed line holds none. Rejects when
 * the file cannot be read, or the load is aborted. Only the lines holding `USER_MARK` are decoded
 * and parsed, found by scanning the bytes rather than decoding and splitting the whole file: tool
 * output lines can be megabytes and never hold a prompt. Each parsed line is turned into its
 * prompt at once, so nothing else it holds (such as an image) is kept, and the work yields to the
 * event loop whenever a time slice is spent.
 */
async function readUserPrompts(path: string, cwd: string, slices: TimeSlices): Promise<HistoryRecord[]> {
	const content = await readFile(path);
	const records: HistoryRecord[] = [];
	for (let at = content.indexOf(USER_MARK); at !== -1; ) {
		const start = content.lastIndexOf(NEWLINE, at) + 1;
		const newline = content.indexOf(NEWLINE, at);
		const end = newline === -1 ? content.length : newline;
		const record = userPromptOf(parseJson(content.toString("utf8", start, end)), cwd);
		if (record) records.push(record);
		at = content.indexOf(USER_MARK, end);
		if (slices.due()) await slices.next();
	}
	return records;
}

/**
 * Every user prompt among a session's entries, in order: every user message, on every branch and
 * before any compaction, since a prompt that was typed is history.
 */
function userPrompts(entries: readonly unknown[], cwd: string): HistoryRecord[] {
	return entries.flatMap((entry) => userPromptOf(entry, cwd) ?? []);
}

/**
 * The prompt a session entry holds, if it is a user message with text: its text restored (see
 * `restoreSkillInvocation`), before it is de-duplicated or cached, so every use of a record (the
 * list, the matcher's input, the confirmed text) sees the command that was typed.
 */
function userPromptOf(entry: unknown, cwd: string): HistoryRecord | undefined {
	if (!isObject(entry) || entry.type !== "message" || !isObject(entry.message)) return undefined;
	const message = entry.message;
	if (message.role !== "user") return undefined;
	const stored = userMessageText(message.content);
	if (stored === undefined || stored.trim() === "") return undefined;
	const text = restoreSkillInvocation(stored);
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

/** Record a use of a text in `newest`, unless it already holds a more recent one. */
function keepNewest(newest: Map<string, HistoryRecord>, record: HistoryRecord): void {
	const existing = newest.get(record.text);
	if (!existing || record.timestamp > existing.timestamp) newest.set(record.text, record);
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
