// Shared constants and vault configuration.
//
// VAULTS maps the short vault name (used as a tool parameter) to its
// absolute working-checkout path on the host. These are git working
// directories that the server pulls before reads and commits+pushes
// after writes.
//
// Vault roots MUST be supplied via environment variables. The server
// refuses to start if neither vault is configured (see assertVaultsConfigured).

export interface VaultConfig {
  name: string;
  path: string;
}

// Vault roots are read from env. Empty defaults mean a missing env var
// will produce a clear "not configured" error at startup rather than
// silently writing to a wrong path.
export const VAULTS: Record<string, VaultConfig> = {
  work: {
    name: "work",
    path: process.env.TOLARIA_WORK_PATH || "",
  },
  personal: {
    name: "personal",
    path: process.env.TOLARIA_PERSONAL_PATH || "",
  },
};

export const VALID_VAULTS = Object.keys(VAULTS);

// Cap on response size to protect the agent's context window.
export const CHARACTER_LIMIT = 25000;

// Per-filename cap. Linux's NAME_MAX is 255 bytes; leave room for ".md"
// and a folder prefix. Long titles are sliced before being used as a
// filename (the in-frontmatter title is preserved as written).
export const FILENAME_MAX_LENGTH = 200;

// Git sync behavior. Per-operation sync (pull-before-read,
// commit+push-after-write) is the v1 default.
export const GIT_REMOTE = process.env.TOLARIA_GIT_REMOTE || "origin";
export const GIT_BRANCH = process.env.TOLARIA_GIT_BRANCH || "main";

// If TOLARIA_DISABLE_GIT_SYNC is "true", pull/push become no-ops. Tests
// and offline development use this. Production should leave it unset.
export const DISABLE_GIT_SYNC = process.env.TOLARIA_DISABLE_GIT_SYNC === "true";

// Commit author for changes made through this server.
export const COMMIT_AUTHOR_NAME = process.env.TOLARIA_COMMIT_NAME || "Tolaria MCP";
export const COMMIT_AUTHOR_EMAIL = process.env.TOLARIA_COMMIT_EMAIL || "tolaria-mcp@localhost";

export enum ResponseFormat {
  MARKDOWN = "markdown",
  JSON = "json",
}

// Validate that at least one vault is configured. Called at startup so
// misconfiguration fails loudly with a clear error.
export function assertVaultsConfigured(): void {
  const configured = Object.entries(VAULTS).filter(([, cfg]) => cfg.path.length > 0);
  if (configured.length === 0) {
    throw new Error(
      "No vaults configured. Set at least one of TOLARIA_WORK_PATH or " +
        "TOLARIA_PERSONAL_PATH to point at a git working checkout."
    );
  }
}
