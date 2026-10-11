# Owner qualification and release checklist

Source tests and candidate construction are complete independently of this checklist. A passing hosted runner is not a fresh installation or a real Telegram/client qualification. Keep the existing Intel lab gateway untouched until a specific installation/migration action is approved. Never copy sessions between machines.

## Test first in the existing private repository

Decision 68 prioritizes owner installation and client testing before new-repository or open-source work. Use an unsigned CI candidate from the current private PR, freeze its exact source SHA, then sign it locally before installation. New repository creation, clean import and npm access do not block this test phase. PR #21 is ready for review/testing; merging remains a separate owner decision. Keep the same candidate identity across cancellation/resume checks.

When the owner later resumes publication, rebuild and verify the actual clean-import/release SHA. Results from the private candidate remain evidence for that candidate rather than automatic qualification of a different signed artifact.

For the first actual ARM Mac run, use [mac-arm-private-test.md](mac-arm-private-test.md), which supplies the frozen download, hashes, commands and expected outcomes.

## Evidence matrix

Record one evidence row per actual candidate and environment. Do not include passwords, Telegram application hashes, codes, bearer tokens, session contents, profile contents or private keys.

| Target | Required evidence | Current live result |
| --- | --- | --- |
| macOS 26.6.2 arm64, owner development Mac | Exact signed bundle; protected service; fresh local session; selected client model tools | Pending |
| macOS 15.7.9 x64, owner Intel Mac | Exact signed bundle; explicit existing-gateway coexistence/migration decision; separate local session | Pending |
| Ubuntu 24.04 LTS x64 | Fresh environment without Node/npm; official prerequisite consent; systemd isolation; local session/client | Pending |
| Ubuntu 24.04 LTS arm64 | Same qualification on arm64 if claiming that architecture | Pending |
| Fully updated Arch Linux x64 | Record snapshot date and package versions; no AUR/full-upgrade transaction; isolation/login/client | Pending |
| Windows 11 x64, owner Intel machine | Native no-Node bootstrap; protected ACL/virtual service identity; bounded extraction; local session/client | Pending |

macOS 13 remains a designed floor and explicitly unqualified until tested. Extra macOS 13 hardware is not a release blocker. Other Windows versions/architectures, WSL, Arch ARM/derivatives and other distributions are unqualified.

For each row record OS build/architecture, source commit, manifest SHA-256, public signer DER SHA-256, Node version, chosen client versions, date, checks performed and safe failure codes. Mark a client/OS combination qualified only after that actual model has loaded the catalog and used a controlled read tool. SDK initialize/catalog/status alone does not establish model-tool availability.

## Local owner signing

Create the production key only in an ordinary owner terminal with agents/capture stopped. Do not run the following through an agent, CI or shared shell transcript. Store the private directory outside the checkout, backup it privately and never send its key/passphrase to chat. This is a custom release signature and does not require paid Apple membership or notarization.

```sh
umask 077
mkdir "$HOME/tg-mcp-signing"
cd "$HOME/tg-mcp-signing"
/usr/bin/openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:3072 \
  -aes-256-cbc -out owner-signing-key.pem
/usr/bin/openssl req -new -x509 -key owner-signing-key.pem -sha256 -days 3650 \
  -out owner-signing-certificate.pem -subj '/CN=Telegram MCP Gateway Owner Release Signing'
chmod 600 owner-signing-key.pem
```

OpenSSL asks for the encryption passphrase directly. Keep the encrypted PKCS#8 `BEGIN ENCRYPTED PRIVATE KEY` format; do not remove encryption. The certificate is public. Establish its DER SHA-256 independently before installation. No OS publisher/CA trust is implied.

From the reviewed source checkout, after approving the exact source and manifest hashes, sign an unsigned candidate using the owner-only helper:

```sh
node scripts/release/sign-candidate.mjs \
  --candidate /absolute/private/unsigned-candidate \
  --private-key "$HOME/tg-mcp-signing/owner-signing-key.pem" \
  --certificate "$HOME/tg-mcp-signing/owner-signing-certificate.pem" \
  --source-sha EXACT_SOURCE_SHA --manifest-sha256 EXACT_MANIFEST_SHA256
```

The helper prompts for the passphrase without display, verifies candidate files before/after input and creates only the public certificate/signature alongside them. Share only these public artifacts and safe hashes when needed. Independently authenticate the verifier itself before privilege elevation as described in `install-owner.md`.

## Per-environment checks

1. Verify the approved candidate without installation. Reject a wrong signer/source/platform and tampered copy before staged execution. Use copies for negative probes.
2. Approve the concrete system installation in the owner terminal. If prerequisites are missing, inspect the entire isolated official-source transaction and confirm separately. Cancellation must leave gateway provisioning unstarted.
3. Confirm separate service identity and immutable executable tree; ordinary owner/agent cannot read protected session/key/state or replace executable code. Check service registration and safe status without exposing private files.
4. Stop agents/capture. Run owner setup from the ordinary terminal, enter the machine's fresh Telegram login directly and select clients. Test cancellation and same-candidate resumption without duplicate MTProto ownership or silent token rotation.
5. Verify the service owns the expected listener, then SDK connectivity. Restart each selected client and use the same controlled read-only prompt from `scenarios.md` through Codex, Claude Code, OpenCode and Hermes where qualification is claimed.
6. Qualify writes only if separately authorized for the owner test account/channel: preview, explicit owner consent, then confirm once. Do not repeat uncertain writes. Default managed installation keeps writes disabled.
7. Record result/failure code and the exact artifact identity. Investigate failures while retaining private state. Updates/backups/destructive uninstall are separate follow-ups.

## Publication gates

The owner deferred creation of the new clean private repository and npm access. Neither is waived. Build a file-only selected snapshot with provenance, let the owner create its destination, then verify its new source commit and required CI. The private source commit and clean-import commit are different identities: rebuild/sign the final public candidate for its actual commit.

Stage 8 receives its one independent review after qualification, before any merge/tag/publication. Correct medium-or-higher findings and reverify without another review round. Obtain explicit owner approval for merge and for the exact final release commit. Only then create the release/tag, change visibility or publish npm as authorized. Finally verify anonymous retrieval, checksums/signatures, installation documentation and package contents. A post-publication failure requires owner-approved remediation and does not count as release completion.
