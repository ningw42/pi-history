import { readFileSync } from "node:fs";

// Development commands only: Pi loads src/index.ts without running this guard.
const major = readFileSync(new URL("../.node-version", import.meta.url), "utf8").trim();
const version = process.versions.node;
const alternative = process.versions.bun ? "Bun" : process.versions.deno ? "Deno" : undefined;
if (alternative || process.release.name !== "node" || !new RegExp(`^${major}\\.\\d+\\.\\d+$`).test(version)) {
	console.error(`Development commands require Node ${major}.x; found ${alternative ?? `Node ${version}`}. Run nix develop or select Node ${major}.`);
	process.exit(1);
}
