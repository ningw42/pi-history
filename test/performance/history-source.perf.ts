import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { type Harness, Keys, minutesAfterT0, useHarness } from "../harness.ts";

/**
 * Open the modal and press a key every 5 ms, as fast typing does, until its records have loaded:
 * a letter for the query line while it still shows "Loading history…". Returns the longest wait
 * between two keys being handled and how many letters were typed while loading.
 */
async function typeWhileLoading(h: Harness): Promise<{ longestWaitMs: number; typedWhileLoading: number }> {
	h.press(Keys.ctrlR);
	await h.flush();
	let previous = performance.now();
	let longestWaitMs = 0;
	let typedWhileLoading = 0;
	const typing = setInterval(() => {
		const now = performance.now();
		longestWaitMs = Math.max(longestWaitMs, now - previous);
		previous = now;
		if (h.modalList()[0] === "Loading history…") {
			h.type("x");
			typedWhileLoading++;
		}
	}, 5);
	try {
		await h.loaded();
	} finally {
		clearInterval(typing);
	}
	return { longestWaitMs, typedWhileLoading };
}

describe("loading a large history", () => {
	/** Far above the 5 ms between keys, and far below the stall of parsing the whole history at once (about 300 ms). */
	const PROMPT_KEY_LATENCY_MS = 100;

	test("keeps handling keys and editing the query while records are read, parsed and ordered", async (t) => {
		const h = useHarness(t);
		// 100,000 prompts, about 50 MB, in shuffled time order, so ordering them is real work too.
		const count = 100_000;
		h.writeSession({
			cwd: h.cwd,
			prompts: Array.from({ length: count }, (_, i) => ({
				text: `prompt ${i} ${"x".repeat(128)}`,
				timestamp: minutesAfterT0((i * 7919) % count),
			})),
		});
		h.writeConfig({ recordLimit: count });
		await h.start();

		const cold = await typeWhileLoading(h);
		t.diagnostic(`cold load: max key wait ${cold.longestWaitMs.toFixed(3)} ms; ${cold.typedWhileLoading} keys typed while loading`);
		assert.ok(cold.typedWhileLoading >= 3, `only ${cold.typedWhileLoading} keys were handled while loading`);
		// The query line scrolls a query wider than itself, so render it wide enough to show every letter.
		assert.equal(h.modalQuery(cold.typedWhileLoading + 10), `> ${"x".repeat(cold.typedWhileLoading)}`);
		assert.ok(cold.longestWaitMs < PROMPT_KEY_LATENCY_MS, `a key waited ${cold.longestWaitMs.toFixed(0)} ms on a cold load`);
		h.press(Keys.escape);
		await h.flush();

		const cached = await typeWhileLoading(h);
		t.diagnostic(`cached load: max key wait ${cached.longestWaitMs.toFixed(3)} ms; ${cached.typedWhileLoading} keys typed while loading`);
		assert.ok(cached.longestWaitMs < PROMPT_KEY_LATENCY_MS, `a key waited ${cached.longestWaitMs.toFixed(0)} ms on a cached load`);
		h.press(Keys.clearLine);
		// The newest is prompt 82321 (82321 × 7919 mod 100,000 = 99,999), then prompt 64642 (… = 99,998).
		await h.waitFor(() => /^› prompt 82321 x+…$/.test(h.modalList().at(-1) ?? ""), "the newest record selected");
		assert.match(h.modalList().at(-2) ?? "", /^ {2}prompt 64642 x+…$/);
	});
});
