import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";

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
	/** Directory holding the current session's files; empty for an ephemeral session. */
	sessionDir: string;
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
			const sessions = await SessionManager.list(cwd, context.sessionDir || undefined, undefined, signal);
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
