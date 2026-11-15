import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { type ExtensionContext, SessionManager } from "@earendil-works/pi-coding-agent";

/** Pi's documented environment override for the session directory. */
const SESSION_DIR_ENV = "PI_CODING_AGENT_SESSION_DIR";

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
	/** Directory Pi stores this directory's sessions in; undefined means Pi's default layout. */
	sessionDir: string | undefined;
}

/**
 * Where the sessions for `ctx.cwd` live. A persisted session reports its own directory. An
 * ephemeral (`--no-session`) session reports none, so fall back to the custom directory configured
 * through Pi's documented environment variable or `sessionDir` setting, in Pi's precedence order.
 * A `--session-dir` flag given together with `--no-session` is not visible to extensions.
 */
export function sessionContextOf(
	ctx: Pick<ExtensionContext, "cwd" | "sessionManager">,
	settingsSessionDir: string | undefined,
): SessionContext {
	const configured = process.env[SESSION_DIR_ENV] || settingsSessionDir;
	return {
		cwd: ctx.cwd,
		sessionDir: ctx.sessionManager.getSessionDir() || (configured ? resolveUserPath(configured, ctx.cwd) : undefined),
	};
}

/** Resolve a user-configured path the way Pi does: `~` expands to home, relative to `cwd`. */
function resolveUserPath(path: string, cwd: string): string {
	if (path === "~") return homedir();
	if (path.startsWith("~/")) return join(homedir(), path.slice(2));
	return resolve(cwd, path);
}

export interface HistorySource {
	/** Records newest first, de-duplicated on their text. */
	load(context: SessionContext, signal?: AbortSignal): Promise<HistoryRecord[]>;
}

/**
 * History drawn from Pi session files whose recorded working directory equals the current one.
 * Sessions are found through Pi's public session-listing API, so a custom session directory is
 * honoured. Session files are only ever read.
 */
export function createHistorySource(): HistorySource {
	return {
		async load(context, signal) {
			const cwd = resolve(context.cwd);
			const sessions = await SessionManager.list(cwd, context.sessionDir, undefined, signal);
			const occurrences: HistoryRecord[] = [];
			for (const session of sessions) {
				signal?.throwIfAborted();
				if (!session.cwd || resolve(session.cwd) !== cwd) continue;
				occurrences.push(...(await readUserPrompts(session.path, session.cwd)));
			}
			return dedupeNewestFirst(occurrences);
		},
	};
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
