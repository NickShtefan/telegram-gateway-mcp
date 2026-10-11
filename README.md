# Unofficial Telegram MCP Gateway

An MCP gateway for Telegram user accounts. One daemon owns the MTProto sessions and exposes tools to Claude Code, Codex, OpenCode and other MCP clients. Agents can read and search chats, fetch media, export messages, inspect channel counters, build a local index and prepare confirmed writes.

The gateway is a tool for an agent. It does not run models, watch chats, start agents or manage negotiation goals. Every Telegram operation begins with a tool call. This project is independent of Telegram.

## Capabilities

23 tools in five toolsets; `core` is enabled by default.

| Toolset | Capabilities |
| --- | --- |
| core | Account dialogs, chat resolution, search, history, comments, forum topics, JSONL/CSV exports, photos and previews |
| discover | Channel name search, similar channels and forwarding sources |
| analytics | Public channel counters, reach, engagement and trends |
| index | Explicit chat indexing and local substring search without Telegram calls |
| write | Preview and confirm replies, sends, reactions, joins and callback button presses |

One process owns each session. Bearer tokens separate gateway users and their account grants. Private conversations are closed by default. Every MTProto call passes through an account queue with limits and a deadline. A hung operation stops queued work and exits with code 1 for supervisor restart. Telegram text is labeled as untrusted data.

Write tools return a preview and `approval_id`. The agent must show it to the owner and call `tg_confirm` only after consent. The gateway cannot independently verify human approval; client permissions are part of this boundary.

## Installation

Download a **signed release archive**, not an unsigned Actions candidate. No Node/npm, compiler, local signing key or manually entered hash is required. Only the maintainer signs releases. The current repository is private and a signed draft must first be prepared by the owner: draft releases are visible only to authorized users with the necessary repository permissions. Anonymous installation is unavailable until the owner publishes a release and chooses repository visibility. See [private tester access](docs/outsider-test.md).

1. In your browser, open [Releases](https://github.com/NickShtefan/telegram-gateway-mcp/releases) and download the archive for your machine into **Downloads**. Also download the bootstrap from the immutable source link below, not from an untrusted mirror. Do not rename the files or open/extract the archive yourself.
2. Run the matching three-command sequence below. The first automatically checks the bootstrap against this README. The second installs with system authorization; the third runs the wizard as your ordinary user.
3. In the wizard, press Enter for local account/user labels if appropriate, choose clients, and enter your own Telegram API credentials, phone/code/2FA directly into its hidden prompts. Restart selected clients after setup, then ask for an actual `telegram_gateway` / `tg_status` tool call.

| Platform | Signed archive |
| --- | --- |
| macOS arm64 (Apple Silicon) | `telegram-mcp-gateway-0.2.0-macos-arm64.tar.gz` |
| macOS Intel | `telegram-mcp-gateway-0.2.0-macos-x64.tar.gz` |
| Ubuntu 24.04 x64, Arch x64 | `telegram-mcp-gateway-0.2.0-linux-x64.tar.gz` |
| Ubuntu 24.04 arm64 | `telegram-mcp-gateway-0.2.0-linux-arm64.tar.gz` |
| Windows 11 x64 | `telegram-mcp-gateway-0.2.0-windows-x64.zip` |

The current Node 24 bundle needs macOS 13.5 or later. macOS 13.0-13.4 requires a separately prepared Node 22 bundle and is not qualified by these assets. Other platforms/versions remain unqualified until tested. See [platform checks](docs/outsider-test.md).

### macOS

Download [bootstrap-posix.sh at immutable source f16ac13](https://github.com/NickShtefan/telegram-gateway-mcp/blob/f16ac135c6e98d37876fffc161769fcea6e287dc/scripts/install/bootstrap-posix.sh) using **Download raw file**. For Apple Silicon, run in Terminal:

```sh
cd "$HOME/Downloads" && printf '4299233c7c215ead859a44941e817878db3485a512289856571e9422e39ae630  bootstrap-posix.sh\n' | /usr/bin/shasum -a 256 -c -
sudo /bin/sh -c 'set -eu; d=$(/usr/bin/mktemp -d /private/tmp/tg-bootstrap.XXXXXX); trap '\''/bin/rm -rf "$d"'\'' EXIT; /bin/cp "$1" "$d/bootstrap.sh"; printf "4299233c7c215ead859a44941e817878db3485a512289856571e9422e39ae630  %s\n" "$d/bootstrap.sh" | /usr/bin/shasum -a 256 -c -; /bin/sh "$d/bootstrap.sh" "$2" install' sh "$HOME/Downloads/bootstrap-posix.sh" "$HOME/Downloads/telegram-mcp-gateway-0.2.0-macos-arm64.tar.gz"
'/Library/Application Support/TelegramMCPGateway/bin/tg-mcp-owner' setup
```

On Intel, use the same commands with `macos-x64.tar.gz` in command 2. Expected: checksum `OK`, then `needs_api_credentials` with no service started yet; the wizard subsequently verifies the authenticated connection and tells you which clients to restart. Stop if a checksum fails or an existing/foreign installation is reported. Keep the same signed archive for retries.

### Ubuntu 24.04 and Arch

Download the same immutable [bootstrap-posix.sh](https://github.com/NickShtefan/telegram-gateway-mcp/blob/f16ac135c6e98d37876fffc161769fcea6e287dc/scripts/install/bootstrap-posix.sh). For x64:

```sh
cd "$HOME/Downloads" && printf '4299233c7c215ead859a44941e817878db3485a512289856571e9422e39ae630  bootstrap-posix.sh\n' | /usr/bin/sha256sum -c -
sudo /bin/sh -c 'set -eu; d=$(/usr/bin/mktemp -d /tmp/tg-bootstrap.XXXXXX); trap '\''/bin/rm -rf "$d"'\'' EXIT; /bin/cp "$1" "$d/bootstrap.sh"; printf "4299233c7c215ead859a44941e817878db3485a512289856571e9422e39ae630  %s\n" "$d/bootstrap.sh" | /usr/bin/sha256sum -c -; /bin/sh "$d/bootstrap.sh" "$2" install' sh "$HOME/Downloads/bootstrap-posix.sh" "$HOME/Downloads/telegram-mcp-gateway-0.2.0-linux-x64.tar.gz"
/opt/telegram-mcp-gateway/bin/tg-mcp-owner setup
```

On Ubuntu arm64, use `linux-arm64.tar.gz` in command 2. Arch ARM is not part of this release. If OS utilities are missing, the installer shows the complete official-source package transaction and asks you to type `INSTALL`. Cancel to leave gateway provisioning unstarted. It uses isolated Ubuntu official sources or Arch core/extra, never AUR/third-party repositories, and does not perform a full OS upgrade. Resolve stale Arch package databases by updating your OS yourself before retrying; the installer does not refresh the host database. [Linux checklist](docs/linux-private-test.md).

### Windows 11 x64

Download [bootstrap-windows.ps1 at immutable source f16ac13](https://github.com/NickShtefan/telegram-gateway-mcp/blob/f16ac135c6e98d37876fffc161769fcea6e287dc/scripts/install/bootstrap-windows.ps1). Open **Windows PowerShell as Administrator** for commands 1 and 2 (same OS user). Command 2 copies the verified bootstrap into a fresh administrator/System-only directory before execution. After it finishes, close that elevated window and use an ordinary PowerShell for command 3:

```powershell
if ((Get-FileHash "$HOME\Downloads\bootstrap-windows.ps1" -Algorithm SHA256).Hash.ToLowerInvariant() -ne '83f714d2f4ecf0c36cbe71438e936cc370c1071c0523845182c61487fada1a29') { throw 'Bootstrap checksum mismatch: stop' }
& { $acl=New-Object Security.AccessControl.DirectorySecurity; $acl.SetAccessRuleProtection($true,$false); $admin=New-Object Security.Principal.SecurityIdentifier 'S-1-5-32-544'; $acl.SetOwner($admin); foreach($sid in @($admin,(New-Object Security.Principal.SecurityIdentifier 'S-1-5-18'))){ $acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($sid,'FullControl','ContainerInherit,ObjectInherit','None','Allow'))) }; $d=Join-Path ([Environment]::GetFolderPath('ProgramFiles')) ('TelegramMCPBootstrap-'+[guid]::NewGuid()); $null=[IO.Directory]::CreateDirectory($d,$acl); try{ Copy-Item -LiteralPath "$HOME\Downloads\bootstrap-windows.ps1" -Destination "$d\bootstrap.ps1"; if((Get-FileHash "$d\bootstrap.ps1" -Algorithm SHA256).Hash.ToLowerInvariant() -ne '83f714d2f4ecf0c36cbe71438e936cc370c1071c0523845182c61487fada1a29'){throw 'Bootstrap checksum mismatch'}; & "$env:WINDIR\System32\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -ExecutionPolicy Bypass -File "$d\bootstrap.ps1" -Archive "$HOME\Downloads\telegram-mcp-gateway-0.2.0-windows-x64.zip" -Install; if($LASTEXITCODE -ne 0){throw 'Installation failed: preserve state'} }finally{Remove-Item -LiteralPath $d -Recurse -Force} }
& "$env:ProgramData\TelegramMCPGateway\bin\tg-mcp-owner.cmd" setup
```

The process-scoped PowerShell execution policy does not change machine policy or replace signature verification. An organization policy may refuse execution. Expected: installation creates a stopped manual service; the ordinary-user wizard performs login and starts/verifies it. [Windows checklist](docs/windows-private-test.md).

### Bootstrap trust and limits

The bootstrap is the trust root. This README pins its immutable repository commit and SHA-256; commands compare hashes automatically before executing a protected copy. Authenticate the repository/README independently (for example a reviewed clone or a known maintainer channel). A checksum from the same compromised release page is not independent proof. Replacing both an untrusted README and bootstrap, compromising the repository/maintainer account, or compromising the local OS remains outside this protection. A release page attacker who can replace only package bytes cannot pass the embedded owner-certificate check.

The signed manifest supplies the exact source SHA only **after** RSA signature verification, so users never type it. The owner draft command binds all five CI manifests, the release target and existing tag to one frozen SHA. Bootstrap does not resolve a mutable GitHub tag during privileged execution: fresh installation trusts an owner-signed 0.2.0 manifest; existing installation receipts prevent silently adopting another source/certificate. Keep the selected release fixed during qualification/retries.

Owner certificate DER SHA-256: `f6d3d70c8909d302f24c6853dfb82dad1ab7a2a2006221699002117b6a22c682`. `SHA256SUMS` detects corrupted downloads but is not an independent authenticity root. The installer verifies the certificate, signature and every payload before executing bundled Node. No key, token or session is included. Private chats and writes default to disabled; secrets go only into the human terminal with agents/capture stopped.

## Maintainer draft preparation

Only the owner runs the [one-command draft procedure](docs/release-qualification.md), entering the signing passphrase once. Never give the signing key/passphrase to an agent or CI. Publication, repository visibility and npm remain separate owner decisions. The gateway package is private and unpublished; do not run `npx tg-mcp` (that package belongs to another project).

## Development

Requires Node.js 22.13 or later and npm. macOS source builds also need the Xcode Command Line Tools to build the small universal kernel-lease helper; the release installer will bundle it, so target users need no compiler. The release policy is to recommend a tested LTS branch and verify the minimum Node version separately. Local and hosted source checks cover macOS, Linux and Windows; tested Node versions and live support evidence are recorded separately before release.

```bash
npm ci --ignore-scripts
npm run build
npm run typecheck
npm test
node dist/cli/index.js help
```

The build removes old outputs before compiling. The npm archive contains JavaScript, declarations, this README and license notices when provided; tests, source maps, private records and runtime state are excluded.

State defaults to `~/.tg-mcp`, or `TG_MCP_HOME`. Use only sessions created by this gateway's own login, separately on each machine. Never share session strings with another process or project. Store credentials, database and session key outside the checkout and away from agents with shell access.

## Source directory map

| Path | Contents |
| --- | --- |
| src/core | Session pool, limiter, watchdog, configuration, login and file safety |
| src/storage | SQLite implementation, interfaces and immutable migrations |
| src/services | Reads, search, export, media, index, statistics and actions |
| src/policy, src/writegate | User access, scopes, untrusted content, audit and write confirmation |
| src/mcp, src/transport | MCP tools, compact responses, HTTP server and stdio proxy |
| src/cli | Owner administration and daemon commands |
| docs | Architecture, tool contracts, connections, risks and synthetic scenarios |

The source checkout contains the detailed documents; they are not part of the runtime npm archive. Contributor agent instructions live in `AGENTS.md`.

Read-only `tg-mcp setup preflight` is implemented; see [setup preflight](docs/setup.md). The terminal bootstrap, protected service and owner/four-client components are under staged release preparation. Source/synthetic checks do not prove a complete no-Node installation on an owner machine.

The [artifact foundation](docs/install-artifacts.md) verifies signed version/platform-bound candidates and provides no-Node verification entries. Protected apply paths are implemented as release candidates. Independent verifier/signer trust and live platform qualification remain required.

Candidate guides: [independent owner installation](docs/install-owner.md), [agent-assisted installation](docs/install-agent.md), and [client adapters](docs/client-adapters.md). The package stays private until its exact release commit is qualified and separately approved.
