# Agent guidance

## Documentation

- Keep installation, usage, configuration and contributor workflows in `README.md`. Keep agent-only instructions here.
- Put non-obvious design and implementation rationale beside the relevant source. Create `DESIGN.md` only for cross-cutting decisions that cannot be explained locally; remove it when none remain.
- Keep issue progress, implementation inventories and test-by-test reports out of project documentation.

## Changes and tests

- For development prerequisites and check commands, see [Development](README.md#development). For behaviour changes, run `npm run check`; editor/overlay lifecycle changes also need `npm run test:pty` on Linux/macOS.
- When adding extension-boundary tests, use `test/harness.ts` and read its header for lifecycle, fixtures and observable assertions. Test user-visible behaviour or external contracts, not private state.
- Use temporary session/configuration fixtures. Tests must not read personal history, inherit credentials or query a model; preserve the isolation in `test/pty/terminal.ts` and `test/pty/guard.ts`.
- Keep wall-clock checks in `test/performance/*.perf.ts`, separate from concurrent functional tests. Investigate timing failures on an idle machine rather than masking them with retries or weaker limits.
