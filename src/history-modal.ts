import type { KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import { type Component, type TUI, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { HistoryRecord } from "./history-source.ts";

/** How the history modal closed. */
export type ModalResult = { kind: "confirm"; text: string } | { kind: "dismiss" };

export interface HistoryModalOptions {
	tui: TUI;
	theme: Theme;
	keybindings: KeybindingsManager;
	/** Loads the records to browse. The signal aborts when the modal closes. */
	loadRecords: (signal: AbortSignal) => Promise<HistoryRecord[]>;
	done: (result: ModalResult) => void;
}

type LoadState = { kind: "loading" } | { kind: "ready"; records: HistoryRecord[] } | { kind: "error"; message: string };

const MIN_LIST_ROWS = 3;
const MAX_LIST_ROWS = 15;
/** Rows the modal needs besides the list: frame, title separator and slack for Pi's own chrome. */
const RESERVED_ROWS = 10;

/**
 * The single Pi-drawn overlay through which history is browsed.
 *
 * Invariant: the modal never touches Pi's input bar. It only reports a result through `done`;
 * applying a confirmed record is the editor integration's job, and dismissal changes nothing.
 */
export class HistoryModal implements Component {
	private readonly options: HistoryModalOptions;
	private readonly abort = new AbortController();
	private state: LoadState = { kind: "loading" };
	/** Index into the records; 0 is the best candidate (the newest record). */
	private selected = 0;
	/** Index of the lowest list row on screen, so the selection can scroll into view. */
	private scrollOffset = 0;
	private closed = false;

	constructor(options: HistoryModalOptions) {
		this.options = options;
		options.loadRecords(this.abort.signal).then(
			(records) => this.setState({ kind: "ready", records }),
			(error: unknown) => {
				if (!this.abort.signal.aborted) this.setState({ kind: "error", message: errorMessage(error) });
			},
		);
	}

	handleInput(data: string): void {
		const { keybindings } = this.options;
		if (keybindings.matches(data, "tui.select.cancel")) {
			this.close({ kind: "dismiss" });
		} else if (keybindings.matches(data, "tui.select.confirm")) {
			const record = this.records()[this.selected];
			if (record) this.close({ kind: "confirm", text: record.text });
		} else if (keybindings.matches(data, "tui.select.up")) {
			this.moveSelection(1);
		} else if (keybindings.matches(data, "tui.select.down")) {
			this.moveSelection(-1);
		}
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
		const bottom = border(`╰${"─".repeat(Math.max(0, width - 2))}╯`);
		return [top, ...this.renderBody().map(row), bottom];
	}

	invalidate(): void {}

	dispose(): void {
		this.closed = true;
		this.abort.abort();
	}

	private renderBody(): string[] {
		const { theme } = this.options;
		if (this.state.kind === "loading") return [theme.fg("muted", "Loading history…")];
		if (this.state.kind === "error") return [theme.fg("error", `Could not read history: ${this.state.message}`)];
		const records = this.state.records;
		if (records.length === 0) return [theme.fg("muted", "No history yet")];

		const visible = this.listRows();
		this.scrollOffset = Math.min(Math.max(this.scrollOffset, this.selected - visible + 1), this.selected);
		const window = records.slice(this.scrollOffset, this.scrollOffset + visible);
		// The best candidate sits at the bottom, next to where the query line will be; older
		// records extend upwards, so Up moves both "older" and visually away from it.
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

	private records(): HistoryRecord[] {
		return this.state.kind === "ready" ? this.state.records : [];
	}

	private moveSelection(delta: number): void {
		const count = this.records().length;
		if (count === 0) return;
		this.selected = Math.max(0, Math.min(count - 1, this.selected + delta));
		this.options.tui.requestRender();
	}

	private setState(state: LoadState): void {
		if (this.closed) return;
		this.state = state;
		this.selected = 0;
		this.scrollOffset = 0;
		this.options.tui.requestRender();
	}

	private close(result: ModalResult): void {
		if (this.closed) return;
		this.dispose();
		this.options.done(result);
	}
}

/** Collapse a multi-line record into one row. */
function oneLine(text: string): string {
	return text.replace(/\s*\r?\n\s*/g, " ↵ ").replace(/\t/g, " ");
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
