import { CustomEditor, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type EditorComponent, type KeyId, matchesKey } from "@earendil-works/pi-tui";
import { HistoryModal, type ModalResult, type SearchKeyConflict } from "./history-modal.ts";
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
	/** The current directory and Pi's session storage, resolved at every load (on opening the modal and on each scope switch). */
	sessionContext: () => SessionContext;
	/**
	 * Tells the user, once, that the search key cannot switch scope because a list key has it;
	 * called with undefined when no list key has it. Checked on every open, from the input the search
	 * key sent and the keybindings in effect then (Pi reloads them after `session_start` on `/reload`).
	 */
	reportSearchKeyConflict: (problem: string | undefined) => void;
}

/**
 * Install the entry points into the history modal on Pi's input bar.
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
		 * Set from the moment the search key opens a modal until its result has been applied. Pi
		 * mounts the overlay asynchronously and gives focus back to the editor before the result
		 * arrives, so keys from the same input batch can reach the editor in both windows. They
		 * belong to the modal instead (a closed modal cannot close again); otherwise a buffered Enter
		 * would submit the draft the modal is about to replace.
		 */
		let pending: { modal?: HistoryModal } | undefined;

		/** Open the modal for the search key, which arrived as `searchKeyInput`. */
		const openModal = ({ historySource, matcher, searchKey }: ConfiguredParts, searchKeyInput: string) => {
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
						options.reportSearchKeyConflict(conflictProblem(searchKey, session.modal.searchKeyConflict));
						return session.modal;
					},
					{ overlay: true, overlayOptions: { anchor: "bottom-center", width: "100%", maxHeight: "80%" } },
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
			handleInput(data);
		};
		return editor;
	});
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
