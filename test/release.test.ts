import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("../scripts/check-release.mjs", import.meta.url));
// Git hooks can export GIT_DIR / GIT_INDEX_FILE; never let fixtures touch that repository.
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));

function releaseRepo(t: TestContext) {
	const cwd = mkdtempSync(join(tmpdir(), "pi-history-release-"));
	t.after(() => rmSync(cwd, { recursive: true, force: true }));
	// Ignore contributor hooks, signing and identity in this disposable fixture.
	const hooks = join(cwd, "empty-hooks");
	mkdirSync(hooks);
	const git = (...args: string[]) => execFileSync("git", [
		"-c", `core.hooksPath=${hooks}`, "-c", "commit.gpgsign=false",
		"-c", "tag.gpgsign=false", "-c", "user.name=Release test",
		"-c", "user.email=release@example.invalid", ...args,
	], { cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
	git("init");
	writeFileSync(join(cwd, "package.json"), JSON.stringify({ version: "0.1.0" }));
	writeFileSync(join(cwd, "package-lock.json"), JSON.stringify({
		version: "0.1.0", packages: { "": { version: "0.1.0" } },
	}));
	git("add", ".");
	git("commit", "-m", "Release fixture");
	git("tag", "-a", "v0.1.0", "-m", "v0.1.0");
	git("update-ref", "refs/remotes/origin/main", "HEAD");
	return {
		cwd, git,
		check: (tag?: string) => spawnSync(process.execPath, [script, ...(tag ? [tag] : [])], { cwd, env, encoding: "utf8" }),
	};
}

test("release accepts an annotated tag matching package, lockfile and main", (t) => {
	const result = releaseRepo(t).check("v0.1.0");
	assert.equal(result.status, 0, result.stderr);
	assert.match(result.stdout, /v0.1.0 matches/);
});

test("release requires a stable semver tag", (t) => {
	const repo = releaseRepo(t);
	for (const tag of [undefined, "0.1.0", "v01.1.0", "v0.1.0-beta.1", "v0.1.0+build", "v0.1.0;echo oops"]) {
		const result = repo.check(tag);
		assert.notEqual(result.status, 0);
		assert.match(result.stderr, /Expected a stable vX.Y.Z tag/);
	}
});

test("release rejects a version that differs from package.json", (t) => {
	const result = releaseRepo(t).check("v0.2.0");
	assert.notEqual(result.status, 0);
	assert.match(result.stderr, /Tag must match package.json/);
});

for (const field of ["version", "root"] as const) {
	test(`release rejects a stale lockfile ${field} version`, (t) => {
		const repo = releaseRepo(t);
		writeFileSync(join(repo.cwd, "package-lock.json"), JSON.stringify({
			version: field === "version" ? "0.0.0" : "0.1.0",
			packages: { "": { version: field === "root" ? "0.0.0" : "0.1.0" } },
		}));
		const result = repo.check("v0.1.0");
		assert.notEqual(result.status, 0);
		assert.match(result.stderr, /Lockfile.*version must match/);
	});
}

test("release rejects a missing tag", (t) => {
	const repo = releaseRepo(t);
	repo.git("tag", "-d", "v0.1.0");
	assert.notEqual(repo.check("v0.1.0").status, 0);
});

test("release rejects a tag that does not point at HEAD", (t) => {
	const repo = releaseRepo(t);
	repo.git("commit", "--allow-empty", "-m", "Later commit");
	repo.git("update-ref", "refs/remotes/origin/main", "HEAD");
	const result = repo.check("v0.1.0");
	assert.notEqual(result.status, 0);
	assert.match(result.stderr, /Tag must point at HEAD/);
});

test("release rejects a tagged commit not contained in main", (t) => {
	const repo = releaseRepo(t);
	repo.git("commit", "--allow-empty", "-m", "Unmerged commit");
	repo.git("tag", "-f", "v0.1.0");
	assert.notEqual(repo.check("v0.1.0").status, 0);
});

test("release accepts a lightweight tag when main has advanced", (t) => {
	const repo = releaseRepo(t);
	const release = repo.git("rev-parse", "HEAD");
	repo.git("tag", "-f", "v0.1.0");
	repo.git("commit", "--allow-empty", "-m", "Later main commit");
	repo.git("update-ref", "refs/remotes/origin/main", "HEAD");
	repo.git("checkout", "--detach", release);
	const result = repo.check("v0.1.0");
	assert.equal(result.status, 0, result.stderr);
});
