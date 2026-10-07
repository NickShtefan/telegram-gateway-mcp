# Terminal installer trust and owner handoffs

Current design for issue #3 and the broader public 0.2.0 workstream. Decisions 54-60, accepted October 8, replace the earlier unaccepted Developer ID `.pkg`, native owner GUI/XPC and separate-human-login proposals. Their old text remains in private Git history. Implementation and proof are tracked in [release-progress.md](release-progress.md).

## Accepted direction and limits

One terminal wizard serves independent and agent-assisted entry. The installer supplies an exact tested Node runtime, protects code/runtime and Telegram state under a separate service identity, preserves completed setup and connects selected clients without disclosing tokens in transcripts. macOS 13+ arm64/Intel, Linux and native Windows are required for this release. Automatic adapters target Codex Desktop, Claude Code, OpenCode and Hermes. No Apple Developer membership, paid certificate or notarization dependency is selected.

The owner manually enters system authorization and API credentials/phone/code/2FA in a human-controlled terminal under the existing OS login. Agents must be stopped and UI control/capture disabled for this interaction. Do not create the secret-input terminal through an agent tool, type into it, inspect its output, take screenshots or request secrets in chat. After the sensitive step the agent may read only allowlisted progress.

This is operational separation, not an independent security boundary against arbitrary software sharing the owner's UID. Same-user screen/input manipulation and malicious release signers remain limitations; they must not be described as solved by hidden input, an encrypted session or a project signature. Persistent service state and executable code still require OS isolation. No broad passwordless sudo, generic service-user shell or administrative MCP/HTTP API is introduced.

The owner terminal displays the exact release, destinations and actions before scoped elevation. Ordinary MCP stays unprivileged. Cancellation retains completed state. The legacy lab installation is detected but never adopted, updated or logged into automatically.

## Initial trust before privileged downloaded code

The verifier cannot prove its own authenticity with a key/checksum that arrived alongside it. Establish a production public-key fingerprint and exact approved release identity through an independent owner channel before first installation. The owner/release signing-key provisioning is a publication prerequisite, not a reason to request private keys from chat during development. Synthetic keys exercise the pipeline without authorizing production installation.

Proposed portable mechanism: a canonical, strictly parsed manifest with detached RSA-3072/SHA-256 signature. RSA PKCS#1 verification is an engineering candidate for system OpenSSL on POSIX and .NET cryptography in PowerShell; exact implementation/availability is verified in the bootstrap stage, not inferred from installed developer tools. Refuse unsupported verification capability rather than falling back to checksum-only trust. Keys/signatures are project authenticity evidence, not notarization, Authenticode or an OS publisher guarantee.

The initial privileged verifier is a small independently reviewed owner-executed command using fixed OS tools and a controlled environment. It must not run a downloaded script or the checkout as root to establish trust. Its fixed revision and key fingerprint are part of the owner approval material. In the same-user model this relies on the accepted manual/paused-agent operating procedure; do not promise protection if that owner interaction is controlled by malicious same-user software.

Sequence:

1. Unprivileged preflight identifies target OS/architecture, safe existing-installation presence and intended changes. Agent downloads/checks may provide diagnostics only.
2. The owner reviews the initial verifier and expected release/key identity independently, then performs scoped system authorization manually. The system-tool verifier acquires its own files in a new protected staging directory; it never executes agent-supplied downloads, configuration, startup files or arbitrary hooks.
3. Validate the independently pinned key fingerprint, detached manifest signature, exact version/source SHA, platform and artifact sizes/hashes. URLs are restricted to approved HTTPS acquisition locations; redirects, private-source authentication and anonymous acquisition are treated explicitly. Caller-supplied strings are never evaluated as commands.
4. Fetch a standalone Node executable and installer entry from the authenticated manifest, verify bounded sizes/digests and retain only private regular files. Privileged downloaded code is executed only after these checks. Do not extract an untrusted runtime archive merely to obtain the verifier.
5. The verified installer validates the canonical application archive before extraction: reject traversal, absolute paths, duplicate names, links/reparse points, unsupported entry types, unsafe permissions, oversized content and undeclared files. Stage a full candidate before activation; never build/npm-install from the owner's checkout as administrator.
6. Provision the isolated service and fixed owner/agent commands from the verified candidate. Check ancestor ownership/ACLs and existing collisions before mutation. Privileged acquisition/elevation steps preserve only narrowly required inputs, with no inherited PATH, shell/npm/curl configuration or Node injection variables.

Only the intended verified bytes may be activated. A manifest supplied solely by an agent, moving unverified bytes to a root-owned path, or comparing hashes from the same untrusted source is insufficient. A failed trust check leaves the existing installation untouched and returns a fixed safe error.

## Identities, authority and interfaces

| Participant | Authority | Inputs and outputs |
| --- | --- | --- |
| Agent/human preflight | Ordinary OS identity, read-only | Platform/architecture, safe presence checks, plan; no service secrets |
| Initial owner verifier | Explicit scoped sudo/UAC through fixed system tools | Independently pinned release/key, protected staging and verified candidate |
| Owner terminal administration | Human-selected fixed installed commands, operation-scoped elevation | Credentials directly to service worker; exact access/client plan; no token printing |
| Setup worker | Dedicated service identity, protected Node/code | Authoritative private journal, own sessions, grants and safe stage outcomes |
| Gateway daemon | Same service identity, no administrator authority | Existing MCP, account queue/deadline and exclusive session ownership |
| Client adapter | Selected client identity, constrained destination | Direct bearer-token handoff and atomic configuration merge; no service/admin authority |
| Progress reader | Ordinary OS identity, read-only | Allowlisted published projection only; setup IDs grant no authority |

Root/Administrator controls executable code/runtime, service definitions and trusted command entry points. The service identity controls private configuration, SQLite, encryption key, sessions and authoritative setup progress. Exports/media have their own safe readable directory. An MCP token identifies a gateway user; it never becomes an administrative capability.

On POSIX, the privileged coordinator switches only to a fixed service worker and fixed subcommands, with a controlled environment and inherited private pipes. On Windows, the elevated installer must run gateway/login workers as the protected service identity, not retain owner/Administrator execution as the permanent daemon. The exact launchd/systemd/Windows-service mechanisms and ACLs belong to their implementation stages. No unverified Windows isolation claim follows from generating a service definition.

The token is delivered to a constrained adapter running as the selected client identity. Do not write arbitrary user-controlled paths as root/Administrator or execute a caller-provided command. Discover supported client configuration through the actual installed version; validate target ownership/ancestors, reject unsafe links, preserve unrelated data and detect concurrent changes. Token accessibility to the client user is expected and distinct from protection of Telegram/admin material.

## Shared stages and resumable outcomes

The owner wizard and agent presenter consume one engine. A human message saying "approved" or "finished" never advances protected state. The worker inspects actual protected resources and validates prior journal records before deciding what remains.

| Stage | Owner/service action | Resume and cancellation |
| --- | --- | --- |
| Preflight | Show release, platform, locations and required actions without gateway initialization | No credentials/database/keys/services created |
| System approval/trust | Owner invokes the reviewed verifier; validate exact signed release in protected staging | Reject mismatches; completed valid resources retained; no silent upgrade |
| Service provisioning | Prepare identity, code/runtime, fixed commands and disabled/unconfigured service | Reconcile partial state; unsafe identity/ACLs require owner review |
| API credentials | Owner obtains own Telegram app credentials and enters them directly | Atomic protected write; canceled input discarded |
| Login | Owner initiates fresh gateway-owned login and enters phone/code/2FA | Existing session skipped unless explicitly replacing; expired challenge discarded; no automatic code resend |
| Access | Owner chooses users/accounts/grants and reviews defaults | Core tools, closed private chats, disabled writes; accepted grants preserved |
| Client connection | Owner chooses any supported adapter; token passed directly | Retry pending handoff without rotation; conflict requires safe resolution |
| Verification | Prove intended service, authenticated MCP, defaults and each selected client's tools | Installation, configuration, reload and actual tools are separate evidence |
| Completion/cancel | Display safe result or next owner action | Preserve completed accounts/tokens; never replay interrupted writes |

Before any login/replacement worker opens a Telegram client, stop the old daemon, prevent supervisor restart and prove it has exited. The worker acquires the same session-ownership lock before constructing the client; release only after destroying the client and committing its result. On a stuck MTProto call/cleanup, exit the worker and prove process termination before restoring supervision. Never recover a stuck call in process.

The earlier socket-only lock had a reproduced stale-socket deletion race. The foundation stage introduces a permanent-inode kernel lease before socket cleanup and simultaneous restart regressions. Compatibility with a still-running legacy daemon must be tested: a new lock must not permit a second client beside an old process. No existing lab deployment is changed during development.

Human secrets never enter argv, environment variables, stdout/stderr logs, screenshots, clipboard, URLs, user-readable temporary files or agent-controlled inputs. API credentials persist only under the service identity; OTP/2FA/challenge data remain ephemeral. Hidden terminal entry suppresses display but does not strengthen the accepted same-user threat boundary. Use closed error codes instead of raw library errors, phone-derived identities or 2FA hints in progress.

## Current engine and proof boundaries

The [setup foundation](setup.md) already supplies read-only preflight/cached status, strict schemas, reconciliation and adapter journal primitives. It does not yet execute installation/login/grant/client stages. The foundation stage changes the unshipped owner action to `open_owner_terminal` and allows selection of any of the four client identifiers; actual client adapters remain stage 6 work. Do not treat existing cached status as fresh service/client proof.

The privileged adapters publish only a bounded allowlisted projection. Authoritative progress remains service-protected, with an exclusive setup lease and atomic writes. A setup UUID correlates progress only. Future/unknown schemas, corrupted state, unapproved changes, stale observations and foreign installations cannot silently become ready. Explicit later client selection does not repeat login or rotate existing tokens.

Verification uses synthetic secrets and fake Telegram first. Required hostile cases include wrong trust key/signature/version/architecture, oversized or substituted payloads, unsafe archives/paths/ACLs, privilege denial, competing/restarted workers, canceled/expired login, repeated handoff, unrelated client config/concurrent edits, wrong service at the port and claimed ready status without actual tools. Record exact candidate, OS/architecture, Node/client versions and artifact checksum, never real secrets or owner screens.

Both entries must subsequently work in fresh no-Node environments on every declared platform. The owner uses the separate controlled test account/channel selected in decision 59. Real login, each Telegram write, merges and publication retain their concrete owner gates. Green synthetic checks and one agent review do not substitute for those gates. Repository creation and npm access remain deferred owner actions under decision 58.
