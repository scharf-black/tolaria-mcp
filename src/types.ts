// Shared type definitions for the Tolaria MCP server.

export interface NoteFrontmatter {
  type?: string;
  status?: string;
  belongs_to?: string[];
  related_to?: string[];
  [key: string]: unknown;
}

export interface Note {
  // Path relative to the vault root, e.g. "Middleware/DataPower/Foo.md"
  relPath: string;
  // The note title (H1 if present, else filename without extension)
  title: string;
  frontmatter: NoteFrontmatter;
  body: string;
}

export interface NoteSummary {
  relPath: string;
  title: string;
  type?: string;
  belongs_to?: string[];
  related_to?: string[];
}

export interface TypeDoc {
  // The type identity (the H1 of the type document, which must match
  // the `type:` value used on notes)
  name: string;
  relPath: string;
  sidebarLabel?: string;
}

export interface Taxonomy {
  vault: string;
  types: TypeDoc[];
  // Hub notes: any note whose own type is "Area" or "Project" — these are
  // the valid targets for belongs_to / related_to.
  hubs: { title: string; slug: string; type: string; relPath: string }[];
}

// A normalized error the tools can surface with actionable text.
export class ToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolError";
  }
}
