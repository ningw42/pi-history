/**
 * The matcher adapter against the real `fzf` binary on synthetic records. These tests fail, rather
 * than skip, when fzf is missing: the stub used by the extension-boundary tests cannot prove the
 * ranking contract.
 */
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";
import { createFzfMatcher, type MatchOutcome } from "../src/matcher.ts";

/** Records newest first, from the fuzzy-matching investigation. */
const INVESTIGATION_FIXTURE = [
	"reformat generated fixtures",
	"remove temporary git files",
	"inspect config",
	"fix regression tests",
	"rg foo",
	"git rebase feature",
	"fix startup selector bug",
];

async function match(query: string, texts: string[]): Promise<string[]> {
	const outcome: MatchOutcome<{ text: string }> = await createFzfMatcher().match(
		query,
		texts.map((text) => ({ text })),
		new AbortController().signal,
	);
	assert.equal(outcome.kind, "matches", outcome.kind === "failure" ? outcome.message : undefined);
	return outcome.kind === "matches" ? outcome.records.map((record) => record.text) : [];
}

describe("the fzf matcher, against the real fzf", () => {
	const inherited = { opts: process.env.FZF_DEFAULT_OPTS, file: process.env.FZF_DEFAULT_OPTS_FILE };
	beforeEach(() => {
		// Options that would break the ranking if they reached fzf.
		process.env.FZF_DEFAULT_OPTS = "--no-sort --tac";
		delete process.env.FZF_DEFAULT_OPTS_FILE;
	});
	afterEach(() => {
		for (const [name, value] of [
			["FZF_DEFAULT_OPTS", inherited.opts],
			["FZF_DEFAULT_OPTS_FILE", inherited.file],
		] as const) {
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
	});

	test("ranks an old obvious match above recent weak ones", async () => {
		const ranked = await match("rg", INVESTIGATION_FIXTURE);
		assert.equal(ranked[0], "rg foo");
	});

	test("keeps equal-quality matches newest first", async () => {
		assert.deepEqual(await match("task", ["zulu task", "alpha task", "mike task"]), [
			"zulu task",
			"alpha task",
			"mike task",
		]);
	});

	test("applies fzf's search syntax to the query", async () => {
		assert.deepEqual(await match("^fix", INVESTIGATION_FIXTURE), ["fix regression tests", "fix startup selector bug"]);
		assert.deepEqual(await match("'git !rebase", INVESTIGATION_FIXTURE), ["remove temporary git files"]);
	});

	test("round-trips multi-line and tab-containing records unchanged", async () => {
		const records = ["first line\nsecond line", "a\tcolumn", "\n  indented\n"];
		const ranked = await match("n", records);
		assert.deepEqual([...ranked].sort(), [...records].sort());
	});

	test("a query that matches nothing yields no matches, not a failure", async () => {
		assert.deepEqual(await match("zzzz", INVESTIGATION_FIXTURE), []);
	});
});
