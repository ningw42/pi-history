// Resolve once per CI run so every OS tests the same releases, even during an upstream release.
import { readFileSync } from "node:fs";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const agent = "@earendil-works/pi-coding-agent";
const tui = "@earendil-works/pi-tui";

function version(value) {
	if (!/^\d+\.\d+\.\d+$/.test(value)) throw new Error(`Expected a stable version, got ${value}`);
	return value;
}

function peerMinimum(name) {
	const range = pkg.peerDependencies[name];
	if (!range?.startsWith(">=")) throw new Error(`Expected a minimum version for ${name}, got ${range}`);
	return version(range.slice(2));
}

async function json(url, headers) {
	const response = await fetch(url, { headers });
	if (!response.ok) throw new Error(`${url}: ${response.status} ${response.statusText}`);
	return response.json();
}

async function latestNpm(name) {
	return version((await json(`https://registry.npmjs.org/${name}/latest`)).version);
}

async function latestRelease(repo) {
	const headers = process.env.GH_TOKEN ? { Authorization: `Bearer ${process.env.GH_TOKEN}` } : {};
	const release = await json(`https://api.github.com/repos/${repo}/releases/latest`, headers);
	return version(release.tag_name.replace(/^v/, ""));
}

const floors = pkg.config.minimumMatcherVersions;
const [latestAgent, latestTui, latestFzf, latestSkim] = await Promise.all([
	latestNpm(agent), latestNpm(tui), latestRelease("junegunn/fzf"), latestRelease("skim-rs/skim"),
]);
console.log(JSON.stringify([
	{ lane: "minimum", agent: peerMinimum(agent), tui: peerMinimum(tui), fzf: version(floors.fzf), skim: version(floors.skim) },
	{ lane: "latest", agent: latestAgent, tui: latestTui, fzf: latestFzf, skim: latestSkim },
]));
