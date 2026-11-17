import { CustomEditor, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type Editor, type EditorComponent, getKeybindings, type KeyId, matchesKey } from "@earendil-works/pi-tui";
import { HistoryModal, type ModalResult, OVERLAY_MAX_HEIGHT_PERCENT, type SearchKeyConflict } from "./history-modal.ts";
import type { HistorySource, SessionContext } from "./history-source.ts";
import type { Matcher } from "./matcher.ts";

/** The parts of the integration that come from the configuration. */
export interface ConfiguredParts {
	historySource: HistorySource;
	matcher: Matcher;
	/** Key that opens the history modal while the input bar has focus, and switches its scope inside it. */
	searchKey: KeyId;
}

export interface EditorIntegrationOptions {
	/**
	 * The configured parts, looked up on every key. Not called while installing, so the caller can
	 * install before any I/O and read the configuration right afterwards, in the same synchronous step.
	 */
	configured: () => ConfiguredParts;
	/**
	 * The current directory, Pi's session storage and the live session, resolved at every load (on
	 * opening the modal and on each scope switch), so prompts submitted moments ago are included.
	 */
	sessionContext: () => SessionContext;
	/**
	 * Tells the user, once, that the search key cannot switch scope because a list key has it;
	 * called with undefined when no list key has it. Checked on every open, from the input the search
	 * key sent and the keybindings in effect then (Pi reloads them after `session_start` on `/reload`).
	 * When the Up entry opens the modal, only a keybinding that has the search key itself is seen, so
	 * it is called only when there is one.
	 */
	reportSearchKeyConflict: (problem: string | undefined) => void;
}

/**
 * Install the entry points into the history modal on Pi's input bar.
 *
 * Wrap the editor rather than registering a shortcut: registration also applies outside TUI mode,
 * and Pi 1.5.2 reports Ctrl+R as a startup conflict with /resume's rename binding.
 *
 * Must run synchronously inside `session_start`, before any I/O: replacing the editor later would
 * dismiss a selector the user opened in the meantime (for example `/model`). No history is read,
 * no configuration is consulted and no editor text is written here.
 */
export function installEditorIntegration(ctx: ExtensionContext, options: EditorIntegrationOptions): void {
	const previous = ctx.ui.getEditorComponent();
	ctx.ui.setEditorComponent((tui, theme, keybindings) => {
		const editor: EditorComponent =
			previous?.(tui, theme, keybindings) ?? new CustomEditor(tui, theme, keybindings, { embedWorkingStatus: true });

		/**
		 * Set from the moment an entry point opens a modal until its result has been applied. Pi
		 * mounts the overlay asynchronously and gives focus back to the editor before the result
		 * arrives, so keys from the same input batch can reach the editor in both windows. They
		 * belong to the modal instead (a closed modal cannot close again); otherwise a buffered Enter
		 * would submit the draft the modal is about to replace.
		 */
		let pending: { modal?: HistoryModal } | undefined;

		/** Open the modal: for the search key, which arrived as `searchKeyInput`, or for the Up entry (undefined). */
		const openModal = ({ historySource, matcher, searchKey }: ConfiguredParts, searchKeyInput: string | undefined) => {
			const session: { modal?: HistoryModal } = {};
			pending = session;
			// The draft as the user wrote it: a collapsed paste counts with its content.
			const draft = editor.getExpandedText?.() ?? editor.getText();
			ctx.ui
				.custom<ModalResult>(
					(modalTui, modalTheme, modalKeybindings, done) => {
						session.modal = new HistoryModal({
							tui: modalTui,
							theme: modalTheme,
							keybindings: modalKeybindings,
							draft,
							loadRecords: (scope, signal) => historySource.load(scope, options.sessionContext(), signal),
							matcher,
							searchKey,
							searchKeyInput,
							done,
						});
						// Without the search key's input, a conflict the terminal causes cannot be ruled out.
						const conflict = session.modal.searchKeyConflict;
						if (searchKeyInput !== undefined || conflict) options.reportSearchKeyConflict(conflictProblem(searchKey, conflict));
						return session.modal;
					},
					{ overlay: true, overlayOptions: { anchor: "bottom-center", width: "100%", maxHeight: `${OVERLAY_MAX_HEIGHT_PERCENT}%` } },
				)
				.then((result) => {
					// Dismissal leaves the input bar untouched. Confirmation replaces the whole draft;
					// setText leaves the cursor at the end. Nothing is submitted.
					if (result?.kind === "confirm") editor.setText(result.text);
				})
				.finally(() => {
					if (pending === session) pending = undefined;
					tui.requestRender();
				});
		};

		const handleInput = editor.handleInput.bind(editor);
		editor.handleInput = (data: string) => {
			if (pending) {
				pending.modal?.handleInput(data);
				return;
			}
			// Checked before the editor sees the key, so the search key wins over Pi's own bindings.
			const configured = options.configured();
			if (matchesKey(data, configured.searchKey)) {
				openModal(configured, data);
				return;
			}
			// The Up/previous-history entry, when the editor exposes the public state it needs.
			if (startsHistoryRecall(editor, data)) {
				openModal(configured, undefined);
				return;
			}
			handleInput(data);
		};
		// Pi hands the input bar every prompt it submits or loads, for the editor's in-bar history.
		// They are dropped, so the editor gets none of Pi's history to recall into the bar, whatever
		// it lets the wrapper see. Independently preloaded or maintained history is not inspected or cleared.
		editor.addToHistory = () => {};
		return editor;
	});
}

/**
 * The keys an open autocomplete popup takes in Pi's editor, ahead of the editor's other bindings:
 * closing it, moving through it and completing with its selection.
 */
const AUTOCOMPLETE_KEYBINDINGS = [
	"tui.select.cancel",
	"tui.select.up",
	"tui.select.down",
	"tui.select.pageUp",
	"tui.select.pageDown",
	"tui.input.tab",
	"tui.select.confirm",
] as const;

/**
 * Whether the Up/previous-history entry takes `data`: the key bound to Pi's previous-history
 * action (unbound by default), anywhere; or the key bound to moving the
 * cursor up, pressed at the very start of the draft (Pi recalls from the first visual row only when
 * the draft is empty or the cursor is in its first column, which is the same place). An open
 * autocomplete popup keeps the keys it takes; outside it, these keys win over any other editor
 * action bound to them. Decided from the editor's public state and Pi's keybindings, as Pi's editor
 * decides it. Pi's editor contract does not require an editor to report its cursor and popup, so
 * for one that does not report both, this is never the place: the keys stay with that editor.
 */
function startsHistoryRecall(editor: EditorComponent & Partial<Pick<Editor, "getCursor" | "isShowingAutocomplete">>, data: string): boolean {
	if (typeof editor.getCursor !== "function" || typeof editor.isShowingAutocomplete !== "function") return false;
	const keybindings = getKeybindings();
	if (editor.isShowingAutocomplete() && AUTOCOMPLETE_KEYBINDINGS.some((name) => keybindings.matches(data, name))) return false;
	if (keybindings.matches(data, "tui.editor.historyPrevious")) return true;
	if (!keybindings.matches(data, "tui.editor.cursorUp")) return false;
	const { line, col } = editor.getCursor();
	return line === 0 && col === 0;
}

/** What to tell the user about a list key that has the search key too; undefined when none has. */
function conflictProblem(searchKey: KeyId, conflict: SearchKeyConflict | undefined): string | undefined {
	if (!conflict) return undefined;
	const { keybinding, description } = conflict;
	return (
		`pi-history: the search key "${searchKey}" also acts as ${keybinding} (${description}), through your Pi keybindings ` +
		"or because your terminal sends the same input for both keys. " +
		"In the history modal it keeps that action, so it cannot switch between repo and global scope. " +
		`Set another "searchKey" in pi-history.json, or rebind ${keybinding}.`
	);
}
