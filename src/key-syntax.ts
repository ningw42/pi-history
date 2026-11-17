import type { KeyId } from "@earendil-works/pi-tui";

/**
 * Pi's keybinding syntax, as Pi's key matching reads a key: in any case, modifiers each joined by
 * `+` to what follows, in any order, then a base key (`ctrl+shift+r`, `+` and `ctrl++` included).
 */

const MODIFIERS = ["ctrl", "shift", "alt", "super"];
/** Every base key of Pi's keybinding syntax, lower-cased as Pi compares them. */
const BASE_KEYS = new Set([
	..."abcdefghijklmnopqrstuvwxyz0123456789",
	..."`-=[]\\;',./!@#$%^&*()_+|~{}:<>?",
	...["escape", "esc", "enter", "return", "tab", "space", "backspace", "delete", "insert", "clear"],
	...["home", "end", "pageup", "pagedown", "up", "down", "left", "right"],
	...Array.from({ length: 12 }, (_, i) => `f${i + 1}`),
]);
/** Escape and its alias, which Pi's key matching never recognizes with any modifier. */
const UNMODIFIABLE_KEYS = new Set(["escape", "esc"]);
/** Base keys Pi's key matching treats as one. */
const ALIASES = new Map([
	["esc", "escape"],
	["return", "enter"],
]);

/** A key's modifiers, in the order written and repeats included, and its base key, lower-cased. */
function keyParts(key: string): { modifiers: string[]; base: string } {
	let base = key.toLowerCase();
	const modifiers: string[] = [];
	for (;;) {
		// "ctrl+" alone is the base key "ctrl+", not the modifier ctrl and nothing.
		const modifier = MODIFIERS.find((name) => base.startsWith(`${name}+`) && base.length > name.length + 1);
		if (!modifier) return { modifiers, base };
		modifiers.push(modifier);
		base = base.slice(modifier.length + 1);
	}
}

/**
 * Whether `value` is a key Pi can recognize: in Pi's keybinding syntax (modifiers, each at most
 * once, then a base key), and not a combination Pi's key matching rejects outright.
 */
export function isKeyId(value: unknown): value is KeyId {
	if (typeof value !== "string") return false;
	const { modifiers, base } = keyParts(value);
	return new Set(modifiers).size === modifiers.length && BASE_KEYS.has(base) && !(modifiers.length > 0 && UNMODIFIABLE_KEYS.has(base));
}

/**
 * Whether `a` and `b` are one key to Pi's key matching: the same modifiers, in any case and order,
 * and the same base key, `esc` being `escape` and `return` being `enter`.
 */
export function sameKey(a: string, b: string): boolean {
	const canonical = (key: string) => {
		const { modifiers, base } = keyParts(key);
		return [...new Set(modifiers)].sort().concat(ALIASES.get(base) ?? base).join("+");
	};
	return canonical(a) === canonical(b);
}
