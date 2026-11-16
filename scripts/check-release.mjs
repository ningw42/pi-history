import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

// Validate stable release tags against the checked-out commit, never a branch tip.
const tag = process.argv[2];
assert.match(tag ?? "", /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/, "Expected a stable vX.Y.Z tag");
const pkg = JSON.parse(readFileSync("package.json", "utf8"));
const lock = JSON.parse(readFileSync("package-lock.json", "utf8"));
assert.equal(tag, `v${pkg.version}`, "Tag must match package.json version");
assert.equal(lock.version, pkg.version, "Lockfile version must match package.json");
assert.equal(lock.packages[""].version, pkg.version, "Lockfile root version must match package.json");

const git = (...args) => execFileSync("git", args, { encoding: "utf8" }).trim();
assert.equal(git("rev-parse", `refs/tags/${tag}^{commit}`), git("rev-parse", "HEAD"), "Tag must point at HEAD");
git("merge-base", "--is-ancestor", "HEAD", "refs/remotes/origin/main");
console.log(`${tag} matches the package, lockfile and HEAD, and is contained in origin/main.`);
