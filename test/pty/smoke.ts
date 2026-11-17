import assert from "node:assert/strict";
import { test } from "node:test";
import { launchPi } from "./terminal.ts";

for (const matcher of ["fzf", "sk"] as const) {
	test(`${matcher}: Up opens history; Enter recalls without submitting`, async (t) => {
		const pi = await launchPi(t, { matcher });
		pi.key("Up");
		await pi.waitFor((screen) => screen.includes("History · repo") && screen.includes("› newest prompt"));
		pi.key("Enter");
		await pi.waitFor((screen) => !screen.includes("History ·") && screen.includes("newest prompt"));
		pi.text("!");
		await pi.waitFor((screen) => screen.includes("newest prompt!"));
	});

	test(`${matcher}: Ctrl+R searches the draft, toggles scope, and Escape preserves the cursor`, async (t) => {
		const pi = await launchPi(t, { matcher });
		pi.text("newest");
		const draft = await pi.waitFor((screen) => screen.split("\n").some((line) => line.trim() === "newest"));
		const lines = draft.split("\n");
		const row = lines.findIndex((line) => line.trim() === "newest");
		const cursor = `${lines[row]!.indexOf("newest") + 4},${row}`; // between "newe" and "st"
		pi.key("Left", "Left");
		await pi.waitFor(() => pi.cursor() === cursor);
		pi.key("C-r");
		await pi.waitFor((screen) => screen.includes("History · repo") && screen.includes("› newest prompt") && screen.includes("> newest"));
		assert.ok(!pi.screen().includes("Rename session"));
		pi.key("C-r");
		await pi.waitFor((screen) => screen.includes("History · global") && screen.includes("newest elsewhere") && screen.includes("> newest"));
		pi.text(" query-only");
		await pi.waitFor((screen) => screen.includes("No matches"));
		pi.key("Escape");
		await pi.waitFor((screen) => !screen.includes("History ·") && screen.includes("newest") && pi.cursor() === cursor);
		pi.text("X");
		await pi.waitFor((screen) => screen.includes("neweXst"));
		assert.ok(!pi.screen().includes("query-only"));
	});

	test(`${matcher}: /model survives startup and a dismissed history load completing`, async (t) => {
		const pi = await launchPi(t, { matcher, holdHistoryRead: true });
		pi.text("/model");
		pi.key("Enter");
		await pi.waitFor((screen) => screen.includes("Only showing models") && screen.includes("smoke-beta"));
		pi.text("beta");
		await pi.waitFor((screen) => screen.includes("> beta") && screen.includes("smoke-beta"));
		pi.key("Enter");
		await pi.waitFor((screen) => !screen.includes("Only showing models") && screen.includes("smoke-beta"));

		// Production does no startup scan. Exercise the async-work hazard with a real modal
		// load, dismissed while its fixture-file read is held, then reopen the real selector.
		pi.key("Up");
		await pi.waitFor((screen) => screen.includes("Loading history") && pi.title() === "PTY history read held");
		pi.key("Escape");
		await pi.waitFor((screen) => !screen.includes("History ·"));
		pi.text("/model");
		pi.key("Enter");
		await pi.waitFor((screen) => screen.includes("Only showing models") && pi.title() === "PTY history read held");
		pi.text("beta");
		await pi.waitFor((screen) => screen.includes("> beta"));
		pi.key("C-g"); // release the read through the test-only terminal listener
		const completed = await pi.waitFor((screen) => screen.includes("PTY history read drained"));
		assert.ok(completed.includes("Only showing models"), `history completion dismissed /model:\n${completed}`);
		assert.ok(completed.includes("> beta"), `history completion changed the selector query:\n${completed}`);
		pi.key("C-u");
		pi.text("alpha");
		await pi.waitFor((screen) => screen.includes("> alpha") && screen.includes("smoke-alpha"));
		pi.key("Enter");
		await pi.waitFor((screen) => !screen.includes("Only showing models") && screen.includes("smoke-alpha"));
		pi.text("still editing");
		await pi.waitFor((screen) => screen.includes("still editing"));
	});

	test(`${matcher}: a previously installed editor keeps its look and keys through history`, async (t) => {
		const pi = await launchPi(t, { matcher, customEditor: true });
		assert.ok(pi.screen().includes("marker editor"));
		pi.key("C-t");
		await pi.waitFor((screen) => screen.includes("[marker]"));
		pi.key("C-u", "Up");
		await pi.waitFor((screen) => screen.includes("History · repo") && screen.includes("› newest prompt"));
		pi.key("Enter");
		await pi.waitFor((screen) => !screen.includes("History ·") && screen.includes("newest prompt"));
		pi.key("C-t");
		await pi.waitFor((screen) => screen.includes("newest prompt[marker]") && screen.includes("marker editor"));
	});

	test(`${matcher}: a skill invocation stored by Pi is searched and recalled as its command`, async (t) => {
		const pi = await launchPi(t, { matcher, skill: true });
		pi.text("/skill:pty-fixture");
		pi.key("C-r");
		await pi.waitFor((screen) => screen.includes("History · repo") && screen.includes("› /skill:pty-fixture keep these arguments"));
		assert.ok(!pi.screen().includes("INSTRUCTIONS_ONLY_SENTINEL"));
		pi.key("Enter");
		await pi.waitFor((screen) => !screen.includes("History ·") && screen.includes("/skill:pty-fixture keep these arguments"));
		pi.text("!");
		await pi.waitFor((screen) => screen.includes("/skill:pty-fixture keep these arguments!"));
	});
}
