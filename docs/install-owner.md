# Independent owner installation: 0.2.0 candidate

For the owner's first ARM Mac test, start with the [concrete step-by-step guide](mac-arm-private-test.md). This page is the generic multi-platform contract.

This is the candidate workflow. Publication, production signer establishment and live qualification are still required before it becomes an installation recommendation. Use the owner-approved exact source commit and platform bundle, not the current repository's private history or another npm package named `tg-mcp`.

The current bootstrap scripts embed the owner-approved DER certificate SHA-256 `f6d3d70c8909d302f24c6853dfb82dad1ab7a2a2006221699002117b6a22c682`. Caller-supplied alternatives are rejected.

1. Obtain the versioned bootstrap verifier and bundle from the project owner's trusted release channel. Independently establish the verifier's exact code/checksum, the DER signer-certificate SHA-256 fingerprint and source commit. A fingerprint supplied only by an agent or by the same unauthenticated download is not an independent trust anchor. Have the human review and establish verifier trust before elevation; do not execute an untrusted downloaded verifier as administrator.
2. Keep the bundle in a local regular filesystem directory. Verification rejects redirects, hard links, unsafe archives, wrong signer/version/platform/architecture and inconsistent artifact bytes. The bundle carries its exact official Node runtime and license. Target users need no Node/npm or compiler. If required OS utilities are missing, the installer presents an exact package list and installs only those official-repository prerequisites after owner confirmation. Package resolution uses an isolated fixed official-source configuration for the entire transaction, including dependencies. Ubuntu refreshes only a disposable official-source index; Arch uses core/extra with required package signatures and no global index refresh. Unsupported or unverifiable sources stop installation with a manual next action. It does not perform a full OS upgrade or use third-party/AUR repositories. The designed macOS 13.0-13.4 runtime path uses Node 22; Node 24 requires macOS 13.5+. The owner qualification matrix currently targets the available macOS 26.6.2 arm64 and 15.7.9 x64 hosts. A separate macOS 13 test is not a release blocker, but that version must remain explicitly unqualified unless actually tested.
3. Stop agents and capture/UI automation before the human-owned terminal steps. Hidden input suppresses display; it cannot protect against arbitrary software under that same OS user. Never send Telegram credentials, codes or 2FA passwords to an agent conversation.

From an independently trusted POSIX verifier in the owner's terminal, verify without installation:

```sh
/bin/sh bootstrap-posix.sh /absolute/bundle-directory EXACT_SOURCE_SHA verify
```

After the owner establishes trust and approves system installation, run the same trusted verifier elevated:

```sh
sudo /bin/sh bootstrap-posix.sh /absolute/bundle-directory EXACT_SOURCE_SHA install
```

The selected owner Windows qualification target is Windows 11 x64 (Intel). Windows 10, ARM64 and WSL are not automatically declared supported.

On Windows, use Windows PowerShell 5.1 with the independently trusted verifier. Verification is read-only:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\bootstrap-windows.ps1 -Bundle C:\Local\Bundle -SourceSha EXACT_SOURCE_SHA
```

The process-scoped execution policy does not change machine policy; organization policy may still reject execution. In a human-elevated terminal, add `-Install` to stage the authenticated bytes with administrator-only ACLs, extract them, and provision the fixed virtual-account service. Never substitute a different script or candidate after approval. The service remains unconfigured/unstarted after provisioning.

The selected Linux qualification targets are Ubuntu 24.04 LTS and Arch Linux x64. Arch uses a fully updated snapshot with its date and package versions recorded. They share this bundle/systemd workflow; no .deb or AUR package is required. Other distributions and Arch ARM are not automatically declared supported.

The fixed prefixes are `/Library/Application Support/TelegramMCPGateway` (macOS), `/opt/telegram-mcp-gateway` with state in `/var/lib/telegram-mcp-gateway` (Linux), and `C:\ProgramData\TelegramMCPGateway` (Windows). Existing foreign identities/installations and different releases require review; there is no silent migration, session adoption or update workflow. An interrupted same-candidate provisioning run revalidates protected resources and keeps matching completed stages. A first run that fails before recording any stage leaves only an empty `provision.lock` in the prefix and can be repeated as is. `invalid_state` means existing state needs owner review before a retry: for example a service account or group with the fixed name but no installation receipt (possibly from interrupted account creation), or other prefix content without a receipt.

Return to an ordinary, unelevated human terminal for login and client configuration:

```sh
"/Library/Application Support/TelegramMCPGateway/bin/tg-mcp-owner" setup
# Linux: /opt/telegram-mcp-gateway/bin/tg-mcp-owner setup
```

On Windows invoke the installed `releases\EXACT_SOURCE_SHA\node.exe` with `application\dist\setup\ownerLauncher.js`. Choose gateway account/user IDs and any subset of Codex Desktop/CLI, Claude Code, OpenCode stable and Hermes. The launcher requests scoped elevation internally. Windows requires the same OS identity across original/elevated processes; elevation as another user is rejected.

Obtain your own Telegram application credentials from `https://my.telegram.org/apps`, then enter phone/code/2FA only into the human terminal. The gateway never registers new Telegram accounts, pays for code delivery or borrows another project's credentials/sessions. Create sessions separately on every machine. Existing sessions/grants are preserved on repeat; no token is silently rotated. Failed first login does not cache an unverified application pair.

The login worker exits before service startup. The coordinator proves the registered service owns the loopback listener, then gives the bearer directly to the selected original-user profiles. Conflicting gateway entries require an explicit replacement choice; unrelated settings are preserved. Pending encrypted handoff survives failure until all selected profiles and the SDK check acknowledge the token hash. No token is printed. Keep clients stopped until setup checks succeed. Interrupting the owner command (Ctrl-C, closed terminal) returns the service to the state it had before the run; if the coordinator was killed outright, the next owner run restores that state from a protected marker.

Read the result's evidence carefully: SDK initialize/catalog/status is distinct from actual model tool loading. Sign in to model providers separately, restart/reload selected clients, and run the same controlled read-only scenario from `scenarios.md`. Default managed setup exposes core tools with private chats closed and writes disabled. Real write qualification needs a separately approved preview/confirmation using only the controlled owner test account/channel. No public support claim follows from source/fixture checks alone.

Rollback/recovery is not destructive uninstall: stop the fixed service and preserve private state while reviewing the cause. Do not delete/copy sessions, overwrite another identity, rewrite published migrations or re-run uncertain writes. Safe updates/backups and broader owner administration remain separate follow-ups. Record actual OS/architecture, Node/client versions, source SHA and artifact checksums before release.

Use [release-qualification.md](release-qualification.md) for owner-only local key/signing steps, the live evidence matrix and final publication gates.
