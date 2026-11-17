import { isAbsolute } from "node:path";

const OPEN = '<skill name="';
const LOCATION = '" location="';
const HEADER_END = '">\n';
const PROLOGUE = "References are relative to ";
const CLOSER = "\n</skill>";
const CLOSER_LINE = "</skill>";

/** A name that can be typed back as `/skill:NAME`: letters, digits, `.`, `_`, `:` and `-`, starting with a letter or digit. */
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;

/**
 * The command a prompt was typed as, when it began with a skill invocation. Pi 1.5.2 stores
 * `/skill:NAME ARGUMENTS` expanded into a skill envelope, followed by the arguments when there are
 * any (`AgentSession._expandSkillCommand`):
 *
 *   <skill name="NAME" location="FILE">\nReferences are relative to DIR.\n\nBODY\n</skill>[\n\nARGUMENTS]
 *
 * That is restored to `/skill:NAME`, or `/skill:NAME ARGUMENTS` with the arguments exactly as stored.
 * DIR is the skill's base directory: Pi's own loader sets it to FILE's directory, but a skill
 * supplied as an object may have any, so it is not compared with FILE.
 *
 * Only an envelope that starts the text is restored, and only an unambiguous one: any other text,
 * including an envelope whose name could not be typed back as a command, whose FILE is not
 * absolute or whose prologue is missing, is returned as it is. The body ends at the first closing
 * tag that is followed by the end of the text or by a blank line and arguments; when the text after
 * it holds a line that is exactly the closing tag, the body might end there instead, so the
 * envelope is ambiguous. Pi's own skill-block parser is not used: it takes the first closing tag
 * and trims the arguments. Nothing but the text is consulted, so a skill that is no longer loaded
 * is restored too: history shows what was typed.
 *
 * Linear in the length of the text, which may hold a skill body of megabytes.
 */
export function restoreSkillInvocation(text: string): string {
	if (!text.startsWith(OPEN)) return text;
	const nameEnd = text.indexOf(LOCATION, OPEN.length);
	if (nameEnd === -1) return text;
	const name = text.slice(OPEN.length, nameEnd);
	const locationStart = nameEnd + LOCATION.length;
	const headerEnd = text.indexOf(HEADER_END, locationStart);
	if (headerEnd === -1 || !SAFE_NAME.test(name) || !isAbsolute(text.slice(locationStart, headerEnd))) return text;

	// The prologue: one line naming a directory, then a blank line.
	const prologueStart = headerEnd + HEADER_END.length;
	const prologueEnd = text.indexOf("\n", prologueStart);
	if (
		prologueEnd === -1 ||
		!text.startsWith(PROLOGUE, prologueStart) ||
		prologueEnd - prologueStart <= PROLOGUE.length + 1 ||
		text[prologueEnd - 1] !== "." ||
		text[prologueEnd + 1] !== "\n"
	) {
		return text;
	}

	const bodyStart = prologueEnd + 2;
	for (let closer = text.indexOf(CLOSER, bodyStart); closer !== -1; closer = text.indexOf(CLOSER, closer + 1)) {
		const after = closer + CLOSER.length;
		if (after === text.length) return `/skill:${name}`;
		if (text.startsWith("\n\n", after) && after + 2 < text.length) {
			const args = text.slice(after + 2);
			return hasCloserLine(args) ? text : `/skill:${name} ${args}`;
		}
	}
	return text;
}

/** Whether `text` holds a line that is exactly the closing tag. */
function hasCloserLine(text: string): boolean {
	return (
		text === CLOSER_LINE ||
		text.startsWith(`${CLOSER_LINE}\n`) ||
		text.endsWith(`\n${CLOSER_LINE}`) ||
		text.includes(`\n${CLOSER_LINE}\n`)
	);
}
