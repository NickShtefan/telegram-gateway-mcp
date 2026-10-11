# First private installation test: the owner's Apple Silicon Mac

Start here for the ARM development Mac. This guide freezes the **October 11, 2026 candidate with the latest fixes**. Run one step at a time in Terminal and continue only when its expected result matches. Stop on any error; do not substitute a newer build midway through a test or delete gateway state to make a retry succeed.

This is private qualification, not a public release. No new repository, npm account or paid Apple membership is needed. The installer includes Node; this development Mac uses its existing Node/npm and Command Line Tools only to prepare the owner-operated signing helper. Other target machines will not need a compiler. Signing, sudo approval and Telegram secrets are human terminal steps: never give their values to an agent.

## 1. Confirm the machine and check for conflicts

```sh
uname -m
sw_vers -productVersion
command -v gh
command -v node
xcode-select -p
```

Expected on this Mac: `arm64`, macOS `26.6.2`, and paths for GitHub CLI, Node and Command Line Tools. Node must be 22.13+ on the supported 22/24 branch; the existing development Node is 24.10.0. If a tool is missing, stop and resolve preparation first.

```sh
if [ -e '/Library/Application Support/TelegramMCPGateway' ] ||
   [ -L '/Library/Application Support/TelegramMCPGateway' ]; then
  printf 'Existing installation: stop and review before continuing.\n'
else
  printf 'New installation prefix is absent.\n'
fi
/usr/sbin/lsof -nP -iTCP:7777 -sTCP:LISTEN
```

Expected: `New installation prefix is absent.` and no listener output. `lsof` returning 1 with no output is normal here. If a listener or existing installation appears, stop; do not kill it or remove files. The Intel lab gateway is outside this test.

## 2. Download this exact ARM candidate

Open the [successful workflow run](https://github.com/NickShtefan/telegram-gateway-mcp/actions/runs/38148696332), signed into a GitHub account with access to the private repository. Under **Artifacts**, the ARM build is:

```text
unsigned-macos-15-42e0874ce0d45a625fbc1c7a6141b23f732f11d9
```

`macos-15` is the ARM CI builder label, not a restriction to macOS 15. Do not choose `macos-15-intel`. The following commands download the exact ZIP through GitHub CLI, so its path and checksum are unambiguous:

```sh
umask 077
TG_SOURCE_SHA=42e0874ce0d45a625fbc1c7a6141b23f732f11d9
TG_TEST_ROOT="$HOME/tg-mcp-mac-arm-test-42e0874"
TG_BUNDLE="$TG_TEST_ROOT/bundle"
TG_SOURCE="$TG_TEST_ROOT/source"
TG_REPO="$HOME/Projects/CODE/Chanel/tg-mcp"
TG_SIGNING_DIR="$HOME/tg-mcp-signing"
TG_BOOTSTRAP="$TG_REPO/scripts/install/bootstrap-posix.sh"
TG_TRUSTED_VERIFIER=/Library/TelegramMCPGateway-bootstrap-f6d3d70c.sh
mkdir -m 700 "$TG_TEST_ROOT"
gh api repos/NickShtefan/telegram-gateway-mcp --jq .private
gh api repos/NickShtefan/telegram-gateway-mcp/actions/artifacts/11705630926/zip \
  > "$TG_TEST_ROOT/download.zip"
shasum -a 256 "$TG_TEST_ROOT/download.zip"
```

Expected: repository check prints `true`; download succeeds; ZIP SHA-256 is exactly:

```text
7b31fae7133f146577c559cd8fc3445a79b3f94e5e98fc7e9770fb50921e9dc4
```

Only after that match, extract:

```sh
test "$(shasum -a 256 "$TG_TEST_ROOT/download.zip" | awk '{print $1}')" = \
  7b31fae7133f146577c559cd8fc3445a79b3f94e5e98fc7e9770fb50921e9dc4 &&
mkdir -m 700 "$TG_BUNDLE" &&
/usr/bin/ditto -x -k "$TG_TEST_ROOT/download.zip" "$TG_BUNDLE"
shasum -a 256 "$TG_BUNDLE/manifest.tsv"
```

Expected: eight public files, including `node`, `manifest.tsv` and `application.tar.gz`. No key or signature exists yet. Manifest SHA-256 must be:

```text
fa15c6a2a19fd6563b637f25fe2d590852238a19b5d456c37070694fea4c386b
```

This is an unsigned candidate. Do not launch its Node or install it yet. If the artifact expires or GitHub returns 404, stop and obtain a regenerated, explicitly identified candidate; do not silently replace the source SHA. If GitHub authentication is missing, sign in yourself and retry; never share a GitHub token. If the test directory already exists from your own earlier attempt, reuse that same directory and candidate rather than overwriting it or starting with different hashes.

## 3. Prepare the signing helper from the exact fixed source

Update the repository to include the owner-pinned bootstrap before starting. The application and signing helper stay frozen at source `42e0874`; the bootstrap comes from the updated checkout and must match the new hash below. Do not use the older unpinned bootstrap exported with the application source. Export its tracked files into a separate directory, preserving your working checkout:

```sh
git -C "$TG_REPO" cat-file -e "$TG_SOURCE_SHA^{commit}"
mkdir -m 700 "$TG_SOURCE"
git -C "$TG_REPO" archive "$TG_SOURCE_SHA" | /usr/bin/tar -x -C "$TG_SOURCE"
cd "$TG_SOURCE"
npm ci --ignore-scripts --no-audit --no-fund --cache "$TG_TEST_ROOT/npm-cache"
npm run build
shasum -a 256 "$TG_BOOTSTRAP" scripts/release/sign-candidate.mjs
```

Expected: dependency installation and build exit successfully. Script hashes, in the printed order:

```text
a38abb05090f89b79144ecd000730b1a6139948dfefa37fc177e10246d5fce59
63c368974ef7cf87411d910d16b617803c134e75fdbc7793c8679ec10a1348d1
```

Review the [owner-pinned verifier](https://github.com/NickShtefan/telegram-gateway-mcp/blob/codex/install-trust-design/scripts/install/bootstrap-posix.sh) and the [owner signing helper](https://github.com/NickShtefan/telegram-gateway-mcp/blob/42e0874ce0d45a625fbc1c7a6141b23f732f11d9/scripts/release/sign-candidate.mjs). Establish your trust in this exact source before giving it a signing key or elevation. Hashes printed by a download alone do not establish independent authenticity.

```sh
node "$TG_SOURCE/dist/cli/index.js" setup preflight --client codex --json
```

Expected: `phase: "preflight_ready"`, `architecture: "arm64"`, `next_action: "review_plan"`, port 7777, core tools/private chats closed/writes disabled. No installation or login occurs. A failed result means stop and investigate its safe error code. There is no `setup status` command in the fixed source.

## 4. Create or reuse your encrypted local signing key

**Stop all agents and disable terminal capture/UI automation now. Keep them stopped through signing, installation and Telegram login.** Hidden prompts do not protect against arbitrary software running as your OS user. Perform the remaining commands yourself in an ordinary Terminal, not an agent tool or shared transcript. Keep this Terminal open so the `TG_*` variables remain available.

Use your existing encrypted key and certificate in `$TG_SIGNING_DIR`. You have already established the certificate fingerprint. **Do not generate another key or certificate for this test.** If those files are unavailable or stored elsewhere, stop and locate your own files rather than replacing the signing identity.

```sh
TG_SIGNER_PIN="$(/usr/bin/openssl x509 \
  -in "$TG_SIGNING_DIR/owner-signing-certificate.pem" -outform DER |
  /usr/bin/shasum -a 256 | /usr/bin/awk '{print $1}')"
printf 'Public signer SHA-256: %s\n' "$TG_SIGNER_PIN"
test "$TG_SIGNER_PIN" = f6d3d70c8909d302f24c6853dfb82dad1ab7a2a2006221699002117b6a22c682
```

Expected: the printed value is exactly `f6d3d70c8909d302f24c6853dfb82dad1ab7a2a2006221699002117b6a22c682` and `test` exits 0. This reads only the public certificate. A mismatch means stop: the pinned bootstrap will reject that certificate. The encrypted private key stays exclusively yours, outside the bundle/repository. The initial creation command in [release-qualification.md](release-qualification.md) includes `req -new -x509`; it is not a repeat step now that your certificate is pinned.

## 5. Sign the candidate locally

```sh
/usr/bin/env -u NODE_OPTIONS -u NODE_PATH node "$TG_SOURCE/scripts/release/sign-candidate.mjs" \
  --candidate "$TG_BUNDLE" \
  --private-key "$TG_SIGNING_DIR/owner-signing-key.pem" \
  --certificate "$TG_SIGNING_DIR/owner-signing-certificate.pem" \
  --source-sha "$TG_SOURCE_SHA" \
  --manifest-sha256 fa15c6a2a19fd6563b637f25fe2d590852238a19b5d456c37070694fea4c386b
TG_SIGNER_PIN="$(/usr/bin/openssl x509 \
  -in "$TG_SIGNING_DIR/owner-signing-certificate.pem" -outform DER |
  /usr/bin/shasum -a 256 | /usr/bin/awk '{print $1}')"
printf 'Public signer SHA-256: %s\n' "$TG_SIGNER_PIN"
```

Expected: a hidden passphrase prompt, then JSON with `phase: "owner_signed"`, the frozen source SHA and manifest hash. `signer.der` and `manifest.sig` are added to the bundle. The printed public fingerprint must match `signer_sha256` in the signing result. The pin comes from your own locally created certificate; do not replace it with a fingerprint supplied by an unknown download. Do not rerun signing over an already signed directory; its exclusive writes intentionally reject that.

## 6. Verify without installing

```sh
/bin/sh "$TG_BOOTSTRAP" \
  "$TG_BUNDLE" "$TG_SOURCE_SHA" verify
```

Expected: exit 0 and JSON containing `phase: "candidate_verified"`, `version: "0.2.0"`, the frozen source SHA, `platform: "darwin"`, `architecture: "arm64"`, `node_version: "24.21.0"`, and `installed: false`. Verification creates only disposable private staging. It does not create a service or Telegram session.

## 7. Approve installation in your Terminal

This step changes system files and creates the separate `_tgmcp` service identity. Installed code/state are under `/Library/Application Support/TelegramMCPGateway`; the launchd definition is `/Library/LaunchDaemons/io.telegram-mcp-gateway.plist`. The service uses port 7777. Execute it only when you approve these concrete changes.

First put the exact reviewed verifier in the root-owned `/Library` location. If that path already exists from this same test, skip the copy only after confirming the ownership/mode/hash below; otherwise stop rather than adopt another file.

```sh
sudo /usr/bin/install -o root -g wheel -m 0555 \
  "$TG_BOOTSTRAP" "$TG_TRUSTED_VERIFIER"
test ! -L "$TG_TRUSTED_VERIFIER"
/usr/bin/stat -f '%u:%g:%Lp' "$TG_TRUSTED_VERIFIER"
/usr/bin/shasum -a 256 "$TG_TRUSTED_VERIFIER"
```

Expected: `0:0:555` and verifier SHA-256 `a38abb05090f89b79144ecd000730b1a6139948dfefa37fc177e10246d5fce59`. Do not execute it if either differs. `/Library` must be a normal protected system directory, not an owner/agent-writable replacement.

```sh
sudo /bin/sh "$TG_TRUSTED_VERIFIER" \
  "$TG_BUNDLE" "$TG_SOURCE_SHA" install
```

Expected: verified extraction metadata followed by JSON with `phase: "needs_api_credentials"`, `error_code: null`, and `service_started: false`. The owner command now exists:

```sh
ls -l '/Library/Application Support/TelegramMCPGateway/bin/tg-mcp-owner'
```

No Telegram login has happened yet. An error is not a completed installation: keep the same candidate and report only the step/error code.

## 8. Log in and connect the first client

Close the selected clients before changing their configuration. Keep agents/capture stopped. Obtain your own Telegram application credentials at [my.telegram.org/apps](https://my.telegram.org/apps); use the agreed controlled test account. Create a new session on this Mac, not a copy from Intel or another project.

Run **without `sudo`**:

```sh
'/Library/Application Support/TelegramMCPGateway/bin/tg-mcp-owner' setup
```

Enter these nonsecret answers when prompted:

| Prompt | First-test answer |
| --- | --- |
| `Type OWNER READY after completing those steps:` | `OWNER READY` |
| `Gateway account id:` | `test-arm` |
| `Gateway user id:` | `owner-arm` |
| `Clients (codex,claude,opencode,hermes; comma-separated; empty to skip):` | `codex` |

Then enter your application id/hash, phone in international format, verification code and optional 2FA password directly into the hidden terminal prompts. Do not send these values or client configuration files to chat. Sudo may ask for your Mac password. If a different gateway entry already exists, the launcher asks for `REPLACE`: choose it only if you approve replacing that one entry; otherwise cancel and review the conflict.

Expected: the command finishes without hanging, exits 0, and prints JSON with `error_code: null`, `sdk_connectivity_verified: true`, `model_tool_loading_verified: false`, and `clients: ["codex"]`. The result may retain `phase: "needs_service_start"` even after the coordinator has started and probed the service; use the SDK field and the next checks, not that phase label alone. A false SDK field or `owner_setup_failed` is a failed test.

## 9. Check the running service and actual client tools

```sh
sudo /bin/launchctl print system/io.telegram-mcp-gateway |
  /usr/bin/awk '/state =|pid =/ {print}'
/usr/bin/curl --fail --silent --show-error --max-time 5 http://127.0.0.1:7777/healthz
```

Expected: running state/PID and `{"ok":true}`. Health is liveness only: it does not prove Telegram login or MCP authentication. The launcher SDK result covers initialize/catalog/status; actual model loading is a separate check.

Reopen the configured Codex client in a fresh conversation and ask:

> Use the telegram_gateway MCP server's tg_status tool. Report the connected gateway account IDs and status. Do not read chats, send messages or print credentials.

Expected: an actual `tg_status` call through the configured local gateway and connected account `test-arm`. A prose answer without a tool call is not sufficient. If the tools do not appear, stop at client qualification and report that, rather than repeating Telegram login. Private chats and writes remain disabled. Do not use a write tool during this first test.

## 10. Record the result and test a same-candidate repeat

Record only: macOS/architecture, source SHA, manifest/public signer fingerprints, successful steps, selected client/version, actual tool-call result, and safe error codes. No secrets, sessions, client-profile contents or screenshots of hidden-input steps are needed.

If you closed Terminal, restore only the `TG_*` variable assignments from step 2. Do not rerun directory creation, key generation or signing over completed files.

Repeat the unelevated owner command with the same account/user/client answers. Expected: no new Telegram login, no token rotation, successful SDK check and return to the Terminal. If a step failed earlier, preserve the same bundle and private state; ask for a diagnosis before retrying uncertain operations. Do not delete the prefix, signing key or sessions. Stop agents/capture again whenever a repeat may request secret input.

Next qualification targets are Intel macOS, Ubuntu 24.04, Arch x64 and Windows 11 x64. They get their own exact bundles and fresh local sessions after this ARM test. Keep new-repository/open-source work deferred.

Download mechanism references: [GitHub artifact downloads](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/download-workflow-artifacts) and [GitHub CLI API](https://cli.github.com/manual/gh_api). The ZIP and script hashes in this guide were checked against the named private run/source on October 11, 2026; signing/privileged installation and real Telegram/client checks are still owner-run qualification.
