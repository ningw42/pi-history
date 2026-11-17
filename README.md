# pi-history

Recall and search previous prompts in a [Pi](https://pi.dev) overlay. Your draft stays untouched until you confirm a prompt, and recalling never submits it.

Targets **Pi 1.5.2** on Linux and macOS, in interactive (TUI) mode. Pi loads the TypeScript source directly; no build is needed.

## Install

Install [`fzf`](https://github.com/junegunn/fzf) on your `PATH`, or [`skim`](https://github.com/skim-rs/skim) (`sk`) and [configure](#configuration) it as the matcher. Then install the extension from Git:

```sh
pi install git:github.com/ningw42/pi-history
```

This follows `main`. To pin a published release, append `@vX.Y.Z` with the desired tag; pinned installations require an explicit tag change to upgrade. There is no npm package.

> Do not load another prompt-history extension alongside this one: they compete for the same history keys.

Without a matcher, you can still browse history with an empty query. Searches show an error; clearing the query returns to browsing.

## Usage

Open history with **Ctrl+R** from anywhere in the draft. With autocomplete closed, **Up** opens it on an empty input bar or at the very start of the draft; a key bound to `tui.editor.historyPrevious` opens it from anywhere. Otherwise Up keeps Pi's cursor movement and autocomplete behaviour. These entry points work while the agent is working, too.

Inside the modal:

| Key | Action |
| --- | --- |
| Type | Edit the search query without changing the draft. |
| Up / Down | Move toward older / newer prompts, or lower / higher ranked matches. |
| Ctrl+R | Switch between repo and global scope, keeping the query. |
| Enter | Replace the whole draft with the selection, with the cursor at the end. Nothing is submitted. |
| Escape | Close history, preserving the draft, cursor and collapsed pastes. |

These are the defaults: opening and scope switching use the configured `searchKey`; navigation, confirmation and cancellation follow Pi's `tui.select.*` bindings. The modal shows the active keys.

The query starts with your draft; multi-line drafts become a single line. An empty or whitespace-only query lists newest prompts first. Searches rank by match quality, then recency, using the matcher's syntax: multiple terms, `'exact`, `^prefix`, `suffix$`, `!negation` and `a | b`. This syntax applies to the starting draft too. The best candidate starts selected at the bottom of the list.

Each unique prompt appears once, at its most recent use, up to the configured limit. Multi-line prompts use `↵` in the list; the preview preserves their lines and shows the last-used time and directory. Skill invocations are recalled as `/skill:name arguments`, not expanded instructions, so submitting one runs the current skill.

### History scopes

Every open starts in **repo** scope:

- **Repo:** sessions started anywhere in the current Git repository. Worktrees and nested repositories have separate scopes. Outside Git, this is the exact current directory.
- **Global:** all sessions in the active Pi session storage, across projects.

History includes the live session, abandoned branches and prompts from before compaction. Prompts from `--no-session` runs remain available for the life of the Pi process, including after `/new` or `/fork`. Session files are only read; new, changed and deleted files are reflected when history is opened again.

Pi's custom session storage is respected. For custom storage in a `--no-session` run, use `PI_CODING_AGENT_SESSION_DIR` or Pi's `sessionDir` setting; `--session-dir` alone is not visible to extensions in that mode.

### Editor compatibility

Pi's standard editor and `CustomEditor` subclasses support both entry points. Load a custom-editor extension before pi-history to keep its appearance and non-history keys. Editors missing either public `getCursor()` or `isShowingAutocomplete()` get search-key-only entry: Up and previous-history keys stay with that editor. Pi-fed in-bar history is disabled; independently maintained custom-editor history is outside this integration.

## Configuration

Create `~/.pi/agent/pi-history.json`, or `$PI_CODING_AGENT_DIR/pi-history.json` if you override Pi's agent directory. All settings are optional:

```json
{
  "matcher": "sk",
  "matcherCommand": "~/.local/bin/sk",
  "searchKey": "ctrl+t",
  "recordLimit": 10000
}
```

| Setting | Default | Meaning |
| --- | --- | --- |
| `matcher` | `"fzf"` | Search program: `"fzf"` or `"sk"`. |
| `matcherCommand` | Matcher's name on `PATH` | Executable name or path, without arguments. `~/` expands to your home; other relative paths are relative to the agent directory, not the current project. |
| `searchKey` | `"ctrl+r"` | Opens history and switches scope, in [Pi's keybinding syntax](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/keybindings.md#key-syntax), such as `"ctrl+t"` or `"alt+h"`. Escape takes no modifiers. |
| `recordLimit` | `5000` | Maximum unique prompts per scope; a positive integer. |

Run `/reload` to apply changes. Configuration is also read at startup, `/new`, `/resume` and `/fork`. Invalid settings fall back individually; an unreadable or malformed file uses all defaults. Unknown settings are ignored. Pi warns about problems once, repeating the warning only when they change.

The search key takes precedence over Pi bindings while the input bar has focus. Inside the modal, confirm, cancel and navigation take precedence: if the search key conflicts with them, scope switching is unavailable and Pi warns you. Terminal aliases count too—for example, Ctrl+M may arrive as Enter and Ctrl+[ as Escape. Choose an unshared key to retain scope switching.

Matcher default options (`FZF_DEFAULT_OPTS`, `FZF_DEFAULT_OPTS_FILE`, `SKIM_DEFAULT_OPTIONS`, `SKIM_OPTIONS_FILE`) are ignored so they cannot override search ranking.

## Development

Use **Node 26.x** (see `.node-version`), npm, Git, and both `fzf` and `sk` on `PATH`. Tests require both matchers, regardless of your personal configuration. The Node version requirement applies to development commands, not to the runtime hosting the extension.

```sh
npm ci --ignore-scripts
pi -e ./src/index.ts            # try the checkout once
pi install /path/to/pi-history  # or install the local checkout

npm run check                  # typecheck, functional tests, performance checks
npm run typecheck              # typecheck only, including the PTY suite
npm test                       # functional tests, then performance checks
npm run test:functional        # functional tests only
npm run test:performance       # performance checks only
npm run test:pty               # real-Pi smoke tests; Linux/macOS, also needs tmux
```

Functional tests run concurrently; wall-clock performance checks run afterward, one file at a time. Run performance investigations on an otherwise idle machine. Tests use temporary history and configuration, not your real data. If the harness reports that its temporary directory is inside a Git repository, set `TMPDIR` to a directory outside one.

The PTY suite uses the pinned Pi development dependency and isolated tmux servers. It needs no globally installed Pi or credentials and makes no model calls. To run every suite on Linux/macOS:

```sh
npm run check && npm run test:pty
```

CI runs `npm run check` on Linux, macOS and Windows, plus the PTY suite on Linux/macOS. Windows coverage excludes some POSIX-only tests; the supported interactive platforms remain Linux/macOS.

### Optional Nix shell and hooks

```sh
nix develop                    # Node 26, Git, fzf, sk, tmux and lint tools
npm ci --ignore-scripts
pre-commit run --all-files
pre-commit install             # optional; uninstall with pre-commit uninstall

nix fmt                        # format Nix files
nix flake check                # Nix formatting and GitHub Actions lint checks
nix flake update               # update pinned tools; review and commit flake.lock
```

The shell supports x86-64/ARM64 Linux and Apple Silicon macOS. It generates an ignored `.pre-commit-config.yaml` link without installing dependencies or hooks, and leaves an existing unrelated configuration alone. Hook installation is opt-in and refuses a custom `core.hooksPath`.

The hook runs npm checks for code/config changes, formats Nix files and lints workflows. Review and stage formatter changes before retrying a commit. Re-enter `nix develop` after flake updates; if garbage collection breaks the generated link, remove it, re-enter the shell and reinstall the hook. `nix flake check` does not run npm checks.

### Releases

Distribution is Git-only. To release:

1. On a PR branch, run `npm version patch --no-git-tag-version` (or choose `minor`, `major`, or an explicit stable version). Commit both `package.json` and `package-lock.json`, then merge after CI passes.
2. Tag the merged commit from an up-to-date `main`:

   ```sh
   git switch main
   git pull --ff-only
   version=$(node -p 'JSON.parse(require("node:fs").readFileSync("package.json", "utf8")).version')
   git tag -a "v$version" -m "v$version"
   npm run release:check -- "v$version"
   git push origin "v$version"
   ```

3. The release workflow reruns CI, validates that the stable `vX.Y.Z` tag matches the package and lockfile versions and belongs to `origin/main`, then creates a GitHub release with generated notes.

Published tags are immutable: fix a bad release with a new version. A tag is installable as soon as it is pushed; release checks gate the GitHub release, not access to the Git tag.
