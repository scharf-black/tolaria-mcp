#!/usr/bin/env node
// Tolaria Notes MCP Server
//
// Taxonomy-aware read/write access to Tolaria vaults backed by local git
// checkouts on the host. Reads pull-before; writes commit+push-after.
// Stop-and-report on git conflicts (no auto-merge).
//
// Public API: tolaria_get_taxonomy, tolaria_list_notes, tolaria_read_note,
// tolaria_create_note, tolaria_update_note, tolaria_capture, tolaria_delete_note.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import path from "node:path";

import { CHARACTER_LIMIT, ResponseFormat, assertVaultsConfigured } from "./constants.js";
import { ToolError, NoteFrontmatter } from "./types.js";
import {
  ListNotesSchema,
  ReadNoteSchema,
  GetTaxonomySchema,
  CreateNoteSchema,
  UpdateNoteSchema,
  CaptureSchema,
  DeleteNoteSchema,
} from "./schemas/index.js";
import * as vault from "./services/vault.js";
import { pull, commitAndPush } from "./services/git.js";
import { validateType, validateRelationships } from "./services/validation.js";

const SERVER_VERSION = "1.0.0";
const server = new McpServer({ name: "tolaria-notes-mcp-server", version: SERVER_VERSION });

// ---- response helpers -------------------------------------------------

type TextResult = {
  content: { type: "text"; text: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
};

function ok(text: string, structured?: Record<string, unknown>): TextResult {
  let out = text;
  if (out.length > CHARACTER_LIMIT) {
    out = out.slice(0, CHARACTER_LIMIT) + `\n\n[truncated at ${CHARACTER_LIMIT} chars]`;
  }
  return structured
    ? { content: [{ type: "text", text: out }], structuredContent: structured }
    : { content: [{ type: "text", text: out }] };
}

function fail(err: unknown): TextResult {
  const msg = err instanceof ToolError ? err.message : `Unexpected error: ${(err as Error).message}`;
  return { content: [{ type: "text", text: `Error: ${msg}` }], isError: true };
}

// ---- filename helpers -------------------------------------------------

/**
 * Sanitize a title into a safe filename component. Strips path separators
 * and other characters that could either break the filesystem or escape
 * the vault root. The clamp keeps us safely under NAME_MAX (255 bytes on
 * Linux).
 */
function slugifyTitle(title: string): string {
  const cleaned = title.replace(/[\/\\:*?"<>|]/g, "-").trim();
  return vault.clampFilename(cleaned);
}

// ---- per-vault mutex --------------------------------------------------

// One in-flight operation per vault. Each operation serializes the
// pull → mutate → commit → push sequence so concurrent agent calls
// don't trample each other.
const vaultLocks = new Map<string, Promise<unknown>>();

function withVaultLock<T>(vaultName: string, fn: () => Promise<T>): Promise<T> {
  const prev = vaultLocks.get(vaultName) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  vaultLocks.set(
    vaultName,
    next.catch(() => undefined)
  );
  return next;
}

// ---- get_taxonomy -----------------------------------------------------

server.registerTool(
  "tolaria_get_taxonomy",
  {
    title: "Get Vault Taxonomy",
    description: `Return the live taxonomy of a Tolaria vault: all declared note types and all hub notes (Areas and Projects) that can be relationship targets. Call this before creating notes so the type and belongs_to/related_to targets are valid. Read-only.

Args:
  - vault (one of the configured vaults)
  - response_format ('markdown' | 'json')

Returns: list of valid type names and hub titles (with their type).`,
    inputSchema: GetTaxonomySchema.shape,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  async (params) => {
    try {
      const p = GetTaxonomySchema.parse(params);
      return await withVaultLock(p.vault, async () => {
        const root = vault.resolveVault(p.vault);
        await pull(root);
        const tax = await vault.getTaxonomy(p.vault);
        if (p.response_format === ResponseFormat.JSON) {
          return ok(JSON.stringify(tax, null, 2), tax as unknown as Record<string, unknown>);
        }
        const lines = [
          `# Taxonomy: ${p.vault} vault`,
          ``,
          `## Types (${tax.types.length})`,
          ...tax.types.map((t) => `- ${t.name}${t.sidebarLabel ? ` (shows as "${t.sidebarLabel}")` : ""}`),
          ``,
          `## Hubs (${tax.hubs.length})`,
          ...tax.hubs.map((h) => `- ${h.title} [${h.type}]`),
        ];
        return ok(lines.join("\n"), tax as unknown as Record<string, unknown>);
      });
    } catch (err) {
      return fail(err);
    }
  }
);

// ---- list_notes -------------------------------------------------------

server.registerTool(
  "tolaria_list_notes",
  {
    title: "List Notes",
    description: `List notes in a vault, optionally filtered by type, linked hub (area), or title substring. Excludes Type-definition documents. Read-only.

Args:
  - vault
  - type (string, optional)
  - area (string, optional): hub title the note links to
  - query (string, optional): title substring match
  - response_format ('markdown' | 'json')

Returns: matching notes with title, path, type, and relationships.`,
    inputSchema: ListNotesSchema.shape,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  async (params) => {
    try {
      const p = ListNotesSchema.parse(params);
      return await withVaultLock(p.vault, async () => {
        const root = vault.resolveVault(p.vault);
        await pull(root);
        const notes = await vault.listNotes(p.vault, { type: p.type, area: p.area, query: p.query });
        if (p.response_format === ResponseFormat.JSON) {
          const structured = { count: notes.length, notes };
          return ok(JSON.stringify(structured, null, 2), structured);
        }
        if (!notes.length) return ok(`No notes matched in the ${p.vault} vault.`);
        const lines = [
          `# ${notes.length} note(s) in ${p.vault}`,
          ``,
          ...notes.map((n) => {
            const rels = [
              ...(n.belongs_to || []).map((b) => `belongs_to ${b}`),
              ...(n.related_to || []).map((r) => `related_to ${r}`),
            ];
            return `- **${n.title}** [${n.type || "untyped"}] — \`${n.relPath}\`${rels.length ? ` — ${rels.join(", ")}` : ""}`;
          }),
        ];
        return ok(lines.join("\n"), { count: notes.length, notes } as unknown as Record<string, unknown>);
      });
    } catch (err) {
      return fail(err);
    }
  }
);

// ---- read_note --------------------------------------------------------

server.registerTool(
  "tolaria_read_note",
  {
    title: "Read Note",
    description: `Read a single note by fuzzy title or exact relative path. Returns frontmatter and body. If the title is ambiguous, returns the list of candidates. Read-only.

Args:
  - vault
  - title (string): fuzzy title or exact path ending in .md

Returns: the note's type, relationships, other frontmatter, and full body.`,
    inputSchema: ReadNoteSchema.shape,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  async (params) => {
    try {
      const p = ReadNoteSchema.parse(params);
      return await withVaultLock(p.vault, async () => {
        const root = vault.resolveVault(p.vault);
        await pull(root);
        const note = await vault.resolveNote(p.vault, p.title);
        const fmText = Object.entries(note.frontmatter)
          .map(([k, v]) => `${k}: ${Array.isArray(v) ? JSON.stringify(v) : v}`)
          .join("\n");
        const text = `# ${note.title}\n\nPath: \`${note.relPath}\`\n\n## Frontmatter\n${fmText}\n\n## Body\n${note.body}`;
        return ok(text, {
          relPath: note.relPath,
          title: note.title,
          frontmatter: note.frontmatter,
          body: note.body,
        } as unknown as Record<string, unknown>);
      });
    } catch (err) {
      return fail(err);
    }
  }
);

// ---- create_note ------------------------------------------------------

server.registerTool(
  "tolaria_create_note",
  {
    title: "Create Note",
    description: `Create a new note with validated type and relationships, then commit and push. The type must be a declared type (see tolaria_get_taxonomy) and any belongs_to target must be an existing hub. Frontmatter is assembled automatically with correct Tolaria syntax.

Args:
  - vault
  - type (string): a valid declared type
  - title (string): becomes the H1 and filename
  - body (string, optional): markdown body
  - belongs_to (string[], optional): project/area hub titles (validated)
  - related_to (string[], optional): subject hub titles
  - folder (string, optional): subfolder under vault root

Returns: the created note's path and the commit hash. Writes to git.`,
    inputSchema: CreateNoteSchema.shape,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  async (params) => {
    try {
      const p = CreateNoteSchema.parse(params);
      return await withVaultLock(p.vault, async () => {
        const root = vault.resolveVault(p.vault);
        await pull(root);
        await validateType(p.vault, p.type);
        const warnings = await validateRelationships(p.vault, p.belongs_to, p.related_to);

        const fileName = slugifyTitle(p.title) + ".md";
        const relPath = p.folder ? path.join(p.folder, fileName) : fileName;
        // safeJoin runs inside noteExists / writeNoteFile and will throw
        // if the resolved path escapes the vault root.
        if (await vault.noteExists(root, relPath)) {
          throw new ToolError(`A note already exists at '${relPath}'. Use tolaria_update_note to modify it.`);
        }

        const fm: NoteFrontmatter = { type: p.type };
        if (p.belongs_to?.length) fm.belongs_to = p.belongs_to;
        if (p.related_to?.length) fm.related_to = p.related_to;
        const body = `# ${p.title}\n\n${p.body}`.trimEnd() + "\n";
        const content = vault.serializeNote(fm, body);
        await vault.writeNoteFile(root, relPath, content);

        const hash = await commitAndPush(root, relPath, `Add note: ${p.title}`);
        const note =
          `Created '${p.title}' at \`${relPath}\` (commit ${hash}).` +
          (warnings.length ? `\n\nWarnings:\n${warnings.map((w) => `- ${w}`).join("\n")}` : "");
        return ok(note, { relPath, commit: hash, warnings });
      });
    } catch (err) {
      return fail(err);
    }
  }
);

// ---- update_note ------------------------------------------------------

const UNSET_PROTECTED = new Set(["type", "belongs_to", "related_to"]);

server.registerTool(
  "tolaria_update_note",
  {
    title: "Update Note",
    description: `Update an existing note: replace its body, add relationship links (merged with existing), set frontmatter fields, and/or remove frontmatter keys. Preserves all other frontmatter. Commits and pushes.

Args:
  - vault
  - title (string): note to update (fuzzy or exact path)
  - body (string, optional): replaces the body (frontmatter kept)
  - add_related_to (string[], optional): related_to links to merge in
  - add_belongs_to (string[], optional): belongs_to links to merge in (validated as hubs)
  - set_fields (object, optional): frontmatter key/value pairs. Values may be strings, arrays of strings, numbers, or booleans.
  - unset_fields (string[], optional): frontmatter keys to remove (type/belongs_to/related_to are protected)

Returns: the note path and commit hash. Writes to git.`,
    inputSchema: UpdateNoteSchema.shape,
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  },
  async (params) => {
    try {
      const p = UpdateNoteSchema.parse(params);
      return await withVaultLock(p.vault, async () => {
        const root = vault.resolveVault(p.vault);
        await pull(root);
        const note = await vault.resolveNote(p.vault, p.title);

        if (p.add_belongs_to?.length) {
          await validateRelationships(p.vault, p.add_belongs_to, []);
        }

        const fm: NoteFrontmatter = { ...note.frontmatter };
        const mergeList = (existing: unknown, add: string[]): string[] => {
          const cur = Array.isArray(existing)
            ? existing.map((x) => String(x).replace(/^\[\[|\]\]$/g, ""))
            : [];
          return Array.from(new Set([...cur, ...add]));
        };
        if (p.add_related_to?.length) fm.related_to = mergeList(fm.related_to, p.add_related_to);
        if (p.add_belongs_to?.length) fm.belongs_to = mergeList(fm.belongs_to, p.add_belongs_to);
        if (p.set_fields) for (const [k, v] of Object.entries(p.set_fields)) fm[k] = v;

        if (p.unset_fields?.length) {
          for (const key of p.unset_fields) {
            if (UNSET_PROTECTED.has(key)) {
              throw new ToolError(
                `Cannot unset protected field '${key}'. Type changes go through set_fields; ` +
                  `clear belongs_to/related_to via direct vault edits.`
              );
            }
            delete fm[key];
          }
        }

        // If type is being changed via set_fields, validate it.
        if (p.set_fields?.type && typeof p.set_fields.type === "string") {
          await validateType(p.vault, p.set_fields.type);
        }

        const newBody = p.body != null ? `# ${note.title}\n\n${p.body}`.trimEnd() + "\n" : note.body;
        const content = vault.serializeNote(fm, newBody);
        await vault.writeNoteFile(root, note.relPath, content);

        const hash = await commitAndPush(root, note.relPath, `Update note: ${note.title}`);
        if (hash === "no-change") return ok(`No changes to write for '${note.title}'.`);
        return ok(`Updated '${note.title}' at \`${note.relPath}\` (commit ${hash}).`, {
          relPath: note.relPath,
          commit: hash,
        });
      });
    } catch (err) {
      return fail(err);
    }
  }
);

// ---- capture ----------------------------------------------------------

server.registerTool(
  "tolaria_capture",
  {
    title: "Capture Quick Note",
    description: `Quickly capture an untyped note into the vault's Inbox folder for later organization (Tolaria capture-first workflow). Commits and pushes.

Args:
  - vault
  - text (string): the note content
  - title (string, optional): otherwise a timestamp title is used

Returns: the captured note's path and commit hash. Writes to git.`,
    inputSchema: CaptureSchema.shape,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  async (params) => {
    try {
      const p = CaptureSchema.parse(params);
      return await withVaultLock(p.vault, async () => {
        const root = vault.resolveVault(p.vault);
        await pull(root);
        const now = new Date().toISOString().replace(/[:.]/g, "-");
        const title = p.title || `Capture ${now}`;
        const relPath = path.join("Inbox", slugifyTitle(title) + ".md");
        if (await vault.noteExists(root, relPath)) {
          throw new ToolError(`A capture already exists at '${relPath}'.`);
        }
        const body = `# ${title}\n\n${p.text}`.trimEnd() + "\n";
        // Untyped on purpose — Inbox notes get organized later.
        const content = vault.serializeNote({}, body);
        await vault.writeNoteFile(root, relPath, content);
        const hash = await commitAndPush(root, relPath, `Capture: ${title}`);
        return ok(`Captured to \`${relPath}\` (commit ${hash}).`, { relPath, commit: hash });
      });
    } catch (err) {
      return fail(err);
    }
  }
);

// ---- delete_note -----------------------------------------------------

server.registerTool(
  "tolaria_delete_note",
  {
    title: "Delete Note",
    description: `Permanently delete a note from a vault, then commit and push. This is irreversible from the perspective of normal operations — the file is removed from disk and from git history going forward. (Recovery is still possible via git checkout of an earlier commit.)

Args:
  - vault
  - title (string): note to delete (fuzzy or exact path)
  - confirm (true): must be explicitly set to true as a safety guard

Returns: the deleted note's path and commit hash.`,
    inputSchema: DeleteNoteSchema.shape,
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  },
  async (params) => {
    try {
      const p = DeleteNoteSchema.parse(params);
      return await withVaultLock(p.vault, async () => {
        const root = vault.resolveVault(p.vault);
        await pull(root);
        const note = await vault.resolveNote(p.vault, p.title);
        await vault.deleteNoteFile(root, note.relPath);
        const hash = await commitAndPush(root, note.relPath, `Delete note: ${note.title}`);
        return ok(`Deleted '${note.title}' at \`${note.relPath}\` (commit ${hash}).`, {
          relPath: note.relPath,
          commit: hash,
        });
      });
    } catch (err) {
      return fail(err);
    }
  }
);

// ---- run --------------------------------------------------------------

async function main(): Promise<void> {
  assertVaultsConfigured();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`tolaria-notes-mcp-server v${SERVER_VERSION} running on stdio`);
}

main().catch((error) => {
  console.error("Server error:", error);
  process.exit(1);
});
