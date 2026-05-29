// Smoke tests for the Tolaria vault service. These exercise the
// taxonomy-aware read/write logic without requiring git push/pull
// (TOLARIA_DISABLE_GIT_SYNC is set in test setup so all operations
// are local-only).

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// Configure env BEFORE importing the modules so they pick up the test paths.
let TMP_VAULT: string;

before(async () => {
  TMP_VAULT = await fs.mkdtemp(path.join(os.tmpdir(), "tolaria-test-"));
  process.env.TOLARIA_PERSONAL_PATH = TMP_VAULT;
  process.env.TOLARIA_DISABLE_GIT_SYNC = "true";

  // Initialize a git repo in the temp vault so commitAndPush can stage/commit locally.
  await execFileAsync("git", ["-C", TMP_VAULT, "init", "-b", "main"]);
  await execFileAsync("git", ["-C", TMP_VAULT, "config", "user.email", "test@example.com"]);
  await execFileAsync("git", ["-C", TMP_VAULT, "config", "user.name", "Test User"]);

  // Seed: one type doc + one hub doc so create_note has something to validate against.
  await fs.writeFile(
    path.join(TMP_VAULT, "reference.md"),
    `---\ntype: Type\n---\n\n# Reference\n`
  );
  await fs.writeFile(
    path.join(TMP_VAULT, "area.md"),
    `---\ntype: Type\n---\n\n# Area\n`
  );
  await fs.writeFile(
    path.join(TMP_VAULT, "Homelab.md"),
    `---\ntype: Area\n---\n\n# Homelab\n`
  );
  await execFileAsync("git", ["-C", TMP_VAULT, "add", "."]);
  await execFileAsync("git", ["-C", TMP_VAULT, "commit", "-m", "seed"]);
});

after(async () => {
  if (TMP_VAULT) await fs.rm(TMP_VAULT, { recursive: true, force: true });
});

test("safeJoin rejects path traversal", async () => {
  const vault = await import("../dist/services/vault.js");
  assert.throws(() => vault.safeJoin(TMP_VAULT, "../outside"), /escapes/);
  assert.throws(() => vault.safeJoin(TMP_VAULT, "/absolute/path"), /absolute/);
  assert.throws(() => vault.safeJoin(TMP_VAULT, "a/../../b"), /escapes/);
});

test("safeJoin allows valid relative paths", async () => {
  const vault = await import("../dist/services/vault.js");
  const result = vault.safeJoin(TMP_VAULT, "folder/file.md");
  assert.equal(result, path.join(path.resolve(TMP_VAULT), "folder/file.md"));
});

test("serializeNote round-trips YAML dates correctly", async () => {
  const vault = await import("../dist/services/vault.js");
  const matter = (await import("gray-matter")).default;

  // Build a note with a YAML date field (gray-matter parses these as Date objects)
  const original = `---\ntype: Reference\ncreated: 2026-04-28\nupdated: 2026-05-01\n---\n\n# Test\n\nhi\n`;
  const parsed = matter(original);
  assert.ok(parsed.data.created instanceof Date, "gray-matter should parse YAML date as Date");

  // Serialize back. The output should contain "created: 2026-04-28" as a string,
  // NOT "Mon Apr 27 2026 ..." (the old bug).
  const serialized = vault.serializeNote(parsed.data, parsed.content);
  assert.match(serialized, /created: 2026-04-28/);
  assert.ok(!serialized.includes("GMT"), "should not contain locale date format");

  // Round-trip: re-parse and confirm the date is preserved.
  const reparsed = matter(serialized);
  const got = reparsed.data.created;
  if (got instanceof Date) {
    assert.equal(got.toISOString().split("T")[0], "2026-04-28");
  } else {
    assert.equal(got, "2026-04-28");
  }
});

test("serializeNote preserves wikilink relationships", async () => {
  const vault = await import("../dist/services/vault.js");
  const serialized = vault.serializeNote(
    {
      type: "Reference",
      belongs_to: ["Homelab"],
      related_to: ["AI-Stack", "DataPower"],
    },
    "# Test\n\nbody\n"
  );
  assert.match(serialized, /belongs_to:\n  - "\[\[Homelab\]\]"/);
  assert.match(serialized, /related_to:\n  - "\[\[AI-Stack\]\]"\n  - "\[\[DataPower\]\]"/);
});

test("serializeNote handles strings with newlines safely", async () => {
  const vault = await import("../dist/services/vault.js");
  const matter = (await import("gray-matter")).default;

  const serialized = vault.serializeNote(
    { type: "Reference", description: "Line one\nLine two" },
    "# Test\n\nbody\n"
  );
  // Re-parse to confirm it survives a round trip — the description field should
  // come back as a single string, not split into a "Line two" top-level key.
  const reparsed = matter(serialized);
  assert.equal(reparsed.data.description, "Line one\nLine two");
});

test("normalizeList strips wikilink wrappers and advanced syntax", async () => {
  const vault = await import("../dist/services/vault.js");
  assert.deepEqual(vault.normalizeList(["[[Foo]]", "[[Bar|Display]]", "[[Baz#Section]]"]), [
    "Foo",
    "Bar",
    "Baz",
  ]);
  assert.deepEqual(vault.normalizeList("[[Single]]"), ["Single"]);
  assert.equal(vault.normalizeList(null), undefined);
  assert.equal(vault.normalizeList([]), undefined);
});

test("clampFilename caps long names", async () => {
  const vault = await import("../dist/services/vault.js");
  const long = "x".repeat(500);
  const clamped = vault.clampFilename(long);
  assert.ok(clamped.length <= 200);
});

test("listNotes filters by type and area", async () => {
  const vault = await import("../dist/services/vault.js");

  // Create a Reference note via the vault service
  const fm = { type: "Reference", belongs_to: ["Homelab"] };
  const content = vault.serializeNote(fm, "# Sample Note\n\nbody\n");
  await vault.writeNoteFile(TMP_VAULT, "sample-note.md", content);

  const all = await vault.listNotes("personal", {});
  assert.ok(all.some((n) => (n as any).title === "Sample Note"));
  assert.ok(all.some((n) => (n as any).title === "Homelab")); // the area hub also matches

  const refOnly = await vault.listNotes("personal", { type: "Reference" });
  assert.equal(refOnly.length, 1);
  assert.equal((refOnly[0] as any).title, "Sample Note");

  const inHomelab = await vault.listNotes("personal", { area: "Homelab" });
  assert.ok(inHomelab.some((n) => (n as any).title === "Sample Note"));
});

test("getTaxonomy returns types and hubs", async () => {
  const vault = await import("../dist/services/vault.js");
  const tax = await vault.getTaxonomy("personal");
  const typeNames = tax.types.map((t) => (t as any).name);
  assert.ok(typeNames.includes("Reference"));
  assert.ok(typeNames.includes("Area"));
  const hubTitles = tax.hubs.map((h) => (h as any).title);
  assert.ok(hubTitles.includes("Homelab"));
});

test("validateType rejects unknown types", async () => {
  const validation = await import("../dist/services/validation.js");
  await assert.rejects(() => validation.validateType("personal", "BogusType"), /not a valid type/);
});

test("validateRelationships rejects unknown belongs_to", async () => {
  const validation = await import("../dist/services/validation.js");
  await assert.rejects(
    () => validation.validateRelationships("personal", ["NoSuchHub"], []),
    /not an existing hub/
  );
});

test("validateRelationships warns on unknown related_to but allows", async () => {
  const validation = await import("../dist/services/validation.js");
  const warnings = await validation.validateRelationships("personal", [], ["NoSuchHub"]);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /does not match an existing hub/);
});
