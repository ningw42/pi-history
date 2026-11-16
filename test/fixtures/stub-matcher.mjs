#!/usr/bin/env node
// Scripted stand-in for fzf/sk used by the extension-boundary tests.
//
// STUB_MATCHER_CONFIG: optional path to JSON
//   { "responses": [{ "query": "...", "output": ["record", ...], "exitCode": 0, "delayMs": 0, "stderr": "..." }] }
//   A response whose query equals the received query (or that has no query) is used; otherwise
//   the stub keeps input records containing the query (case-insensitive), in input order, and
//   exits 1 when nothing matches, like fzf.
// STUB_MATCHER_LOG: optional path; one JSON line is appended when an invocation starts:
//   { "pid": 123, "argv": [...], "env": { matcher env vars }, "input": ["record", ...] }
//   and another, { "pid": 123, "finished": true }, if it outlives its scripted delay.
import { appendFileSync, readFileSync } from "node:fs";

const argv = process.argv.slice(2);
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const raw = Buffer.concat(chunks).toString("utf8");
const input = raw === "" ? [] : raw.replace(/\0$/, "").split("\0");

const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(FZF|SKIM)_/.test(key)));
const log = (entry) => {
	if (process.env.STUB_MATCHER_LOG) appendFileSync(process.env.STUB_MATCHER_LOG, `${JSON.stringify({ pid: process.pid, ...entry })}\n`);
};
log({ argv, env, input });

const query = findQuery(argv);
const config = process.env.STUB_MATCHER_CONFIG ? JSON.parse(readFileSync(process.env.STUB_MATCHER_CONFIG, "utf8")) : {};
const response = (config.responses ?? []).find((r) => r.query === undefined || r.query === query);

if (response?.delayMs) await new Promise((resolve) => setTimeout(resolve, response.delayMs));

const output = response?.output ?? input.filter((record) => record.toLowerCase().includes((query ?? "").toLowerCase()));
const exitCode = response?.exitCode ?? (output.length > 0 ? 0 : 1);
log({ finished: true });
if (response?.stderr) process.stderr.write(response.stderr);
if (output.length > 0) process.stdout.write(`${output.join("\0")}\0`);
process.exitCode = exitCode;

function findQuery(args) {
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg === "--filter" || arg === "-f") return args[i + 1];
		if (arg.startsWith("--filter=")) return arg.slice("--filter=".length);
	}
	return undefined;
}
