# macOS installer trust and owner handoffs

Design candidate for [issue #3](https://github.com/NickShtefan/telegram-gateway-mcp/issues/3), the first task in [installer milestone #2](https://github.com/NickShtefan/telegram-gateway-mcp/issues/2). Baseline: `8681293c68fbbe625b3102306a3e71745af50f12`, decisions 51-53 and the [installation plan](installation-plan.md). Prepared October 7, 2026.

Status: proposed for owner review, not an accepted interface or implemented installer. No installation, privileged command, Telegram login, client edit or lab deployment is authorized by this document. The first implementation PR remains a draft until its manual gates pass. No new public version is selected.

## Recommended design and unresolved choices

Ship an architecture-specific, Developer ID-signed and notarized flat `.pkg` containing a native owner application, a narrow native privilege broker, the compiled gateway, production dependencies and an exact Node runtime. A user starts macOS Installer directly, or an external agent downloads the same package and hands it to the owner. Neither entry needs Node, npm, Homebrew, Xcode, an agent or provider credentials on the target machine. Build/signing tools are release prerequisites only.

The package installs protected code; the native application guides both entries through one setup engine. Use macOS system authorization for restricted operations and direct native fields for Telegram input. Avoid an agent-controlled terminal, localhost browser panel, URL callback carrying secrets, or an administrative MCP endpoint.

There are two concrete owner choices before claiming this route satisfies the security requirements:

1. Approve the native signed-package direction and supply or establish the release signing identity. Developer ID availability, certificate ownership, Team ID, private signing credentials, notarization access and approved distribution identity have not been verified. Do not register an account, buy membership or obtain credentials as part of this task. Without a trusted signing identity, qualification of the bootstrap is blocked; an unsigned local build is only a synthetic development artifact.
2. Approve using a separate human OS login, with a UID different from the agent account, for protected owner steps. If the owner instead wants the native application in the agent's OS login, explicitly review the weaker screen/input boundary. Pausing an agent and disabling its UI tools is an operational precaution, not independent protection against arbitrary same-user software.

These proposals refine the open interface/authorization work in decisions 51-53. They do not revise the separate service decision or the lab workflow. Requiring a separate human login is an additional proposed operating requirement, not an already accepted decision. Until it is resolved, independent owner interaction remains an open acceptance gate.

| Candidate | Benefit | Why it is insufficient or still conditional |
| --- | --- | --- |
| Hidden CLI input | Small implementation; existing login prompts reusable | Agent controls terminal/process under the same UID; no independent secret-input boundary |
| Localhost browser wizard | Familiar presentation | Browser control, local requests and same-user credentials remain agent-accessible; local origin is not owner authentication |
| Signed native app in agent login | OS rights checks and authenticated helper; fewer account switches | Same-user screen/input control remains unproven; cannot promise secret isolation solely from signing |
| Signed native app in separate human login | Distinct file/IPC/input identity and system authorization | Recommended candidate; adds account switching and native release/broker work, requires owner approval and cross-session proof |

## Threat model and limits

Assume an agent can execute arbitrary commands as its OS user, modify its checkout and downloads, forge progress text, connect to local sockets, open applications and potentially operate browser/native UI. Do not assume its chat output or a checksum it provides is trustworthy. The service UID and root are outside that agent's authority. An agent with root, an unrestricted sudo authorization, or authority to act as the human owner defeats the boundary.

OS separation protects persistent service state and executable code. A signed GUI alone does not protect human input from another process under the same UID. Accessibility, Screen Recording, remote desktop, input monitoring, clipboard access, automation and debug capabilities must be examined on the actual machine and actual client. Secure password fields suppress ordinary display; they do not prove resistance to all capture or control. Telegram application credentials and phone are sensitive even when they are not passwords.

The recommended owner handoff uses a separate human login with no agent process, agent-controlled remote session or automation permission. The owner enters the installer/application from the independently verified distribution, not an agent-supplied lookalike. Do not capture screenshots or accessibility trees during any protected interaction. Do not permit an agent to create, switch into or authenticate that login. Cross-session capture/control must be tested before promising protection. Malware, compromised administrator authority and malicious release signers remain outside the supported boundary.

If this separation cannot be demonstrated, return `owner_boundary_unverified`, retain setup state and do not request live secrets. No localhost or hidden-terminal fallback silently weakens the boundary.

## Bootstrap trust before privileged execution

The no-Node starting artifact is the signed `.pkg`, not a downloaded shell script. Its identity record includes product identifier, release/build identifier, source SHA, architecture, OS minimum, exact Node version, package checksum and expected publisher Team ID. The private installer build identifier need not equal the undecided first public version.

The release pipeline builds from the exact reviewed commit in a clean environment, locks production dependencies, verifies Node provenance against upstream authenticated release checksums/signatures, records its license/notices and hashes every payload. It signs native components and the package, notarizes the distribution and staples the ticket. Node redistribution, signing/hardened-runtime compatibility and both architecture builds require qualification. The package carries Node, so privileged installation never downloads or builds executable content.

Trust sequence for either entry:

1. Obtain the expected publisher identity and exact build from the owner-reviewed release record through an independent owner lookup. A README, checksum, Team ID or release page supplied only by the agent is insufficient. Current private GitHub access remains separate from future anonymous release proof.
2. The agent may download and perform unprivileged signature, notarization, architecture and digest checks. These are useful diagnostics, not owner authorization or the sole trust anchor.
3. In the protected login, the owner acquires the same exact release independently into an owner-private directory whose ancestry/ACLs exclude agent writes. The agent's download is diagnostic only, never the privileged execution source. The owner opens this package with macOS Installer. Check the Developer ID publisher against the independently established identity, the expected build and macOS trust assessment before approving installation. Preserve quarantine/trust checks; do not disable Gatekeeper or ask the owner to bypass an unsigned-artifact warning.
4. The system installer must validate the package it actually executes. A check of an agent-writable path followed later by root execution is insufficient. Qualification must prove agent replacement is prevented by protected staging and that unsigned, differently signed or unapproved builds are rejected. Signing alone does not pin the requested build: owner review also checks the exact release identity. Copying agent bytes to a root-owned path does not establish trust. A future automated transfer into protected staging would need its own authenticated release verification and cannot be substituted silently.
5. Approved package payload/scripts establish the service identity and protected destinations. Scripts use fixed system tools and controlled environment, never user shell initialization, PATH-resolved Node, npm/git configuration, arbitrary hooks or caller-supplied executable paths. Reject unsafe existing ownership, ACLs, symlinks and collisions before mutation.

Developer ID verifies publisher identity; notarization is an Apple assessment for known malicious content, not proof that our code is correct. Checksums bind the reviewed bytes once the publisher/release anchor is established. They do not replace that anchor. Fail closed on mismatch, missing identity or failed trust assessment; no `curl | sudo sh`, root build of the checkout or unverified npm execution.

## Components and privilege boundaries

Names/paths below are proposed logical roles. Final product identifiers and non-colliding paths belong to #6. Detect the current lab installation and stop with `existing_installation_requires_review`; do not adopt, overwrite or migrate its sessions automatically.

| Component | Identity and authority | Interface and data |
| --- | --- | --- |
| Download/preflight presenter | Agent or human UID, unprivileged | Exact artifact metadata, OS/architecture, safe presence checks; no credentials or state reads |
| macOS Installer | OS-authorized package installation | Only verified package payload/scripts; fixed initial provisioning |
| Owner application | Separate human UID, signed installed native app | Wizard, OS authorization request, ephemeral credential fields, explicit plan/access review |
| Privilege broker | Root, installed protected native executable | Narrow authenticated XPC operations; verifies peer identity and OS rights for each mutation |
| Setup engine/worker | Dedicated service UID, protected Node/code | Versioned setup journal, credentials, session creation, grants, verification; fixed IPC inherited from broker |
| Gateway daemon | Same service UID, protected Node/code | Ordinary MCP only, account queues and session lock; never obtains root authority |
| Client handoff adapter | Selected client UID, narrowly scoped handoff | Receives only that client's bearer token and approved configuration change; no admin authority |
| Progress reader | Agent/human UID, unprivileged | Sanitized immutable snapshot; setup ID is correlation only |

Root owns code/runtime, owner application, broker, supervisor definitions and their parent directories. The service UID owns its private configuration, SQLite database, encryption key, sessions and setup journal, with restrictive modes and verified ACLs. It has no interactive shell/login and cannot modify its executables. Shared exports/media remain a separately validated directory. Progress contains no raw paths chosen by an untrusted caller and no account identifiers derived from Telegram.

The broker is a platform adapter, not a general administration API. Its fixed verbs are initial setup preparation, stage authorization, launching/canceling a setup worker, bounded service lifecycle transitions and obtaining a safe result. Inputs use closed enums, validated identifiers and size limits, never shell strings, arbitrary file destinations, environment overrides, executable names or SQL. Updates, deletion and broader administration remain follow-ups.

Use signed-peer requirements on both XPC ends, including approved Team ID, bundle identifier, supported code version and interactive owner UID/session. Check requirements before accepting messages; a same-Team signature alone is too broad. Validate OS authorization for the exact requested operation in the broker, not only in the GUI. Authorization references remain ephemeral, never appear in progress and cannot be replayed through an agent-facing channel. Bind each operation to the owner-reviewed plan revision, peer connection and one-use challenge. Code-signing identity is not proof of human consent; the application must display the exact operation and require owner action.

Authorization Services supplies system credential interaction; the application/broker must not collect an administrator password. Proposed macOS minimum is 13 for native peer-signature enforcement. Final minimum/architecture/Node compatibility requires evidence and must not silently become a support claim. Broker registration and approval must be prototyped with the supported Service Management API; its enabled state is a separate check from package installation. Do not rely on deprecated arbitrary privileged execution or install passwordless sudo rules.

The native owner application uses hardened runtime, controlled library loading and no scripting/deep-link/CLI interface that submits credentials or approves mutations. Authorization Services is unavailable inside App Sandbox, so do not claim the owner application is sandboxed as an extra boundary. Restrict logging, crash diagnostics and memory lifetimes explicitly.

## Stage map for both entries

Both entries run the same state transitions. The agent sees safe progress and explains the next owner action; the wizard provides that explanation itself for independent installation. Agent text saying "approved" or "done" never changes authoritative state.

| Stage | Caller/executor and authority | Data/owner action | Persisted result and interruption behavior |
| --- | --- | --- | --- |
| Preflight | Agent/human UID; read-only | OS/arch, safe installation presence, intended client/port; show planned changes | Plan only; no state directory, database, key, token or Telegram connection created |
| Artifact review | Owner; unprivileged OS trust tools | Independently check publisher/build, inspect fixed installation summary | Await system approval; reject mismatches without mutation |
| Protected provisioning | macOS Installer; scoped root approval | Owner approves verified package; create isolated identity, code/runtime and disabled service | Record completed resources; failed partial install is resumable only after protected ownership checks, never reports success |
| Broker activation | Owner app and OS service management | Owner permits exact installed broker where OS requires approval | `needs_system_approval` until enabled; no privileged agent fallback |
| API credentials | Owner app to service worker; operation authorization | Owner obtains own application credentials at the official Telegram site and enters them directly | Atomic protected configuration commit; canceled fields discarded; no other project's credentials discovered |
| Telegram login | Authorized worker as service UID | Account holder enters phone/code/2FA; explicitly initiate a new login attempt | Fresh gateway-owned session committed after success; expired/canceled challenge discarded; no automatic code resend |
| Account access | Owner app to authorized worker | Owner selects gateway user/account grants and default account; review final plan | Atomic grants; `core`, private chats closed, writes disabled; repeat run preserves accepted grants |
| Optional client handoff | Worker and narrow selected-UID adapter | Owner chooses client and approves redacted target change | Pending or committed handoff receipt; no repeated token issuance on resume |
| Service/MCP verification | Worker, broker, client adapter within granted scope | Verify installed identity, intended service, authenticated MCP and defaults | Separate pass/fail evidence; failed health cannot become ready |
| Actual client loading | Owner/client, then agent read verification | Reload client if needed and observe `tg_status` plus tool listing in that client | Client readiness remains pending until observed; no provider login performed by installer |
| Completion/cancel | Engine/wizard | Show installed build and remaining owner/client actions | Durable result; cancel retains completed components/accounts/tokens and removes ephemeral secrets |

Before login, the broker prevents supervisor restart, stops the daemon and proves its process has exited. The worker acquires the existing session lock before constructing a Telegram client and retains it until that client is destroyed and state is committed. A concurrent worker/daemon must fail without opening a client. Check existing completed sessions before sending a code: resume skips login unless the owner explicitly selects replacement. On cancellation/failure, destroy the login client, release the lock and restore the previously recorded safe service state. If client shutdown hangs, exit the worker, prove process termination and only then resume the daemon. Never recover a stuck MTProto call in process.

The current CLI login only probes the daemon lock and can print account identity; it is not this protected worker protocol. Adapt its injected `LoginPrompts` interface, logging and cancellation deliberately in #7. Raw teleproto errors, 2FA hints, account names and phone-derived text must not enter public progress. All MTProto operations keep the gateway's queue/deadline rules; the broker never calls Telegram itself.

## Input, output and token handoff

Human input flows from protected native fields through authenticated local IPC to the worker's inherited private channel. No secrets in arguments, environment variables, URLs, clipboard, temporary user files, application preferences, stdout/stderr, progress snapshots or screenshots. API credentials persist only under the service identity; codes/passwords and challenge state remain ephemeral. Use allowlisted error codes/messages, not post-hoc regex redaction of raw errors. Do not reuse current token-printing CLI commands in the setup route.

The Codex adapter remains subject to #9's verification of the actual client/version and supported credential storage. Do not invent a Keychain integration or assume a config key. The broker authenticates the selected client UID; a one-use narrow handoff carries the token directly to that UID's adapter. It permits only the approved MCP entry and fixed target discovered by the adapter, preserves unrelated settings, validates paths/ownership/symlinks, handles concurrent edits and commits atomically. Configuration is written as the client UID, never via a root write to an arbitrary user path. No adapter command executes caller-provided code.

A pending handoff stores its token in service-protected storage until receipt, enabling retry without rotation. The public receipt contains only a handoff ID and committed/pending outcome. A conflict leaves setup usable and requests owner resolution; no secret-bearing manual copy through chat. The token can be readable by the client UID after handoff. That permits ordinary MCP within grants, not access to administration, session material or setup worker input.

For different owner/client UIDs, bind the handoff to the selected client UID and destination from the owner-reviewed plan. Test this explicitly; do not weaken the owner interaction by requiring both processes to share a UID.

## Shared engine and progress v1

Place shared transition/resume logic in a new `src/setup/` layer, independent of MCP and native presentation. Platform adapters supply protected journal/file operations, owner-channel events, process/service controls, trust evidence and client handoff. Native controls/rendering remain macOS-specific; Linux/Windows adapters are outside this milestone. The wizard and versioned agent guide consume the same stage names and safe errors.

Persist authoritative setup state under the service UID. Provisioning receipts before that UID exists are root-protected. Use atomic writes and an exclusive setup lease; a crash between mutation and receipt is reconciled against actual protected resources, not blindly replayed. Journal only completed stages and opaque resource references, no credentials or challenge bodies. A plan revision change requires owner review before mutating accepted access/client selections. Incompatible journal versions fail safely. Pre-existing installations, ambiguous state and damaged permissions require review, not repair by recursive chown or deletion.

Proposed non-mutating command: `tg-mcp setup status --json --setup-id <id>`. This command does not exist yet. Before protected runtime installation, the native package/preflight presenter provides the same schema without Node. Status reads a protected, sanitized projection only, never opens SQLite, creates keys, initializes configuration or connects to Telegram. Root/service owns the published snapshot and every parent; agent access is read-only. A forged/copied snapshot is not privileged authorization or readiness proof. Verification binds reported checks to the actual installed service and authenticated endpoint.

Example using synthetic identifiers:

```json
{
  "format_version": 1,
  "setup_id": "fixture_setup_001",
  "revision": 4,
  "stage": "needs_telegram_login",
  "outcome": "waiting_for_owner",
  "error_code": null,
  "next_action": "open_protected_owner_application",
  "checks": {
    "artifact": "passed",
    "installation": "passed",
    "service": "not_checked",
    "authenticated_mcp": "not_checked",
    "client_configuration": "not_selected",
    "client_tools": "not_selected"
  }
}
```

Use closed stage/action/error enums and explicit `not_checked`, `pending`, `passed`, `failed` and `not_selected` values. Include verified non-secret build/OS/Node metadata once available. No arbitrary error strings, untrusted chat text, account/phone labels, usernames, bearer tokens, authorization references or secret-bearing paths/URLs. Unknown schema/enum values require a compatible presenter, not optimistic success. CLI safe status may use stdout; stdio MCP continues to reserve stdout exclusively for JSON-RPC.

`ready` means installation, intended service and authenticated MCP pass. If no client was selected, show `gateway_ready` and explicitly state that client tools were not checked. A selected client with pending reload/tools uses `needs_client_reload` or `needs_client_verification`; it cannot report full completion. SDK tests do not establish actual model-client tool loading. Changes to service identity, candidate or configuration invalidate affected checks.

## Verification and delivery map

No tests below are claimed to have passed for this proposed installer. Use synthetic credentials and fake Telegram for automated probes. Keep real secrets and owner screens outside evidence; record only versions, candidate SHA, checksums, safe states and results.

| Task | Required evidence before its gate closes |
| --- | --- |
| #4 bootstrap | Fresh arm64/x86_64 macOS with no Node/npm; independent and agent download of same package; correct publisher/build accepted; unsigned/wrong publisher, modified payload, missing notarization and artifact replacement rejected before privileged execution; no root network/build/user-config use |
| #5 engine | Both presenters follow same transitions; truly non-mutating preflight/status; schema compatibility; allowlist secrecy canaries in every output/error; exclusive lease, crash reconciliation, cancellation and repeats preserve completed state |
| #6 isolation/broker | Agent UID cannot read/replace service state, Node, app, broker or supervisor; ancestor/ACL/symlink attacks rejected; unsigned/wrong bundle/UID/version XPC peers and forged/replayed/expired authorization rejected; broker disabled/approval denied is resumable; no arbitrary execution or passwordless sudo |
| #7 owner/login | Synthetic phone/code/2FA and error/hint canaries absent from logs, transcripts, argv/env, user files and screenshots; second owner worker or daemon cannot open a client; cancellation/timeouts terminate worker before supervisor resume; completed session never relogged in automatically |
| #8 grants/handoff | Closed private scope and absent write tools verified; per-user/account grants and unchanged token on resume; another UID or setup ID cannot obtain/replay handoff; failed receipt reconciles without exposing token |
| #9 Codex | Exact client version/storage contract; selected-UID atomic merge preserves unrelated config; symlink, collision, concurrent edit and unsupported config fail safely; redacted preview/receipt and reload status; no assumed provider availability |
| #10 readiness | Wrong service on occupied port, stale build, dead broker/daemon, unauthorized MCP, missing defaults/toolset and pending client loading cannot pass; authenticated `tg_status` and tool listing match intended installation |
| #11/#12 automation/guides | Build, typecheck, tests on exact PR candidate; native build/security tests where applicable; standalone guide explains every owner action; versioned agent prompt cannot submit secrets or approve owner steps |
| #13 owner qualification | Demonstrate cross-UID input/screen boundary with actual clients using synthetic inputs first; owner performs new main-Mac gateway login only after concrete approval; both full entry paths qualified in clean environments, independent path completed without undocumented agent action; real Codex tools evidenced separately |

Test permission denial and consent cancellation, UI disconnection, expired login, interrupted package provisioning, worker crash, client restart and token handoff failure. Each case returns a concrete safe next action and preserves completed state. Do not silently uninstall, delete accounts, retry writes or rotate credentials. Scope stays initial macOS installation; Linux, Windows, updates/backup/recovery, uninstall, broader admin, other clients and anonymous public proof retain their follow-up issues.

## Primary references and evidence limits

Apple documentation checked October 7, 2026:

- [Developer ID](https://developer.apple.com/developer-id/) and [Developer ID certificates](https://developer.apple.com/help/account/certificates/create-developer-id-certificates/): publisher identity and distinct application/installer signing roles.
- [Notarization](https://developer.apple.com/documentation/security/notarizing-macos-software-before-distribution): supported package trust assessment. This does not verify project certificate availability or artifact correctness.
- [Authorization Services](https://developer.apple.com/documentation/security/authorization-services): system-managed credential interaction and rights checking; unavailable inside App Sandbox.
- [XPC peer signing requirement](https://developer.apple.com/documentation/foundation/nsxpcconnection/setcodesigningrequirement(_:)): native signed-peer enforcement, available from macOS 13; it does not attest human consent.
- [SMAppService](https://developer.apple.com/documentation/servicemanagement/smappservice): service registration/control on macOS 13+, subject to approval. Exact broker packaging/lifecycle still needs a native prototype.

These sources support available OS mechanisms. The package topology, peer/operation binding, separate human login, shared engine and handoff above are engineering proposals. They need implementation and hostile-client tests; documentation review is not platform or live-login proof.
