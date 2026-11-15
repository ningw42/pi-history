import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { installEditorIntegration } from "./editor-integration.ts";
import { createHistorySource, sessionContextOf } from "./history-source.ts";

const DEFAULT_SEARCH_KEY = "ctrl+r";

/**
 * pi-history: one history modal for Pi's input bar.
 *
 * Inert outside TUI mode. In TUI mode the editor integration is installed synchronously at the
 * start of every session, before any asynchronous work.
 */
export default function piHistory(pi: ExtensionAPI): void {
	const historySource = createHistorySource();
	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		installEditorIntegration(ctx, {
			historySource,
			sessionContext: () => sessionContextOf(ctx, pi.getSettings().sessionDir),
			searchKey: DEFAULT_SEARCH_KEY,
		});
	});
}
