# Protected platform provisioning

Platform definitions and protected provisioning components are implemented for the 0.2.0 workstream. They have not been applied to owner/lab machines. Root/Administrator authority is required only through the independently trusted owner coordinator. A setup UUID, cached progress or root-owned copy alone is not artifact/owner authorization.

## Fixed profiles and state

| Platform | Code/runtime prefix | Identity | Supervisor |
| --- | --- | --- | --- |
| macOS | `/Library/Application Support/TelegramMCPGateway` | Hidden `_tgmcp`, dedicated UID/GID, no login shell/password | Disabled `io.telegram-mcp-gateway` LaunchDaemon |
| Linux | `/opt/telegram-mcp-gateway` | System `telegram-mcp-gateway`, no login shell | Installed systemd unit, not enabled/started by provisioning |
| Windows | `C:\ProgramData\TelegramMCPGateway` | `NT SERVICE\TelegramMCPGateway` virtual service account | Demand-start Windows Service |

Release directories are keyed by exact source SHA. Credentials/database/session state, logs and readable exports have separate destinations/permissions. The legacy laboratory prefix is never adopted implicitly. Current Windows implementation rejects a non-default CommonApplicationData location rather than trusting an environment-supplied path.

`src/install/provision.ts` requires owner/code/candidate attestation, an exclusive lease, a validated private receipt and fresh stage inspection. It records identity, release, state, definition and command completion in order. Resume skips completed stages only after actual inspection; changed/unknown/out-of-order receipts fail safely. Root/owner identities cannot substitute for a POSIX service account or Windows virtual SID. Provisioning does not start the daemon, issue tokens, ask for secrets or change clients.

## POSIX backend

The backend checks exact pinned candidate identity/files and 0.2.0 application metadata before protected work. Its initial-trust callback is mandatory and must come from the trusted owner coordinator; it is not implemented as an agent boolean or a permissive production default. Root ancestry, ownership and ACL checks reject foreign paths. macOS rejects ACL-bearing ancestors conservatively; Linux requires the system `getfacl` capability. Only designated root-owned sticky system temporary ancestors are accepted for private staging.

Account creation uses fixed dscl/useradd commands with controlled environment and no caller shell strings. Existing accounts/groups require verified resume or owner review; there is no automatic identity adoption. A crash during ambiguous identity creation may require owner resolution, while completed state is preserved. Root controls executable code/runtime; the service UID controls private state/logs and writable exports. Source/candidate content is checked before activation, and source extraction rejects unsafe objects/paths.

Same-stage release interruption preserves matching files and rejects unexpected/corrupt files instead of overwriting a tree. Existing state directories need the expected owner/mode/ACL; recursive chown/chmod repair of foreign state is not used. Service definitions and fixed agent entry points are written without replacing unrelated commands. Owner administration is wired in the next stage, rather than exposing a generic root shell here.

The launchd definition is disabled initially. The systemd unit uses an isolated user, on-failure restart, restrictive umask, NoNewPrivileges, private temporary space and a read-only system except declared state/export/log paths. Exact supervisor behavior and real permission denial remain platform qualification gates.

## Windows components

The PowerShell provisioning entry has non-mutating PlanOnly and elevated-owner apply paths. It requires an independently authenticated immutable candidate, rejects reparse points/ordinary-user-writable candidate ancestry and rechecks the extracted application against the authenticated archive. It creates a demand-start virtual-account service, applies explicit administrator/System/service SID permissions and records a private installation receipt. Root code/service definitions are not writable by the service or ordinary users; private state/logs are not readable by ordinary users. It performs no provider authentication or Telegram input.

The fixed C# service host starts only the protected Node/entry selected by the validated service definition, with a controlled environment. It runs as the service identity, not as the owner/Administrator, captures logs into the private service directory and stops the child on service stop. Gateway restart uses SCM recovery; it does not repair hung MTProto calls in process. The host is built in Windows source/CI environments and bundled, so users do not compile it during setup.

Windows session/setup leases use first-instance named pipes whose namespace is derived from canonical state-directory identity. Kernel cleanup replaces filesystem stale-file deletion. This is a liveness/exclusion primitive, not an administrative pipe. The libuv mechanism and account model were checked against primary sources: [first-instance pipe implementation](https://github.com/libuv/libuv/blob/v1.x/src/win/pipe.c), [Microsoft service accounts](https://learn.microsoft.com/windows/security/identity-protection/access-control/service-accounts). Native Windows runtime/ACL and crash-recovery proof are still required.

## Checks and remaining proof

Tests use fake provisioning backends and synthetic receipts to cover authorization failure before mutation, ordered stages, repeated setup, retained completed steps, fresh-inspection failure, changed/corrupted state, separate identities and fixed service definitions. Windows-only kernel-pipe tests run on Windows. A read-only GitHub workflow parses PowerShell, compiles the service host and checks common/native contracts on hosted runners, without real Telegram or publishing secrets.

These tests do not establish independently trusted initial production elevation, actual service operation, owner terminal input, cross-user permission denial or supported OS versions. Keep these gates open until fresh environment/owner qualification. No production session, credential, service or lab configuration was modified during component development.
