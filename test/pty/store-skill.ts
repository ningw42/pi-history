import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";

// Run only in the same isolated, network-denied environment as the real CLI. Pi expands the
// command through its public queue API; no prompt()/agent run/provider dispatch is needed.
const agentDir = process.env.PI_CODING_AGENT_DIR!;
const skillPath = join(agentDir, "skills/pty-fixture/SKILL.md");
mkdirSync(dirname(skillPath), { recursive: true });
writeFileSync(skillPath, "---\nname: pty-fixture\ndescription: PTY smoke fixture.\n---\n\nINSTRUCTIONS_ONLY_SENTINEL\n");
const settingsManager = SettingsManager.inMemory({});
const resourceLoader = new DefaultResourceLoader({
	cwd: process.cwd(), agentDir, settingsManager,
	noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
	additionalSkillPaths: [skillPath],
});
await resourceLoader.reload();
const modelRuntime = await ModelRuntime.create({
	authPath: join(agentDir, "auth.json"), modelsPath: null, refreshOnCreate: false, allowModelNetwork: false,
});
const { session } = await createAgentSession({
	cwd: process.cwd(), agentDir, settingsManager, resourceLoader, modelRuntime,
	sessionManager: SessionManager.inMemory(process.cwd()), noTools: "all",
});
try {
	await session.steer("/skill:pty-fixture keep these arguments");
	const [expanded] = session.clearQueue().steering;
	assert.ok(expanded);
	assert.ok(expanded.startsWith('<skill name="pty-fixture"'));
	assert.ok(expanded.includes("INSTRUCTIONS_ONLY_SENTINEL"));
	const stored = SessionManager.create(process.cwd(), process.env.PI_CODING_AGENT_SESSION_DIR);
	stored.appendMessage({ role: "user", content: expanded, timestamp: Date.now() });
	assert.ok(stored.getSessionFile());
} finally {
	session.dispose();
}
