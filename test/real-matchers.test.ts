/**
 * The matcher adapter against the real `fzf` and `sk` binaries on synthetic records. These tests
 * fail, rather than skip, when a binary is missing: the stub used by the extension-boundary tests
 * cannot prove the ranking contract.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { createMatcher, type MatchOutcome, type MatcherName } from "../src/matcher.ts";

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

/** Options that would break the ranking if they reached either matcher, inline or from a file. */
const HOSTILE_OPTIONS = "--no-sort --tac";
const OPTION_VARIABLES = ["FZF_DEFAULT_OPTS", "SKIM_DEFAULT_OPTIONS"];
const OPTION_FILE_VARIABLES = ["FZF_DEFAULT_OPTS_FILE", "SKIM_OPTIONS_FILE"];

for (const name of ["fzf", "sk"] as const satisfies readonly MatcherName[]) {
	async function match(query: string, texts: string[]): Promise<string[]> {
		const outcome: MatchOutcome<{ text: string }> = await createMatcher({ name }).match(
			query,
			texts.map((text) => ({ text })),
			new AbortController().signal,
		);
		assert.equal(outcome.kind, "matches", outcome.kind === "failure" ? outcome.message : undefined);
		return outcome.kind === "matches" ? outcome.records.map((record) => record.text) : [];
	}

	describe(`the ${name} matcher, against the real ${name}`, () => {
		const inherited = new Map<string, string | undefined>();
		let optionsDir: string;
		beforeEach(() => {
			optionsDir = mkdtempSync(join(tmpdir(), "pi-history-matcher-options-"));
			const optionsFile = join(optionsDir, "options");
			writeFileSync(optionsFile, HOSTILE_OPTIONS);
			for (const variable of [...OPTION_VARIABLES, ...OPTION_FILE_VARIABLES]) {
				inherited.set(variable, process.env[variable]);
			}
			for (const variable of OPTION_VARIABLES) process.env[variable] = HOSTILE_OPTIONS;
			for (const variable of OPTION_FILE_VARIABLES) process.env[variable] = optionsFile;
		});
		afterEach(() => {
			for (const [variable, value] of inherited) {
				if (value === undefined) delete process.env[variable];
				else process.env[variable] = value;
			}
			rmSync(optionsDir, { recursive: true, force: true });
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

		test(`applies ${name}'s search syntax to the query`, async () => {
			assert.deepEqual(await match("^fix", INVESTIGATION_FIXTURE), ["fix regression tests", "fix startup selector bug"]);
			assert.deepEqual(await match("'git !rebase", INVESTIGATION_FIXTURE), ["remove temporary git files"]);
		});

		test("round-trips multi-line and tab-containing records unchanged", async () => {
			const records = ["first line\nsecond line", "a\tcolumn", "\n  indented\n"];
			const ranked = await match("n", records);
			assert.deepEqual([...ranked].sort(), [...records].sort());
		});

		test("treats a query starting with '-' or '=' as a search term, not an option", async () => {
			assert.deepEqual(await match("-foo", ["bar", "-foo"]), ["-foo"]);
			assert.deepEqual(await match("--read0", ["bar", "--read0 flag"]), ["--read0 flag"]);
			assert.deepEqual(await match("=foo", ["bar", "=foo"]), ["=foo"]);
		});

		test("a query that matches nothing yields no matches, not a failure", async () => {
			assert.deepEqual(await match("zzzz", INVESTIGATION_FIXTURE), []);
		});
	});
}
