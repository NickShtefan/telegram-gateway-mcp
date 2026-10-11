# Installer delivery status

## Implemented

- Owner-pinned certificate trust; signed manifests and authenticated standalone Node.
- User-facing tar.gz/ZIP archives; bootstrap source identity derives from the verified manifest.
- Protected macOS/Linux service identities and native Windows virtual-account/ACL provisioning.
- Native Windows exports and media: run-time ACL and reparse-point attestation of the shared files directories, once per process and directory, with link-safe file creation and reads.
- Ordinary-user wizard with label defaults, API instructions, hidden input and safe next steps.
- Optional Codex, Claude Code, OpenCode and Hermes adapters; direct private token handoff and SDK checks.
- One-command owner draft preparation: successful frozen CI evidence, all five manifest/payload checks, one hidden signing passphrase, platform archives/SHA256SUMS and draft-only GitHub Release.
- README installation path and separate platform/README-only test checklists.

The gateway remains pure MCP. No model execution, watcher, approval bot or administrative MCP API is added. Private chats/writes are disabled by default. The private signing key remains owner-only and outside agent/CI/bundles.

## Verification boundary

Source tests use fake Telegram and disposable keys. They cover multi-candidate signing and recheck-after-input, archive boundaries/tampering, no-Node bootstrap parsing, service/lease ownership, private lifecycle, input cancellation, client configuration preservation and SDK probes. Hosted full tests run on Ubuntu, macOS and Windows, with platform-specific/root-only cases recorded as skips where appropriate. The real Windows files-directory ACL check runs only on the hosted Windows runner against synthetic temporary trees.

Files-directory behavior under the provisioned Windows service identity is not yet verified. Actual owner signing/draft creation and README-only trials in fresh macOS/Windows users have not been executed by this agent. Production key/certificate files are not inspected. Live installation/login/client and controlled write evidence remain owner-run. See [acceptance sheet](outsider-test.md), [owner draft command](release-qualification.md) and platform checklists.

New repository creation, visibility changes, npm and publication are deferred. PR #21 remains unmerged pending exact owner approval. A draft is not anonymously available; no public release/support claim follows from source tests.
