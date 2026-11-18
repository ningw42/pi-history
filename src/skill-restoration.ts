import { isAbsolute } from "node:path";

const OPENING_TAG_START = '<skill name="';
const LOCATION_ATTRIBUTE = '" location="';
const OPENING_TAG_END = '">\n';
const PROLOGUE = "References are relative to ";
const CLOSING_TAG = "</skill>";
const CLOSING_TAG_AT_LINE_START = `\n${CLOSING_TAG}`;

/** A name that can be typed back as `/skill:NAME`: letters, digits, `.`, `_`, `:` and `-`, starting with a letter or digit. */
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;

/**
 * The command a prompt was typed as, when it began with a skill invocation. Pi stores
 * `/skill:NAME ARGUMENTS` expanded into a skill envelope, followed by the arguments when there are
 * any (`AgentSession._expandSkillCommand`):
 *
 *   <skill name="NAME" location="FILE">\nReferences are relative to DIR.\n\nBODY\n</skill>[\n\nARGUMENTS]
 *
 * That is restored to `/skill:NAME`, or `/skill:NAME ARGUMENTS` with the arguments exactly as stored.
 * DIR is the skill's base directory: Pi's own loader sets it to FILE's directory, but a skill
 * supplied as an object may have any, even none, so it is not compared with FILE.
 *
 * Only an envelope that starts the text is restored, and only an unambiguous one: any other text,
 * including an envelope whose name could not be typed back as a command, whose FILE is not
 * absolute, or whose prologue line is missing or malformed, is returned as it is. The body ends at
 * the first closing tag, where Pi's own skill-block parser would stop: the first line after the
 * prologue's blank line, the body's first line included, that is exactly the closing tag and is
 * followed by the end of the text or by a blank line and arguments (Pi writes nothing else after
 * its own). When the text after it holds a line that is exactly the closing tag, the body might
 * end there instead, so the envelope is ambiguous. That parser is not used itself: it would take
 * the first closing tag even then, and it trims the arguments.
 * Nothing but the text is consulted, so a skill that is no longer loaded is restored too: history
 * shows what was typed.
 *
 * Linear in the length of the text, which may hold a skill body of megabytes.
 */
export function restoreSkillInvocation(text: string): string {
	if (!text.startsWith(OPENING_TAG_START)) return text;
	const nameEnd = text.indexOf(LOCATION_ATTRIBUTE, OPENING_TAG_START.length);
	if (nameEnd === -1) return text;
	const name = text.slice(OPENING_TAG_START.length, nameEnd);
	const locationStart = nameEnd + LOCATION_ATTRIBUTE.length;
	const openingTagEnd = text.indexOf(OPENING_TAG_END, locationStart);
	if (openingTagEnd === -1 || !SAFE_NAME.test(name) || !isAbsolute(text.slice(locationStart, openingTagEnd))) return text;

	// The prologue: one line naming the base directory, then a blank line. (PROLOGUE ends in a
	// space, so a line that starts with it and ends in "." names a directory, or none.)
	const prologueStart = openingTagEnd + OPENING_TAG_END.length;
	const prologueEnd = text.indexOf("\n", prologueStart);
	if (prologueEnd === -1 || !text.startsWith(PROLOGUE, prologueStart) || text[prologueEnd - 1] !== "." || text[prologueEnd + 1] !== "\n") {
		return text;
	}

	// From the blank line's line break on, so that a closing tag on the body's first line counts too.
	const blankLine = prologueEnd + 1;
	for (
		let closingTag = text.indexOf(CLOSING_TAG_AT_LINE_START, blankLine);
		closingTag !== -1;
		closingTag = text.indexOf(CLOSING_TAG_AT_LINE_START, closingTag + 1)
	) {
		const after = closingTag + CLOSING_TAG_AT_LINE_START.length;
		if (after === text.length) return `/skill:${name}`;
		if (text.startsWith("\n\n", after) && after + 2 < text.length) {
			const args = text.slice(after + 2);
			return hasClosingTagLine(args) ? text : `/skill:${name} ${args}`;
		}
	}
	return text;
}

/** Whether `text` holds a line that is exactly the closing tag. */
function hasClosingTagLine(text: string): boolean {
	return (
		text === CLOSING_TAG ||
		text.startsWith(`${CLOSING_TAG}\n`) ||
		text.endsWith(`\n${CLOSING_TAG}`) ||
		text.includes(`\n${CLOSING_TAG}\n`)
	);
}
