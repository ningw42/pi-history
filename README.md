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

From a clone:

```sh
npm install
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

```sh
npm install
npm run typecheck   # tsc, no emit
npm test            # extension-boundary suite (node:test, Node's built-in TypeScript support)
```

The tests load the real entry point against a fake Pi API and UI context, with Pi's real editor component (Pi's text-input component joins it with the query line in #3). The fake mirrors Pi's overlay lifecycle: the overlay is mounted asynchronously, and closing it gives focus back to the editor before the result arrives. History comes from synthetic session files in a temporary agent directory (`PI_CODING_AGENT_DIR`), so no real prompt history is read.

Tests assert on what a user sees: the input bar's text and cursor, and the rendered overlay lines. The one allowed exception is a narrow set of safety checks at the extension's boundary with Pi, for behaviour that has no visible output: prompts handed to Pi for submission ("nothing is submitted"), what the extension registered or installed with Pi ("registers nothing outside TUI mode"), and the session files on disk ("never written"). Tests never assert on the extension's private state.

The harness (`test/harness.ts`) can also put a scripted stub matcher on `PATH` as `fzf` and `sk`, ready for #3 and #4.
