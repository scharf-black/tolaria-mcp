import { z } from "zod";
import { VALID_VAULTS, ResponseFormat } from "../constants.js";

const vaultParam = z
  .enum(VALID_VAULTS as [string, ...string[]])
  .describe("Which vault to operate on. Defined in TOLARIA_*_PATH env vars.");

export const ListNotesSchema = z
  .object({
    vault: vaultParam,
    type: z
      .string()
      .optional()
      .describe("Filter to a single note type, e.g. 'Reference', 'Project', 'Task'"),
    area: z
      .string()
      .optional()
      .describe("Filter to notes linked (belongs_to or related_to) to this hub title"),
    query: z
      .string()
      .optional()
      .describe("Filter to notes whose title contains this substring (case-insensitive)"),
    response_format: z
      .nativeEnum(ResponseFormat)
      .default(ResponseFormat.MARKDOWN)
      .describe("Output format"),
  })
  .strict();

export const ReadNoteSchema = z
  .object({
    vault: vaultParam,
    title: z
      .string()
      .min(1)
      .describe("Note title (fuzzy, case-insensitive) or exact relative path ending in .md"),
  })
  .strict();

export const GetTaxonomySchema = z
  .object({
    vault: vaultParam,
    response_format: z.nativeEnum(ResponseFormat).default(ResponseFormat.MARKDOWN),
  })
  .strict();

export const CreateNoteSchema = z
  .object({
    vault: vaultParam,
    type: z.string().min(1).describe("Note type — must be a valid declared type (see get_taxonomy)"),
    title: z.string().min(1).describe("Note title; becomes the H1 and the filename"),
    body: z.string().default("").describe("Markdown body content (without frontmatter or H1)"),
    belongs_to: z
      .array(z.string())
      .optional()
      .describe("Hub titles this note is part of (project membership). Must be existing hubs."),
    related_to: z
      .array(z.string())
      .optional()
      .describe("Hub titles this note relates to (subject association)"),
    folder: z
      .string()
      .optional()
      .describe("Optional folder (relative to vault root) to place the file in"),
  })
  .strict();

export const UpdateNoteSchema = z
  .object({
    vault: vaultParam,
    title: z.string().min(1).describe("Note to update (fuzzy title or exact .md path)"),
    body: z.string().optional().describe("If provided, replaces the note body (frontmatter preserved)"),
    add_related_to: z
      .array(z.string())
      .optional()
      .describe("Hub titles to add as related_to links (merged with existing)"),
    add_belongs_to: z
      .array(z.string())
      .optional()
      .describe("Hub titles to add as belongs_to links (merged with existing)"),
    set_fields: z
      .record(z.union([z.string(), z.array(z.string()), z.number(), z.boolean()]))
      .optional()
      .describe(
        "Frontmatter key/value pairs to set or overwrite. Values may be strings, " +
          "arrays of strings, numbers, or booleans."
      ),
    unset_fields: z
      .array(z.string())
      .optional()
      .describe(
        "Frontmatter keys to remove. Applied after set_fields. " +
          "The protected keys 'type', 'belongs_to', and 'related_to' cannot be unset here — " +
          "change the type via set_fields and clear relationships by leaving them out of " +
          "subsequent updates."
      ),
  })
  .strict();

export const CaptureSchema = z
  .object({
    vault: vaultParam,
    text: z.string().min(1).describe("Quick note text; captured untyped into the Inbox folder"),
    title: z.string().optional().describe("Optional title; otherwise derived from a timestamp"),
  })
  .strict();

export const DeleteNoteSchema = z
  .object({
    vault: vaultParam,
    title: z.string().min(1).describe("Note to delete (fuzzy title or exact .md path)"),
    confirm: z
      .literal(true)
      .describe("Must be explicitly set to true — safety guard against accidental deletion"),
  })
  .strict();
