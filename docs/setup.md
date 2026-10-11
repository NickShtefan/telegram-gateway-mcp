# Setup preflight and setup lease

`tg-mcp setup preflight` is a read-only inspection command. It does not install a service or replace the development/lab workflow. From the source build it requires that build's Node runtime; the installed POSIX agent command `<prefix>/bin/tg-mcp` allows it as its only `setup` subcommand. Installation, owner administration and client connection are described in [install-owner.md](install-owner.md), [owner-setup.md](owner-setup.md) and [client-adapters.md](client-adapters.md).

## Read-only preflight

```bash
node dist/cli/index.js setup preflight --json --port 7777 --client none
node dist/cli/index.js setup preflight --client codex
node dist/cli/index.js setup preflight --client claude
node dist/cli/index.js setup preflight --client opencode
node dist/cli/index.js setup preflight --client hermes
```

Preflight checks macOS version (provisional minimum 13), architecture, presence of the new or legacy installation and loopback port reachability. It describes installer-managed Node, the required verified package and defaults: `core`, private conversations closed, writes disabled. The current new-installation profile uses `/Library/Application Support/TelegramMCPGateway`; it is provisional until platform provisioning is verified. The legacy `/opt/telegram-gateway-mcp` installation is never adopted automatically.

Preflight does not load gateway `.env`, create `TG_MCP_HOME`, open/migrate SQLite, create keys, issue tokens, start services or contact Telegram. A loopback TCP reachability probe sends no HTTP/MCP/Telegram request; an available port is a point-in-time observation, not a reservation. Existing installations return `existing_installation_requires_review`; different releases are never silently reinstalled. Selected client configuration is `not_inspected`; no config path is guessed or read.

Both human and JSON presentations use the same logic. Errors contain fixed codes from `src/setup/contract.ts` only, never raw parser/filesystem/library text or caller values. The command bypasses the ordinary CLI's mutating configuration initialization. stdio MCP output behavior is unchanged. Any other `setup` subcommand returns `invalid_request`.

## Setup and session leases

Setup and session ownership share `core/fileLease.ts`: the bundled macOS `lease-darwin` helper or Linux `/usr/bin/flock` locks an inherited file descriptor. The parent retains the kernel lock after the helper exits, and process death releases it. The `setup.lock` and `sessions.lock` inodes are retained permanently; they are never unlinked as recovery. Session-lock stale socket cleanup is serialized under its kernel lease. Helpers use fixed paths/environment and bounded execution; unavailable helpers fail closed. Native Windows uses a first-instance named pipe (`core/windowsLease.ts`). Do not replace the lock inode while any worker may be running.

## Verification limits

Automated tests use fake probes and temporary directories. They cover no-state CLI execution, closed error handling, secret redaction, cross-process lease exclusion, in-process exclusion and a single winner during simultaneous recovery after a killed lease holder.

These tests do not prove root/service isolation, artifact trust, independent owner authorization, actual Telegram login, no-Node entry or client tool loading. Those remain platform installation and owner-qualification gates.
