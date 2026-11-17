import { appendFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Safety net at Pi's submission boundary; never reads or changes the editor. */
export default function guard(pi: ExtensionAPI): void {
	// Static, keyless catalog: /model is usable without credentials or a model service.
	const forbiddenModelCall = (): never => {
		appendFileSync(process.env.PTY_SUBMISSIONS!, "MODEL CALL\n");
		throw new Error("The PTY smoke suite must never call a model");
	};
	pi.registerProvider({
		id: "pty", name: "PTY fixture",
		auth: { apiKey: { name: "Keyless fixture", resolve: async () => ({ auth: {} }) } },
		getModels: () => ["smoke-alpha", "smoke-beta"].map((id) => ({
			id, name: id, provider: "pty", api: "openai-completions", baseUrl: "http://invalid.invalid",
			reasoning: false, input: ["text"], contextWindow: 8192, maxTokens: 1024,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		})),
		stream: forbiddenModelCall, streamSimple: forbiddenModelCall,
	});
	pi.on("session_start", (_event, ctx) => {
		ctx.ui.setStatus("pty", "PTY ready");
	});
	pi.on("input", (event) => {
		appendFileSync(process.env.PTY_SUBMISSIONS!, `${JSON.stringify(event.text)}\n`);
		return { action: "handled" };
	});
}
