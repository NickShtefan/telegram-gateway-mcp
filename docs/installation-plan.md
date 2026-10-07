# Installation redesign

Prepared October 7, 2026, from source commit `d57f0ae581845a4876edd9b03ccf90396d3abcfa`.

This is the implementation workstream for section 4 of the [open-source plan](open-source-plan.md). The owner requested that installation preparation take priority over installing the existing gateway on the main Mac, then selected a separate service with convenient owner management (decision 51). This document proposes implementation work; no deployment has been executed.

## Current implementation

| Component | Implemented behavior | Gap for external users |
| --- | --- | --- |
| [Lab installer](../scripts/lab-install.sh) | macOS only; creates a service user, protected Node/code, shared files and a launchd service | Fixed private repository, service paths and example identities; requires a GitHub token and full SHA; no public package installation |
| [Deployment guide](deploy.md) | Separate lab installation, manual administration and development startup | Credentials, login, user creation, token transfer and client connection are separate manual steps |
| [CLI](../src/cli/main.ts) | `serve`, `stdio`, `login`, `doctor`, users, accounts and scopes | No unified setup, service lifecycle, update or uninstall commands; installer commands remain under its prefix rather than being added to PATH |
| [Configuration](../src/core/config.ts) and [.env.example](../.env.example) | State outside the checkout; safe default toolset; configuration template | No guided credential entry, setup progress or repeat-run handling |
| [Doctor](../src/cli/doctor.ts) | Node, state permissions, credentials, users/accounts and daemon checks | Opens local state through the CLI; not a general non-mutating installation preflight or a separate agent-readable service diagnostic |
| [Client connections](connect.md) | Generic HTTP/stdio configuration examples | No generated client configuration or setup-time connection verification |
| [Session lock](../src/core/lock.ts) and [file operations](../src/core/safeFs.ts) | Unix socket, UID/mode checks and symlink protections | Native Windows implementation and actual ACL/reparse-point verification remain necessary |

The package can already be packed and installed from a local archive. That proof does not install a supervisor, configure real credentials, create a Telegram session or connect a model client. The package remains private and unpublished.

Ordinary MCP calls require no `sudo`. The lab workflow requires it for installation, updates and owner administration. A global npm install alone would not reproduce the protected daemon/code/runtime boundary.

## Findings to address

These are source observations, not reproduced deployment failures:

1. **Updates modify the active installation before stopping the old service.** The installer replaces Node and synchronizes application files in steps 2/3, then stops launchd in step 7. A running process can observe replaced files, and a failed update can leave a partially changed installation. Prepare an independent candidate first, stop the old service before switching active files, and retain the previous release.
2. **Failed health verification still reaches `Done`.** A missing health response prints a warning without a failing exit status. Health checks also accept any response from the configured port. Completion must require evidence from the intended service and a nonzero result on failure.
3. **First setup is fragmented.** The installer starts a service with possibly empty API credentials, then prints manual instructions for editing configuration, login, issuing a token and diagnosis. Track installation, configured state and usable MCP connection as separate milestones.
4. **Source acquisition is private and macOS-specific.** Installation builds from a fixed private GitHub address and requires `GH_TOKEN`. Public installation must use the selected `telegram-mcp-gateway` package/release artifact without private access. Local archives can exercise this before publication.
5. **Recovery, backups and uninstall are manual or absent.** Code replacement is not transactional; there is no automated state backup or schema-aware rollback procedure. Define recovery before claiming safe updates. Removing software must preserve account data unless the owner explicitly chooses deletion.

Retain the lab installer during this work. Change it deliberately with its own checks; do not deploy changes to the lab as part of main-Mac testing.

## Accepted execution model

| Model | Owner experience | Boundary |
| --- | --- | --- |
| Separate service identity | Administrator approval for initial protected installation and updates; design more convenient routine administration | Can protect sessions, database, encryption key, code and Node from agent shells |
| Same OS identity as the agent | Direct setup and administration without switching users | Shell-enabled agents can read session material and modify user-owned code/runtime; file encryption does not establish isolation |

The owner selected the separate service identity with convenient management on October 7 (decision 51). The second row documents the alternative considered, not a selected public mode. An owner interface is not automatically an independent authorization channel: browser access, a local port or a token readable by the agent is insufficient by itself. Evaluate the authorization mechanism before promising administration without repeated privilege prompts. Do not grant agents unrestricted service-user access or passwordless administration.

The current lab's decisions 17/22 remain in force. The interface and authorization design should follow the selected model rather than introducing an admin UI by assumption. Interface selection and a proof of independent owner authorization remain open design work. Decision 52 adds an agent-assisted entry and installer-managed Node prerequisites without selecting an owner-entry interface.

## Agent-assisted installation

On October 7 the owner requested a prompt-to-agent workflow as the preferred entry (decision 52). The agent can perform technical work while the owner completes protected interactions. Codes and 2FA do not require abandoning the workflow: setup can pause and resume. The protocol below is proposed design, not implemented behavior.

### Proposed sequence

1. **Prompt and instructions.** The user asks an existing local agent to install a selected verified release and connect a specified client. The agent reads that release's installation instructions. The prompt does not authorize arbitrary privileged commands, broad Telegram access, credential discovery in other projects or provider-account changes.
2. **Preflight and plan.** The agent checks OS/architecture, prior installation, intended service identity/paths, port and client configuration through a secret-safe preflight. The installer manages the protected Node runtime; a Node/npm installation is not a user prerequisite. Return an installation plan before privileged mutations. On an existing installation, resume or take the update path rather than silently reinstalling.
3. **System authorization.** The owner approves the specified protected installation through the supported OS mechanism. The trusted installer acquires and verifies the exact release/runtime, creates the service identity and prepares state. Do not execute an agent-modifiable installer, clone or build as root. Agent-supplied checksums alone do not establish artifact trust. The exact bootstrap and verification mechanism need design and platform proof.
4. **Owner credentials and login.** Setup hands control to a protected owner interaction for the user's own `api_id`/`api_hash`, phone, verification code and 2FA as required. Explain the official credential-creation page if credentials are missing. Inputs go directly to the trusted setup/login process, never through chat, command arguments, logs, screenshots or agent-managed tool input. Keep Telegram state under the service identity and create an independent session on this machine.
5. **Access and client connection.** After the owner selects the account and initial access, the installer creates a gateway user and passes its MCP token directly to the selected client's credential/configuration path without printing it in agent output. Preserve unrelated client configuration; show a redacted change summary. Default to `core` with private conversations closed and writes disabled. Do not rotate tokens or replace accounts on repeated setup unless requested.
6. **Resume and verify.** The agent reads only setup progress and safe diagnostics, verifies the intended service and an authenticated MCP/SDK call, then checks actual client tool availability. If the client needs a reload, report that separately and continue after reload without repeating login or issuing a new token. Finish with the installed release, readiness checks and any unresolved owner/client action.

The product goal is one installation request followed by a small number of clearly explained owner actions. Do not promise a fixed number of prompts: OS approval, credential creation, Telegram's login requirements and client reload/provider state vary. Routine MCP calls remain unprivileged. Client/provider authentication remains outside gateway installation.

The MCP token is a client credential and can be accessible to the client/its OS identity. Direct handoff prevents unnecessary transcript disclosure; it does not establish OS isolation of that token from the client using it. Administrative authority and Telegram session material must remain separate from this token.

### Resumable setup contract

Provide a versioned, machine-readable setup result and a non-mutating progress command. Example state names are proposals, not CLI commands or existing endpoints:

| State | Meaning | Next participant |
| --- | --- | --- |
| `preflight_ready` | Planned changes and release identity available | Installer after scoped system authorization |
| `needs_system_approval` | Privileged installation has not been authorized | Owner through the OS mechanism |
| `needs_api_credentials` | Own Telegram application credentials absent | Owner in the protected setup interaction |
| `needs_telegram_login` | No completed usable gateway session | Account holder in the protected login interaction |
| `needs_client_reload` | Configuration prepared; client tool loading unverified | Owner/client, then agent verification |
| `ready` | Service and selected client checks passed | Agent reports completion |
| `failed` | A specific stage failed; completed stages retained | Safe error and recovery instruction, without secrets |

Return a setup identifier, stage, safe error code and resumable next action. The identifier correlates progress; it grants no administrative authority. The agent-facing result must contain no raw token, API hash, phone, code, password, session, encryption key or secret-bearing URL. Do not expose the protected database or an unrestricted administrative endpoint to enable status polling. Polling follows the external agent's explicit checks and is not a gateway model launcher or Telegram watcher.

Store authoritative progress under the service's protection. An owner-ready signal from chat is insufficient proof of login or setup completion: the trusted process must verify the completed stage. Cancellation, client restart and expired login challenges retain installed components and completed state. Do not automatically retry sending login codes or reuse an expired challenge indefinitely.

### Required implementation changes

- Supply versioned agent-facing installation instructions and a release-specific bootstrap that works before Node/npm is installed. Keep the runtime npm package under the selected public package name; a bootstrap is an additional installation entry, not a change to npm publication.
- Separate common setup/status handling from privileged platform adapters. The agent never receives general service-user access to make installation easier.
- Add an owner-entry handoff outside the agent's transcript, with independent authorization where required. A hidden terminal prompt suppresses echo but does not by itself prove protection from an agent controlling that terminal or browser. Validate input handling and access restrictions for the supported clients; do not claim universal protection against all same-user screen/input inspection.
- Add a token handoff without stdout disclosure. Current `user add` and `user token` print the token, so calling them through an agent's ordinary command output is not the proposed automated route.
- Add client adapters, redacted configuration previews and safe progress/diagnostic output. If automatic editing is unsupported or blocked, provide a concrete manual handoff and retain completed setup.
- Verify the prompt workflow in the actual clients with synthetic installation/login inputs before live owner participation. Test transcript redaction, cancellation/resume, repeated setup, service/client mismatch and reload handling as well as installation correctness.

### Telegram and client documentation checked

Official Telegram documentation requires application credentials obtained through [API development tools](https://core.telegram.org/api/obtaining_api_id) and describes [verification-code/2FA authorization](https://core.telegram.org/api/auth). The current gateway implements phone/code/2FA login. [QR login](https://core.telegram.org/api/qr-login) is a possible future simplification of human entry, not an implemented or selected gateway flow. The pinned teleproto package exposes a QR authentication function, but that alone is not gateway integration or verification; QR does not remove the application-credential requirement.

The [official Codex MCP guide](https://learn.chatgpt.com/docs/extend/mcp) describes shared local MCP configuration, HTTP bearer authentication and a client restart step after app configuration. Therefore configuration writing, SDK connectivity and tools becoming available in an existing model conversation must be verified separately. Do not promise that a newly configured server appears immediately in the installing conversation.

## Proposed user journey

1. Ask a local agent to install a specified verified package/release using its versioned instructions, or start the same installer directly. Explain supported platforms and any administrator step before changing the machine. Supply the protected Node runtime without a prior Node/npm requirement.
2. Run setup: detect existing state/service/port, show the intended paths, then prepare code, state, shared files and supervisor through the selected model.
3. Enter the user's own Telegram application credentials through a protected owner interaction. Store them outside the checkout; never pass secrets in command arguments or include them in reports.
4. Log in through the gateway on this machine. The account holder enters the code and 2FA password personally. Existing completed setup must not force another login.
5. Create a gateway user, grant the chosen account and configure toolsets. Keep `core` enabled and writes disabled initially. Repeating setup must not rotate an existing MCP token without an explicit request.
6. Prepare a client connection, starting with Codex Desktop on the main Mac. Show the configuration changes before applying them, preserve unrelated servers, and expose only the MCP token to the client. Model/provider authentication remains the client's responsibility.
7. Verify the installed service, session ownership and MCP connection. Show what is ready and the next required owner action without displaying secrets or Telegram content.

Suggested command names such as `setup`, `service`, `update` and `uninstall` are interface proposals, not available commands. Detailed prompts and command boundaries follow the model decision.

## Implementation sequence and acceptance

| Step | Work | Completion evidence |
| --- | --- | --- |
| 1 | Inspect existing installation and prepare this plan | Complete: source inventory and implementation gaps recorded |
| 2 | Select execution model and design owner administration | Service identity selected under decision 51; still define privilege points for setup, login, permissions, diagnosis, updates and removal; no agent-readable administrative credential used as proof of owner approval |
| 3 | Implement shared setup/preflight and macOS installation | Repeatable setup; safe cancellation/resume; paths with spaces; occupied-port detection; no overwritten secrets/state; protected artifact acquisition and disabled dependency install scripts |
| 4 | Implement onboarding and first client connection | Owner-created main-Mac session; user/account grants; secret-safe token transfer; authenticated SDK check and actual Codex Desktop tool call; no second session client |
| 5 | Implement service lifecycle, update, recovery and uninstall | Supervisor restart; second-process rejection; staged release switch; failed-update recovery; consistent backup; retain-data removal; explicit deletion path |
| 6 | Adapt Linux and native Windows | Platform service/identity adapters; equivalent real access protection, locking and safe file operations; native Windows tests on the owner's computer, independent of WSL |
| 7 | Finish public guide and platform/client verification | Clean installation from exact archive/version; supported Node matrix; documented privileges and data lifecycle; declared clients pass their prepared scenarios |

Keep generic workflow/state handling separate from platform-specific service registration and permissions. Do not disable Unix safeguards to make Windows tests pass. Do not add an administrative API to the agent's MCP surface.

For updates, prepare and validate the candidate without touching the active release; stop the service and verify session ownership is released before switching. Back up SQLite consistently together with the key and configuration, under protected storage. Schema migrations remain immutable. A code fallback is allowed only when the database schema remains compatible; never start old code against an incompatible newer schema or blindly restore state after new writes.

The first implementation target is the main Mac, followed by Linux and the owner's native Windows computer. No platform is claimed supported solely because a generated service file or unit test passes. Public version selection and npm publication are separate release gates and need not block local installation testing.

## Verification boundaries

Use synthetic accounts and Telegram doubles for automated setup, failure and MCP checks. Test meaningful boundaries: interrupted setup, repeat setup, unexpected symlinks, port conflicts, failed release preparation, stale service state, second-process rejection and schema-incompatible fallback. Build, typecheck and existing tests must pass at each completed implementation step.

Live login and client verification happen after installation is ready and the account holder participates. Never copy the lab session or read another project's credentials for the main-Mac setup. Test only the owner's authorized accounts/chats; write scenarios still require a preview and explicit consent.

This inspection did not run the installer, install a service, change client settings, read credentials or contact Telegram.

Planning-step validation on October 7: build and typecheck pass; all 726 tests in 21 files pass; local links, English-only content, U+2014 exclusion and the public transfer manifest pass. The new plan remains private preparation material. Gateway source, the lab installer and published migrations are unchanged. These checks do not prove the proposed installation workflow or any new platform/client support.
