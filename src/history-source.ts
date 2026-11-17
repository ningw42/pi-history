import type { Dirent } from "node:fs";
import { type FileHandle, open, readdir, readFile, stat } from "node:fs/promises";
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
}

/**
 * Where Pi keeps session files: in its default layout, one directory per working directory below a
 * root; with a custom session directory, that one directory, holding every session.
 */
export type SessionStorage = { layout: "default"; root: string } | { layout: "custom"; dir: string };

/**
 * The session context of a running Pi session. A persisted session reports its own session
 * directory: one directory below `<agent dir>/sessions` in Pi's default layout, else a custom one.
 * An ephemeral (`--no-session`) session reports none, so fall back to the custom directory
 * configured through Pi's documented environment variable or `sessionDir` setting, in Pi's
 * precedence order, else the default layout. A `--session-dir` flag given together with
 * `--no-session` is not visible to extensions.
 */
export function sessionContextOf(
	ctx: Pick<ExtensionContext, "cwd" | "sessionManager">,
	settingsSessionDir: string | undefined,
): SessionContext {
	const root = join(getAgentDir(), "sessions");
	const current = ctx.sessionManager.getSessionDir();
	const configured = process.env[SESSION_DIR_ENV] || settingsSessionDir;
	let custom: string | undefined;
	if (current) custom = resolve(dirname(current)) === resolve(root) ? undefined : current;
	else if (configured) custom = resolveUserPath(configured, ctx.cwd);
	return { cwd: ctx.cwd, storage: custom ? { layout: "custom", dir: custom } : { layout: "default", root } };
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
 * History drawn from the Pi session files in a scope. Every session file in Pi's storage is found by
 * listing its directories, and the working directory recorded in each file's header decides whether
 * the session is in scope; only in-scope files are read further. Session files are only ever read.
 */
export function createHistorySource({ recordLimit }: HistorySourceOptions): HistorySource {
	return {
		async load(scope, context, signal) {
			const inScope = scope === "global" ? async () => true : await inRepoScopeOf(context.cwd);
			const occurrences: HistoryRecord[] = [];
			for (const path of await sessionFiles(context.storage)) {
				signal?.throwIfAborted();
				const cwd = await recordedCwd(path);
				if (cwd === undefined || !(await inScope(cwd))) continue;
				occurrences.push(...(await readUserPrompts(path, cwd)));
			}
			return dedupeNewestFirst(occurrences).slice(0, recordLimit);
		},
	};
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
 * when the header records none, and undefined when the file cannot be read or does not start with
 * a session header (so it is not a session).
 */
async function recordedCwd(path: string): Promise<string | undefined> {
	let file: FileHandle | undefined;
	try {
		file = await open(path, "r");
		const chunks: Buffer[] = [];
		for (let position = 0; position < MAX_HEADER_BYTES; ) {
			const { bytesRead, buffer } = await file.read(Buffer.alloc(HEADER_CHUNK_BYTES), 0, HEADER_CHUNK_BYTES, position);
			const chunk = buffer.subarray(0, bytesRead);
			const newline = chunk.indexOf("\n");
			chunks.push(newline === -1 ? chunk : chunk.subarray(0, newline));
			if (bytesRead === 0 || newline !== -1) break;
			position += bytesRead;
		}
		const header: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
		if (!isObject(header) || header.type !== "session") return undefined;
		return typeof header.cwd === "string" ? header.cwd : "";
	} catch {
		return undefined;
	} finally {
		await file?.close();
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
 * Whether `dir` is the top-level directory of a git repository, recognised as Pi recognises one:
 * its `.git` is a directory holding `HEAD`, or a file (as in a linked worktree or a submodule) whose
 * `gitdir:` line names a directory holding `HEAD`. Anything else, such as an empty `.git`
 * directory, is not a repository, and the search goes on above it, as git's does.
 */
async function isRepositoryTopLevel(dir: string): Promise<boolean> {
	const git = join(dir, ".git");
	try {
		const stats = await stat(git);
		if (stats.isDirectory()) return await exists(join(git, "HEAD"));
		if (!stats.isFile()) return false;
		const content = (await readFile(git, "utf8")).trim();
		if (!content.startsWith(GITDIR_PREFIX)) return false;
		return await exists(join(resolve(dir, content.slice(GITDIR_PREFIX.length).trim()), "HEAD"));
	} catch {
		return false;
	}
}

async function exists(path: string): Promise<boolean> {
	return stat(path).then(
		() => true,
		() => false,
	);
}

/** Every user prompt in one session file, in file order. An unreadable file yields nothing. */
async function readUserPrompts(path: string, cwd: string): Promise<HistoryRecord[]> {
	let content: string;
	try {
		content = await readFile(path, "utf8");
	} catch {
		return [];
	}
	const records: HistoryRecord[] = [];
	for (const line of content.split("\n")) {
		// Cheap pre-filter: tool output lines can be megabytes and never hold a user prompt.
		if (!line.includes('"user"')) continue;
		const record = parseUserPrompt(line, cwd);
		if (record) records.push(record);
	}
	return records;
}

function parseUserPrompt(line: string, cwd: string): HistoryRecord | undefined {
	let entry: unknown;
	try {
		entry = JSON.parse(line);
	} catch {
		return undefined;
	}
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

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}
