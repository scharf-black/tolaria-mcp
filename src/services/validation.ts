// Validation helpers. These enforce the taxonomy at write time so a note
// that violates the conventions literally cannot be created through the
// server: the type must be a real declared type, and every belongs_to /
// related_to target must resolve to an existing hub note.

import { getTaxonomy } from "./vault.js";
import { ToolError } from "../types.js";

export async function validateType(vault: string, type: string): Promise<void> {
  const tax = await getTaxonomy(vault);
  const valid = tax.types.map((t) => t.name);
  if (!valid.includes(type)) {
    throw new ToolError(
      `'${type}' is not a valid type in the ${vault} vault. Valid types are: ${valid.join(", ")}. ` +
        `If you intended a new type, create its Type document first.`
    );
  }
}

// Validate relationship targets exist as hubs. Returns a warning string
// for any targets that don't match a hub (we warn rather than hard-fail on
// related_to, since loose associations to non-hub notes can be legitimate;
// belongs_to is stricter).
export async function validateRelationships(
  vault: string,
  belongs_to: string[] = [],
  related_to: string[] = []
): Promise<string[]> {
  const tax = await getTaxonomy(vault);
  const hubKeys = new Set();
  for (const h of tax.hubs) { hubKeys.add(h.title.toLowerCase()); hubKeys.add(h.slug.toLowerCase()); }
  const warnings: string[] = [];

  for (const target of belongs_to) {
    if (!hubKeys.has(target.toLowerCase())) {
      throw new ToolError(
        `belongs_to target '${target}' is not an existing hub (Area/Project) in the ${vault} vault. ` +
          `belongs_to must point at a project or area hub. Existing hubs: ${tax.hubs
            .map((h) => h.title)
            .join(", ")}.`
      );
    }
  }
  for (const target of related_to) {
    if (!hubKeys.has(target.toLowerCase())) {
      warnings.push(
        `related_to target '${target}' does not match an existing hub — the link will still be written, ` +
          `but won't resolve until a note titled '${target}' exists.`
      );
    }
  }
  return warnings;
}
