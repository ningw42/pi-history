import { homedir } from "node:os";
import { sep } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { type KeybindingsManager, rawKeyHint, type Theme, type ThemeColor } from "@earendil-works/pi-coding-agent";
import {
	type Component,
	type Focusable,
	Input,
	type KeyId,
	matchesKey,
	type TUI,
	sliceByColumn,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import type { HistoryRecord, Scope } from "./history-source.ts";
import { sameKey } from "./key-syntax.ts";
import type { MatchOutcome, Matcher } from "./matcher.ts";

/** How the history modal closed. */
export type ModalResult = { kind: "confirm"; text: string } | { kind: "dismiss" };

export interface HistoryModalOptions {
	tui: TUI;
	theme: Theme;
	keybindings: KeybindingsManager;
	/** The input bar's text when the modal opened; it becomes the starting query. */
	draft: string;
	/** Loads a scope's records to browse. The signal aborts when the load is superseded or the modal closes. */
	loadRecords: (scope: Scope, signal: AbortSignal) => Promise<HistoryRecord[]>;
	/** Filters and ranks the records for a non-empty query. */
	matcher: Matcher;
	/** The search key: it opens the modal from the input bar, and inside it switches between the repo and global scopes. */
	searchKey: KeyId;
	/**
	 * The input that opened the modal when the search key did: the search key as this terminal
	 * sends it. Undefined when the Up entry opened the modal (see `searchKeyConflict`).
	 */
	searchKeyInput: string | undefined;
	done: (result: ModalResult) => void;
}

type LoadState = { kind: "loading" } | { kind: "ready"; records: HistoryRecord[] } | { kind: "error"; message: string };

/**
 * What the list area shows once history has loaded: an empty query's records newest first, or the
 * latest matcher outcome. Records stay on screen while a newer query is being matched, so the list
 * does not flicker, but they cannot be confirmed until the latest query's outcome replaces them.
 */
type Results = { kind: "searching" } | MatchOutcome<HistoryRecord>;

/** Each scope's frame and title colour: the usual highlighted border for repo, a contrasting one for global. */
const SCOPE_COLOURS: Record<Scope, ThemeColor> = { repo: "borderAccent", global: "warning" };

function otherScope(scope: Scope): Scope {
	return scope === "repo" ? "global" : "repo";
}

/** The modal's own keys, checked before the search key: Pi's keybindings for closing and navigating a list. */
const LIST_KEYBINDINGS = ["tui.select.cancel", "tui.select.confirm", "tui.select.up", "tui.select.down"] as const;

/** A list keybinding that has the search key too. */
export interface SearchKeyConflict {
	keybinding: (typeof LIST_KEYBINDINGS)[number];
	/** Pi's description of the keybinding, such as "Move selection up". */
	description: string;
}

/**
 * The list keybinding that the search key also acts as, if any, in the effective Pi keybindings.
 * When the search key opened the modal, its own input (as this terminal sent it) is matched: so a
 * shared binding counts, and so does a key the terminal sends identically, such as Ctrl+M arriving
 * as Enter without the Kitty keyboard protocol; with the protocol they stay distinct. Without that
 * input (the Up entry opened the modal), only a list keybinding that has the search key itself
 * counts.
 */
export function searchKeyConflict(
	searchKey: KeyId,
	searchKeyInput: string | undefined,
	keybindings: KeybindingsManager,
): SearchKeyConflict | undefined {
	const hasSearchKey = (name: (typeof LIST_KEYBINDINGS)[number]) =>
		searchKeyInput === undefined
			? keybindings.getKeys(name).some((key) => sameKey(key, searchKey))
			: keybindings.matches(searchKeyInput, name);
	const keybinding = LIST_KEYBINDINGS.find(hasSearchKey);
	return keybinding && { keybinding, description: keybindings.getDefinition(keybinding).description ?? keybinding };
}

/** Pause after a query edit before matching, so a burst of keys starts one matcher run. */
const SEARCH_DEBOUNCE_MS = 50;
/** A line break as Pi's editor reads one: CRLF, CR or LF. */
const LINE_BREAK = /\r\n|\r|\n/;
const LINE_BREAKS = new RegExp(LINE_BREAK.source, "g");
/**
 * Runs of whitespace: a list row collapses one holding a line break into one "↵". (Matching the
 * whitespace around a line break directly, as `\s*\n\s*`, backtracks through a long run without
 * one at every position: quadratic time.)
 */
const WHITESPACE_RUNS = /\s+/g;
/**
 * How much of the terminal's height the overlay may take, in percent. Pi drops the lines beyond
 * it, the bottom ones: the query line and key hints first.
 */
export const OVERLAY_MAX_HEIGHT_PERCENT = 80;
/** Rows of the selected record the preview shows, terminal height permitting. */
const PREVIEW_ROWS = 4;
const MIN_LIST_ROWS = 3;
const MAX_LIST_ROWS = 15;
/**
 * The modal's rows besides the list, the preview and any key hints above the bottom edge: the
 * title, the rule with the last use, the rule above the query line, the query line and the bottom
 * edge.
 */
const FRAME_ROWS = 5;
/** Terminal rows the modal leaves to the list and the preview when it can: all but its own, and eight more, so the conversation stays in view. */
const RESERVED_ROWS = FRAME_ROWS + 8;

/**
 * The single Pi-drawn overlay through which history is browsed and searched.
 *
 * Invariant: the modal never touches Pi's input bar. It only reports a result through `done`;
 * applying a confirmed record is the editor integration's job, and dismissal changes nothing.
 */
export class HistoryModal implements Component, Focusable {
	private readonly options: HistoryModalOptions;
	/** Set when the modal closes; then it ignores keys. */
	private closed = false;
	/** Pi's single-line input; render the prompt separately so it follows the shrinking gutter. */
	private readonly query = new Input({ prompt: "" });
	/** Every open starts in repo scope. */
	private scope: Scope = "repo";
	/** Cancels loading the current scope's records; a scope switch supersedes it. */
	private load: AbortController | undefined;
	private history: LoadState = { kind: "loading" };
	private results: Results = { kind: "searching" };
	/**
	 * Cancels the latest query's search, through its debounce and its matcher run. Set from a query
	 * change until its outcome is shown; meanwhile the results are out of date.
	 */
	private search: AbortController | undefined;
	/** Index into the shown records; 0 is the best candidate. */
	private selected = 0;
	/** Index of the lowest list row on screen, so the selection can scroll into view. */
	private scrollOffset = 0;
	/**
	 * The modal key the search key is also bound to, if any. That key keeps its list action, so
	 * the modal can always be closed and navigated, and the scope cannot be switched.
	 */
	readonly searchKeyConflict: SearchKeyConflict | undefined;

	constructor(options: HistoryModalOptions) {
		this.options = options;
		this.searchKeyConflict = searchKeyConflict(options.searchKey, options.searchKeyInput, options.keybindings);
		const query = startingQuery(options.draft);
		// Seeded as a bracketed paste: Input has no API to place the cursor, and a paste leaves it
		// at the end, ready for refining.
		if (query) this.query.handleInput(`\x1b[200~${query}\x1b[201~`);
		this.loadHistory();
	}

	handleInput(data: string): void {
		// Keys from the input batch that closed the modal still arrive here; they belong to the
		// closed modal, so they neither edit the query nor start a search.
		if (this.closed) return;
		const { keybindings } = this.options;
		if (keybindings.matches(data, "tui.select.cancel")) {
			this.close({ kind: "dismiss" });
		} else if (keybindings.matches(data, "tui.select.confirm")) {
			// Out-of-date results are not what the query line asks for (for example after typing a
			// query and Enter in one input batch), so they cannot be confirmed.
			const record = this.search ? undefined : this.shownRecords()[this.selected];
			if (record) this.close({ kind: "confirm", text: record.text });
		} else if (keybindings.matches(data, "tui.select.up")) {
			this.moveSelection(1);
		} else if (keybindings.matches(data, "tui.select.down")) {
			this.moveSelection(-1);
		} else if (matchesKey(data, this.options.searchKey)) {
			// After the list keys, which keep a key they share with it (see searchKeyConflict), and
			// ahead of the query line's editing keys.
			this.scope = otherScope(this.scope);
			this.loadHistory();
		} else {
			const before = this.query.getValue();
			this.query.handleInput(data);
			if (this.query.getValue() !== before) this.queryChanged(SEARCH_DEBOUNCE_MS);
			this.options.tui.requestRender();
		}
	}

	/** Set by Pi's TUI; passed on so the query line shows the terminal cursor. */
	get focused(): boolean {
		return this.query.focused;
	}

	set focused(value: boolean) {
		this.query.focused = value;
	}

	/**
	 * From top to bottom: the title, the list (its best candidate at the bottom), a rule naming the
	 * selected record's last use, the preview of that record, a rule, the query line, and the bottom
	 * edge with the key hints. Every row is cut to `width`, and the terminal's height is read anew,
	 * so a resize re-renders the modal to fit.
	 *
	 * The frame and title take the scope's colour and the title names the scope, so the scope is
	 * plain even where the two colours are hard to tell apart. The key hints start with the scope the
	 * search key switches to, or, when a list key has it, that the scope cannot be switched.
	 */
	render(width: number): string[] {
		const { theme } = this.options;
		const inner = Math.max(1, width - 4);
		// The selection and query indicators live in the left gutter; reserve the same room on
		// the right. Unmarked content and frame labels align with the prompt text, not its marker.
		const gutter = " ".repeat(Math.min(2, Math.floor((inner - 1) / 2)));
		const contentWidth = inner - 2 * gutter.length;
		const markedWidth = inner - gutter.length;
		const colour = SCOPE_COLOURS[this.scope];
		const border = (text: string) => theme.fg(colour, text);
		const row = (content: string) => {
			const fitted = truncateToWidth(content, markedWidth, "…");
			return `${border("│")} ${fitted}${" ".repeat(Math.max(0, inner - visibleWidth(fitted)))} ${border("│")}`;
		};
		const plainRow = (content: string) => row(gutter + content);
		/** A horizontal edge whose label shares the content's alignment and width. */
		const edge = (left: string, label: string, right: string) => {
			const fitted = truncateToWidth(label, contentWidth, "…");
			const before = "─".repeat(gutter.length);
			const after = "─".repeat(Math.max(0, width - 4 - gutter.length - visibleWidth(fitted)));
			return border(`${left}${before} `) + fitted + border(` ${after}${right}`);
		};

		const top = edge("╭", theme.fg(colour, theme.bold(`History · ${this.scope}`)), "╮");
		const rule = border(`├${"─".repeat(Math.max(0, width - 2))}┤`);
		const selected = this.selectedRecord();
		const lastUse = selected ? describeLastUse(selected, contentWidth) : "";
		const previewRule = lastUse ? edge("├", theme.fg("muted", lastUse), "┤") : rule;
		const hints = packHints(this.keyHints(), contentWidth);
		const { listRows, previewRows } = this.layout(hints.length - 1);
		return [
			top,
			...this.renderList(markedWidth, listRows, gutter).slice(0, listRows).map(row),
			previewRule,
			...this.renderPreview(selected, contentWidth, previewRows).map(plainRow),
			rule,
			...this.query.render(contentWidth).map((content) => row("> ".slice(0, gutter.length) + content)),
			...hints.slice(0, -1).map(plainRow),
			edge("╰", hints.at(-1) ?? "", "╯"),
		];
	}

	/**
	 * The keys, in Pi's hint style: first what the search key does, which names the scope it switches
	 * to (or, when a list key has it, that the scope cannot be switched); then navigating, confirming
	 * and cancelling, each by the first key Pi's keybindings give it, and left out when they give it
	 * none.
	 */
	private keyHints(): string[] {
		const { keybindings, searchKey } = this.options;
		const conflict = this.searchKeyConflict;
		const action = conflict
			? `${conflict.description.toLowerCase()} (scope switch unavailable)`
			: `switch to ${otherScope(this.scope)}`;
		/** The first key bound to `keybinding`; "" when none is. */
		const firstKey = (keybinding: (typeof LIST_KEYBINDINGS)[number]) => keybindings.getKeys(keybinding)[0] ?? "";
		const hint = (key: string, description: string) => (key ? [rawKeyHint(key, description)] : []);
		// Pi's own hints write the arrow keys as one "↑↓".
		const navigation = [firstKey("tui.select.up"), firstKey("tui.select.down")].filter(Boolean).map(arrow);
		return [
			rawKeyHint(searchKey, action),
			...hint(navigation.join(navigation.every((key) => key.length === 1) ? "" : "/"), "navigate"),
			...hint(firstKey("tui.select.confirm"), "confirm"),
			...hint(firstKey("tui.select.cancel"), "cancel"),
		];
	}

	/**
	 * The selected record with its line breaks, wrapped to `width`, in a fixed number of rows, so the
	 * list above does not move as the selection does. When more of the record does not fit, the last
	 * row ends with an ellipsis.
	 */
	private renderPreview(record: HistoryRecord | undefined, width: number, rows: number): string[] {
		const { lines, more } = record ? wrapRecord(record.text, width, rows) : { lines: [], more: false };
		const last = lines.length - 1;
		if (more && last >= 0) {
			const content = truncateToWidth((lines[last] ?? "").trimEnd(), Math.max(0, width - 2), "");
			lines[last] = `${content} ${this.options.theme.fg("muted", "…")}`;
		}
		return Array.from({ length: rows }, (_, index) => lines[index] ?? "");
	}

	invalidate(): void {}

	/** Closing marks the modal closed and aborts loading and any matcher run. */
	dispose(): void {
		this.closed = true;
		this.load?.abort();
		this.cancelSearch();
	}

	/**
	 * Load the current scope's records, then bring the results in line with the query. Any earlier
	 * load and search are cancelled and the list shows that it is loading, so records or results
	 * from the previous scope are never shown, or confirmed, under this one.
	 */
	private loadHistory(): void {
		this.load?.abort();
		this.cancelSearch();
		const load = new AbortController();
		this.load = load;
		this.history = { kind: "loading" };
		this.results = { kind: "searching" };
		this.options
			.loadRecords(this.scope, load.signal)
			.then(
				(records): LoadState => ({ kind: "ready", records }),
				(error: unknown): LoadState => ({ kind: "error", message: errorMessage(error) }),
			)
			.then((history) => {
				if (load.signal.aborted) return;
				this.history = history;
				this.queryChanged(0);
				this.options.tui.requestRender();
			});
		this.options.tui.requestRender();
	}

	private renderList(width: number, visible: number, gutter: string): string[] {
		const { theme } = this.options;
		const message = (colour: ThemeColor, text: string) => gutter + theme.fg(colour, text);
		if (this.history.kind === "loading") return [message("muted", "Loading history…")];
		if (this.history.kind === "error") return [message("error", `Could not read history: ${this.history.message}`)];
		if (this.history.records.length === 0) return [message("muted", "No history yet")];
		if (this.results.kind === "searching") return [message("muted", "Searching…")];
		if (this.results.kind === "failure") {
			return [
				message("error", `Search failed: ${this.results.message}`),
				message("muted", "Clear the query to browse recent prompts"),
			];
		}
		const { records } = this.results;
		if (records.length === 0) return [message("muted", "No matches")];

		// Keep the selection in view, and every row filled that can be: after a resize from a short
		// terminal, the better candidates below the selection come back into view.
		this.scrollOffset = Math.min(
			Math.max(this.scrollOffset, this.selected - visible + 1),
			this.selected,
			Math.max(0, records.length - visible),
		);
		const window = records.slice(this.scrollOffset, this.scrollOffset + visible);
		// The best candidate is the list's bottom row, the one nearest the query line; the rest extend
		// upwards, so Up moves both "older / lower-ranked" and visually away from the query.
		return window
			.map((record, offset) => {
				const index = this.scrollOffset + offset;
				const text = oneLine(record.text, width);
				return index === this.selected ? theme.fg("accent", "› ".slice(0, gutter.length) + text) : gutter + text;
			})
			.reverse();
	}

	/**
	 * How many rows the list and the preview get at the terminal's current height, read at every
	 * render, so the modal fits again after a resize, besides `hintRows` rows of key hints above the
	 * bottom edge. With rows to spare, the preview gets up to `PREVIEW_ROWS`, down to one while the
	 * list keeps `MIN_LIST_ROWS`; the list gets the rest, up to `MAX_LIST_ROWS`. On a terminal too
	 * short for that within the overlay's height limit, the preview gives up its rows first, then the
	 * list, down to the selected record's row, so the query line and key hints are always in view.
	 */
	private layout(hintRows: number): { listRows: number; previewRows: number } {
		const terminalRows = this.options.tui.terminal.rows;
		const free = terminalRows - RESERVED_ROWS - hintRows;
		let previewRows = Math.max(1, Math.min(PREVIEW_ROWS, free - MIN_LIST_ROWS));
		let listRows = Math.max(MIN_LIST_ROWS, Math.min(MAX_LIST_ROWS, free - previewRows));
		const room = Math.floor((terminalRows * OVERLAY_MAX_HEIGHT_PERCENT) / 100) - FRAME_ROWS - hintRows;
		previewRows = Math.max(0, Math.min(previewRows, room - listRows));
		listRows = Math.max(1, Math.min(listRows, room - previewRows));
		return { listRows, previewRows };
	}

	private shownRecords(): HistoryRecord[] {
		return this.history.kind === "ready" && this.results.kind === "matches" ? this.results.records : [];
	}

	private selectedRecord(): HistoryRecord | undefined {
		return this.shownRecords()[this.selected];
	}

	private moveSelection(delta: number): void {
		const count = this.shownRecords().length;
		if (count === 0) return;
		this.selected = Math.max(0, Math.min(count - 1, this.selected + delta));
		this.options.tui.requestRender();
	}

	/**
	 * Bring the results in line with the current query. An empty query lists every record newest
	 * first without running the matcher; otherwise one matcher run starts after `debounceMs`. Either
	 * way any earlier run is cancelled, so only the latest query's outcome is ever shown.
	 */
	private queryChanged(debounceMs: number): void {
		this.cancelSearch();
		if (this.history.kind !== "ready") return; // the search starts once records arrive
		const records = this.history.records;
		const query = this.query.getValue();
		if (query.trim() === "" || records.length === 0) {
			this.showResults({ kind: "matches", records });
			return;
		}
		const search = new AbortController();
		this.search = search;
		delay(debounceMs, undefined, { signal: search.signal })
			.then(() => this.options.matcher.match(query, records, search.signal))
			// Only a cancelled search rejects, and its outcome is discarded below.
			.catch((error: unknown): MatchOutcome<HistoryRecord> => ({ kind: "failure", message: errorMessage(error) }))
			.then((outcome) => {
				if (search.signal.aborted) return;
				this.search = undefined;
				this.showResults(outcome);
			});
	}

	private cancelSearch(): void {
		this.search?.abort();
		this.search = undefined;
	}

	/** Replace the results and select their best candidate. */
	private showResults(results: Results): void {
		this.results = results;
		this.selected = 0;
		this.scrollOffset = 0;
		this.options.tui.requestRender();
	}

	private close(result: ModalResult): void {
		this.dispose();
		this.options.done(result);
	}
}

/**
 * The query a draft starts the modal with. A whitespace-only draft means no query. Otherwise the
 * draft is kept verbatim, so the matcher's search syntax applies, except that line breaks become
 * spaces, because the query line (Pi's single-line Input) cannot hold one. fzf separates terms on
 * spaces only, so a multi-line draft's lines are then matched as separate terms, more loosely than
 * the exact multi-line text would be. (Pi's editor stores tabs as spaces, so the paste that seeds
 * the query line changes nothing else.)
 */
function startingQuery(draft: string): string {
	return draft.trim() === "" ? "" : draft.replace(LINE_BREAKS, " ");
}

/**
 * When and where a record was last used, in at most `width` columns: its local time, then its
 * working directory with the home directory as `~`, cut from the left if need be, so the end that
 * names the project stays. Either is left out when its session did not record it (the history
 * source gives such a record time 0 and directory ""); "" when both are.
 */
function describeLastUse(record: HistoryRecord, width: number): string {
	const date = new Date(record.timestamp);
	const twoDigits = (n: number) => String(n).padStart(2, "0");
	const time =
		record.timestamp > 0 && !Number.isNaN(date.getTime())
			? `${date.getFullYear()}-${twoDigits(date.getMonth() + 1)}-${twoDigits(date.getDate())} ` +
				`${twoDigits(date.getHours())}:${twoDigits(date.getMinutes())}`
			: "";
	const directory = shortenHome(record.cwd);
	const before = time && directory ? `${time} · ` : time;
	return before + truncateStart(directory, Math.max(1, width - visibleWidth(before)));
}

/** `text` in at most `width` columns: its end, after "…", when it is wider. Never splits a wide character. */
function truncateStart(text: string, width: number): string {
	const textWidth = visibleWidth(text);
	return textWidth <= width ? text : `…${sliceByColumn(text, textWidth - (width - 1), width - 1, true)}`;
}

/** `path` with the home directory written as `~`. */
function shortenHome(path: string): string {
	const home = homedir();
	if (!home || !path) return path;
	if (path === home) return "~";
	return path.startsWith(home + sep) ? `~${path.slice(home.length)}` : path;
}

/**
 * Key hints in rows of at most `width` columns: as many to a row as fit, two spaces apart, and a
 * hint wider than a row wrapped onto rows of its own, so every hint is shown whole.
 */
function packHints(hints: string[], width: number): string[] {
	const rows: string[] = [];
	for (const hint of hints) {
		const last = rows.at(-1);
		if (last !== undefined && visibleWidth(last) + 2 + visibleWidth(hint) <= width) rows[rows.length - 1] = `${last}  ${hint}`;
		else rows.push(...wrapTextWithAnsi(hint, Math.max(1, width)));
	}
	return rows;
}

/** Arrow keys as the arrows Pi's own hints show. */
function arrow(key: string): string {
	return key === "up" ? "↑" : key === "down" ? "↓" : key;
}

/**
 * The first `rows` rows of `text` as Pi wraps it to `width`, its lines broken where Pi's editor
 * breaks them and tabs as four spaces (as in Pi's editor), and whether it has more rows: those
 * rows and one more are wrapped, and no more of the record than they need (see `wrapLine`), so a
 * record of megabytes is previewed as quickly as a short one.
 */
function wrapRecord(text: string, width: number, rows: number): { lines: string[]; more: boolean } {
	const lines: string[] = [];
	for (let start: number | undefined = 0; start !== undefined && lines.length <= rows; ) {
		const line = wrapLine(text, start, width, rows + 1 - lines.length);
		lines.push(...line.rows);
		start = line.next;
	}
	return { lines: lines.slice(0, rows), more: lines.length > rows };
}

/**
 * The rows of the line of `text` starting at `start`, wrapped to `width` as Pi wraps the whole line,
 * and where the next line starts. A line longer than `needed` rows may instead give just `needed`
 * rows, the last of them possibly not as the whole line's (it is only counted, never shown), and
 * no next line.
 *
 * Such a line is wrapped from a prefix, doubled until it fills `needed` rows. Pi wraps greedily:
 * each row ends where the next word does not fit, a word too wide for any row starting a row of
 * its own. So the word the prefix cuts short changes only the row that holds it, the prefix's last.
 * Whitespace dropped at a row's end, and characters of several code units or none, may take more
 * doublings; the prefix never outgrows the line.
 */
function wrapLine(text: string, start: number, width: number, needed: number): { rows: string[]; next?: number } {
	const wrap = (line: string) => wrapTextWithAnsi(line.replace(/\t/g, "    "), width);
	for (let length = 2 * needed * width; ; length *= 2) {
		// One more character, so a CRLF whose CR ends the prefix is seen whole.
		const window = text.slice(start, start + length + 1);
		const lineBreak = LINE_BREAK.exec(window);
		if (lineBreak && lineBreak.index < length) {
			return { rows: wrap(window.slice(0, lineBreak.index)), next: start + lineBreak.index + lineBreak[0].length };
		}
		if (start + length >= text.length) return { rows: wrap(window) };
		const rows = wrap(window.slice(0, length));
		if (rows.length >= needed) return { rows: rows.slice(0, needed) };
	}
}

/**
 * Collapse a multi-line record into one row, its first `width` columns as the whole record's
 * would be: each run of whitespace holding a line break becomes one "↵", and tabs spaces. Only a
 * prefix of the record is collapsed, doubled until it fills the row, and never ending inside a
 * whitespace run, which collapses as a whole: a long record costs no more, though a run of
 * whitespace within the row's width is read to its end, a line break in it being what decides.
 * Every step is a single pass, so whitespace costs linear time, however long the run.
 */
function oneLine(text: string, width: number): string {
	for (let length = 2 * (width + 1); ; length *= 2) {
		const whitespace = /\s*/y; // sticky: the run of whitespace, if any, from where the prefix would end
		whitespace.lastIndex = Math.min(length, text.length);
		whitespace.exec(text);
		const end = whitespace.lastIndex;
		const row = text
			.slice(0, end)
			.replace(WHITESPACE_RUNS, (run) => (LINE_BREAK.test(run) ? " ↵ " : run.replace(/\t/g, " ")));
		// Past `width` columns, a character the prefix cut short is never shown.
		if (end >= text.length || visibleWidth(row) > width) return row;
	}
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
