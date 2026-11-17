import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { type Harness, harnessWithPrompts, Keys } from "../harness.ts";

async function pressSearchKey(h: Harness): Promise<void> {
	h.press(Keys.ctrlR);
	await h.loaded();
}

describe("long records", () => {
	test("of megabytes, on one line or many, render as quickly as a short one", async (t) => {
		/** Median time to render the modal, opened with the record `text` selected. */
		const renderTime = async (text: string) => {
			const h = harnessWithPrompts(t, [text]);
			await h.start();
			await pressSearchKey(h);
			const samples: number[] = [];
			for (let i = 0; i < 7; i++) {
				const start = performance.now();
				h.overlayLines();
				samples.push(performance.now() - start);
			}
			return samples.sort((a, b) => a - b)[3] ?? Number.NaN;
		};
		const short = await renderTime("a short prompt");
		for (const [kind, text] of [
			["one line", "word ".repeat(800_000)],
			["many lines", "word word\n".repeat(400_000)],
		]) {
			const large = await renderTime(text ?? "");
			// Wrapping all of a 4 MB record takes about 330 ms, collapsing all of it into a row 30 to
			// 80 ms; a short one renders in well under a millisecond, hence the floor for timer noise.
			assert.ok(large < Math.max(2, short) * 5, `${kind}: ${short.toFixed(2)} ms short, ${large.toFixed(2)} ms at 4 MB`);
		}
	});

	test("ending in a long run of whitespace, before a line break or none, render whole in linear time", async (t) => {
		/** The rendered row and preview, and the median time to render the modal, with the record `text` selected. */
		const render = async (text: string) => {
			const h = harnessWithPrompts(t, [text]);
			await h.start();
			await pressSearchKey(h);
			const samples: number[] = [];
			for (let i = 0; i < 5; i++) {
				const start = performance.now();
				h.overlayLines();
				samples.push(performance.now() - start);
			}
			return { row: h.modalList()[0], preview: h.modalPreview(), ms: samples.sort((a, b) => a - b)[2] ?? Number.NaN };
		};
		for (const [kind, end, row, preview] of [
			["no line break", "", `› first${" ".repeat(68)}…`, ["first"]],
			["a line break after it", "\nsecond", "› first ↵ second", ["first", "second"]],
		] as const) {
			const [small, large] = [await render(`first${" ".repeat(2_500)}${end}`), await render(`first${" ".repeat(20_000)}${end}`)];
			assert.deepEqual([small.row, small.preview, large.row, large.preview], [row, preview, row, preview], kind);
			// 8 times the whitespace: linear work takes about 8 times as long, quadratic about 64 times.
			// The floor absorbs timer noise on renders of a millisecond or less.
			assert.ok(large.ms < Math.max(1, small.ms) * 24, `${kind}: ${small.ms.toFixed(2)} ms at 2,500, ${large.ms.toFixed(2)} ms at 20,000`);
		}
	});
});
