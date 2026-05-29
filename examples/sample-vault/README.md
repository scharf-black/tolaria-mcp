# Sample Vault

A minimal Tolaria-compatible vault for trying the MCP server.

## Structure

- `*.md` at root with `type: Type` — declares valid types (Area, Project, Reference, Note)
- Hub notes (`Homelab.md`, `Networking.md`) — typed as `Area`, become valid relationship targets
- A content note (`Homelab/DNS/Pi-hole DNS Setup.md`) — typed as `Reference`, linked to hubs via `belongs_to` and `related_to`

## To try it

```bash
# Initialize the sample as a git repo (the MCP server expects a git checkout)
cd examples/sample-vault
git init -b main
git add .
git commit -m "Initial sample vault"

# Point the MCP server at this directory and disable git sync (no remote configured)
export TOLARIA_PERSONAL_PATH=$(pwd)
export TOLARIA_DISABLE_GIT_SYNC=true

cd ../..
npm start
```

Then call `tolaria_get_taxonomy` to see the four types and two hubs, or `tolaria_list_notes` to see the Pi-hole reference.
