import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { restoreSkillInvocation } from "../../src/skill-restoration.ts";
import { largeSkillRecords } from "../fixtures/skill-records.ts";

describe("restoring very large records", () => {
	const MB = 1024 * 1024;

	test("take roughly linear time", () => {
		const median = (text: string) => {
			const samples: number[] = [];
			for (let i = 0; i < 7; i++) {
				const start = performance.now();
				restoreSkillInvocation(text);
				samples.push(performance.now() - start);
			}
			return samples.sort((a, b) => a - b)[3] ?? Number.NaN;
		};
		const [small, large] = [largeSkillRecords(MB / 2), largeSkillRecords(4 * MB)];
		for (const kind of Object.keys(small)) {
			const [t1, t8] = [median(small[kind]?.[0] ?? ""), median(large[kind]?.[0] ?? "")];
			// 8 times the input: linear work takes about 8 times as long, quadratic about 64 times. The
			// floor absorbs timer noise on inputs rejected in microseconds.
			assert.ok(t8 < Math.max(1, t1) * 24, `${kind}: ${t1.toFixed(2)} ms at 0.5 MB, ${t8.toFixed(2)} ms at 4 MB`);
			assert.ok(t8 < 250, `${kind}: ${t8.toFixed(2)} ms at 4 MB`);
		}
	});
});
