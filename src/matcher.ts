import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";

/** What a matcher run produced: the matching records best first (possibly none), or why it failed. */
export type MatchOutcome<R> = { kind: "matches"; records: R[] } | { kind: "failure"; message: string };

export interface Matcher {
	/**
	 * The records matching `query`, ranked by match quality first and input order second. `records`
	 * are expected newest first and unique by text. The query is passed verbatim, so the matcher's
	 * own search syntax applies.
	 *
	 * Never rejects, except once `signal` aborts: the run is then killed and the promise rejects with
	 * the signal's reason, so no outcome is ever delivered after cancellation.
	 */
	match<R extends { readonly text: string }>(
		query: string,
		records: readonly R[],
		signal: AbortSignal,
	): Promise<MatchOutcome<R>>;
}

/** Inherited default options would change ranking or output format; they never reach the matcher. */
const DEFAULT_OPTION_VARIABLES = ["FZF_DEFAULT_OPTS", "FZF_DEFAULT_OPTS_FILE"];
/** fzf's exit status when nothing matched; not an error. */
const NO_MATCH_STATUS = 1;
/** Enough standard error to explain a failure. */
const STDERR_LIMIT = 4096;

/**
 * fzf in non-interactive filter mode. The history scheme ranks by match quality and breaks ties by
 * input order, which is newest first; sorting is left enabled.
 */
export function createFzfMatcher(): Matcher {
	return {
		match: (query, records, signal) =>
			runFilter("fzf", ["--filter", query, "--read0", "--print0", "--scheme=history"], records, signal),
	};
}

/**
 * Run a matcher process directly (never through a shell), with the records NUL-delimited on its
 * standard input, and map its NUL-delimited output back to records by text. Records containing a
 * NUL cannot be delimited, so they never match.
 */
function runFilter<R extends { readonly text: string }>(
	command: string,
	args: string[],
	records: readonly R[],
	signal: AbortSignal,
): Promise<MatchOutcome<R>> {
	return new Promise((resolve, reject) => {
		if (signal.aborted) {
			reject(signal.reason);
			return;
		}
		// A NUL cannot be passed in an argument; the query line accepts one from a paste.
		if (args.some((arg) => arg.includes("\0"))) {
			resolve({ kind: "failure", message: "a query cannot contain a NUL character" });
			return;
		}
		const searchable = records.filter((record) => !record.text.includes("\0"));
		const env = { ...process.env };
		for (const name of DEFAULT_OPTION_VARIABLES) delete env[name];
		let child: ChildProcessWithoutNullStreams;
		try {
			child = spawn(command, args, { env, stdio: "pipe", windowsHide: true });
		} catch (error) {
			resolve({ kind: "failure", message: `could not run ${command}: ${error instanceof Error ? error.message : String(error)}` });
			return;
		}

		let settled = false;
		const settle = (deliver: () => void) => {
			if (settled) return;
			settled = true;
			signal.removeEventListener("abort", onAbort);
			deliver();
		};
		const onAbort = () => {
			child.kill();
			settle(() => reject(signal.reason));
		};
		signal.addEventListener("abort", onAbort, { once: true });

		const stdout: Buffer[] = [];
		let stderr = "";
		child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
		child.stderr.setEncoding("utf8");
		child.stderr.on("data", (chunk: string) => {
			if (stderr.length < STDERR_LIMIT) stderr += chunk;
		});
		// The matcher may exit (for example on an error) before reading all of its input.
		child.stdin.on("error", () => {});

		child.on("error", (error: NodeJS.ErrnoException) => {
			const message = error.code === "ENOENT" ? `${command} was not found` : `could not run ${command}: ${error.message}`;
			settle(() => resolve({ kind: "failure", message }));
		});
		child.on("close", (status, killedBy) => {
			settle(() => {
				if (status === 0) resolve({ kind: "matches", records: byText(searchable, Buffer.concat(stdout).toString("utf8")) });
				else if (status === NO_MATCH_STATUS) resolve({ kind: "matches", records: [] });
				else resolve({ kind: "failure", message: exitMessage(command, status, killedBy, stderr) });
			});
		});

		child.stdin.end(searchable.map((record) => `${record.text}\0`).join(""));
	});
}

/** Map NUL-terminated output back to the records, in output order. */
function byText<R extends { readonly text: string }>(records: readonly R[], output: string): R[] {
	const index = new Map(records.map((record) => [record.text, record]));
	return output
		.split("\0")
		.slice(0, -1)
		.flatMap((text) => index.get(text) ?? []);
}

function exitMessage(command: string, status: number | null, killedBy: NodeJS.Signals | null, stderr: string): string {
	const reason = status === null ? `was terminated by ${killedBy}` : `exited with status ${status}`;
	const detail = stderr.trim().split(/\r?\n/)[0];
	return detail ? `${command} ${reason}: ${detail}` : `${command} ${reason}`;
}
