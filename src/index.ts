import { type ExtensionAPI, type ExtensionContext, getAgentDir } from "@earendil-works/pi-coding-agent";
import { loadConfig } from "./config.ts";
import { type ConfiguredParts, installEditorIntegration } from "./editor-integration.ts";
import { createHistorySource, sessionContextOf } from "./history-source.ts";
import { createMatcher } from "./matcher.ts";

/**
 * pi-history: one history modal for Pi's input bar.
 *
 * Inert outside TUI mode. In TUI mode, at the start of every session, the editor integration is
 * installed first, synchronously and before any I/O; the configuration file is read right
 * afterwards in the same synchronous step, so it is in place before any key reaches the editor.
 */
export default function piHistory(pi: ExtensionAPI): void {
	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		let configured!: ConfiguredParts;
		installEditorIntegration(ctx, {
			configured: () => configured,
			sessionContext: () => sessionContextOf(ctx, pi.getSettings().sessionDir),
		});
		const { config, problem } = loadConfig(getAgentDir());
		configured = {
			historySource: createHistorySource({ recordLimit: config.recordLimit }),
			matcher: createMatcher({ name: config.matcher, command: config.matcherCommand }),
			searchKey: config.searchKey,
		};
		reportConfigProblem(ctx, problem);
	});
}

/** Process-wide memory of the configuration problem last reported; undefined once there is none. */
const REPORTED_PROBLEM = Symbol.for("pi-history.reportedConfigProblem");

/**
 * Tell the user about a configuration problem once. Pi loads the extension afresh, re-importing its
 * module, at every session start (`/new`, `/resume`, `/fork` and `/reload` included), so only
 * process-wide state remembers what was already reported. A problem is reported when it is new or
 * has changed; fixing the file forgets it, so making the same mistake again is reported again.
 */
function reportConfigProblem(ctx: ExtensionContext, problem: string | undefined): void {
	const processState = globalThis as typeof globalThis & { [REPORTED_PROBLEM]?: string };
	if (problem && problem !== processState[REPORTED_PROBLEM]) ctx.ui.notify(problem, "warning");
	processState[REPORTED_PROBLEM] = problem;
}
