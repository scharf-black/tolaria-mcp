---
type: Reference
belongs_to:
  - "[[Homelab]]"
related_to:
  - "[[Networking]]"
created: 2026-05-30
---

# Pi-hole DNS Setup

Notes on the Pi-hole DNS deployment.

## Container

Running as a Docker container on the homelab Unraid box. Bound to port 53 UDP/TCP on the host.

## Configured upstream resolvers

- 1.1.1.1 (Cloudflare)
- 9.9.9.9 (Quad9)
