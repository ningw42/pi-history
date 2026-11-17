import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { matchesKey } from "@earendil-works/pi-tui";

/**
 * Opt-in filesystem barrier for the selector scenario. Only the fixture session's full read is
 * held; Pi, the history source and the modal still execute their real code. The native read is
 * finished first, so release schedules promise continuations, not another uncontrolled disk read.
 */
export default function heldHistoryRead(pi: ExtensionAPI): void {
	pi.on("session_start", (_event, ctx) => {
		const path = join(process.env.PI_CODING_AGENT_SESSION_DIR!, "history.jsonl");
		const readFile = fs.readFile;
		let release!: () => void;
		const gate = new Promise<void>((resolve) => { release = resolve; });
		let stopped = false;
		let restored = false;
		const restore = () => {
			if (restored) return;
			restored = true;
			fs.readFile = readFile;
			syncBuiltinESMExports();
		};
		fs.readFile = (async (...args: Parameters<typeof readFile>) => {
			if (args[0] !== path) return readFile(...args);
			restore(); // one read only, also restore the named ESM export
			const content = await readFile(...args);
			if (stopped) return content;
			ctx.ui.setTitle("PTY history read held"); // observable even under the overlay
			await gate;
			// Dismissal already aborted the load. After this final held read, the tiny
			// fixture parses synchronously; its next time-slice/record check rejects with
			// that signal, without starting more I/O. The modal's promise handlers discard
			// the result in microtasks. A check-phase callback runs after that chain.
			setImmediate(() => {
				if (!stopped) ctx.ui.setStatus("held-history", "PTY history read drained");
			});
			return content;
		}) as typeof readFile;
		syncBuiltinESMExports();
		const unsubscribe = ctx.ui.onTerminalInput((data) => {
			if (!matchesKey(data, "ctrl+g")) return;
			release();
			return { consume: true };
		});
		pi.on("session_shutdown", () => {
			stopped = true;
			unsubscribe();
			restore();
			release();
		});
	});
}
