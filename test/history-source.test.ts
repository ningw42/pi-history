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

/** Open the modal on an empty draft and wait for its records. */
async function open(h: Harness): Promise<void> {
	h.press(Keys.ctrlR);
	await h.loaded();
}

/** Switch the open modal to the other scope and wait for its records. */
async function switchScope(h: Harness): Promise<void> {
	h.press(Keys.ctrlR);
	await h.loaded();
}

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

/** Skip a test that makes a file unreadable: POSIX permissions do not stop root, nor apply on Windows. */
const needsPosixPermissions = {
	skip: process.platform === "win32" || process.getuid?.() === 0 ? "POSIX read-permission test requires a non-root Unix user" : false,
};

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
