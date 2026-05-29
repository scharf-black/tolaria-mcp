# Contributing

Thanks for your interest in improving Tolaria MCP. This is a small, focused project — the contribution loop is intentionally lightweight.

## Development setup

```bash
git clone https://github.com/scharf-black/tolaria-mcp.git
cd tolaria-mcp
npm install
npm run build
```

## Running tests

The test suite uses [`node:test`](https://nodejs.org/api/test.html) (no external test framework). Tests run against a temporary vault and set `TOLARIA_DISABLE_GIT_SYNC=true` so they don't need a real git remote.

```bash
npm test
```

A clean run shows all 12 smoke tests passing.

## Adding tests

New behavior should come with a test. Tests live in `test/` and are compiled to `dist-test/` separately from the main code. Use the existing `smoke.test.ts` as the template — it shows the temp-vault setup, the env vars to set, and the import pattern (`await import("../dist/...")`).

## Code style

- Strict TypeScript, no `any` in production paths.
- Every filesystem operation must go through `safeJoin()` from `services/vault.ts`. Don't `path.join(root, …)` directly outside that module.
- Errors that should reach the user as actionable messages use `ToolError` from `types.ts`. Programmer errors should throw plain `Error`.
- Keep tool descriptions in `src/index.ts` concise and grounded — they're agent-facing.

## Commit messages

Conventional-ish but not strict. Examples:
- `fix: reject absolute paths in safeJoin`
- `feat: add unset_fields to update_note`
- `docs: expand README env var table`
- `test: add round-trip test for multi-line string fields`

## What this project will and won't accept

**Will accept:**
- Bug fixes with a test that reproduces the bug.
- New tools that fit the taxonomy-aware, git-backed Tolaria model.
- Documentation improvements.
- Performance improvements (with a measurement showing the gain).

**Probably won't accept without prior discussion:**
- Auto-merge logic on git conflicts (the stop-and-report posture is intentional).
- Bypassing the type/relationship validation.
- New runtime dependencies (the current dep tree is deliberately small).
- Anything that changes the disk format of notes in a way that would require an existing vault to be re-migrated.

Open an issue first for anything in the second list and we can talk about it.
