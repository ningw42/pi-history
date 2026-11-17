import assert from "node:assert/strict";
import { statSync } from "node:fs";
import { join } from "node:path";
import { describe, type TestContext, test } from "node:test";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { restoreSkillInvocation } from "../src/skill-restoration.ts";
import { type Harness, harnessWithPrompts, Keys, minutesAfterT0, needsStub, useHarness } from "./harness.ts";

const LOCATION = "/abs/skills/code-review/SKILL.md";
const BODY = "Review the diff carefully.\n\n## Steps\n1. Read every hunk.";

/**
 * A skill invocation as Pi 1.5.2 stores it (`AgentSession._expandSkillCommand`): the skill block,
 * then, when arguments were typed, a blank line and the arguments. `baseDir` is the skill's base
 * directory, which Pi's own loader sets to the directory of its file.
 */
function skillEnvelope(
	options: { name?: string; location?: string; baseDir?: string; body?: string; args?: string } = {},
): string {
	const { name = "code-review", location = LOCATION, body = BODY, args } = options;
	const baseDir = options.baseDir ?? location.slice(0, location.lastIndexOf("/"));
	const block = `<skill name="${name}" location="${location}">\nReferences are relative to ${baseDir}.\n\n${body}\n</skill>`;
	return args === undefined ? block : `${block}\n\n${args}`;
}

describe("restoring a skill invocation", () => {
	const restored: [what: string, stored: string, expected: string][] = [
		["an invocation with arguments", skillEnvelope({ args: "review changes since main" }), "/skill:code-review review changes since main"],
		["an invocation without arguments", skillEnvelope(), "/skill:code-review"],
		[
			"arguments exactly as stored: line breaks, indentation, tabs, carriage returns and trailing space",
			skillEnvelope({ args: "first line\n\n  indented\ttabbed\r\nlast line " }),
			"/skill:code-review first line\n\n  indented\ttabbed\r\nlast line ",
		],
		[
			"arguments in any script, with quoting and shell or template syntax",
			skillEnvelope({ args: `"naïve" café — 日本語 🚀 $1 $(whoami) \`id\`` }),
			`/skill:code-review "naïve" café — 日本語 🚀 $1 $(whoami) \`id\``,
		],
		// Pi 1.5.2 writes the skill's base directory into the prologue. Its own loader sets that to the
		// file's directory, but a skill supplied as an object (through the SDK) may have any, even none.
		[
			"a base directory other than the skill file's directory",
			skillEnvelope({ location: "/abs/skills/code-review/SKILL.md", baseDir: "/abs/elsewhere", args: "go" }),
			"/skill:code-review go",
		],
		["an empty base directory", skillEnvelope({ baseDir: "", args: "go" }), "/skill:code-review go"],
		["a skill file with an empty body", skillEnvelope({ body: "", args: "go" }), "/skill:code-review go"],
		[
			"a name using every allowed kind of character",
			skillEnvelope({ name: "My_Skill.v2:beta-1", location: "/abs/skills/my/SKILL.md", args: "go" }),
			"/skill:My_Skill.v2:beta-1 go",
		],
		[
			"a location holding spaces",
			skillEnvelope({ location: "/abs/my skills/code review/SKILL.md", args: "go" }),
			"/skill:code-review go",
		],
		[
			"a closing tag right after the prologue's blank line, with no body line",
			`<skill name="code-review" location="${LOCATION}">\nReferences are relative to /abs/skills/code-review.\n\n</skill>\n\ngo`,
			"/skill:code-review go",
		],
		// Pi's own parser does not stop at a closing tag followed by a single line break, and Pi writes
		// nothing but the end of the text or a blank line after its own, so these cannot end the body.
		[
			"a body holding closing tags that cannot end it",
			skillEnvelope({ body: "Inline </skill> tag.\n</skill>X is no closer.\n</skill>\nnor is this.", args: "go" }),
			"/skill:code-review go",
		],
		[
			"a body line that is exactly the closing tag, followed by more instructions",
			skillEnvelope({ body: "example\n</skill>\nmore instructions", args: "go" }),
			"/skill:code-review go",
		],
		[
			"the same without arguments",
			skillEnvelope({ body: "example\n</skill>\nmore instructions" }),
			"/skill:code-review",
		],
		[
			"arguments holding closing tags that are not lines of their own",
			skillEnvelope({ args: "quote <skill>x</skill>\n</skill>X\nX</skill>\n </skill>" }),
			"/skill:code-review quote <skill>x</skill>\n</skill>X\nX</skill>\n </skill>",
		],
	];
	for (const [what, stored, expected] of restored) {
		test(`restores ${what}`, () => assert.equal(restoreSkillInvocation(stored), expected));
	}

	const invocation = skillEnvelope({ args: "go" });
	const prologue = "References are relative to /abs/skills/code-review.\n\n";
	const keptAsStored: [what: string, stored: string][] = [
		["a plain prompt", "fix the failing test"],
		["a skill command as typed", "/skill:code-review go"],
		["an empty text", ""],
		["an envelope after other text", `please look at this:\n${invocation}`],
		["an envelope after leading whitespace", ` ${invocation}`],
		...[".hidden", "-dash", ":colon", "_under", "has space", "slash/name", "tab\tname", "ünï", "line\nbreak", ""].map(
			(name): [string, string] => [`the unsafe name ${JSON.stringify(name)}`, skillEnvelope({ name, args: "go" })],
		),
		["a relative location", skillEnvelope({ location: "skills/code-review/SKILL.md", baseDir: "skills/code-review", args: "go" })],
		["an empty location", skillEnvelope({ location: "", baseDir: "/abs", args: "go" })],
		["a missing location", invocation.replace(` location="${LOCATION}"`, "")],
		["attributes in another order", invocation.replace(`name="code-review" location="${LOCATION}"`, `location="${LOCATION}" name="code-review"`)],
		["a missing prologue", invocation.replace(prologue, "")],
		["a prologue in other words", invocation.replace("References are", "references are")],
		["a line between the opening tag and the prologue", invocation.replace(prologue, `Note.\n${prologue}`)],
		["a prologue without its full stop", invocation.replace(prologue, "References are relative to /abs/skills/code-review\n\n")],
		["a prologue without its blank line", invocation.replace(prologue, "References are relative to /abs/skills/code-review.\n")],
		["a missing closing tag", invocation.replace("\n</skill>", "")],
		["a closing tag not on a line of its own", invocation.replace("\n</skill>", "</skill>")],
		["a closing tag followed by a single line break", invocation.replace("\n</skill>\n\n", "\n</skill>\n")],
		["a closing tag followed by text on its line", invocation.replace("\n</skill>\n\n", "\n</skill> ")],
		["a blank line after the closing tag with no arguments", `${skillEnvelope()}\n\n`],
		["CRLF line breaks", invocation.replaceAll("\n", "\r\n")],
		// The first closing tag that could end the body is in the body: what follows it holds a line that
		// is exactly the closing tag, so where the body ends, and what the arguments are, is ambiguous.
		["an early closing tag followed by a blank line in the body", skillEnvelope({ body: "Example:\n</skill>\n\nnot the arguments", args: "go" })],
		["the same without arguments", skillEnvelope({ body: "Example:\n</skill>\n\nnot the arguments" })],
		["a closing tag followed by a blank line as the body's first line", skillEnvelope({ body: "</skill>\n\nexample", args: "go" })],
		["the same without arguments, too", skillEnvelope({ body: "</skill>\n\nexample" })],
		...["</skill>", "</skill>\nafter", "before\n</skill>", "before\n</skill>\nafter", "before\n\n</skill>\n\nafter"].map(
			(args): [string, string] => [`arguments ${JSON.stringify(args)} with a line that is exactly the closing tag`, skillEnvelope({ args })],
		),
	];
	for (const [what, stored] of keptAsStored) {
		test(`keeps ${what} as stored`, () => assert.equal(restoreSkillInvocation(stored), stored));
	}
});

describe("restoring very large records", () => {
	const MB = 1024 * 1024;
	/** Records of about `size` characters, each with the text it must restore to. */
	const records = (size: number): Record<string, [stored: string, expected: string]> => {
		const kept = (stored: string): [string, string] => [stored, stored];
		return {
			body: [skillEnvelope({ body: "x".repeat(size), args: "go" }), "/skill:code-review go"],
			arguments: [skillEnvelope({ args: "y\n".repeat(size / 2) }), `/skill:code-review ${"y\n".repeat(size / 2)}`],
			bodyOfClosersThatCannotEndIt: [skillEnvelope({ body: "\n</skill>X".repeat(size / 10), args: "go" }), "/skill:code-review go"],
			noClosingTag: kept(skillEnvelope({ body: "\n</skill>X".repeat(size / 10) }).replace(/\n<\/skill>$/, "")),
			ambiguousArguments: kept(skillEnvelope({ args: `${"a\n</skill>X".repeat(size / 10)}\n</skill>` })),
			unterminatedName: kept(`<skill name="${"n".repeat(size)}`),
			longUnsafeName: kept(skillEnvelope({ name: `${"n".repeat(size)} `, args: "go" })),
		};
	};

	test("are restored, or kept as stored, whole", () => {
		for (const [kind, [stored, expected]] of Object.entries(records(4 * MB))) {
			const result = restoreSkillInvocation(stored);
			assert.equal(result.length, expected.length, kind);
			assert.equal(result === expected, true, kind);
		}
	});

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
		const [small, large] = [records(MB / 2), records(4 * MB)];
		for (const kind of Object.keys(small)) {
			const [t1, t8] = [median(small[kind]?.[0] ?? ""), median(large[kind]?.[0] ?? "")];
			// 8 times the input: linear work takes about 8 times as long, quadratic about 64 times. The
			// floor absorbs timer noise on inputs rejected in microseconds.
			assert.ok(t8 < Math.max(1, t1) * 24, `${kind}: ${t1.toFixed(2)} ms at 0.5 MB, ${t8.toFixed(2)} ms at 4 MB`);
			assert.ok(t8 < 250, `${kind}: ${t8.toFixed(2)} ms at 4 MB`);
		}
	});
});

describe("a stored skill invocation in the modal", () => {
	test("is listed, matched and confirmed as /skill:name arguments", needsStub, async (t) => {
		const restored = "/skill:code-review review changes since main";
		const h = harnessWithPrompts(t, ["older prompt", skillEnvelope({ args: "review changes since main" })], {
			stubMatcher: { responses: [{ query: "review", output: [restored] }] },
		});
		await h.start();

		h.press(Keys.ctrlR);
		await h.loaded();
		assert.deepEqual(h.modalList(), ["  older prompt", `› ${restored}`]);

		h.type("review");
		await h.waitFor(() => h.modalList().join() === `› ${restored}`, "results for review");
		// Exactly these records: no word of the skill body reaches the matcher.
		assert.deepEqual(h.matcherCalls()[0]?.input, [restored, "older prompt"]);

		h.press(Keys.enter);
		await h.flush();
		assert.equal(h.editorText(), restored);
		assert.deepEqual(h.submissions, []);
	});

	test("is one record per command, at its newest use, however the skill body changed", async (t) => {
		const h = harnessWithPrompts(t, [skillEnvelope({ args: "go" }), skillEnvelope({ args: "other" }), skillEnvelope()]);
		await h.start();
		// Typed again in the running session after the skill was edited.
		h.livePrompt(skillEnvelope({ body: "Edited instructions.", args: "go" }), minutesAfterT0(10));

		h.press(Keys.ctrlR);
		await h.loaded();

		assert.deepEqual(h.modalList(), ["  /skill:code-review other", "  /skill:code-review", "› /skill:code-review go"]);
	});
});

describe("updating from a version that kept prompts as stored", () => {
	type StoredPrompt = { text: string; timestamp: number };

	/**
	 * Leave, for the harness's session storage, the process-wide state that the extension up to
	 * issue #6 (`main` at 5fa1da4) left behind, keyed and shaped as it kept it: the prompts of the
	 * ephemeral sessions that ended in this process, by text as stored, and what it read from
	 * session files, prompts as stored. As after a `--no-session` run that went through `/new`.
	 */
	function leaveVersion1State(
		h: Harness,
		t: TestContext,
		state: { endedEphemeralPrompts: StoredPrompt[]; files: [path: string, prompts: StoredPrompt[]][] },
	): void {
		const key = JSON.stringify({ layout: "default", root: join(getAgentDir(), "sessions") });
		const versionOf = (path: string) => {
			const stats = statSync(path);
			return `${stats.dev}:${stats.ino}:${stats.size}:${stats.mtimeMs}`;
		};
		const record = (prompt: StoredPrompt) => ({ ...prompt, cwd: h.cwd });
		const global = globalThis as typeof globalThis & Record<symbol, Map<string, unknown> | undefined>;
		const states = (global[Symbol.for("pi-history.storageStates.v1")] ??= new Map());
		states.set(key, {
			files: new Map(state.files.map(([path, prompts]) => [path, { version: versionOf(path), cwd: h.cwd, prompts: prompts.map(record) }])),
			endedEphemeralPrompts: new Map(state.endedEphemeralPrompts.map((prompt) => [prompt.text, record(prompt)])),
		});
		t.after(() => global[Symbol.for("pi-history.storageStates.v1")]?.delete(key));
	}

	test("keeps the ended ephemeral sessions' prompts, restored, in both scopes, and reads session files afresh", async (t) => {
		const h = useHarness(t, { noSession: true });
		const fromDisk = skillEnvelope({ args: "from disk" });
		const file = h.writeSession({ cwd: h.cwd, prompts: [{ text: fromDisk, timestamp: minutesAfterT0(4) }] });
		leaveVersion1State(h, t, {
			endedEphemeralPrompts: [
				// Two uses of one command, kept apart by their skill bodies until restored; the newer one counts.
				{ text: skillEnvelope({ body: "Edited instructions.", args: "go" }), timestamp: minutesAfterT0(5) },
				{ text: "typed before the update", timestamp: minutesAfterT0(1) },
				{ text: skillEnvelope({ args: "go" }), timestamp: minutesAfterT0(2) },
			],
			files: [[file, [{ text: fromDisk, timestamp: minutesAfterT0(4) }]]],
		});

		await h.start("reload"); // the updated extension, in the session /new started
		h.press(Keys.ctrlR);
		await h.loaded();
		const restored = ["  typed before the update", "  /skill:code-review from disk", "› /skill:code-review go"];
		assert.deepEqual(h.modalList(), restored);

		h.press(Keys.ctrlR);
		await h.loaded();
		assert.match(h.modalTitle() ?? "", /History · global/);
		assert.deepEqual(h.modalList(), restored);
	});
});
