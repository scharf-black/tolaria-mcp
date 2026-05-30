# Changelog

All notable changes to this project will be documented in this file.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0] - 2026-05-30

First public release.

### Added
- `tolaria_get_taxonomy` — list declared types and hub notes.
- `tolaria_list_notes` — list notes, with type / area / title-substring filters.
- `tolaria_read_note` — read a note by fuzzy title or exact path.
- `tolaria_create_note` — create a typed, validated, hub-linked note.
- `tolaria_update_note` — update body, merge relationships, set/unset frontmatter fields.
- `tolaria_capture` — capture an untyped note into the Inbox folder.
- `tolaria_delete_note` — delete a note (requires `confirm: true`).
- Per-vault async mutex serializing concurrent operations.
- Smoke test suite covering path-traversal protection, YAML date round-trip, wikilink preservation, and multi-line YAML safety.
- Path traversal protection via `safeJoin()` on every filesystem operation.
- YAML date round-trip stability (parses as `Date`, emits as unquoted `YYYY-MM-DD`).
- Multi-line string safety via `js-yaml` serialization.
- Filename length cap at 200 chars to stay under Linux `NAME_MAX`.
- `unset_fields` parameter on `tolaria_update_note`.
- `TOLARIA_DISABLE_GIT_SYNC` env flag for tests and offline development.
- Startup config assertion (`assertVaultsConfigured`) — refuses to start with no vaults configured.

### Fixed
- CI: restored `package-lock.json` and switched the workflow back to `npm ci` so dependency installs are reproducible across CI runs and contributor environments. The earlier `npm install` workaround (committed without a lockfile) caused `actions/setup-node`'s `cache: 'npm'` to fail at the Setup Node step before any code could run.

### Security
- Path traversal: every filesystem op now resolves through `safeJoin(root, relPath)` which throws on absolute paths or paths that escape the vault root.
