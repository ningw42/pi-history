import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { test } from "node:test";

const guard = new URL("../scripts/check-node.mjs", import.meta.url).href;

function checkRuntime(node: string, alternative?: "bun" | "deno") {
	// Model runtime metadata in a child process without altering the test runner.
	const script = `
		Object.defineProperty(process.versions, "node", { value: ${JSON.stringify(node)} });
		${alternative ? `Object.defineProperty(process.versions, ${JSON.stringify(alternative)}, { value: "1.0.0" });` : ""}
		await import(${JSON.stringify(guard)});
	`;
	return spawnSync(process.execPath, ["--input-type=module", "--eval", script], {
		cwd: tmpdir(), encoding: "utf8",
	});
}

test("development guard accepts stable Node 26 releases regardless of working directory", () => {
	for (const version of ["26.0.0", "26.13.1", "26.99.0"]) {
		const result = checkRuntime(version);
		assert.equal(result.status, 0, result.stderr);
	}
});

test("development guard rejects older, newer and prerelease Node versions", () => {
	for (const version of ["22.19.0", "24.22.2", "25.0.0", "27.0.0", "26.0.0-rc.1"]) {
		const result = checkRuntime(version);
		assert.equal(result.status, 1);
		assert.match(result.stderr, /Development commands require Node 26\.x/);
		assert.ok(result.stderr.includes(`found Node ${version}`));
		assert.match(result.stderr, /Run nix develop/);
	}
});

for (const runtime of ["bun", "deno"] as const) {
	test(`development guard rejects ${runtime} even when reporting Node 26 compatibility`, () => {
		const result = checkRuntime("26.13.1", runtime);
		assert.equal(result.status, 1);
		assert.match(result.stderr, /Development commands require Node 26\.x/);
		assert.match(result.stderr, /found (Bun|Deno)/);
	});
}
