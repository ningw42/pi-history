# pi-history

One history modal for [Pi](https://pi.dev). Recalling and searching previous prompts happens in a single Pi-drawn overlay; Pi's input bar is never used as the browsing surface, so browsing history can never damage a draft.

Targets Pi **1.5.2** on Linux and macOS. It is a Pi package written in TypeScript and loaded by Pi directly, with no build step.

> Do not load it together with another prompt-history extension (for example `pi-input-history`): both take over the input bar's history keys.

## Status

The bootstrap ([#2](https://github.com/ningw42/pi-history/issues/2)) and fuzzy search ([#3](https://github.com/ningw42/pi-history/issues/3)) of the design in [#1](https://github.com/ningw42/pi-history/issues/1) are done. What works today:

- **Ctrl+R** in the input bar, at any cursor position, opens the history modal.
- The modal lists the prompts you typed in sessions started in the **exact current working directory**, one row per unique prompt (its most recent use wins). Multi-line prompts are shown as one row.
- The modal has a **query line**, which starts with whatever is in the input bar when you press Ctrl+R. Editing it never changes your draft. With an empty (or whitespace-only) query the list is newest first. With a query, the list is ranked by [**fzf**](https://github.com/junegunn/fzf): match quality first, recency second, so an old obvious match beats a recent weak one. fzf's search syntax works (several terms, `'exact`, `^prefix`, `suffix$`, `!negation`, `a | b`).
- The best candidate starts selected and sits at the bottom of the list, next to the query line. **Up** moves to older (or lower-ranked) records, **Down** back toward newer (or higher-ranked) ones.
- If nothing matches, the modal says so. If fzf is missing or fails, the modal shows why; clearing the query still browses newest first.
- **Enter** replaces the whole draft with the selected record and puts the cursor at the end. Nothing is submitted.
- **Escape** closes the modal and leaves the draft, cursor and collapsed pastes exactly as they were.
- Confirm, cancel and list navigation follow your Pi keybindings (`tui.select.confirm`, `tui.select.cancel`, `tui.select.up`, `tui.select.down`).
- Session files are only read. The extension does nothing outside Pi's interactive (TUI) mode.

## Roadmap

The remaining sub-issues of #1, in order:

| Issue | Adds |
|---|---|
| [#4](https://github.com/ningw42/pi-history/issues/4) | An optional JSON configuration file in Pi's agent directory, and `sk` (skim) as an alternative matcher. |
| [#5](https://github.com/ningw42/pi-history/issues/5) | **Repo** scope (the whole git repository) and **global** scope (every session), toggled with Ctrl+R inside the modal. |
| [#6](https://github.com/ningw42/pi-history/issues/6) | The live session's prompts, a 5,000-record limit per scope, and an in-memory cache that re-reads only new or changed session files. |
| [#7](https://github.com/ningw42/pi-history/issues/7) | Prompts that began with `/skill:name` are recalled as `/skill:name arguments` instead of the expanded skill body. |
| [#8](https://github.com/ningw42/pi-history/issues/8) | A preview pane (line breaks, last-used time and directory) and a key-hint line. |
| [#9](https://github.com/ningw42/pi-history/issues/9) | **Up** in the input bar opens the modal where native Pi would start recalling history; native in-bar recall is retired. |
| [#10](https://github.com/ningw42/pi-history/issues/10) | A smoke suite that drives the real Pi executable in a pseudo-terminal. |

## Install

Searching needs [`fzf`](https://github.com/junegunn/fzf) on your `PATH` (any recent release; developed against 0.72 and 0.75). Without it the modal still browses newest first, and says that fzf is missing whenever there is a query (including one started from the draft).

Install the latest `main` from Git (no npm publication or build needed):

```sh
pi install git:github.com/ningw42/pi-history
```

For a pinned release, append a published tag, for example `git:github.com/ningw42/pi-history@v0.1.0` once that release exists. Tags stay pinned when Pi updates packages; choose a newer tag explicitly to upgrade.

From a development clone:

```sh
npm ci --ignore-scripts
pi -e ./src/index.ts            # try it once
pi install /path/to/pi-history  # or add it to your Pi settings
```

## Design

### Vocabulary

- **History modal**: the single Pi-drawn overlay through which all history browsing and searching happens.
- **Entry point**: a way into the modal. The **search entry** is Ctrl+R; the **Up entry** arrives in #9.
- **Draft**: the text in Pi's input bar when an entry point fires.
- **History record**: one unique user-typed prompt with the time and working directory of its most recent use.
- **Scope**: which sessions records are drawn from (#5).
- **Matcher**: the external program that filters and ranks records for a query: `fzf` today, `sk` as an alternative in #4.
- **Confirm / dismiss**: the two ways the modal closes, with a record or without changing anything.

### Modules

| Module | File | Responsibility |
|---|---|---|
| Entry point | `src/index.ts` | Wires the modules together; inert unless Pi is in TUI mode. |
| Editor integration | `src/editor-integration.ts` | The only module that knows about Pi's editor. Wraps the input bar's editor to install the entry points, and applies a confirmed record to the draft. |
| History modal | `src/history-modal.ts` | The overlay component. Owns loading state, the query line, the result list and selection; handles keys; renders. Resolves with "confirmed text" or "dismissed" and **never writes to the input bar**. |
| History source | `src/history-source.ts` | Returns history records newest first, de-duplicated, from Pi session files. |
| Matcher adapter | `src/matcher.ts` | Given a query, newest-first records and a cancellation signal, returns the matching records ranked, or a typed failure. Hides process handling, the NUL-delimited transport, environment scrubbing and exit-status interpretation. |

Configuration (#4) and skill restoration (#7) are the remaining modules of the design.

### Decisions

- **The search key is handled by wrapping the input bar's editor, not by `pi.registerShortcut`.** The wrapper sees every key before Pi does, so Ctrl+R takes precedence over any Pi binding on the same key while the input bar has focus. It is installed only in TUI mode, so nothing is registered in print, JSON or RPC mode. A registered `ctrl+r` shortcut would also be registered outside TUI mode, and Pi would report it at startup as a conflict with the `/resume` picker's rename binding.
- **The wrapper is installed synchronously at `session_start`, before any I/O, and never again.** Replacing the editor later would dismiss a selector the user opened in the meantime (for example `/model`). History is read only when the modal opens.
- **The wrapper composes with an editor factory configured by another extension**, falling back to Pi's `CustomEditor` with the working-status indicator embedded in its border. (Full composition coverage arrives with #9.)
- **The working directory recorded in each session header is the authority**, not the storage directory name: two directories such as `/a/b` and `/a-b` share one storage directory name.
- **Text blocks of one user message are joined with no separator**, the way Pi's interactive mode joins them for display and native history.
- **Keys that arrive while the modal is opening or closing belong to the modal.** Pi mounts the overlay asynchronously and gives focus back to the editor before the result arrives, so keys from the same terminal input batch (for example a fast Ctrl+R then Enter, or a double Enter) would otherwise reach the editor and submit the draft the modal is replacing. Once the modal has closed, such keys are dropped: they neither edit its query nor start a search.
- **The session directory** is the current session's. An ephemeral (`--no-session`) session reports none, so the extension uses `PI_CODING_AGENT_SESSION_DIR` if set, else the `sessionDir` setting, else Pi's default directory. A `--session-dir` flag is not visible to extensions in an ephemeral session, so `--no-session --session-dir <dir>` does not read `<dir>`; to browse a custom directory's history in an ephemeral session, set `PI_CODING_AGENT_SESSION_DIR` or the `sessionDir` setting instead.
- **Recalled text goes through Pi's editor**, which stores CRLF/CR as LF and tabs as four spaces, as it does for typed and pasted text. Text typed, pasted or edited in Pi's input bar never contains those characters, so only text stored without passing through the editor is affected: RPC and SDK prompts, extension input transforms, and expanded prompt templates or skills.
- **The draft is the starting query, verbatim**, so fzf's search syntax applies to it: a draft that begins with `!` or `'`, or contains ` | `, is read as fzf operators. Two exceptions: the query line is Pi's single-line text input, which cannot hold a line break, so a multi-line draft's line breaks become spaces, and a collapsed paste counts with its content, not its `[paste #1 …]` marker. The query is one command-line argument, so a paste larger than the operating system allows for one (about 128 KiB on Linux) cannot be searched and shows "Search failed". A whitespace-only draft or query counts as empty: nothing to match, so no fzf process runs. Because fzf separates terms on spaces only, a line break inside a query would be part of a term; with spaces instead, a multi-line draft's lines are matched as separate terms and the search is looser than fzf given the exact multi-line text.
- **The query line is Pi's own `Input` component**, so it edits like the rest of Pi and follows your editing keybindings. The draft is put into it as a bracketed paste, because `Input` has no public way to place the cursor and a paste leaves it at the end.
- **fzf runs as a filter, never interactively**: `fzf --filter <query> --read0 --print0 --scheme=history`, started directly with an argument list (no shell), with records NUL-delimited on its standard input newest first, so multi-line prompts survive. The history scheme ranks by match quality and breaks ties by input order, which is recency; sorting is left on. Results are mapped back to records by text, which is unique after de-duplication. A record containing a NUL cannot be delimited and is never matched.
- **Your fzf defaults cannot change the ranking**: `FZF_DEFAULT_OPTS` and `FZF_DEFAULT_OPTS_FILE` are removed from fzf's environment (`--no-sort` there would otherwise list results in recency order).
- **Only the latest query's results are shown.** A query edit waits 50 ms, then starts one fzf run; any earlier run is killed and its output discarded, so a slow search never replaces a newer one. Closing the modal kills a running search. Until the new results arrive the previous list stays on screen but cannot be confirmed: Enter does nothing while the list is out of date, so typing a query and Enter in one input batch never confirms a record the query does not match. Each new list selects its best candidate.
- **fzf's "no match" status (1) is a result, not an error**: the modal shows "No matches". A missing fzf is reported as not found; any other failure to start fzf (for example one that is not executable, or a query too long for the command line), any other exit status, and fzf being killed by a signal are reported, an exit status with fzf's first line of error output. A query containing a NUL character (only possible by pasting one) cannot be passed to fzf and is reported too. There is no built-in fallback matcher.

## Development

Development and CI require **Node 26.x** (`.node-version`), npm and **`fzf`** on `PATH`: the matcher adapter tests run the real fzf and fail, rather than skip, without it. The Nix shell provides fzf; CI installs it from each runner's package manager. The Node major is selected explicitly, not through a moving `latest` alias; the Nix lockfile pins the development package's exact version. The committed `package-lock.json` is the authority for JavaScript dependencies.

```sh
npm ci --ignore-scripts
npm run check       # typecheck and all tests; also used by CI and the Git hook
npm run typecheck   # tsc, no emit
npm test            # node:test, using Node's built-in TypeScript support
```

`npm run check`, `npm run typecheck`, `npm test` and `npm run release:check` reject runtimes other than stable Node 26.x, with instructions to enter `nix develop` or select Node 26. The guard runs inside the commands, not through pre/post lifecycle hooks, so `--ignore-scripts` does not bypass it.

This is a **development policy**, not a restriction on Pi's runtime. The extension still loads inside whichever runtime runs Pi, including Bun; there is no Node 26 check in extension code. The existing `engines.node >=22.19` compatibility declaration is unchanged. CI tests Node 26 only; Bun and older Node runtimes are not verified by this suite.

Installation scripts are deliberately disabled: this source-only extension needs no build, and its development dependencies work without lifecycle scripts. No `devEngines`, `engine-strict`, `preinstall` or `prepare` gate imposes Node 26 on Pi's Git-package installation; dependency installation itself is intentionally not subject to the development guard.

### Optional Nix shell and pre-commit hooks

```sh
nix develop          # Node 26, fzf, Git, pre-commit, actionlint and nixfmt
npm ci --ignore-scripts
pre-commit run --all-files
pre-commit install   # optional: enable checks on each commit
```

Entering `nix develop` generates the ignored `.pre-commit-config.yaml` link; it does **not** install npm dependencies or modify Git hooks. The upstream automatic installer is disabled because it rewrites `core.hooksPath`. `pre-commit install` explicitly opts in; it refuses a custom `core.hooksPath` and preserves an existing pre-commit hook in migration mode. Use `pre-commit uninstall` to opt out.

The installed hook uses Nix store paths, so commits can also be made from outside the shell. Run `nix develop` again after updating the flake. If garbage collection removes the tools, remove the generated `.pre-commit-config.yaml` link, re-enter the shell and reinstall the hook. The shell leaves an unrelated pre-commit configuration untouched.

The hook runs `npm run check` when source, tests, release scripts or Node configuration change, formats Nix files, and lints workflow files. Hooks are a local convenience, not an enforcement boundary: non-Nix contributors can run the npm commands directly, and PR CI is authoritative. If a formatter changes a file, review and stage it before retrying the commit.

`flake.lock` pins the Node/tooling environment for x86-64/ARM64 Linux and Apple Silicon macOS (the systems exposed by the pinned `git-hooks.nix`; Intel Mac and Windows contributors can use npm directly). This deliberately stays a **dev shell**, not a Nix package for the extension: Pi loads TypeScript directly, and duplicating npm dependency packaging would add little value. `git-hooks.nix` shares the same nixpkgs input.

```sh
nix fmt              # format flake.nix
nix flake check      # sandboxed Nix formatting and GitHub Actions lint checks
nix flake update     # explicitly refresh Nix inputs; review and commit flake.lock
```

`nix flake check` is a local convenience, not a CI job. It excludes npm checks because its sandbox has neither network access nor `node_modules`; CI runs the npm checks directly. Local `.pi/` agent state, generated hook configuration and Nix result links are ignored.

### CI and releases

Every PR and push to `main` runs `.github/workflows/ci.yml`: typechecking and tests on **Linux, macOS and Windows**, each with **Node 26**, read from `.node-version` (also used by the release job), and with fzf installed through apt, Homebrew or Chocolatey. The runners are `ubuntu-latest`, `macos-latest` and `windows-latest`, using their default architectures; Windows uses amd64/x64. Nix and workflow lint checks remain local only. Actions use explicit release tags (such as `v7.0.1`, not a floating major); Dependabot proposes monthly action updates. Tags are easier to read but can be moved upstream, unlike commit pins. To make these checks mandatory before merging, enable a GitHub branch ruleset for `main` and require the CI jobs (workflow files alone do not enforce merge policy).

Distribution remains Git-only: `package.json` is `private` to prevent accidental npm publication. Pi reads the existing `pi.extensions` entry point from the checkout and supplies the host packages declared as peers. There is no bundling, npm token, uploaded tarball or compiled release asset. GitHub provides its usual source archives.

To release:

1. On a normal PR branch, run `npm version patch --no-git-tag-version` (or choose `minor`, `major`, or an explicit stable version). This updates both `package.json` and `package-lock.json`. Commit both files and merge the PR after checks pass.
2. Tag the merged commit from an up-to-date `main` and push the tag:

   ```sh
   git switch main
   git pull --ff-only
   version=$(node -p 'JSON.parse(require("node:fs").readFileSync("package.json", "utf8")).version')
   git tag -a "v$version" -m "v$version"
   npm run release:check -- "v$version"
   git push origin "v$version"
   ```

3. `.github/workflows/release.yml` reruns the same CI suite for the tagged commit. Only after it passes, the release job checks that the stable `vX.Y.Z` tag matches both version fields in the lockfile and `package.json`, points at the checked-out commit, and is contained in `origin/main`. It then creates a GitHub release with generated notes using the built-in `GITHUB_TOKEN`. Only this job gets `contents: write`. Re-running the job leaves an existing release unchanged.

For the first release, the existing `0.1.0` can be tagged after this setup is merged; no artificial bump is needed. Prerelease tags are not supported yet. Published tags are immutable by convention: fix a bad release with a new version instead of moving its tag. A tag is installable by Pi as soon as it is pushed, even if the GitHub release checks later fail—those checks gate the GitHub release, not Git access to the ref. Generated release notes live on GitHub; this setup does not maintain a `CHANGELOG.md` for Pi's in-app update notices.

### Tests

The tests load the real entry point against a fake Pi API and UI context, with Pi's real editor and text-input components. The fake mirrors Pi's overlay lifecycle: the overlay is mounted asynchronously, and closing it gives focus back to the editor before the result arrives. History comes from synthetic session files in a temporary agent directory (`PI_CODING_AGENT_DIR`), so no real prompt history is read.

Tests assert on what a user sees: the input bar's text and cursor, and the rendered overlay lines (the list rows and the query line). The one allowed exception is a narrow set of checks at the extension's external boundaries, for behaviour that has no visible output: prompts handed to Pi for submission ("nothing is submitted"), what the extension registered or installed with Pi ("registers nothing outside TUI mode"), the session files on disk ("never written"), and what the matcher process is given and whether it was killed. Tests never assert on the extension's private state.

The harness (`test/harness.ts`) always puts a scripted stub matcher (`test/fixtures/stub-matcher.mjs`) on `PATH` as `fzf` and `sk`, so on Linux and macOS the extension-boundary tests never reach a real matcher. The stub records its arguments, environment and input, replies with scripted output, exit status, error output and delay or ends by a signal, and records whether it outlived its delay (that is, was not killed). The matcher adapter is also tested on its own against the real fzf (`test/fzf-matcher.test.ts`): ranking on the fixture from the fuzzy-matching investigation, newest-first ties, search syntax and multi-line round trips. The 50 ms debounce has no test: runs it would save are killed before the stub starts, so it is not observable at the process boundary.

On Windows the stub uses `.cmd` launchers, which Node will not start without a shell, and the extension never uses one: tests that need the stub to answer are skipped there, and tests that open the modal with a draft may start the fzf CI installs, without depending on its outcome. The POSIX read-permission test is skipped on Windows (and for root), as are the tests for an fzf without execute permission and for a query too long to start fzf with; malformed-session coverage runs everywhere. CI exercises the extension-boundary suite, not the real Pi terminal executable, so the Windows job is not an interactive Windows smoke test.
