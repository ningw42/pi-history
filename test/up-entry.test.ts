import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { CustomEditor, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { type EditorComponent, type KeybindingsConfig, matchesKey } from "@earendil-works/pi-tui";
import {
	assertModalShown,
	assertNoModal,
	type Harness,
	harnessWithPrompts,
	Keys,
	minutesAfterT0,
	needsStub,
	settle,
	windowsSkip,
} from "./harness.ts";

/** The completion the popup below the input bar has selected (its row starts with an arrow); undefined when no popup is open. */
function selectedCompletion(h: Harness): string | undefined {
	return h.editorLines().find((line) => line.trimStart().startsWith("→"));
}

/**
 * Open the autocomplete popup at the start of the empty input bar: Tab completes file paths, and
 * the current directory holds two files, so a popup lists them. Returns the completion it selects.
 */
async function openCompletionPopup(h: Harness): Promise<string | undefined> {
	for (const name of ["alpha.txt", "beta.txt"]) writeFileSync(join(h.cwd, name), "");
	h.press(Keys.tab);
	await h.waitFor(() => selectedCompletion(h) !== undefined, "the completion popup");
	assert.deepEqual(h.editorCursor(), { line: 0, col: 0 });
	return selectedCompletion(h);
}

/** Another extension's editor: Pi's custom editor, typing a marker on Ctrl+T and drawing a label under itself. */
class MarkerEditor extends CustomEditor {
	override handleInput(data: string): void {
		if (matchesKey(data, "ctrl+t")) {
			this.insertTextAtCursor("[marker]");
			return;
		}
		super.handleInput(data);
	}

	override render(width: number): string[] {
		return [...super.render(width), "marker editor"];
	}
}

/**
 * Another extension's editor that offers only Pi's editor contract (`EditorComponent`), around Pi's
 * own editor: Pi's editing, autocomplete and in-bar history work behind it, but its cursor and
 * autocomplete popup cannot be seen.
 */
function contractOnlyEditor(inner: CustomEditor): EditorComponent {
	return {
		getText: () => inner.getText(),
		setText: (text) => inner.setText(text),
		handleInput: (data) => inner.handleInput(data),
		render: (width) => inner.render(width),
		invalidate: () => inner.invalidate(),
		addToHistory: (text) => inner.addToHistory(text),
		insertTextAtCursor: (text) => inner.insertTextAtCursor(text),
		getExpandedText: () => inner.getExpandedText(),
		setAutocompleteProvider: (provider) => inner.setAutocompleteProvider(provider),
		get onSubmit() {
			return inner.onSubmit;
		},
		set onSubmit(handler) {
			inner.onSubmit = handler;
		},
		get onChange() {
			return inner.onChange;
		},
		set onChange(handler) {
			inner.onChange = handler;
		},
	};
}

/** An extension that installs the editor `create` builds as the input bar, at every session start. */
function editorExtension(create: (...args: ConstructorParameters<typeof CustomEditor>) => EditorComponent) {
	return (pi: ExtensionAPI) => {
		pi.on("session_start", (_event, ctx) => {
			ctx.ui.setEditorComponent((tui, theme, keybindings) => create(tui, theme, keybindings));
		});
	};
}

const markerEditorExtension = editorExtension((tui, theme, keybindings) => new MarkerEditor(tui, theme, keybindings));

/** How often an editor factory was installed in all, and how often other than synchronously in `session_start`. */
function factoryInstalls(h: Harness): { all: number; late: number } {
	return { all: h.editorFactoryInstalls, late: h.lateEditorFactoryInstalls };
}

/** Named pipes hold history loading open; Windows has none a test can make. */
const needsNamedPipes = windowsSkip("holding history loading open needs a named pipe");

describe("Up opens the history modal", () => {
	test("on an empty input bar, listing the newest records with no query", async (t) => {
		const h = harnessWithPrompts(t, ["older", "newer"]);
		await h.start();

		h.press(Keys.up);
		await h.loaded();

		assertModalShown(h);
		assert.equal(h.modalQuery(), ">");
		assert.deepEqual(h.modalList(), ["  older", "› newer"]);
		assert.deepEqual(h.matcherCalls(), []);
	});

	test("at the start of a draft, with the draft as the query", needsStub, async (t) => {
		const h = harnessWithPrompts(t, ["fix the bug", "write docs"]);
		await h.start();
		h.type("fix");
		h.press(Keys.lineStart);

		h.press(Keys.up);
		await h.waitFor(() => h.modalList().join() === "› fix the bug", "the draft's matches");

		assert.equal(h.modalQuery(), "> fix");
		assert.deepEqual(h.matcherCalls().map(({ input }) => input), [["write docs", "fix the bug"]]);
	});

	test("at the start of a whitespace-only draft, with no query", async (t) => {
		const h = harnessWithPrompts(t, ["older", "newer"]);
		await h.start();
		h.type("   ");
		h.press(Keys.lineStart);

		h.press(Keys.up);
		await h.loaded();

		assert.equal(h.modalQuery(), ">");
		assert.deepEqual(h.modalList(), ["  older", "› newer"]);
		assert.deepEqual(h.matcherCalls(), []);
	});

	test("on the first row of a draft, once Up has taken the cursor to its start, as Pi's own recall does", needsStub, async (t) => {
		const h = harnessWithPrompts(t, ["recalled"]);
		await h.start();
		h.type("draft");

		h.press(Keys.up);
		await h.flush();
		assertNoModal(h);
		assert.deepEqual({ text: h.editorText(), cursor: h.editorCursor() }, { text: "draft", cursor: { line: 0, col: 0 } });

		h.press(Keys.up);
		await h.flush();
		assertModalShown(h);
		assert.equal(h.modalQuery(), "> draft");
	});
});

describe("Up keeps moving the cursor", () => {
	test("on the lower lines of a multi-line draft", async (t) => {
		const h = harnessWithPrompts(t, ["recalled"]);
		await h.start();
		h.type("first line");
		h.press("\n");
		h.type("second");
		h.press("\n");
		h.type("third");

		h.press(Keys.up);
		await h.flush();
		assert.deepEqual(h.editorCursor(), { line: 1, col: "third".length });
		h.press(Keys.up);
		await h.flush();

		assertNoModal(h);
		assert.deepEqual({ text: h.editorText(), cursor: h.editorCursor() }, {
			text: "first line\nsecond\nthird",
			cursor: { line: 0, col: "third".length },
		});
	});

	test("on the lower rows of a long first line that wraps", async (t) => {
		const h = harnessWithPrompts(t, ["recalled"]);
		await h.start();
		const long = "word ".repeat(40).trimEnd(); // wraps over three rows of the 80-column editor
		h.type(long);

		h.press(Keys.up);
		await h.flush();

		assertNoModal(h);
		assert.equal(h.editorText(), long);
		const { line, col } = h.editorCursor();
		assert.equal(line, 0);
		assert.ok(col > 0 && col < long.length, `the cursor moved up a row, to column ${col}`);
	});
});

describe("Down outside the modal", () => {
	test("never opens it: it moves the cursor, as on any line of a draft", async (t) => {
		const h = harnessWithPrompts(t, ["recalled"]);
		await h.start();

		h.press(Keys.down);
		await h.flush();
		assertNoModal(h);

		h.type("first");
		h.press("\n");
		h.type("second");
		h.press(Keys.up, Keys.lineStart); // to the start of the draft
		h.press(Keys.down);
		await h.flush();
		assertNoModal(h);
		assert.deepEqual(h.editorCursor(), { line: 1, col: 0 });

		h.press(Keys.down);
		await h.flush();
		assertNoModal(h);
		assert.deepEqual({ text: h.editorText(), cursor: h.editorCursor() }, { text: "first\nsecond", cursor: { line: 1, col: "second".length } });
	});
});

describe("the autocomplete popup", () => {
	test("keeps Up while it is open, even at the start of the draft", async (t) => {
		const h = harnessWithPrompts(t, ["recalled"]);
		await h.start();
		const before = await openCompletionPopup(h);

		h.press(Keys.up);
		await h.flush();

		assertNoModal(h);
		assert.notEqual(selectedCompletion(h), before);
		assert.equal(h.editorText(), "");
	});

	test("once closed, gives Up back to the Up entry", async (t) => {
		const h = harnessWithPrompts(t, ["recalled"]);
		await h.start();
		await openCompletionPopup(h);

		h.press(Keys.escape, Keys.up);
		await h.loaded();

		assert.deepEqual(h.modalList(), ["› recalled"]);
	});

	test("keeps Up when Pi's keybindings make it the popup's cancel key: Up closes it, as in Pi", async (t) => {
		const h = harnessWithPrompts(t, ["recalled"], {
			keybindings: { "tui.select.up": "alt+k", "tui.select.cancel": ["escape", "up"] },
		});
		await h.start();
		await openCompletionPopup(h);

		h.press(Keys.up);
		await h.flush();

		assertNoModal(h);
		assert.equal(selectedCompletion(h), undefined);
		assert.equal(h.editorText(), "");
	});

	for (const [keybinding, defaultKey] of [
		["tui.input.tab", "tab"],
		["tui.select.confirm", "enter"],
	] as const) {
		test(`keeps Up when Pi's keybindings make it a completing key (${keybinding}): Up completes, as in Pi`, async (t) => {
			const h = harnessWithPrompts(t, ["recalled"], {
				keybindings: { "tui.select.up": "alt+k", [keybinding]: [defaultKey, "up"] },
			});
			await h.start();
			const selected = await openCompletionPopup(h);

			h.press(Keys.up);
			await h.flush();

			assertNoModal(h);
			assert.equal(selectedCompletion(h), undefined);
			assert.ok(selected?.includes(h.editorText().trim()) && h.editorText().trim() !== "", `completed ${JSON.stringify(h.editorText())} from ${selected}`);
			assert.deepEqual(h.submissions, []);
		});
	}
});

describe("Pi's previous-history action, when the user binds a key to it", () => {
	test("opens the modal at any cursor position, with the draft as the query", needsStub, async (t) => {
		const h = harnessWithPrompts(t, ["recalled"], { keybindings: { "tui.editor.historyPrevious": "alt+p" } });
		await h.start();
		h.type("first");
		h.press("\n");
		h.type("second");
		h.press(Keys.left, Keys.left);

		h.press(Keys.altP);
		await h.flush();

		assertModalShown(h);
		assert.equal(h.modalQuery(), "> first second");
	});

	test("opens the modal while the autocomplete popup is open, which does not use that key", async (t) => {
		const h = harnessWithPrompts(t, ["recalled"], { keybindings: { "tui.editor.historyPrevious": "alt+p" } });
		await h.start();
		await openCompletionPopup(h);

		h.press(Keys.altP);
		await h.loaded();

		assert.deepEqual(h.modalList(), ["› recalled"]);
	});

	test("bound to Up, leaves Up to the autocomplete popup while it is open", async (t) => {
		const h = harnessWithPrompts(t, ["recalled"], { keybindings: { "tui.editor.historyPrevious": "up" } });
		await h.start();
		const before = await openCompletionPopup(h);

		h.press(Keys.up);
		await h.flush();

		assertNoModal(h);
		assert.notEqual(selectedCompletion(h), before);
	});
});

describe("Pi's in-bar history recall", () => {
	test("is unreachable: no key recalls a prompt into the input bar", async (t) => {
		const h = harnessWithPrompts(t, ["from an earlier session"], {
			keybindings: { "tui.editor.historyPrevious": "alt+p", "tui.editor.historyNext": "alt+n" },
		});
		h.livePrompt("from this session", minutesAfterT0(10));
		await h.start(); // Pi hands this session's prompts to the input bar's history
		h.type("submitted now");
		h.press(Keys.enter); // and every prompt it submits
		assert.deepEqual(h.submissions, ["submitted now"]);

		for (const key of [Keys.up, Keys.altP]) {
			h.press(key);
			await h.loaded();
			assertModalShown(h);
			h.press(Keys.escape);
			await h.flush();
			assert.equal(h.editorText(), "", `after ${JSON.stringify(key)} and Escape`);
		}
		for (const key of [Keys.down, Keys.altN]) {
			h.press(key);
			await h.flush();
			assertNoModal(h);
			assert.equal(h.editorText(), "", `after ${JSON.stringify(key)}`);
		}
	});
});

describe("a modal opened with Up", () => {
	test("confirms into the input bar without submitting, so Up then Enter recalls the newest record", async (t) => {
		const h = harnessWithPrompts(t, ["older", "newest"]);
		await h.start();

		h.press(Keys.up);
		await h.loaded();
		h.press(Keys.enter);
		await h.flush();

		assertNoModal(h);
		assert.deepEqual({ text: h.editorText(), cursor: h.editorCursor() }, { text: "newest", cursor: { line: 0, col: "newest".length } });
		assert.deepEqual(h.submissions, []);
	});

	test("takes an Enter arriving in the same input batch as Up, so the draft is not submitted", async (t) => {
		const h = harnessWithPrompts(t, ["recalled"]);
		await h.start();
		h.type("   ");
		h.press(Keys.lineStart);

		h.press(Keys.up, Keys.enter); // one batch, before the overlay is mounted
		await h.flush();

		assertModalShown(h);
		assert.deepEqual(h.submissions, []);
		assert.equal(h.editorText(), "   ");
	});

	test("dismissed, leaves the draft and the cursor at its start as they were", needsStub, async (t) => {
		const h = harnessWithPrompts(t, ["recalled"]);
		await h.start();
		h.type("first line");
		h.press("\n");
		h.type("second line");
		h.press(Keys.up, Keys.lineStart);
		const before = { text: h.editorText(), cursor: h.editorCursor() };

		h.press(Keys.up);
		await h.flush();
		h.press(Keys.clearLine, Keys.up, Keys.ctrlR);
		await h.loaded();
		h.press(Keys.escape);
		await h.flush();

		assertNoModal(h);
		assert.deepEqual({ text: h.editorText(), cursor: h.editorCursor() }, before);
		assert.deepEqual(h.submissions, []);
	});

	test("is the one Ctrl+R opens: the same key hints, and the search key switches scope", async (t) => {
		const h = harnessWithPrompts(t, ["recalled"]);
		await h.start();
		h.press(Keys.ctrlR);
		await h.loaded();
		const hints = h.modalHints();
		h.press(Keys.escape);
		await h.flush();

		h.press(Keys.up);
		await h.loaded();
		assert.deepEqual(h.modalHints(), hints);
		h.press(Keys.ctrlR);
		await h.loaded();
		assert.match(h.modalTitle() ?? "", /History · global/);
	});

	test("says so, and warns, when Pi's keybindings give the search key to a list key", async (t) => {
		const h = harnessWithPrompts(t, ["recalled"], { keybindings: { "tui.select.up": ["up", "ctrl+r"] } });
		h.writeConfig({ searchKey: "Ctrl+R" }); // any case, as Pi's key matching reads keys
		await h.start();

		h.press(Keys.up);
		await h.loaded();

		assert.match(h.modalHints().join("  "), /^Ctrl\+R move selection up \(scope switch unavailable\) {2}/);
		assert.equal(h.notifications.length, 1);
		assert.match(h.notifications[0]?.message ?? "", /search key "Ctrl\+R" also acts as tui\.select\.up/);
	});

	const spellings: { searchKey: string; keybindings: KeybindingsConfig; hint: string }[] = [
		{ searchKey: "shift+ctrl+r", keybindings: { "tui.select.up": ["up", "ctrl+shift+r"] }, hint: "shift+ctrl+r move selection up" },
		{ searchKey: "Return", keybindings: {}, hint: "Return confirm selection" }, // tui.select.confirm is "enter"
		{ searchKey: "esc", keybindings: {}, hint: "esc cancel selection" }, // tui.select.cancel is "escape"
	];
	for (const { searchKey, keybindings, hint } of spellings) {
		test(`sees the search key "${searchKey}" in a list keybinding spelled another way, as Pi's key matching does`, async (t) => {
			const h = harnessWithPrompts(t, ["recalled"], { keybindings });
			h.writeConfig({ searchKey });
			await h.start();

			h.press(Keys.up);
			await h.loaded();

			const firstHint = h.modalHints().join("  ").split("  ")[0]; // hints are two spaces apart
			assert.equal(firstHint, `${hint} (scope switch unavailable)`);
		});
	}

	test("keeps the keys that reach the input bar while it is open, as when Pi focuses the input bar under it", needsStub, async (t) => {
		const h = harnessWithPrompts(t, ["recalled"]);
		await h.start();
		h.showWorkingStatus("⠋ Working…");
		h.type("steer it");
		h.press(Keys.lineStart);
		h.press(Keys.up);
		await h.flush();

		h.pressInInputBar("!");

		assert.equal(h.modalQuery(), "> steer it!");
		assert.deepEqual({ text: h.editorText(), cursor: h.editorCursor() }, { text: "steer it", cursor: { line: 0, col: 0 } });
	});
});

describe("the input bar's editor", () => {
	test("composes an editor another extension installed: its keys and rendering keep working", async (t) => {
		const h = harnessWithPrompts(t, ["recalled"], { extensionsBefore: [markerEditorExtension] });
		await h.start();
		assert.deepEqual(factoryInstalls(h), { all: 2, late: 0 }); // the other extension's, then this one's

		h.press(Keys.up);
		await h.loaded();
		assert.deepEqual(h.modalList(), ["› recalled"]);
		h.press(Keys.escape);
		await h.flush();

		h.press(Keys.ctrlT);
		assert.equal(h.editorText(), "[marker]");
		assert.equal(h.editorLines().at(-1), "marker editor");
		h.press(Keys.ctrlR);
		await h.flush();
		assertModalShown(h);
	});

	test("composes an editor that offers only Pi's editor contract: nothing is recalled into the bar, and Up opens the modal on an empty input bar", async (t) => {
		const h = harnessWithPrompts(t, ["from an earlier session"], {
			extensionsBefore: [editorExtension((tui, theme, keybindings) => contractOnlyEditor(new CustomEditor(tui, theme, keybindings)))],
		});
		h.livePrompt("from this session", minutesAfterT0(10));
		await h.start(); // Pi hands this session's prompts to the input bar's history
		h.type("submitted now");
		h.press(Keys.enter); // and every prompt it submits
		h.type("my draft");
		h.press(Keys.lineStart);

		h.press(Keys.up); // at the start of the draft, which the wrapper cannot see
		await h.flush();
		assertNoModal(h);
		assert.equal(h.editorText(), "my draft");

		h.press(Keys.lineEnd, Keys.clearLine, Keys.up);
		await h.loaded();
		assert.deepEqual(h.modalList(), ["  from an earlier session", "› from this session"]);
		h.press(Keys.escape);
		await h.flush();
		assert.equal(h.editorText(), "");
	});

	test("is otherwise Pi's custom editor, with the working status embedded in its top border", async (t) => {
		const h = harnessWithPrompts(t, ["recalled"]);
		await h.start();

		h.showWorkingStatus("⠋ Working…");

		assert.match(h.editorLines()[0] ?? "", /^── ⠋ Working… ─+$/);
		assert.equal(h.workingStatusOutsideEditor, undefined);
	});

	test("opens the modal with Up while the agent works, and gives the input bar back with its draft and status", needsStub, async (t) => {
		const h = harnessWithPrompts(t, ["recalled"]);
		await h.start();
		h.showWorkingStatus("⠋ Working…");
		h.type("steer it");
		h.press(Keys.lineStart);

		h.press(Keys.up);
		await h.flush();
		assert.equal(h.modalQuery(), "> steer it");
		h.press(Keys.escape);
		await h.flush();

		assertNoModal(h);
		assert.deepEqual({ text: h.editorText(), cursor: h.editorCursor() }, { text: "steer it", cursor: { line: 0, col: 0 } });
		assert.match(h.editorLines()[0] ?? "", /Working…/);
		h.type("now ");
		assert.equal(h.editorText(), "now steer it");
	});

	test("is installed once, synchronously at session start, and never again, also while history loading is held open", needsNamedPipes, async (t) => {
		const h = harnessWithPrompts(t, ["recalled"]);
		const held = h.holdHistoryLoading();
		await h.start();
		assert.deepEqual(factoryInstalls(h), { all: 1, late: 0 });

		h.press(Keys.up);
		await settle();
		assert.deepEqual(h.modalList(), ["Loading history…"]);
		assert.deepEqual(factoryInstalls(h), { all: 1, late: 0 });

		await held.release();
		await h.loaded();
		assert.deepEqual(h.modalList(), ["› recalled"]);
		h.press(Keys.enter);
		await h.flush();

		assert.equal(h.editorText(), "recalled");
		assert.deepEqual(factoryInstalls(h), { all: 1, late: 0 });
	});

	test("leaves the input bar alone when history loading that was held open ends after a dismissal", needsNamedPipes, async (t) => {
		const h = harnessWithPrompts(t, ["recalled"]);
		const held = h.holdHistoryLoading();
		await h.start();
		h.press(Keys.up);
		await settle();
		assert.deepEqual(h.modalList(), ["Loading history…"]);
		h.press(Keys.escape);
		await h.flush();
		h.type("first");
		h.press("\n");
		h.type("second");
		h.press(Keys.left);
		const before = { text: h.editorText(), cursor: h.editorCursor() };

		await held.release();
		await settle();

		assertNoModal(h);
		assert.deepEqual({ text: h.editorText(), cursor: h.editorCursor() }, before);
		assert.deepEqual(factoryInstalls(h), { all: 1, late: 0 });
		assert.deepEqual(h.submissions, []);
	});

	test("is installed once at each later session start, and Up works after /new, /resume, /fork and /reload", async (t) => {
		const h = harnessWithPrompts(t, ["recalled"], { extensionsBefore: [markerEditorExtension] });
		await h.start();
		for (const [i, reason] of (["new", "resume", "fork", "reload"] as const).entries()) {
			await h.start(reason);
			assert.deepEqual(factoryInstalls(h), { all: 2 * (i + 2), late: 0 }, `after /${reason}`);

			h.press(Keys.up);
			await h.loaded();
			assert.deepEqual(h.modalList(), ["› recalled"], `after /${reason}`);
			h.press(Keys.escape);
			await h.flush();
			h.press(Keys.ctrlT);
			assert.equal(h.editorText(), "[marker]", `after /${reason}`);
			h.press(Keys.clearLine);
		}
	});
});
