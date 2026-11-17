import assert from "node:assert/strict";
import { appendFileSync, chmodSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import { describe, test } from "node:test";
import {
	assistantEntry,
	compactionEntry,
	type Harness,
	Keys,
	minutesAfterT0,
	needsPosixPermissions,
	needsStub,
	type SessionEntry,
	useHarness,
	userEntry,
} from "./harness.ts";

/**
 * A conversation that was branched and compacted: the first answer is followed by an attempt
 * that was abandoned for a retry from the same point, and the retry was then compacted.
 */
function branchedAndCompacted(prefix: string): SessionEntry[] {
	const id = (name: string) => `${prefix}-${name}`;
	return [
		userEntry(id("u1"), null, "first question", minutesAfterT0(1)),
		assistantEntry(id("a1"), id("u1"), minutesAfterT0(1) + 1),
		userEntry(id("u2"), id("a1"), "abandoned attempt", minutesAfterT0(2)),
		assistantEntry(id("a2"), id("u2"), minutesAfterT0(2) + 1),
		userEntry(id("u3"), id("a1"), "retried differently", minutesAfterT0(3)),
		assistantEntry(id("a3"), id("u3"), minutesAfterT0(3) + 1),
		compactionEntry(id("c1"), id("a3"), id("u3"), minutesAfterT0(4)),
		userEntry(id("u4"), id("c1"), "after the compaction", minutesAfterT0(5)),
		assistantEntry(id("a4"), id("u4"), minutesAfterT0(5) + 1),
	];
}

const BRANCHED_AND_COMPACTED_LIST = [
	"  first question",
	"  abandoned attempt",
	"  retried differently",
	"› after the compaction",
];

/** Press the search key and wait for the records: on an empty draft it opens the modal, inside it switches scope. */
async function open(h: Harness): Promise<void> {
	h.press(Keys.ctrlR);
	await h.loaded();
}

const switchScope = open;

describe("the live session", () => {
	for (const noSession of [false, true]) {
		test(`a prompt submitted moments ago appears in both scopes${noSession ? " in an ephemeral (--no-session) run" : ", before Pi has written it to disk"}`, async (t) => {
			const h = useHarness(t, { noSession });
			h.writeSession({ cwd: h.cwd, prompts: [{ text: "from an earlier session", timestamp: minutesAfterT0(1) }] });
			await h.start();
			h.livePrompt("just submitted", minutesAfterT0(2));

			await open(h);
			assert.deepEqual(h.modalList(), ["  from an earlier session", "› just submitted"]);

			await switchScope(h);
			assert.match(h.modalTitle() ?? "", /History · global/);
			assert.deepEqual(h.modalList(), ["  from an earlier session", "› just submitted"]);
		});
	}

	test("its prompts appear once when Pi has written some of them to its session file", async (t) => {
		const h = useHarness(t);
		h.livePrompt("written to disk", minutesAfterT0(1));
		h.writeSessionEntries({ cwd: h.cwd, entries: h.liveEntries, path: h.liveSessionFile });
		await h.start();
		h.livePrompt("still only in memory", minutesAfterT0(2));
		h.livePrompt("written to disk", minutesAfterT0(3));

		await open(h);

		assert.deepEqual(h.modalList(), ["  still only in memory", "› written to disk"]);
	});

	test("a prompt another Pi process appends to its session file appears", async (t) => {
		const h = useHarness(t);
		h.livePrompt("typed here", minutesAfterT0(1));
		const file = h.writeSessionEntries({ cwd: h.cwd, entries: h.liveEntries, path: h.liveSessionFile });
		await h.start();

		// As a second Pi process continuing the same session (`pi -c` in another terminal) does.
		appendFileSync(file, `${JSON.stringify(userEntry("elsewhere", null, "typed in another Pi process", minutesAfterT0(2)))}\n`);
		await open(h);

		assert.deepEqual(h.modalList(), ["  typed here", "› typed in another Pi process"]);
	});

	test("an ephemeral session's prompts stay history after /new, and after /fork leaves their branch", async (t) => {
		const h = useHarness(t, { noSession: true });
		await h.start();
		h.livePrompt("in the first session", minutesAfterT0(1));
		await h.start("new", { liveEntries: [] }); // Pi starts a fresh in-memory session
		h.livePrompt("kept by the fork", minutesAfterT0(2));
		h.livePrompt("left behind by the fork", minutesAfterT0(3));
		// Forking an in-memory session rewrites it to the path up to the fork point.
		await h.start("fork", { liveEntries: h.liveEntries.slice(0, 2) });

		await open(h);
		assert.deepEqual(h.modalList(), ["  in the first session", "  kept by the fork", "› left behind by the fork"]);
		await switchScope(h);
		assert.deepEqual(h.modalList(), ["  in the first session", "  kept by the fork", "› left behind by the fork"]);
	});

	test("a persisted session's prompts go with its file, even those it held in memory", async (t) => {
		const h = useHarness(t);
		h.livePrompt("in a deleted session", minutesAfterT0(1));
		const file = h.writeSessionEntries({ cwd: h.cwd, entries: h.liveEntries, path: h.liveSessionFile });
		await h.start();
		await h.start("new", { liveEntries: [] });

		rmSync(file);
		await open(h);

		assert.deepEqual(h.modalList(), ["No history yet"]);
	});
});

describe("every user message counts", () => {
	test("in a session file, on abandoned branches and before a compaction", async (t) => {
		const h = useHarness(t);
		h.writeSessionEntries({ cwd: h.cwd, entries: branchedAndCompacted("file") });
		await h.start();

		await open(h);

		assert.deepEqual(h.modalList(), BRANCHED_AND_COMPACTED_LIST);
	});

	test("in the live session, on abandoned branches and before a compaction", async (t) => {
		const h = useHarness(t, { noSession: true });
		await h.start();
		h.liveEntries.push(...branchedAndCompacted("live"));

		await open(h);

		assert.deepEqual(h.modalList(), BRANCHED_AND_COMPACTED_LIST);
	});
});

describe("a session file", () => {
	test("yields no prompt for a line that only mentions \"user\" in its JSON, such as a tool call's arguments", async (t) => {
		const h = useHarness(t);
		h.writeSessionEntries({
			cwd: h.cwd,
			entries: [
				userEntry("u1", null, "before the tool call", minutesAfterT0(1)),
				{
					type: "message",
					id: "a1",
					parentId: "u1",
					timestamp: new Date(minutesAfterT0(1) + 1).toISOString(),
					message: {
						role: "assistant",
						content: [{ type: "toolCall", id: "call-1", name: "lookup", arguments: { role: "user", user: "someone" } }],
						timestamp: minutesAfterT0(1) + 1,
					},
				},
				userEntry("u2", "a1", "after the tool call", minutesAfterT0(2)),
			],
		});
		await h.start();

		await open(h);

		assert.deepEqual(h.modalList(), ["  before the tool call", "› after the tool call"]);
	});

	test("with a malformed line, or a last line without a line break, still yields its other prompts", async (t) => {
		const h = useHarness(t);
		const file = h.writeSessionEntries({ cwd: h.cwd, entries: [userEntry("u1", null, "before the damage", minutesAfterT0(1))] });
		const last = userEntry("u2", "u1", "on the last line", minutesAfterT0(2));
		appendFileSync(file, `{"type":"message","message":{"role":"user","content":"cut off\n${JSON.stringify(last)}`);
		await h.start();

		await open(h);

		assert.deepEqual(h.modalList(), ["  before the damage", "› on the last line"]);
	});
});

describe("a user message's content", () => {
	const image = { type: "image", data: "aGVsbG8=", mimeType: "image/png" };

	test("is its text blocks joined as Pi joins them, without a separator, ignoring images", async (t) => {
		const h = useHarness(t);
		h.writeSessionEntries({
			cwd: h.cwd,
			entries: [
				userEntry("u1", null, [{ type: "text", text: "look at " }, image, { type: "text", text: "this screenshot" }], minutesAfterT0(1)),
				userEntry("u2", "u1", [image], minutesAfterT0(2)),
			],
		});
		await h.start();
		h.liveEntries.push(
			userEntry("live-u1", null, [{ type: "text", text: "line one\n" }, { type: "text", text: "line two" }, image], minutesAfterT0(3)),
		);

		await open(h);
		assert.deepEqual(h.modalList(), ["  look at this screenshot", "› line one ↵ line two"]);
		h.press(Keys.enter);
		await h.flush();

		assert.equal(h.editorText(), "line one\nline two");
	});
});

describe("the history cache", () => {
	test("serves an unchanged session file without reading it again, also after /new and /reload", needsPosixPermissions, async (t) => {
		const h = useHarness(t);
		const file = h.writeSession({ cwd: h.cwd, prompts: [{ text: "read once", timestamp: minutesAfterT0(1) }] });
		const other = h.writeSession({ cwd: h.path("work/other"), prompts: [{ text: "elsewhere", timestamp: minutesAfterT0(2) }] });
		await h.start();
		await open(h);
		assert.deepEqual(h.modalList(), ["› read once"]);
		await switchScope(h);
		assert.deepEqual(h.modalList(), ["  read once", "› elsewhere"]);
		h.press(Keys.escape);
		await h.flush();

		// Unchanged, but no longer readable: only a cached copy can still list them.
		chmodSync(file, 0);
		chmodSync(other, 0);
		try {
			for (const reason of ["new", "reload"] as const) {
				await h.start(reason);
				await open(h);
				assert.deepEqual(h.modalList(), ["› read once"], `repo scope after /${reason}`);
				await switchScope(h);
				assert.deepEqual(h.modalList(), ["  read once", "› elsewhere"], `global scope after /${reason}`);
				h.press(Keys.escape);
				await h.flush();
			}
		} finally {
			chmodSync(file, 0o600);
			chmodSync(other, 0o600);
		}
	});

	test("reads a session file again once it has changed", async (t) => {
		const h = useHarness(t);
		const file = h.writeSession({ cwd: h.cwd, prompts: [{ text: "before", timestamp: minutesAfterT0(1) }] });
		await h.start();
		await open(h);
		assert.deepEqual(h.modalList(), ["› before"]);
		h.press(Keys.escape);
		await h.flush();

		// As another Pi process appends to its session.
		appendFileSync(file, `${JSON.stringify(userEntry("appended", null, "appended later", minutesAfterT0(2)))}\n`);
		await open(h);

		assert.deepEqual(h.modalList(), ["  before", "› appended later"]);
	});

	test("reads session files added since the last open, and forgets deleted ones", async (t) => {
		const h = useHarness(t);
		const deleted = h.writeSession({ cwd: h.cwd, prompts: [{ text: "deleted session", timestamp: minutesAfterT0(1) }] });
		h.writeSession({ cwd: h.cwd, prompts: [{ text: "kept session", timestamp: minutesAfterT0(2) }] });
		const elsewhere = h.writeSession({ cwd: h.path("work/other"), prompts: [{ text: "deleted directory", timestamp: minutesAfterT0(3) }] });
		await h.start();
		await open(h);
		await switchScope(h);
		assert.deepEqual(h.modalList(), ["  deleted session", "  kept session", "› deleted directory"]);
		h.press(Keys.escape);
		await h.flush();

		rmSync(deleted);
		rmSync(dirname(elsewhere), { recursive: true });
		h.writeSession({ cwd: h.cwd, prompts: [{ text: "added session", timestamp: minutesAfterT0(4) }] });
		await open(h);
		assert.deepEqual(h.modalList(), ["  kept session", "› added session"]);
		await switchScope(h);
		assert.deepEqual(h.modalList(), ["  kept session", "› added session"]);
	});

	test("reads a session file that could not be read at the last open once it can", needsPosixPermissions, async (t) => {
		const h = useHarness(t);
		h.writeSession({ cwd: h.cwd, prompts: [{ text: "always readable", timestamp: minutesAfterT0(1) }] });
		const file = h.writeSession({ cwd: h.cwd, prompts: [{ text: "readable again", timestamp: minutesAfterT0(2) }] });
		const other = h.writeSession({ cwd: h.path("work/other"), prompts: [{ text: "elsewhere", timestamp: minutesAfterT0(3) }] });
		await h.start();
		chmodSync(file, 0);
		chmodSync(other, 0);
		try {
			await open(h);
			assert.deepEqual(h.modalList(), ["› always readable"]);
			await switchScope(h);
			assert.deepEqual(h.modalList(), ["› always readable"]);
			h.press(Keys.escape);
			await h.flush();
		} finally {
			chmodSync(file, 0o600);
			chmodSync(other, 0o600);
		}

		await open(h);
		assert.deepEqual(h.modalList(), ["  always readable", "› readable again"]);
		await switchScope(h);
		assert.deepEqual(h.modalList(), ["  always readable", "  readable again", "› elsewhere"]);
	});
});

/**
 * Open the modal and press a key every 5 ms, as fast typing does, until its records have loaded:
 * a letter for the query line while it still shows "Loading history…". Returns the longest wait
 * between two keys being handled and how many letters were typed while loading.
 */
async function typeWhileLoading(h: Harness): Promise<{ longestWaitMs: number; typedWhileLoading: number }> {
	h.press(Keys.ctrlR);
	await h.flush();
	let previous = performance.now();
	let longestWaitMs = 0;
	let typedWhileLoading = 0;
	const typing = setInterval(() => {
		const now = performance.now();
		longestWaitMs = Math.max(longestWaitMs, now - previous);
		previous = now;
		if (h.modalList()[0] === "Loading history…") {
			h.type("x");
			typedWhileLoading++;
		}
	}, 5);
	try {
		await h.loaded();
	} finally {
		clearInterval(typing);
	}
	return { longestWaitMs, typedWhileLoading };
}

describe("loading a large history", () => {
	/** Far above the 5 ms between keys, and far below the stall of parsing the whole history at once (about 300 ms). */
	const PROMPT_KEY_LATENCY_MS = 100;

	test("keeps handling keys and editing the query while records are read, parsed and ordered", async (t) => {
		const h = useHarness(t);
		// 100,000 prompts, about 50 MB, in shuffled time order, so ordering them is real work too.
		const count = 100_000;
		h.writeSession({
			cwd: h.cwd,
			prompts: Array.from({ length: count }, (_, i) => ({
				text: `prompt ${i} ${"x".repeat(128)}`,
				timestamp: minutesAfterT0((i * 7919) % count),
			})),
		});
		h.writeConfig({ recordLimit: count });
		await h.start();

		const cold = await typeWhileLoading(h);
		assert.ok(cold.typedWhileLoading >= 3, `only ${cold.typedWhileLoading} keys were handled while loading`);
		// The query line scrolls a query wider than itself, so render it wide enough to show every letter.
		assert.equal(h.modalQuery(cold.typedWhileLoading + 10), `> ${"x".repeat(cold.typedWhileLoading)}`);
		assert.ok(cold.longestWaitMs < PROMPT_KEY_LATENCY_MS, `a key waited ${cold.longestWaitMs.toFixed(0)} ms on a cold load`);
		h.press(Keys.escape);
		await h.flush();

		const cached = await typeWhileLoading(h);
		assert.ok(cached.longestWaitMs < PROMPT_KEY_LATENCY_MS, `a key waited ${cached.longestWaitMs.toFixed(0)} ms on a cached load`);
		h.press(Keys.clearLine);
		// The newest is prompt 82321 (82321 × 7919 mod 100,000 = 99,999), then prompt 64642 (… = 99,998).
		await h.waitFor(() => /^› prompt 82321 x+…$/.test(h.modalList().at(-1) ?? ""), "the newest record selected");
		assert.match(h.modalList().at(-2) ?? "", /^ {2}prompt 64642 x+…$/);
	});
});

describe("the record limit", () => {
	test("by default, the newest 5,000 unique records are searchable", needsStub, async (t) => {
		const h = useHarness(t);
		const count = 5_001;
		h.writeSession({
			cwd: h.cwd,
			prompts: Array.from({ length: count }, (_, i) => ({ text: `prompt ${i + 1}`, timestamp: minutesAfterT0(i + 1) })),
		});
		await h.start();
		h.type("prompt");

		h.press(Keys.ctrlR);
		await h.waitFor(() => h.matcherCalls().length > 0, "the matcher to start");

		const input = h.matcherCalls()[0]?.input ?? [];
		assert.equal(input.length, 5_000);
		assert.equal(input[0], "prompt 5001");
		assert.equal(input.at(-1), "prompt 2");
	});
});
