import type { KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import { type Component, type Focusable, Input, type TUI, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { HistoryRecord } from "./history-source.ts";
import type { MatchOutcome, Matcher } from "./matcher.ts";

/** How the history modal closed. */
export type ModalResult = { kind: "confirm"; text: string } | { kind: "dismiss" };

export interface HistoryModalOptions {
	tui: TUI;
	theme: Theme;
	keybindings: KeybindingsManager;
	/** The input bar's text when the modal opened; it becomes the starting query. */
	draft: string;
	/** Loads the records to browse. The signal aborts when the modal closes. */
	loadRecords: (signal: AbortSignal) => Promise<HistoryRecord[]>;
	/** Filters and ranks the records for a non-empty query. */
	matcher: Matcher;
	done: (result: ModalResult) => void;
}

type LoadState = { kind: "loading" } | { kind: "ready"; records: HistoryRecord[] } | { kind: "error"; message: string };

/**
 * What the list area shows once history has loaded. Records stay on screen while a newer query is
 * being matched, so the list does not flicker, but they cannot be confirmed until the latest
 * query's outcome replaces them.
 */
type Results =
	| { kind: "searching" }
	| { kind: "records"; records: HistoryRecord[] }
	| { kind: "failure"; message: string };

/** A pending or running matcher run; aborting `cancel` cancels it. */
interface SearchRun {
	cancel: AbortController;
	/** Set while the run waits out the debounce. */
	timer?: ReturnType<typeof setTimeout>;
}

/** Pause after a query edit before matching, so a burst of keys starts one matcher run. */
const SEARCH_DEBOUNCE_MS = 50;
const MIN_LIST_ROWS = 3;
const MAX_LIST_ROWS = 15;
/** Rows the modal needs besides the list: frame, query line and its rule, and slack for Pi's chrome. */
const RESERVED_ROWS = 12;

/**
 * The single Pi-drawn overlay through which history is browsed and searched.
 *
 * Invariant: the modal never touches Pi's input bar. It only reports a result through `done`;
 * applying a confirmed record is the editor integration's job, and dismissal changes nothing.
 */
export class HistoryModal implements Component, Focusable {
	private readonly options: HistoryModalOptions;
	private readonly abort = new AbortController();
	/** The query line: Pi's own single-line text input. */
	private readonly query = new Input({ prompt: "> " });
	private history: LoadState = { kind: "loading" };
	private results: Results = { kind: "searching" };
	/** Set from a query change until its outcome is shown; meanwhile the results are out of date. */
	private search: SearchRun | undefined;
	/** Index into the shown records; 0 is the best candidate. */
	private selected = 0;
	/** Index of the lowest list row on screen, so the selection can scroll into view. */
	private scrollOffset = 0;
	private hasFocus = false;

	constructor(options: HistoryModalOptions) {
		this.options = options;
		const query = startingQuery(options.draft);
		// Seeded as a bracketed paste: Input has no API to place the cursor, and a paste leaves it
		// at the end, ready for refining.
		if (query) this.query.handleInput(`\x1b[200~${query}\x1b[201~`);
		options
			.loadRecords(this.abort.signal)
			.then(
				(records): LoadState => ({ kind: "ready", records }),
				(error: unknown): LoadState => ({ kind: "error", message: errorMessage(error) }),
			)
			.then((history) => {
				if (this.abort.signal.aborted) return;
				this.history = history;
				this.queryChanged(0);
				this.options.tui.requestRender();
			});
	}

	handleInput(data: string): void {
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
		} else {
			const before = this.query.getValue();
			this.query.handleInput(data);
			if (this.query.getValue() !== before) this.queryChanged(SEARCH_DEBOUNCE_MS);
			this.options.tui.requestRender();
		}
	}

	/** Set by Pi's TUI; passed on so the query line shows the terminal cursor. */
	get focused(): boolean {
		return this.hasFocus;
	}

	set focused(value: boolean) {
		this.hasFocus = value;
		this.query.focused = value;
	}

	render(width: number): string[] {
		const { theme } = this.options;
		const inner = Math.max(1, width - 4);
		const border = (text: string) => theme.fg("borderAccent", text);
		const row = (content: string) => {
			const fitted = truncateToWidth(content, inner, "…");
			return `${border("│")} ${fitted}${" ".repeat(Math.max(0, inner - visibleWidth(fitted)))} ${border("│")}`;
		};

		const title = ` ${theme.bold("History")} `;
		const top = border("╭─") + title + border(`${"─".repeat(Math.max(0, width - 3 - visibleWidth(title)))}╮`);
		const rule = border(`├${"─".repeat(Math.max(0, width - 2))}┤`);
		const bottom = border(`╰${"─".repeat(Math.max(0, width - 2))}╯`);
		return [top, ...this.renderList().map(row), rule, ...this.query.render(inner).map(row), bottom];
	}

	invalidate(): void {}

	/** Closing aborts loading and any matcher run; the aborted signal also marks the modal closed. */
	dispose(): void {
		this.abort.abort();
		this.cancelSearch();
	}

	private renderList(): string[] {
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
		const records = this.results.records;
		if (records.length === 0) return [theme.fg("muted", "No matches")];

		const visible = this.listRows();
		this.scrollOffset = Math.min(Math.max(this.scrollOffset, this.selected - visible + 1), this.selected);
		const window = records.slice(this.scrollOffset, this.scrollOffset + visible);
		// The best candidate sits at the bottom, next to the query line; the rest extend upwards, so
		// Up moves both "older / lower-ranked" and visually away from the query.
		return window
			.map((record, offset) => {
				const index = this.scrollOffset + offset;
				const text = oneLine(record.text);
				return index === this.selected ? theme.fg("accent", `› ${text}`) : `  ${text}`;
			})
			.reverse();
	}

	private listRows(): number {
		const rows = this.options.tui.terminal.rows - RESERVED_ROWS;
		return Math.max(MIN_LIST_ROWS, Math.min(MAX_LIST_ROWS, rows));
	}

	private shownRecords(): HistoryRecord[] {
		return this.history.kind === "ready" && this.results.kind === "records" ? this.results.records : [];
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
			this.showResults({ kind: "records", records });
			return;
		}
		const cancel = new AbortController();
		const search: SearchRun = { cancel };
		this.search = search;
		search.timer = setTimeout(() => {
			search.timer = undefined;
			this.options.matcher
				.match(query, records, cancel.signal)
				// Only a cancelled run rejects, and its outcome is discarded below.
				.catch((error: unknown): MatchOutcome<HistoryRecord> => ({ kind: "failure", message: errorMessage(error) }))
				.then((outcome) => {
					if (cancel.signal.aborted) return;
					this.search = undefined;
					this.showResults(outcome.kind === "matches" ? { kind: "records", records: outcome.records } : outcome);
				});
		}, debounceMs);
	}

	private cancelSearch(): void {
		if (!this.search) return;
		clearTimeout(this.search.timer);
		this.search.cancel.abort();
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
		if (this.abort.signal.aborted) return;
		this.dispose();
		this.options.done(result);
	}
}

/**
 * The query a draft starts the modal with. A whitespace-only draft means no query. Otherwise the
 * draft is kept verbatim, so the matcher's search syntax applies, except that line breaks become
 * spaces: the query line holds one line, and the matcher separates terms on whitespace anyway.
 * (Pi's editor stores tabs as spaces, so the paste that seeds the query line changes nothing else.)
 */
function startingQuery(draft: string): string {
	return draft.trim() === "" ? "" : draft.replace(/\r\n|\r|\n/g, " ");
}

/** Collapse a multi-line record into one row. */
function oneLine(text: string): string {
	return text.replace(/\s*\r?\n\s*/g, " ↵ ").replace(/\t/g, " ");
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
