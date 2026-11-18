export const LOCATION = "/abs/skills/code-review/SKILL.md";
const BODY = "Review the diff carefully.\n\n## Steps\n1. Read every hunk.";

/**
 * A skill invocation as Pi stores it (`AgentSession._expandSkillCommand`): the skill block,
 * then, when arguments were typed, a blank line and the arguments. `baseDir` is the skill's base
 * directory, which Pi's own loader sets to the directory of its file.
 */
export function skillEnvelope(
	options: { name?: string; location?: string; baseDir?: string; body?: string; args?: string } = {},
): string {
	const { name = "code-review", location = LOCATION, body = BODY, args } = options;
	const baseDir = options.baseDir ?? location.slice(0, location.lastIndexOf("/"));
	const block = `<skill name="${name}" location="${location}">\nReferences are relative to ${baseDir}.\n\n${body}\n</skill>`;
	return args === undefined ? block : `${block}\n\n${args}`;
}

/** Records of about `size` characters, each with the text it must restore to. */
export function largeSkillRecords(size: number): Record<string, [stored: string, expected: string]> {
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
}
