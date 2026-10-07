# Setup foundation

The shared setup engine and read-only CLI are implemented. The native installer, protected owner application, service adapter, progress publisher, login/access handoffs and client adapter are not implemented yet. These commands do not install a service or replace the development/lab workflow. They currently run from the source build and require its Node runtime; the no-Node package entry is separate unfinished work.

## Read-only commands

```bash
node dist/cli/index.js setup preflight --json --port 7777 --client none
node dist/cli/index.js setup preflight --client codex
node dist/cli/index.js setup status --json --setup-id <setup-uuid>
```

Preflight checks macOS version (provisional minimum 13), architecture, presence of the new or legacy installation and loopback port reachability. It describes installer-managed Node, the required verified package and defaults: `core`, private conversations closed, writes disabled. The current new-installation profile uses `/Library/Application Support/TelegramMCPGateway`; it is provisional until native provisioning is verified. The legacy `/opt/telegram-gateway-mcp` installation is never adopted automatically.

Preflight does not load gateway `.env`, create `TG_MCP_HOME`, open/migrate SQLite, create keys, issue tokens, start services or contact Telegram. A loopback TCP reachability probe sends no HTTP/MCP/Telegram request; an available port is a point-in-time observation, not a reservation. Existing installations return `existing_installation_requires_review`: the native adapter must reconcile a matching installation before setup continues. Different releases use the deferred update workflow, never silent reinstall. Codex configuration is `not_inspected` until a verified adapter exists; no config path is guessed or read.

Status reads only a bounded, root-published projection at the fixed profile path `progress.json`, with no caller-supplied file path. Every ancestor must be root-owned, not writable by other users and free of symlinks/ACLs; the file must be a root-owned regular file, not hard-linked or writable by others. This conservative reader rejects any macOS ACL rather than inferring safety from modes. Native provisioning must demonstrate a compatible path before this becomes a supported installation interface.

Snapshots contain a version-1 allowlisted status and `observed_at_ms`. Unknown fields/versions, malformed identifiers, inconsistent completion, mismatched setup IDs and observations older than 60 seconds or in the future fail safely. Output explicitly says `cached_snapshot`; it does not perform fresh service, authenticated MCP or actual client verification. With no native publisher installed, `status_unavailable` is expected. A setup UUID grants no authority and cannot start, cancel or administer setup.

Both human and JSON presentations use the same logic. Errors contain fixed codes only, never raw parser/filesystem/library text or caller values. These commands bypass the ordinary CLI's mutating configuration initialization. stdio MCP output behavior is unchanged.

## Engine and adapter contract

`src/setup/contract.ts` defines strict plans, progress, closed errors and readiness checks. `src/setup/engine.ts` reconciles fresh typed adapter observations rather than accepting journal phase markers. Gateway completion without a selected client is `gateway_ready`. A selected client has distinct configuration, reload and actual tool-observation stages; `ready` needs all gateway/client checks. A saved ready state never bypasses current evidence.

The protected adapter provides an exclusive setup lease, journal read/atomic write and fresh inspection bound to the exact artifact/plan. `resumeSetup` and `selectClient` are internal APIs for that authorized adapter, not MCP or public admin endpoints. Neither executes login, creates grants, issues tokens or mutates gateway state. Owner-required stages remain waiting states. The later native adapter is responsible for authenticating the caller and carrying out approved stage actions.

The journal stores only a validated plan, revision and cancellation flag, not credentials, challenge bodies or tokens. Resume rejects a damaged/future journal or unapproved plan change without overwriting it. Explicit later client selection preserves the plan's installation identity and reconciles existing credentials/session/grants. A foreign installation or different release fails before writing progress. Cancellation retains completed resources; resume inspects them again. A failed persistence/inspection result discards optimistic readiness evidence.

`FileSetupJournal` is a macOS storage primitive for an already-provisioned protected directory. It requires the native adapter's protection attestation on operations; there is no permissive production default or automatic recursive mkdir/chown. It validates bounded, private regular journal files, writes/fsyncs an exclusive temporary file, renames atomically and fsyncs the directory. The native adapter still has to prove service UID, ancestor/ACL protection and peer authorization.

The setup lease uses macOS `/usr/bin/lockf` on an inherited file descriptor. The parent retains the kernel lock after the helper exits, and process death releases it. The `setup.lock` inode is retained permanently; it is never unlinked as recovery. This avoids racing stale-socket deletion and is separate from the gateway's session lock. Keep this primitive under macOS qualification; Linux/Windows need their own protected adapters. Do not replace the lock inode while any worker may be running.

## Verification limits

Automated tests use synthetic plans, fake observations and temporary directories. They cover no-state CLI execution, strict secrecy/error handling, prerequisite/ready reconciliation, canceled/repeated setup, later client selection, rejected journal mutation, atomic persistence, cross-process exclusion and simultaneous recovery after a killed lock holder.

These tests do not prove root/service isolation, artifact trust, independent owner authorization, actual Telegram login, no-Node entry or Codex tool loading. Those remain native installation and owner-qualification gates. The setup engine does not authorize writes to a real machine merely because a test adapter reports success.
