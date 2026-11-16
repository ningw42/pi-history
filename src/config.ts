import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import type { KeyId } from "@earendil-works/pi-tui";
import { MATCHER_NAMES, type MatcherName } from "./matcher.ts";

/** The configuration file's name in Pi's agent directory. */
const CONFIG_FILE_NAME = "pi-history.json";

/** Effective settings: what the file asked for, with defaults for anything absent or invalid. */
export interface Config {
	matcher: MatcherName;
	/** Executable to start for the matcher: a name looked up on PATH (by default the matcher's), or an absolute path. */
	matcherCommand: string;
	/** Opens the history modal from the input bar. */
	searchKey: KeyId;
	/** How many unique records, newest first, a scope holds at most. */
	recordLimit: number;
}

export interface LoadedConfig {
	config: Config;
	/** Everything wrong with the file, as one message for the user; undefined when nothing was. */
	problem?: string;
}

const DEFAULT_MATCHER: MatcherName = "fzf";
const DEFAULT_SEARCH_KEY: KeyId = "ctrl+r";
const DEFAULT_RECORD_LIMIT = 5000;

/**
 * Read the optional configuration file from `agentDir`. A missing file means defaults. A file that
 * cannot be read or parsed means defaults too; an invalid or unknown setting is ignored, keeping the
 * default for that setting only. Either way all problems are described in one message. Synchronous,
 * so the editor integration has its configuration before any key can arrive.
 */
export function loadConfig(agentDir: string): LoadedConfig {
	const path = join(agentDir, CONFIG_FILE_NAME);
	const ignoreFile = (why: string): LoadedConfig => ({
		config: settingsFrom({}, agentDir, []),
		problem: `pi-history: ignoring ${path}, which ${why}; using the default settings.`,
	});

	let content: string;
	try {
		content = readFileSync(path, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return { config: settingsFrom({}, agentDir, []) };
		return ignoreFile(`could not be read (${errorMessage(error)})`);
	}
	let file: unknown;
	try {
		file = JSON.parse(content);
	} catch (error) {
		return ignoreFile(`is not valid JSON (${errorMessage(error)})`);
	}
	if (typeof file !== "object" || file === null || Array.isArray(file)) return ignoreFile("does not hold a JSON object");

	const problems: string[] = [];
	const config = settingsFrom(file as Record<string, unknown>, agentDir, problems);
	return problems.length === 0
		? { config }
		: { config, problem: `pi-history: invalid settings in ${path}: ${problems.join("; ")}.` };
}

/** The settings in `file`, each replaced by its default when absent or invalid; problems are appended. */
function settingsFrom(file: Record<string, unknown>, agentDir: string, problems: string[]): Config {
	const setting = <T>(name: keyof Config, accept: (value: unknown) => T | undefined, requirement: string, fallback: T): T => {
		if (!Object.hasOwn(file, name)) return fallback;
		const value = accept(file[name]);
		if (value !== undefined) return value;
		problems.push(`"${name}" ${requirement}, using ${JSON.stringify(fallback)}`);
		return fallback;
	};

	const matcher = setting(
		"matcher",
		(value) => MATCHER_NAMES.find((name) => name === value),
		`must be ${MATCHER_NAMES.map((name) => JSON.stringify(name)).join(" or ")}`,
		DEFAULT_MATCHER,
	);
	const config: Config = {
		matcher,
		matcherCommand: setting("matcherCommand", (value) => commandOf(value, agentDir), "must be a command name or a path", matcher),
		searchKey: setting(
			"searchKey",
			(value) => (isKeyId(value) ? value : undefined),
			'must be a key Pi recognizes, such as "ctrl+t" (Escape takes no modifiers)',
			DEFAULT_SEARCH_KEY,
		),
		recordLimit: setting(
			"recordLimit",
			(value) => (Number.isSafeInteger(value) && (value as number) > 0 ? (value as number) : undefined),
			"must be a positive integer",
			DEFAULT_RECORD_LIMIT,
		),
	};
	for (const name of Object.keys(file)) {
		if (!Object.hasOwn(config, name)) problems.push(`${JSON.stringify(name)} is not a setting, ignored`);
	}
	return config;
}

/**
 * A matcher command: a bare name, left to be looked up on PATH, or a path. A leading `~/` means the
 * home directory, and any other relative path is relative to the agent directory, which holds the
 * configuration file (and Pi's own `bin` directory), not to the directory Pi happened to start in.
 * No path can contain NUL. Whether the executable exists is left to the matcher run to report.
 */
function commandOf(value: unknown, agentDir: string): string | undefined {
	if (typeof value !== "string" || value === "" || value.includes("\0")) return undefined;
	if (value.startsWith("~/")) return join(homedir(), value.slice(2));
	if (isAbsolute(value) || !/[/\\]/.test(value)) return value;
	return resolve(agentDir, value);
}

const MODIFIERS = ["ctrl", "shift", "alt", "super"];
/** Every base key of Pi's keybinding syntax, lower-cased as Pi compares them. */
const BASE_KEYS = new Set([
	..."abcdefghijklmnopqrstuvwxyz0123456789",
	..."`-=[]\\;',./!@#$%^&*()_+|~{}:<>?",
	...["escape", "esc", "enter", "return", "tab", "space", "backspace", "delete", "insert", "clear"],
	...["home", "end", "pageup", "pagedown", "up", "down", "left", "right"],
	...Array.from({ length: 12 }, (_, i) => `f${i + 1}`),
]);

/** Escape and its alias, which Pi's key matching never recognizes with any modifier. */
const UNMODIFIABLE_KEYS = new Set(["escape", "esc"]);

/**
 * Whether `value` is a key Pi can recognize: in Pi's keybinding syntax (modifiers, each at most
 * once, then a base key), and not a combination Pi's key matching rejects outright.
 */
function isKeyId(value: unknown): value is KeyId {
	if (typeof value !== "string") return false;
	let key = value.toLowerCase();
	const used = new Set<string>();
	for (;;) {
		const modifier = MODIFIERS.find((name) => key.startsWith(`${name}+`) && key.length > name.length + 1);
		if (!modifier) break;
		if (used.has(modifier)) return false;
		used.add(modifier);
		key = key.slice(modifier.length + 1);
	}
	return BASE_KEYS.has(key) && !(used.size > 0 && UNMODIFIABLE_KEYS.has(key));
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
