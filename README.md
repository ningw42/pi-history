# pi-history

One history modal for [Pi](https://pi.dev). Recalling and searching previous prompts happens in a single Pi-drawn overlay; Pi's input bar is never used as the browsing surface, so browsing history can never damage a draft.

Targets Pi **1.5.2** on Linux and macOS. It is a Pi package written in TypeScript and loaded by Pi directly, with no build step.

> Do not load it together with another prompt-history extension (for example `pi-input-history`): both take over the input bar's history keys.

## Status

The bootstrap ([#2](https://github.com/ningw42/pi-history/issues/2)), fuzzy search ([#3](https://github.com/ningw42/pi-history/issues/3)), configuration with skim ([#4](https://github.com/ningw42/pi-history/issues/4)) and the repo and global scopes ([#5](https://github.com/ningw42/pi-history/issues/5)) of the design in [#1](https://github.com/ningw42/pi-history/issues/1) are done. What works today:

- **Ctrl+R** (or the [configured](#configuration) search key) in the input bar, at any cursor position, opens the history modal.
- The modal lists the prompts you typed, one row per unique prompt (its most recent use wins), at most the newest 5,000 (configurable). Multi-line prompts are shown as one row.
- The modal always opens in **repo** scope: the prompts of every session started in the git repository you are in, at its top level or in any subdirectory, so starting Pi in a subdirectory still shows the whole repository's history. Outside a git repository, repo scope is the exact current working directory. Pressing **Ctrl+R** (the search key) inside the modal switches to **global** scope, every Pi session on the machine, and back. The query is kept, and the list is reloaded for the new scope with its best candidate selected. The title names the scope and the frame changes colour with it; the bottom edge names the scope the key switches to.
- The modal has a **query line**, which starts with whatever is in the input bar when you press the search key. Editing it never changes your draft. With an empty (or whitespace-only) query the list is newest first. With a query, the list is ranked by [**fzf**](https://github.com/junegunn/fzf), or by [**skim**](https://github.com/skim-rs/skim) (`sk`) if you configure it: match quality first, recency second, so an old obvious match beats a recent weak one. The matcher's search syntax works (several terms, `'exact`, `^prefix`, `suffix$`, `!negation`, `a | b`).
- The best candidate starts selected and sits at the bottom of the list, next to the query line. **Up** moves to older (or lower-ranked) records, **Down** back toward newer (or higher-ranked) ones.
- If nothing matches, the modal says so. If the matcher is missing or fails, the modal shows why; clearing the query still browses newest first.
- **Enter** replaces the whole draft with the selected record and puts the cursor at the end. Nothing is submitted.
- **Escape** closes the modal and leaves the draft, cursor and collapsed pastes exactly as they were.
- Confirm, cancel and list navigation follow your Pi keybindings (`tui.select.confirm`, `tui.select.cancel`, `tui.select.up`, `tui.select.down`).
- Session files are only read. The extension does nothing outside Pi's interactive (TUI) mode.

## Roadmap

The remaining sub-issues of #1, in order:

| Issue | Adds |
|---|---|
| [#6](https://github.com/ningw42/pi-history/issues/6) | The live session's prompts, and an in-memory cache that re-reads only new or changed session files. |
| [#7](https://github.com/ningw42/pi-history/issues/7) | Prompts that began with `/skill:name` are recalled as `/skill:name arguments` instead of the expanded skill body. |
| [#8](https://github.com/ningw42/pi-history/issues/8) | A preview pane (line breaks, last-used time and directory) and a key-hint line. |
| [#9](https://github.com/ningw42/pi-history/issues/9) | **Up** in the input bar opens the modal where native Pi would start recalling history; native in-bar recall is retired. |
| [#10](https://github.com/ningw42/pi-history/issues/10) | A smoke suite that drives the real Pi executable in a pseudo-terminal. |

## Install

Searching needs [`fzf`](https://github.com/junegunn/fzf) on your `PATH` (any recent release; developed against 0.72 and 0.75), or [`sk`](https://github.com/skim-rs/skim) if you [configure](#configuration) skim instead (tested with 4.7 and 5.9). Without the matcher the modal still browses newest first, and says that the matcher is missing whenever there is a query (including one started from the draft).

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

## Configuration

Everything works without configuration. To change a setting, create `pi-history.json` in Pi's agent directory: `~/.pi/agent/pi-history.json`, or `$PI_CODING_AGENT_DIR/pi-history.json` if you set that variable. Every setting is optional:

```json
{
  "matcher": "sk",
  "matcherCommand": "~/.local/bin/sk",
  "searchKey": "ctrl+t",
  "recordLimit": 10000
}
```

| Setting | Default | Meaning |
|---|---|---|
| `matcher` | `"fzf"` | The program that ranks results for a query: `"fzf"` or `"sk"` (skim). |
| `matcherCommand` | the matcher's name, found on `PATH` | The executable to start: a command name looked up on `PATH`, or a path. A leading `~/` means your home directory; any other relative path (such as `bin/sk`) is relative to the agent directory that holds this file, never to the directory Pi was started in. |
| `searchKey` | `"ctrl+r"` | The key that opens the history modal from the input bar and switches its scope inside it, in [Pi's keybinding syntax](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/keybindings.md#key-syntax) (for example `"ctrl+t"` or `"alt+h"`), in any case. Escape takes no modifiers: Pi never recognizes `ctrl+escape` and the like. It takes precedence over every Pi binding on the same key while the input bar has focus. Inside the modal, a key your Pi keybindings also give to confirming, cancelling or moving the selection (`tui.select.confirm`, `tui.select.cancel`, `tui.select.up`, `tui.select.down`) keeps that action, so the scope cannot be switched: the modal's bottom edge says so, and Pi warns you once. |
| `recordLimit` | `5000` | How many unique prompts, newest first, the modal holds at most in each scope. A positive integer. |

The file is read at every session start (Pi's startup, `/new`, `/resume`, `/fork` and `/reload`); run `/reload` to apply changes right away. If it cannot be read or is not a JSON object, Pi shows a warning and every default applies. An invalid value or an unknown setting is ignored with a warning that lists every problem, and the other settings still apply. Each warning is shown once: later session starts, `/reload` included, repeat it only if the problems have changed.

## Design

### Vocabulary

- **History modal**: the single Pi-drawn overlay through which all history browsing and searching happens.
- **Entry point**: a way into the modal. The **search entry** is Ctrl+R (configurable); the **Up entry** arrives in #9.
- **Draft**: the text in Pi's input bar when an entry point fires.
- **History record**: one unique user-typed prompt with the time and working directory of its most recent use.
- **Scope**: which sessions records are drawn from: **repo** (the git repository containing the current working directory, or exactly that directory outside a repository) or **global** (every session).
- **Matcher**: the external program that filters and ranks records for a query: `fzf` (default) or `sk`.
- **Confirm / dismiss**: the two ways the modal closes, with a record or without changing anything.

### Modules

| Module | File | Responsibility |
|---|---|---|
| Entry point | `src/index.ts` | Wires the modules together from the configuration; inert unless Pi is in TUI mode. |
| Configuration | `src/config.ts` | Loads and validates the optional configuration file, falling back to defaults per setting, and describes every problem in one message. |
| Editor integration | `src/editor-integration.ts` | The only module that knows about Pi's editor. Wraps the input bar's editor to install the entry points, and applies a confirmed record to the draft. |
| History modal | `src/history-modal.ts` | The overlay component. Owns the scope, loading state, the query line, the result list and selection; handles keys; renders. Resolves with "confirmed text" or "dismissed" and **never writes to the input bar**. |
| History source | `src/history-source.ts` | Given a scope and the current session context, returns history records newest first, de-duplicated and limited to the record limit, from Pi session files. Hides session enumeration, session-file parsing and repository-root resolution. |
| Matcher adapter | `src/matcher.ts` | Given a query, newest-first records and a cancellation signal, returns the matching records ranked, or a typed failure. Hides every difference between fzf and sk, process handling, the NUL-delimited transport, environment scrubbing and exit-status interpretation. |

Skill restoration (#7) is the remaining module of the design.

### Decisions

- **The search key is handled by wrapping the input bar's editor, not by `pi.registerShortcut`.** The wrapper sees every key before Pi does, so Ctrl+R (or the configured key) takes precedence over any Pi binding on the same key while the input bar has focus. It is installed only in TUI mode, so nothing is registered in print, JSON or RPC mode. A registered `ctrl+r` shortcut would also be registered outside TUI mode, and Pi would report it at startup as a conflict with the `/resume` picker's rename binding.
- **The wrapper is installed synchronously at `session_start`, before any I/O, and never again.** Replacing the editor later would dismiss a selector the user opened in the meantime (for example `/model`). History is read only when the modal opens, and again whenever its scope is switched.
- **The configuration file is read synchronously right after the wrapper is installed**, in the same `session_start` handler. The wrapper looks its configured parts (search key, matcher, history source) up when a key arrives, so installing needs no configuration and does no I/O, yet the configuration is always in place before the first key. Outside TUI mode the file is not read. The file lives in the agent directory reported by Pi's `getAgentDir()`, so `PI_CODING_AGENT_DIR` is honoured.
- **Pi 1.5.2 loads the extension afresh at every session start**: `/new`, `/resume`, `/fork` and `/reload` reset the extension UI (removing the wrapper), re-import the module (its loader disables jiti's module cache) and call its factory again. So the file is re-read each time, and nothing kept in the module or the factory survives. To warn only once, the last reported problem is remembered in process-wide state (a `Symbol.for` key on `globalThis`): a problem is reported when it is new or changed, at any session start including `/reload`; fixing the file forgets it, so making the same mistake again is reported again. Process-lifetime state planned for later issues, such as #6's history cache, needs the same treatment.
- **Configuration problems never disable the extension.** An unreadable file, invalid JSON or a non-object means every default; an invalid value means that setting's default; an unknown setting (often a misspelt one) is ignored. All of them are listed in one warning, so a typo is noticed instead of silently ignored.
- **The search key is validated against Pi's documented key syntax** (modifiers `ctrl`, `shift`, `alt`, `super`, each at most once, then a known key, in any case) **and Pi's key matching**, because an unrecognised key would match nothing and leave no way to open the modal. Pi's matcher rejects Escape (or `esc`) with any modifier outright, so those are invalid too; every other modified key has a Kitty or modifyOtherKeys form, even if a given terminal cannot send it. Like Pi's own keybindings, any valid key is accepted, even one that shadows typing.
- **The wrapper composes with an editor factory configured by another extension**, falling back to Pi's `CustomEditor` with the working-status indicator embedded in its border. (Full composition coverage arrives with #9.)
- **The working directory recorded in each session header is the authority**, not the storage directory name: two directories such as `/a/b` and `/a-b` share one storage directory name. Pi records absolute directories; a session recording a relative one, or none, is never in repo scope, though it is still in global scope.
- **Text blocks of one user message are joined with no separator**, the way Pi's interactive mode joins them for display and native history.
- **Keys that arrive while the modal is opening or closing belong to the modal.** Pi mounts the overlay asynchronously and gives focus back to the editor before the result arrives, so keys from the same terminal input batch (for example a fast Ctrl+R then Enter, or a double Enter) would otherwise reach the editor and submit the draft the modal is replacing. Once the modal has closed, such keys are dropped: they neither edit its query nor start a search.
- **The session storage** is the current session's. A custom session directory, which holds every session and is then the only directory read, is configured with `PI_CODING_AGENT_SESSION_DIR` or else the `sessionDir` setting (Pi's precedence), wherever it is, even inside `<agent dir>/sessions`. A persisted session reports the directory it actually uses, and that wins: the configured one is custom; another one directly inside `<agent dir>/sessions` means Pi's default layout, one directory per working directory, all of which are read; any other is custom too (as with a `--session-dir` flag). Only a `--session-dir` flag naming a directory directly inside `<agent dir>/sessions` is taken for the default layout: extensions cannot see the flag, and Pi's own test for the default layout compares against its private encoding of the working directory, which the extension does not depend on. An ephemeral (`--no-session`) session reports none, so the configured directory applies, else Pi's default layout. A `--session-dir` flag is not visible to extensions in an ephemeral session, so `--no-session --session-dir <dir>` does not read `<dir>`; to browse a custom directory's history in an ephemeral session, set `PI_CODING_AGENT_SESSION_DIR` or the `sessionDir` setting instead.
- **Sessions are found by listing the storage directories, not through Pi's session-listing API.** `SessionManager.list` and `listAll` parse every line of every file they list, to build summaries the extension does not use. The repo scope must look in every storage directory, because each subdirectory of a repository has its own. So the first line of each `*.jsonl` file, its session header, is read on its own for the recorded working directory, and only the files in scope are read in full. The storage rule above is what honours a custom session directory, the reason #1 gave for using Pi's API. Until #6 adds a cache, every load reads every header again, and global scope reads every session file in full.
- **The repository is found the way git finds it, without running git**: walking up from the current working directory, the top level is the first directory whose `.git` is a git directory, or a file (a linked worktree's or a submodule's) whose `gitdir:` line names one. A git directory passes git's own test (`is_git_directory`): its `HEAD` is a symbolic link into `refs/` (even to an unborn branch) or a file holding `ref: refs/…` or an object id, and its common directory (named by `commondir` in a linked worktree's) has searchable `objects` and `refs` directories. An invalid `.git`, such as an empty directory or one holding only `HEAD`, does not stop the search; as with git, the directories above it are still searched. (Pi's footer accepts any `.git` holding `HEAD` and stops at an invalid one.) git itself is not run: `git rev-parse --show-toplevel` resolves symbolic links, so a repository reached through one (such as macOS's `/var`, really `/private/var`) would no longer match the working directories Pi records.
- **A repository checked out inside another is a separate repository.** A session recorded in a linked worktree, a submodule or any other clone inside the repository (for example in `.worktrees/fix`) belongs to that repository's repo scope, not the enclosing one's, and separate worktrees of one repository are separate repositories wherever they are. Top levels are checked on disk at each load, so the sessions of a nested worktree that has since been deleted fall back into the enclosing repository.
- **Every open starts in repo scope**; the scope is not remembered. **Switching scope** cancels the previous scope's loading and any search and shows the loading state; then the kept query is matched against the new scope's records (an empty query lists them newest first), and the best candidate is selected. Nothing loaded or matched for the previous scope is shown after a switch. Inside the modal the search key is checked before the query line's editing keys but after the confirm, cancel and navigation keys (`tui.select.*`), so the modal can always be closed and navigated. If your Pi keybindings give the search key to one of those (a `searchKey` of `"up"`, or `tui.select.up` rebound to Ctrl+R), that action keeps it and the scope cannot be switched; rather than advertise a switch that never happens, the bottom edge then reads, for example, `ctrl+r move selection up (scope switch unavailable)`, and a warning names the conflicting keybinding and how to resolve it. The check runs at every open against the keybindings in effect then (Pi reloads them after `session_start` on `/reload`) and warns once per conflict. Key ids are compared in one spelling (any case, modifiers in any order, `esc`/`return` aliases); keys a terminal happens to send identically, such as Ctrl+M and Enter without the Kitty keyboard protocol, are not detected.
- **The scope is shown three ways**: the title names it (`History · repo`, `History · global`); the frame and title take the theme's `borderAccent` colour in repo scope and its `warning` colour in global scope; and the bottom edge names the key and the scope it switches to (`ctrl+r switch to global`).
- **Recalled text goes through Pi's editor**, which stores CRLF/CR as LF and tabs as four spaces, as it does for typed and pasted text. Text typed, pasted or edited in Pi's input bar never contains those characters, so only text stored without passing through the editor is affected: RPC and SDK prompts, extension input transforms, and expanded prompt templates or skills.
- **The draft is the starting query, verbatim**, so the matcher's search syntax applies to it: a draft that begins with `!` or `'`, or contains ` | `, is read as matcher operators. Two exceptions: the query line is Pi's single-line text input, which cannot hold a line break, so a multi-line draft's line breaks become spaces, and a collapsed paste counts with its content, not its `[paste #1 …]` marker. The query is one command-line argument, so a paste larger than the operating system allows for one (about 128 KiB on Linux) cannot be searched and shows "Search failed". A whitespace-only draft or query counts as empty: nothing to match, so no matcher process runs. Because fzf and sk separate terms on spaces only, a line break inside a query would be part of a term; with spaces instead, a multi-line draft's lines are matched as separate terms and the search is looser than the matcher given the exact multi-line text.
- **The query line is Pi's own `Input` component**, so it edits like the rest of Pi and follows your editing keybindings. The draft is put into it as a bracketed paste, because `Input` has no public way to place the cursor and a paste leaves it at the end.
- **The matcher runs as a filter, never interactively**, started directly with an argument list (no shell), with records NUL-delimited on its standard input newest first, so multi-line prompts survive. Results are mapped back to records by text, which is unique after de-duplication. A record containing a NUL cannot be delimited and is never matched. Both matchers rank by match quality first and break ties by input order, which is recency; sorting is left on:
  - fzf: `fzf --filter=<query> --read0 --print0 --scheme=history`.
  - sk: `sk --filter=<query> --read0 --print0 --tiebreak=score,index`. Never skim's `--scheme=history`: unlike fzf's, it ranks input order ahead of match quality, so the newest weak match would win.
  - The query is attached to `--filter=` rather than passed as the next argument: sk reads a separate `-foo` as an option and fails, so a draft starting with `-` could not be searched.
- **Your matcher defaults cannot change the ranking**: `FZF_DEFAULT_OPTS`, `FZF_DEFAULT_OPTS_FILE`, `SKIM_DEFAULT_OPTIONS` and `SKIM_OPTIONS_FILE` are removed from the matcher's environment (`--no-sort` there would otherwise list results in recency order).
- **Only the latest query's results are shown.** A query edit waits 50 ms, then starts one matcher run; any earlier run is killed and its output discarded, so a slow search never replaces a newer one. Closing the modal kills a running search. Until the new results arrive the previous list stays on screen but cannot be confirmed: Enter does nothing while the list is out of date, so typing a query and Enter in one input batch never confirms a record the query does not match. Each new list selects its best candidate.
- **The "no match" status (1, for both fzf and sk) is a result, not an error**: the modal shows "No matches". A missing matcher is reported as not found, by its configured command; any other failure to start it (for example one that is not executable, or a query too long for the command line), any other exit status, and the matcher being killed by a signal are reported, an exit status with the matcher's first line of error output. A query containing a NUL character (only possible by pasting one) cannot be passed to the matcher and is reported too. There is no built-in fallback matcher.
- **The record limit is applied after de-duplication**, keeping the newest unique records, so it bounds what the modal holds and what is sent to the matcher.

## Development

Development and CI require **Node 26.x** (`.node-version`), npm, **`git`**, and both **`fzf`** and **`sk`** on `PATH`: the matcher adapter tests run the real fzf and sk and fail, rather than skip, without them, and two scope tests create repositories with `git init`. The Nix shell provides both (sk 4.7 from the pinned nixpkgs). CI installs fzf from each runner's package manager and sk from the pinned upstream release 5.9.0, checking the archive against a SHA-256 recorded in the workflow, because package managers ship skim releases years apart. The Node major is selected explicitly, not through a moving `latest` alias; the Nix lockfile pins the development package's exact version. The committed `package-lock.json` is the authority for JavaScript dependencies.

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
nix develop          # Node 26, fzf, sk, Git, pre-commit, actionlint and nixfmt
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

Every PR and push to `main` runs `.github/workflows/ci.yml`: typechecking and tests on **Linux, macOS and Windows**, each with **Node 26**, read from `.node-version` (also used by the release job), with fzf installed through apt, Homebrew or Chocolatey, and with sk 5.9.0 from its checksum-verified upstream release. The runners are `ubuntu-latest`, `macos-latest` and `windows-latest`, using their default architectures; Windows uses amd64/x64. Nix and workflow lint checks remain local only. Actions use explicit release tags (such as `v7.0.1`, not a floating major); Dependabot proposes monthly action updates. Tags are easier to read but can be moved upstream, unlike commit pins. To make these checks mandatory before merging, enable a GitHub branch ruleset for `main` and require the CI jobs (workflow files alone do not enforce merge policy).

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

The tests load the real entry point against a fake Pi API and UI context, with Pi's real editor and text-input components. The fake mirrors Pi's overlay lifecycle: the overlay is mounted asynchronously, and closing it gives focus back to the editor before the result arrives. It also mirrors how Pi starts a session (at startup and on `/new`, `/resume`, `/fork` and `/reload`): it removes the installed editor wrapper, calls the extension's factory again and then emits `session_start`. It cannot re-import the module the way Pi does, so extension code keeps no module-level state. History comes from synthetic session files in a temporary agent directory (`PI_CODING_AGENT_DIR`), so no real prompt history is read. Git repositories are mostly synthetic too, laid out as git leaves them: a `.git` directory holding `HEAD`, `objects` and `refs`; for a linked worktree, a `.git` file pointing to a git directory inside the main repository's (with `HEAD` and `commondir`); for a submodule, a relative `gitdir:`. Two tests use the real `git init` instead (with inherited `GIT_*` variables removed, so running from a Git hook cannot touch this repository), tying the synthetic layout to git's. The harness refuses to run when the temporary directory is inside a git repository, because every test directory would then share one repo scope; point `TMPDIR` elsewhere.

Tests assert on what a user sees: the input bar's text and cursor, and the rendered overlay lines (the title, the list rows, the query line and the key hint) and the colours of the frame and title. The one allowed exception is a narrow set of checks at the extension's external boundaries, for behaviour that has no visible output: prompts handed to Pi for submission ("nothing is submitted"), what the extension registered or installed with Pi ("registers nothing outside TUI mode"), the session files on disk ("never written"), and what the matcher process is given and whether it was killed. Tests never assert on the extension's private state.

The harness (`test/harness.ts`) always puts a scripted stub matcher (`test/fixtures/stub-matcher.mjs`) on `PATH` as `fzf` and `sk`, so on Linux and macOS the extension-boundary tests never reach a real matcher. The stub records its arguments, environment and input, replies with scripted output (chosen by the query and, optionally, by a record the input must hold, so one scope's run can be told from the other's), exit status, error output and delay or ends by a signal, and records whether it outlived its delay (that is, was not killed). The process contract each matcher must honour (exact arguments and NUL transport, environment scrubbing, the no-match status, a missing executable, a failure status with its first error line) is one suite in `test/fuzzy-search.test.ts`, run once per matcher from a row of fixture data. The matcher adapter is also tested on its own against the real fzf and sk (`test/real-matchers.test.ts`), with both programs' default-option variables and files set to options that would break the ranking: ranking on the fixture from the fuzzy-matching investigation, newest-first ties, search syntax, queries starting with `-` or `=`, and multi-line round trips. The configuration tests (`test/configuration.test.ts`) write the file into the harness's temporary agent directory, which the harness hands to Pi through `PI_CODING_AGENT_DIR`, so the user's real configuration never applies. The 50 ms debounce has no test: runs it would save are killed before the stub starts, so it is not observable at the process boundary.

On Windows the stub uses `.cmd` launchers, which Node will not start without a shell, and the extension never uses one: tests that need the stub to answer are skipped there, and tests that open the modal with a draft may start the fzf CI installs, without depending on its outcome. The POSIX read-permission test is skipped on Windows (and for root), as are the tests for an fzf without execute permission and for a query too long to start fzf with; malformed-session coverage runs everywhere. CI exercises the extension-boundary suite, not the real Pi terminal executable, so the Windows job is not an interactive Windows smoke test.
