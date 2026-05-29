# Tolaria MCP

A small [Model Context Protocol](https://modelcontextprotocol.io/) server that gives LLM agents taxonomy-aware, git-backed read/write access to Markdown note vaults — built around the [Tolaria](https://tolaria.org) note system but compatible with any Obsidian-flavored vault that uses YAML frontmatter for `type` and `belongs_to` / `related_to` relationships.

The goal is to let an agent treat your notes as a typed, networked knowledge base — listing notes by type, reading them by fuzzy title, creating notes with validated relationships, capturing thoughts to an Inbox, all while every write goes through git so there's an audit trail and easy rollback.

## Why this exists

LLM agents are good at writing prose. They're not good at remembering that the schema for a "Project" note is different from the schema for a "Reference" note, that `belongs_to` points at hub notes only, or that a particular vault has a "DataPower" Area but no "DataPower" Project. This server bakes the taxonomy into the tool surface so the agent literally cannot create a note that violates the conventions: the type must be declared, every `belongs_to` target must resolve to a real hub, and the file format is always written in canonical form.

Per-operation git sync (pull-before-read, commit+push-after-write) means multiple devices and multiple agents can collaborate on the same vault without overwriting each other — conflicts surface as actionable errors rather than silent corruption.

## Quick start

```bash
git clone https://github.com/scharf-black/tolaria-mcp.git
cd tolaria-mcp
npm install
npm run build

# Point at a git working checkout of your vault
export TOLARIA_PERSONAL_PATH=/path/to/your/vault

npm start
```

The server speaks MCP over stdio. To connect Claude Desktop, add this to your `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "tolaria": {
      "command": "node",
      "args": ["/absolute/path/to/tolaria-mcp/dist/index.js"],
      "env": {
        "TOLARIA_PERSONAL_PATH": "/absolute/path/to/your/vault"
      }
    }
  }
}
```

Other MCP-aware clients (Cline, Continue, OpenHands, your own SDK code) follow the same pattern: stdio command + env vars.

## Configuration

| Env var                     | Required? | Default                  | Purpose |
|-----------------------------|-----------|--------------------------|---------|
| `TOLARIA_WORK_PATH`         | One of    | _(empty)_                | Absolute path to the `work` vault checkout. |
| `TOLARIA_PERSONAL_PATH`     | these two | _(empty)_                | Absolute path to the `personal` vault checkout. |
| `TOLARIA_GIT_REMOTE`        | optional  | `origin`                 | Git remote name. |
| `TOLARIA_GIT_BRANCH`        | optional  | `main`                   | Git branch. |
| `TOLARIA_COMMIT_NAME`       | optional  | `Tolaria MCP`            | Commit author name for writes. |
| `TOLARIA_COMMIT_EMAIL`      | optional  | `tolaria-mcp@localhost`  | Commit author email for writes. |
| `TOLARIA_DISABLE_GIT_SYNC`  | optional  | _(unset)_                | Set to `true` to skip git pull/push (tests, offline use). |

The server refuses to start if neither `TOLARIA_WORK_PATH` nor `TOLARIA_PERSONAL_PATH` is set. Both vaults are optional but at least one must be configured.

## Vault structure

A Tolaria vault is just a folder of Markdown files. The server discovers structure from frontmatter, not from folder layout, so you can organize files however you like. Three conventions matter:

**Type documents** declare the vocabulary. Any note with `type: Type` defines a valid type — its H1 is the type name. A typical vault has type docs at the root:

```markdown
---
type: Type
_sidebar_label: Projects
---

# Project
```

**Hub notes** (Areas and Projects) are the targets of `belongs_to` / `related_to` links. Any note with `type: Area` or `type: Project` becomes a hub. Hub notes are usually short — a title and maybe a description.

**Content notes** carry one of the declared types and link to hubs:

```markdown
---
type: Reference
belongs_to:
  - "[[Homelab]]"
related_to:
  - "[[Networking]]"
---

# Pi-hole DNS Setup

Notes on the Pi-hole DNS deployment...
```

The `belongs_to` / `related_to` format uses double-bracket wikilinks in a YAML block list — compatible with Obsidian's graph view out of the box.

## Tool reference

The server exposes seven tools, all taking `vault` as the first parameter (one of the configured vault names — typically `work` or `personal`).

### `tolaria_get_taxonomy`
List declared types and hub notes for a vault. Call this before creating notes so the agent knows valid type values and hub link targets.

```json
{"vault": "personal", "response_format": "json"}
```

### `tolaria_list_notes`
List notes, optionally filtered by type, linked area (hub title), or title substring.

```json
{"vault": "personal", "type": "Reference", "area": "Homelab"}
```

### `tolaria_read_note`
Read a note by fuzzy title or exact `.md` path. Returns frontmatter and body. Ambiguous fuzzy titles return a candidate list.

```json
{"vault": "personal", "title": "Pi-hole DNS"}
```

### `tolaria_create_note`
Create a typed, validated note. The type must exist in the taxonomy and `belongs_to` targets must be real hubs (or the call errors with the list of valid hubs).

```json
{
  "vault": "personal",
  "type": "Reference",
  "title": "Pi-hole DNS Setup",
  "folder": "Homelab/DNS",
  "belongs_to": ["Homelab"],
  "related_to": ["Networking"],
  "body": "Notes on the Pi-hole DNS deployment..."
}
```

### `tolaria_update_note`
Modify an existing note: replace body, merge in new `belongs_to` / `related_to` links, set or unset frontmatter fields. Preserves everything not touched.

```json
{
  "vault": "personal",
  "title": "Pi-hole DNS Setup",
  "set_fields": {"status": "deployed", "last_verified": "2026-05-30"},
  "unset_fields": ["pipeline_stage"]
}
```

The protected fields `type`, `belongs_to`, `related_to` can't be removed via `unset_fields` — change `type` via `set_fields` and edit relationships through `add_belongs_to` / `add_related_to` or by direct vault edit.

### `tolaria_capture`
Capture an untyped note into the `Inbox/` folder for later organization. Useful for the agent to "drop a thought" without yet knowing what type it should be.

```json
{"vault": "personal", "text": "Look into Raft vs Paxos for the gossip layer."}
```

### `tolaria_delete_note`
Permanently delete a note. Requires `confirm: true` as a safety guard. The file is removed from disk and committed; the previous content is recoverable via git history.

```json
{"vault": "personal", "title": "Old draft", "confirm": true}
```

## Security model

This server runs with the filesystem permissions of its process, and it writes to disk and pushes to a git remote. Two specific protections:

**Path traversal.** Every filesystem operation resolves through `safeJoin(root, relPath)`, which refuses absolute paths and any relative path whose resolution escapes the vault root. An agent that tries `folder: "../../../etc"` gets a `ToolError`, not a write outside the vault.

**Stop-and-report on git conflicts.** The server never auto-merges. If a `git pull` would need to merge (remote diverged from local), or a `git push` is rejected as non-fast-forward, the operation throws a `ToolError` describing the situation and the work stops. This protects against silent conflict resolution that could lose changes. Reconciliation happens on the host, not inside the agent loop.

The server validates frontmatter (type must be declared, `belongs_to` must point at real hubs) but it does **not** sanitize note body content — if you paste arbitrary markdown including HTML, that's what gets written. The expectation is that the vault is your own and the content origin is trusted.

## Design notes

A few decisions worth surfacing because they're load-bearing:

**No auto-merge.** When a pull or push fails because of remote changes, we stop. This is intentional. An agent has no way to reason about whether a 3-way merge is semantically correct — the safe default is "report and let the human resolve."

**No recycle bin for `delete_note`.** Deletion uses `fs.unlink` and a delete commit. Git history is the safety net; if you delete a note you wanted, `git log --all --diff-filter=D` finds it and `git checkout <sha>~1 -- path/to/file.md` restores it.

**No content indexing or full-text search.** The server discovers structure from frontmatter on every call. For vaults under ~1000 notes this is fine. For larger vaults you'd want a cache layer — open an issue if that's you.

**Wikilink format is opinionated.** `belongs_to` and `related_to` always serialize as:

```yaml
belongs_to:
  - "[[Hub Title]]"
```

Obsidian's advanced link syntaxes (`[[Foo|Display]]`, `[[Foo#Section]]`) get normalized to just the hub title on read — the parts after `|` or `#` are stripped. If you need a display alias or section anchor, put it in the body, not the relationship list.

**YAML quirks.** YAML dates (`created: 2026-04-28`) parse as JavaScript `Date` objects via gray-matter; the serializer normalizes them back to `YYYY-MM-DD` strings emitted unquoted (using `js-yaml`'s `CORE_SCHEMA` which doesn't treat date-shaped strings as needing quotes). This means dates round-trip stably across updates.

## What this isn't

- **Not an Obsidian plugin.** Tolaria MCP runs as a separate process. It reads and writes the same files Obsidian uses, but it doesn't depend on Obsidian being running, doesn't know about Obsidian's link-suggestion algorithm, and doesn't index the vault.
- **Not a full Markdown editor.** The tool surface is intentionally narrow: create, read, update, list, capture, delete. There's no in-place text editing or block-level operations.
- **Not a multi-user collaboration system.** Git-as-sync works fine for one user across devices. Multi-user concurrent editing isn't a goal — the stop-and-report behavior is built for "two devices of one person", not "two people".
- **Not opinionated about your folder layout.** Everything is driven by frontmatter, so you can organize notes however you like.

## Acknowledgements

- [Anthropic](https://anthropic.com) for the Model Context Protocol spec and the SDK.
- [Obsidian](https://obsidian.md) for the wikilink + frontmatter conventions this server is compatible with.
- [Tolaria](https://tolaria.org) for the underlying note-system philosophy.

## License

MIT — see [LICENSE](./LICENSE).
