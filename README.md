# pi-history

One history modal for [Pi](https://pi.dev). Recalling and searching previous prompts happens in a single Pi-drawn overlay; Pi's input bar is never used as the browsing surface, so browsing history can never damage a draft.

Targets Pi **1.5.2** on Linux and macOS. It is a Pi package written in TypeScript and loaded by Pi directly, with no build step.

> Do not load it together with another prompt-history extension (for example `pi-input-history`): both take over the input bar's history keys.

## Status

This is the bootstrap ([#2](https://github.com/ningw42/pi-history/issues/2)) of the design in [#1](https://github.com/ningw42/pi-history/issues/1). What works today:

- **Ctrl+R** in the input bar, at any cursor position, opens the history modal.
- The modal lists the prompts you typed in sessions started in the **exact current working directory**, newest first, one row per unique prompt (its most recent use wins). Multi-line prompts are shown as one row.
- **Up** moves to older records, **Down** back toward newer ones. The newest record starts selected and sits at the bottom of the list.
- **Enter** replaces the whole draft with the selected record and puts the cursor at the end. Nothing is submitted.
- **Escape** closes the modal and leaves the draft, cursor and collapsed pastes exactly as they were.
- Confirm, cancel and list navigation follow your Pi keybindings (`tui.select.confirm`, `tui.select.cancel`, `tui.select.up`, `tui.select.down`).
- Session files are only read. The extension does nothing outside Pi's interactive (TUI) mode.

## Roadmap

The remaining sub-issues of #1, in order:

| Issue | Adds |
|---|---|
| [#3](https://github.com/ningw42/pi-history/issues/3) | A query line seeded from the draft, and fuzzy ranking by `fzf` in filter mode (match quality first, recency second). |
| [#4](https://github.com/ningw42/pi-history/issues/4) | An optional JSON configuration file in Pi's agent directory, and `sk` (skim) as an alternative matcher. |
| [#5](https://github.com/ningw42/pi-history/issues/5) | **Repo** scope (the whole git repository) and **global** scope (every session), toggled with Ctrl+R inside the modal. |
| [#6](https://github.com/ningw42/pi-history/issues/6) | The live session's prompts, a 5,000-record limit per scope, and an in-memory cache that re-reads only new or changed session files. |
| [#7](https://github.com/ningw42/pi-history/issues/7) | Prompts that began with `/skill:name` are recalled as `/skill:name arguments` instead of the expanded skill body. |
| [#8](https://github.com/ningw42/pi-history/issues/8) | A preview pane (line breaks, last-used time and directory) and a key-hint line. |
| [#9](https://github.com/ningw42/pi-history/issues/9) | **Up** in the input bar opens the modal where native Pi would start recalling history; native in-bar recall is retired. |
| [#10](https://github.com/ningw42/pi-history/issues/10) | A smoke suite that drives the real Pi executable in a pseudo-terminal. |

## Install

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
- **Matcher**: the external program (`fzf` or `sk`) that filters and ranks records for a query (#3, #4).
- **Confirm / dismiss**: the two ways the modal closes, with a record or without changing anything.

### Modules

| Module | File | Responsibility |
|---|---|---|
| Entry point | `src/index.ts` | Wires the modules together; inert unless Pi is in TUI mode. |
| Editor integration | `src/editor-integration.ts` | The only module that knows about Pi's editor. Wraps the input bar's editor to install the entry points, and applies a confirmed record to the draft. |
| History modal | `src/history-modal.ts` | The overlay component. Owns loading state, records and selection; handles keys; renders. Resolves with "confirmed text" or "dismissed" and **never writes to the input bar**. |
| History source | `src/history-source.ts` | Returns history records newest first, de-duplicated, from Pi session files. |

The matcher adapter (#3), configuration (#4) and skill restoration (#7) are the remaining modules of the design.

### Decisions

- **The search key is handled by wrapping the input bar's editor, not by `pi.registerShortcut`.** The wrapper sees every key before Pi does, so Ctrl+R takes precedence over any Pi binding on the same key while the input bar has focus. It is installed only in TUI mode, so nothing is registered in print, JSON or RPC mode. A registered `ctrl+r` shortcut would also be registered outside TUI mode, and Pi would report it at startup as a conflict with the `/resume` picker's rename binding.
- **The wrapper is installed synchronously at `session_start`, before any I/O, and never again.** Replacing the editor later would dismiss a selector the user opened in the meantime (for example `/model`). History is read only when the modal opens.
- **The wrapper composes with an editor factory configured by another extension**, falling back to Pi's `CustomEditor` with the working-status indicator embedded in its border. (Full composition coverage arrives with #9.)
- **The working directory recorded in each session header is the authority**, not the storage directory name: two directories such as `/a/b` and `/a-b` share one storage directory name.
- **Text blocks of one user message are joined with no separator**, the way Pi's interactive mode joins them for display and native history.
- **Keys that arrive while the modal is opening or closing belong to the modal.** Pi mounts the overlay asynchronously and gives focus back to the editor before the result arrives, so keys from the same terminal input batch (for example a fast Ctrl+R then Enter, or a double Enter) would otherwise reach the editor and submit the draft the modal is replacing.
- **The session directory** is the current session's. An ephemeral (`--no-session`) session reports none, so the extension uses `PI_CODING_AGENT_SESSION_DIR` if set, else the `sessionDir` setting, else Pi's default directory. A `--session-dir` flag is not visible to extensions in an ephemeral session, so `--no-session --session-dir <dir>` does not read `<dir>`; to browse a custom directory's history in an ephemeral session, set `PI_CODING_AGENT_SESSION_DIR` or the `sessionDir` setting instead.
- **Recalled text goes through Pi's editor**, which stores CRLF/CR as LF and tabs as four spaces, as it does for typed and pasted text. Text typed, pasted or edited in Pi's input bar never contains those characters, so only text stored without passing through the editor is affected: RPC and SDK prompts, extension input transforms, and expanded prompt templates or skills.

## Development

Development and CI require **Node 26.x** (`.node-version`) and npm. The major is selected explicitly, not through a moving `latest` alias; the Nix lockfile pins the development package's exact version. The committed `package-lock.json` is the authority for JavaScript dependencies.

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
nix develop          # Node 26, Git, pre-commit, actionlint and nixfmt
npm ci --ignore-scripts
pre-commit run --all-files
pre-commit install   # optional: enable checks on each commit
```

Entering `nix develop` generates the ignored `.pre-commit-config.yaml` link; it does **not** install npm dependencies or modify Git hooks. The upstream automatic installer is disabled because it rewrites `core.hooksPath`. `pre-commit install` explicitly opts in; it refuses a custom `core.hooksPath` and preserves an existing pre-commit hook in migration mode. Use `pre-commit uninstall` to opt out.

The installed hook uses Nix store paths, so commits can also be made from outside the shell. Run `nix develop` again after updating the flake. If garbage collection removes the tools, remove the generated `.pre-commit-config.yaml` link, re-enter the shell and reinstall the hook. The shell leaves an unrelated pre-commit configuration untouched.

The hook runs `npm run check` when source, tests, release scripts or Node configuration change, formats Nix files, and lints workflow files. Hooks are a local convenience, not an enforcement boundary: non-Nix contributors can run the npm commands directly, and PR CI is authoritative. If a formatter changes a file, review and stage it before retrying the commit.

`flake.lock` pins the Node/tooling environment for x86-64/ARM64 Linux and Apple Silicon macOS (the systems exposed by the pinned `git-hooks.nix`; Intel Mac contributors can use npm directly). This deliberately stays a **dev shell**, not a Nix package for the extension: Pi loads TypeScript directly, and duplicating npm dependency packaging would add little value. `git-hooks.nix` shares the same nixpkgs input.

```sh
nix fmt              # format flake.nix
nix flake check      # sandboxed Nix formatting and GitHub Actions lint checks
nix flake update     # explicitly refresh Nix inputs; review and commit flake.lock
```

The sandboxed flake check excludes npm checks because it has neither network access nor `node_modules`; CI runs those separately with `npm ci`. Local `.pi/` agent state, generated hook configuration and Nix result links are ignored.

### CI and releases

Every PR and push to `main` runs `.github/workflows/ci.yml`: typechecking and tests on **Linux and macOS**, each with **Node 26**, read from `.node-version` (also used by the release job), plus the sandboxed flake/workflow checks on Linux. Actions are pinned to commits; Dependabot proposes monthly action updates. To make these checks mandatory before merging, enable a GitHub branch ruleset for `main` and require the CI jobs (workflow files alone do not enforce merge policy).

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

The tests load the real entry point against a fake Pi API and UI context, with Pi's real editor component (Pi's text-input component joins it with the query line in #3). The fake mirrors Pi's overlay lifecycle: the overlay is mounted asynchronously, and closing it gives focus back to the editor before the result arrives. History comes from synthetic session files in a temporary agent directory (`PI_CODING_AGENT_DIR`), so no real prompt history is read.

Tests assert on what a user sees: the input bar's text and cursor, and the rendered overlay lines. The one allowed exception is a narrow set of safety checks at the extension's boundary with Pi, for behaviour that has no visible output: prompts handed to Pi for submission ("nothing is submitted"), what the extension registered or installed with Pi ("registers nothing outside TUI mode"), and the session files on disk ("never written"). Tests never assert on the extension's private state.

The harness (`test/harness.ts`) can also put a scripted stub matcher on `PATH` as `fzf` and `sk`, ready for #3 and #4.
