import { CustomEditor, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type EditorComponent, type KeyId, matchesKey } from "@earendil-works/pi-tui";
import { HistoryModal, type ModalResult } from "./history-modal.ts";
import type { HistorySource } from "./history-source.ts";

export interface EditorIntegrationOptions {
	historySource: HistorySource;
	/** Key that opens the history modal while the input bar has focus. */
	searchKey: KeyId;
}

/**
 * Install the entry points into the history modal on Pi's input bar.
 *
 * Must run synchronously inside `session_start`, before any asynchronous work: replacing the
 * editor later would dismiss a selector the user opened in the meantime (for example `/model`).
 * No history is read and no editor text is written here.
 */
export function installEditorIntegration(ctx: ExtensionContext, options: EditorIntegrationOptions): void {
	const previous = ctx.ui.getEditorComponent();
	ctx.ui.setEditorComponent((tui, theme, keybindings) => {
		const editor: EditorComponent =
			previous?.(tui, theme, keybindings) ?? new CustomEditor(tui, theme, keybindings, { embedWorkingStatus: true });
		let modalOpen = false;

		const openModal = () => {
			modalOpen = true;
			void ctx.ui
				.custom<ModalResult>(
					(modalTui, modalTheme, modalKeybindings, done) =>
						new HistoryModal({
							tui: modalTui,
							theme: modalTheme,
							keybindings: modalKeybindings,
							loadRecords: (signal) =>
								options.historySource.load(
									{ cwd: ctx.cwd, sessionDir: ctx.sessionManager.getSessionDir() },
									signal,
								),
							done,
						}),
					{ overlay: true, overlayOptions: { anchor: "bottom-center", width: "100%", maxHeight: "80%" } },
				)
				.then((result) => {
					modalOpen = false;
					// Dismissal leaves the input bar untouched. Confirmation replaces the whole draft;
					// setText leaves the cursor at the end. Nothing is submitted.
					if (result?.kind === "confirm") editor.setText(result.text);
					tui.requestRender();
				});
		};

		const handleInput = editor.handleInput.bind(editor);
		editor.handleInput = (data: string) => {
			// Checked before the editor sees the key, so the search key wins over Pi's own bindings.
			if (matchesKey(data, options.searchKey)) {
				if (!modalOpen) openModal();
				return;
			}
			handleInput(data);
		};
		return editor;
	});
}
