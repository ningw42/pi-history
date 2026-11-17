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
	/** The search key, which opened the modal; inside it, it switches between the repo and global scopes. */
	searchKey: KeyId;
	/** The input that opened the modal: the search key as this terminal sends it. */
	searchKeyInput: string;
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
 * The list keybinding that the search key also acts as, if any: the one the search key's own
 * input (as this terminal sent it to open the modal) matches in the effective Pi keybindings. So
 * a shared binding counts, and so does a key the terminal sends identically, such as Ctrl+M
 * arriving as Enter without the Kitty keyboard protocol; with the protocol they stay distinct.
 */
export function searchKeyConflict(searchKeyInput: string, keybindings: KeybindingsManager): SearchKeyConflict | undefined {
	const keybinding = LIST_KEYBINDINGS.find((name) => keybindings.matches(searchKeyInput, name));
	return keybinding && { keybinding, description: keybindings.getDefinition(keybinding).description ?? keybinding };
}

/** Pause after a query edit before matching, so a burst of keys starts one matcher run. */
const SEARCH_DEBOUNCE_MS = 50;
/** A line break as Pi's editor reads one: CRLF, CR or LF. */
const LINE_BREAK = /\r\n|\r|\n/;
const LINE_BREAKS = new RegExp(LINE_BREAK.source, "g");
/** Line breaks with the whitespace around them, which a list row collapses into one "↵". */
const LINE_BREAKS_AND_SPACE = new RegExp(`\\s*(?:${LINE_BREAK.source})\\s*`, "g");
/** Rows of the selected record the preview shows, terminal height permitting. */
const PREVIEW_ROWS = 4;
const MIN_LIST_ROWS = 3;
const MAX_LIST_ROWS = 15;
/**
 * Terminal rows the modal leaves to the list and the preview: all but its own five (the title, the
 * rule with the last use, the rule above the query line, the query line and the key hints) and
 * eight more, so the conversation stays in view. Down to a 12-row terminal, that keeps the modal
 * within the 80% of the terminal the editor integration allows the overlay; Pi would drop the
 * lines beyond it, the query line and key hints first.
 */
const RESERVED_ROWS = 13;

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
	/** The query line: Pi's own single-line text input. */
	private readonly query = new Input({ prompt: "> " });
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
		this.searchKeyConflict = searchKeyConflict(options.searchKeyInput, options.keybindings);
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
		const colour = SCOPE_COLOURS[this.scope];
		const border = (text: string) => theme.fg(colour, text);
		const row = (content: string) => {
			const fitted = truncateToWidth(content, inner, "…");
			return `${border("│")} ${fitted}${" ".repeat(Math.max(0, inner - visibleWidth(fitted)))} ${border("│")}`;
		};
		/** A horizontal edge with `label` embedded after its left corner. */
		const edge = (left: string, label: string, right: string) => {
			const room = Math.max(0, width - 3);
			const fitted = truncateToWidth(` ${label} `, room, "…");
			return border(`${left}─`) + fitted + border(`${"─".repeat(Math.max(0, room - visibleWidth(fitted)))}${right}`);
		};

		const top = edge("╭", theme.fg(colour, theme.bold(`History · ${this.scope}`)), "╮");
		const rule = border(`├${"─".repeat(Math.max(0, width - 2))}┤`);
		const selected = this.selectedRecord();
		// The label's room on the rule: the rule's own four columns and the label's padding aside.
		const lastUse = selected ? describeLastUse(selected, width - 5) : "";
		const previewRule = lastUse ? edge("├", theme.fg("muted", lastUse), "┤") : rule;
		const bottom = edge("╰", this.keyHints(), "╯");
		const { listRows, previewRows } = this.layout();
		return [
			top,
			...this.renderList(inner, listRows).map(row),
			previewRule,
			...this.renderPreview(selected, inner, previewRows).map(row),
			rule,
			...this.query.render(inner).map(row),
			bottom,
		];
	}

	/**
	 * The keys, in Pi's hint style: first what the search key does, which names the scope it switches
	 * to (or, when a list key has it, that the scope cannot be switched), so it is the last to be cut
	 * on a narrow terminal; then navigating, confirming and cancelling, each by the first key Pi's
	 * keybindings give it, and left out when they give it none.
	 */
	private keyHints(): string {
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
		].join("  ");
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
			lines[last] = `${truncateToWidth(lines[last] ?? "", Math.max(0, width - 2), "")} ${this.options.theme.fg("muted", "…")}`;
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

	private renderList(width: number, visible: number): string[] {
		const { theme } = this.options;
		if (this.history.kind === "loading") return [theme.fg("muted", "Loading history…")];
		if (this.history.kind === "error") return [theme.fg("error", `Could not read history: ${this.history.message}`)];
		if (this.history.records.length === 0) return [theme.fg("muted", "No history yet")];
		if (this.results.kind === "searching") return [theme.fg("muted", "Searching…")];
		if (this.results.kind === "failure") {
			return [
				theme.fg("error", `Search failed: ${this.results.message}`),
				theme.fg("muted", "Clear the query to browse recent prompts"),
			];
		}
		const { records } = this.results;
		if (records.length === 0) return [theme.fg("muted", "No matches")];

		this.scrollOffset = Math.min(Math.max(this.scrollOffset, this.selected - visible + 1), this.selected);
		const window = records.slice(this.scrollOffset, this.scrollOffset + visible);
		// The best candidate is the list's bottom row, the one nearest the query line; the rest extend
		// upwards, so Up moves both "older / lower-ranked" and visually away from the query.
		return window
			.map((record, offset) => {
				const index = this.scrollOffset + offset;
				const text = oneLine(record.text, width);
				return index === this.selected ? theme.fg("accent", `› ${text}`) : `  ${text}`;
			})
			.reverse();
	}

	/**
	 * How many rows the list and the preview get at the terminal's current height, read at every
	 * render, so the modal fits again after a resize. The preview gets up to `PREVIEW_ROWS`, down to
	 * one row while the list keeps its minimum; the list gets the rest, up to `MAX_LIST_ROWS`.
	 */
	private layout(): { listRows: number; previewRows: number } {
		const free = this.options.tui.terminal.rows - RESERVED_ROWS;
		const previewRows = Math.max(1, Math.min(PREVIEW_ROWS, free - MIN_LIST_ROWS));
		return { listRows: Math.max(MIN_LIST_ROWS, Math.min(MAX_LIST_ROWS, free - previewRows)), previewRows };
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

/** Arrow keys as the arrows Pi's own hints show. */
function arrow(key: string): string {
	return key === "up" ? "↑" : key === "down" ? "↓" : key;
}

/**
 * The first `rows` rows of `text`, its lines (broken where Pi's editor breaks them) wrapped to
 * `width`, and whether any of it is left over. Tabs become four spaces, as in Pi's
 * editor. Only as much of each line as can fill the rows is wrapped, so a record of megabytes is
 * previewed as quickly as a short one.
 */
function wrapRecord(text: string, width: number, rows: number): { lines: string[]; more: boolean } {
	// Every character but a zero-width one takes a column, so a line this long fills more rows than
	// are shown. Longer lines are cut here, and then more of the record follows, whatever its rows.
	const longest = (rows + 1) * width;
	const lines: string[] = [];
	for (let start = 0; lines.length <= rows; ) {
		// Room for a line break right after the longest line, CRLF included.
		const window = text.slice(start, start + longest + 2);
		const lineBreak = LINE_BREAK.exec(window);
		const cut = !lineBreak || lineBreak.index > longest;
		const end = cut ? Math.min(window.length, longest) : lineBreak.index;
		lines.push(...wrapTextWithAnsi(window.slice(0, end).replace(/\t/g, "    "), width));
		if (cut) return { lines: lines.slice(0, rows), more: lines.length > rows || start + end < text.length };
		start += end + lineBreak[0].length;
	}
	return { lines: lines.slice(0, rows), more: true };
}

/**
 * Collapse a multi-line record into one row, of more than `width` columns if the record has them.
 * Only as much of the record as fills the row is collapsed, so a record of megabytes is no slower.
 */
function oneLine(text: string, width: number): string {
	for (let length = 2 * (width + 1); ; length *= 2) {
		const row = text.slice(0, length).replace(LINE_BREAKS_AND_SPACE, " ↵ ").replace(/\t/g, " ");
		// Beyond `width` columns, a line break or character cut short by the slice is never shown.
		if (length >= text.length || visibleWidth(row) > width) return row;
	}
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
