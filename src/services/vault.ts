// Vault service. Filesystem + taxonomy operations on a vault checkout.
//
// This is the taxonomy-aware core: it knows how Tolaria notes are
// structured (YAML frontmatter + H1 title), how type documents define
// the valid type vocabulary, and which notes are hubs (Area/Project)
// that can be relationship targets.
//
// Security: every filesystem operation MUST resolve paths through
// safeJoin() to prevent traversal outside the vault root.

import { promises as fs } from "node:fs";
import path from "node:path";
import matter from "gray-matter";
import yaml from "js-yaml";
import { VAULTS, VALID_VAULTS, FILENAME_MAX_LENGTH } from "../constants.js";
import { Note, NoteFrontmatter, NoteSummary, Taxonomy, TypeDoc, ToolError } from "../types.js";

// ---- security ---------------------------------------------------------

/**
 * Resolve a vault-relative path to its absolute form, refusing to
 * escape the vault root. Throws ToolError on traversal attempts.
 *
 * Examples:
 *   safeJoin("/v", "a/b.md")        -> "/v/a/b.md"
 *   safeJoin("/v", "../etc/passwd") -> throws
 *   safeJoin("/v", "/absolute")     -> throws
 */
export function safeJoin(root: string, relPath: string): string {
  if (path.isAbsolute(relPath)) {
    throw new ToolError(
      `Refusing absolute path '${relPath}'. Paths must be relative to the vault root.`
    );
  }
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, relPath);
  const rootWithSep = resolvedRoot.endsWith(path.sep) ? resolvedRoot : resolvedRoot + path.sep;
  if (resolved !== resolvedRoot && !resolved.startsWith(rootWithSep)) {
    throw new ToolError(
      `Refusing path '${relPath}' which escapes the vault root.`
    );
  }
  return resolved;
}

/** Cap a slug at FILENAME_MAX_LENGTH chars. */
export function clampFilename(name: string): string {
  if (name.length <= FILENAME_MAX_LENGTH) return name;
  return name.slice(0, FILENAME_MAX_LENGTH).trimEnd();
}

// ---- vault resolution -------------------------------------------------

export function resolveVault(vault: string): string {
  const cfg = VAULTS[vault];
  if (!cfg) {
    throw new ToolError(
      `Unknown vault '${vault}'. Valid vaults are: ${VALID_VAULTS.join(", ")}.`
    );
  }
  if (!cfg.path) {
    throw new ToolError(
      `Vault '${vault}' is not configured. Set TOLARIA_${vault.toUpperCase()}_PATH ` +
        `to a git working checkout to enable it.`
    );
  }
  return cfg.path;
}

// ---- listing ----------------------------------------------------------

// Recursively list all .md files in a vault, returning paths relative
// to the vault root. Skips dotfolders (.git, .obsidian, .trash, etc.)
// and the conventional node_modules.
async function listMarkdownFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string): Promise<void> {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      if (entry.name === "node_modules") continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile() && entry.name.endsWith(".md")) {
        out.push(path.relative(root, full));
      }
    }
  }
  await walk(root);
  return out;
}

// ---- title + frontmatter helpers --------------------------------------

// Extract the H1 title from note body, falling back to the filename.
function deriveTitle(relPath: string, body: string): string {
  const m = body.match(/^#\s+(.+?)\s*$/m);
  if (m) return m[1].trim();
  return path.basename(relPath, ".md");
}

/**
 * Normalize a list-valued frontmatter field. Accepts a single string,
 * an array, or null/undefined. Strips Obsidian wikilink wrappers and
 * any advanced link syntax (|display, #section) so values are clean
 * hub titles ready for matching.
 */
export function normalizeList(value: unknown): string[] | undefined {
  if (value == null) return undefined;
  const arr = Array.isArray(value) ? value : [value];
  const cleaned = arr
    .map((v) =>
      String(v)
        .replace(/^\[\[|\]\]$/g, "")
        .replace(/[|#].*$/, "")
        .trim()
    )
    .filter((v) => v.length > 0);
  return cleaned.length ? cleaned : undefined;
}

// ---- file reads -------------------------------------------------------

export async function readNoteFile(root: string, relPath: string): Promise<Note> {
  const full = safeJoin(root, relPath);
  let raw: string;
  try {
    raw = await fs.readFile(full, "utf-8");
  } catch {
    throw new ToolError(`Note not found at path '${relPath}'.`);
  }
  const parsed = matter(raw);
  const fm = parsed.data as NoteFrontmatter;
  return {
    relPath,
    title: deriveTitle(relPath, parsed.content),
    frontmatter: fm,
    body: parsed.content.replace(/^\s+/, ""),
  };
}

// Parse just the frontmatter + title cheaply for listing/summary purposes.
async function readSummary(root: string, relPath: string): Promise<NoteSummary> {
  const note = await readNoteFile(root, relPath);
  return {
    relPath,
    title: note.title,
    type: typeof note.frontmatter.type === "string" ? note.frontmatter.type : undefined,
    belongs_to: normalizeList(note.frontmatter.belongs_to),
    related_to: normalizeList(note.frontmatter.related_to),
  };
}

export async function listNotes(
  vault: string,
  opts: { type?: string; area?: string; query?: string }
): Promise<NoteSummary[]> {
  const root = resolveVault(vault);
  const files = await listMarkdownFiles(root);
  const summaries: NoteSummary[] = [];
  for (const rel of files) {
    try {
      const s = await readSummary(root, rel);
      // Exclude type-definition documents from normal listings.
      if (s.type === "Type") continue;
      if (opts.type && s.type !== opts.type) continue;
      if (opts.area) {
        const links = [...(s.belongs_to || []), ...(s.related_to || [])];
        if (!links.some((l) => l.toLowerCase() === opts.area!.toLowerCase())) continue;
      }
      if (opts.query) {
        if (!s.title.toLowerCase().includes(opts.query.toLowerCase())) continue;
      }
      summaries.push(s);
    } catch {
      // skip unreadable files rather than fail the whole listing
    }
  }
  summaries.sort((a, b) => a.title.localeCompare(b.title));
  return summaries;
}

// ---- taxonomy ---------------------------------------------------------

// Discover the taxonomy: type documents (type: Type) and hub notes
// (type: Area or type: Project).
export async function getTaxonomy(vault: string): Promise<Taxonomy> {
  const root = resolveVault(vault);
  const files = await listMarkdownFiles(root);
  const types: TypeDoc[] = [];
  const hubs: { title: string; slug: string; type: string; relPath: string }[] = [];
  for (const rel of files) {
    try {
      const note = await readNoteFile(root, rel);
      const t = note.frontmatter.type;
      if (t === "Type") {
        types.push({
          name: note.title,
          relPath: rel,
          sidebarLabel:
            typeof note.frontmatter._sidebar_label === "string"
              ? (note.frontmatter._sidebar_label as string)
              : undefined,
        });
      } else if (t === "Area" || t === "Project") {
        hubs.push({ title: note.title, slug: path.basename(rel, ".md"), type: t, relPath: rel });
      }
    } catch {
      // skip
    }
  }
  types.sort((a, b) => a.name.localeCompare(b.name));
  hubs.sort((a, b) => a.title.localeCompare(b.title));
  return { vault, types, hubs };
}

// ---- note resolution --------------------------------------------------

// Resolve a fuzzy title (or relative path) to a single note. Throws an
// actionable error listing candidates if ambiguous, or none if missing.
export async function resolveNote(vault: string, titleOrPath: string): Promise<Note> {
  const root = resolveVault(vault);
  // Exact path match first (only if it would not escape the vault).
  if (titleOrPath.endsWith(".md")) {
    try {
      return await readNoteFile(root, titleOrPath);
    } catch {
      // fall through to title search
    }
  }
  const files = await listMarkdownFiles(root);
  const needle = titleOrPath.toLowerCase();
  const exact: string[] = [];
  const partial: string[] = [];
  for (const rel of files) {
    const base = path.basename(rel, ".md").toLowerCase();
    if (base === needle) {
      exact.push(rel);
    } else if (base.includes(needle)) {
      partial.push(rel);
    }
  }
  const matches = exact.length ? exact : partial;
  if (matches.length === 0) {
    throw new ToolError(
      `No note found matching '${titleOrPath}' in the ${vault} vault. ` +
        `Try list_notes to see available notes.`
    );
  }
  if (matches.length > 1) {
    throw new ToolError(
      `Multiple notes match '${titleOrPath}' in the ${vault} vault:\n` +
        matches.map((m) => `  - ${m}`).join("\n") +
        `\nSpecify the exact path to disambiguate.`
    );
  }
  return await readNoteFile(root, matches[0]);
}

// ---- serialization ----------------------------------------------------

/**
 * Format a Date as YYYY-MM-DD. Used to preserve date-typed frontmatter
 * across read/serialize round-trips (gray-matter parses YAML dates as
 * JS Date objects).
 */
function dateToIsoDay(d: Date): string {
  const yr = d.getUTCFullYear();
  const mo = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dy = String(d.getUTCDate()).padStart(2, "0");
  return `${yr}-${mo}-${dy}`;
}

/**
 * Coerce frontmatter values for safe YAML serialization. Specifically:
 *  - Date objects → YYYY-MM-DD strings (round-trip stable for YAML dates)
 *  - everything else passed through unchanged
 */
function coerceForYaml(value: unknown): unknown {
  if (value instanceof Date) return dateToIsoDay(value);
  if (Array.isArray(value)) return value.map(coerceForYaml);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = coerceForYaml(v);
    }
    return out;
  }
  return value;
}

/**
 * Assemble frontmatter + body into a Tolaria-correct note string.
 *
 * `belongs_to` and `related_to` use the block-style quoted wikilink
 * format that round-trips cleanly with Obsidian:
 *
 *   belongs_to:
 *     - "[[Hub A]]"
 *     - "[[Hub B]]"
 *
 * Other fields are serialized via js-yaml which handles dates, quoted
 * strings, multi-line strings, and special characters correctly.
 */
export function serializeNote(fm: NoteFrontmatter, body: string): string {
  const wikilinkKeys = new Set(["belongs_to", "related_to"]);

  // Split fields: wikilinks get bespoke formatting, the rest go through js-yaml.
  const standardFm: Record<string, unknown> = {};
  const wikilinkFm: Record<string, string[]> = {};

  if (fm.type != null) standardFm.type = fm.type;

  for (const [key, value] of Object.entries(fm)) {
    if (key === "type") continue;
    if (value == null) continue;
    if (wikilinkKeys.has(key)) {
      const list = normalizeList(value);
      if (list) wikilinkFm[key] = list;
    } else {
      standardFm[key] = coerceForYaml(value);
    }
  }

  // js-yaml dump with CORE_SCHEMA so date-shaped strings (YYYY-MM-DD) emit
  // unquoted. With DEFAULT_SCHEMA they would be quoted to avoid re-parse as
  // dates, which creates noisy git diffs on every update.
  const yamlText = yaml
    .dump(standardFm, {
      lineWidth: -1, // never wrap
      noRefs: true,
      sortKeys: false, // preserve insertion order
      schema: yaml.CORE_SCHEMA,
    })
    .trimEnd();

  // Append wikilink fields with the canonical Tolaria format.
  const wikilinkParts: string[] = [];
  for (const [key, list] of Object.entries(wikilinkFm)) {
    wikilinkParts.push(`${key}:`);
    for (const item of list) wikilinkParts.push(`  - "[[${item}]]"`);
  }
  const wikilinkText = wikilinkParts.join("\n");

  const fmText = [yamlText, wikilinkText].filter((s) => s.length > 0).join("\n");
  const trimmedBody = body.replace(/^\s+/, "");
  return `---\n${fmText}\n---\n\n${trimmedBody ? trimmedBody + "\n" : ""}`;
}

// ---- file writes ------------------------------------------------------

export async function writeNoteFile(
  root: string,
  relPath: string,
  content: string
): Promise<void> {
  const full = safeJoin(root, relPath);
  await fs.mkdir(path.dirname(full), { recursive: true });
  await fs.writeFile(full, content, "utf-8");
}

export function noteExists(root: string, relPath: string): Promise<boolean> {
  return fs
    .access(safeJoin(root, relPath))
    .then(() => true)
    .catch(() => false);
}

export async function deleteNoteFile(root: string, relPath: string): Promise<void> {
  const full = safeJoin(root, relPath);
  try {
    await fs.unlink(full);
  } catch {
    throw new ToolError(`Could not delete note at path '${relPath}' — file may not exist.`);
  }
}
