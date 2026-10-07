# Public 0.2.0 staged delivery journal

Owner instructions on October 8, 2026 authorize implementation through public release under decisions 54-60. Current source base is `e3815b6e42cf82c2371356338445105e892986f7` on draft PR #21. This is a development journal, not a release/support claim.

## Protocol

Finish each stage's implementation and required checks, commit its review candidate and start one separate read-only review agent. Record reviewed SHA, evidence and severity. Correct every confirmed medium/high/critical finding, rerun affected checks and record the corrected SHA. No automatic second review round. Low findings are recorded; do not broaden scope for them by default. A stage with unresolved medium-or-higher findings is not complete.

Synthetic fixtures and local reversible work proceed autonomously. Real owner terminal input/elevation, Telegram writes, merge/release approval and deferred repository/npm onboarding remain separate gates. Never publish an unqualified build or turn a review timeout into approval.

The final stage has an explicit ordering exception: qualify the exact candidate, perform its single independent review before publication, fix findings and reverify, obtain the applicable exact owner merge/release approvals, publish, then run anonymous published-artifact checks. If merging changes the candidate SHA, reverify the actual merged commit and obtain release approval for that SHA. No tag, public visibility change, GitHub Release or npm publish precedes the review/corrections and owner release approval. A post-publication failure blocks release completion and requires an owner-approved remediation; do not silently change the released candidate or publish another version.

## Stages

| Stage | Scope | Completion gate | Status |
| --- | --- | --- | --- |
| 1: decisions and terminal trust design | Record answers; replace unaccepted native/Apple/separate-login proposal; establish release/platform/client scope | Coherent owner policy and trust transitions; one review round; corrected findings and docs checks | Complete |
| 2: foundation and session ownership | Bring current setup into terminal/four-client model; fix session-lock restart race, keep legacy-owner exclusion; strict safe status/resume | Build/typecheck/tests, killed-holder and competing-recovery tests; one review round and required corrections | Complete |
| 3: authenticated no-Node bootstrap | Versioned signed manifest, verified standalone Node/installer, protected staging and safe application archive | Tamper/identity/size/path/interrupt probes; test signing fixtures; one review round | In progress |
| 4: platform isolation | macOS launchd, Linux systemd and native Windows service/identity/ACL adapters, safe commands/progress publication | Platform adapter failure tests; no agent-writable privileged inputs; one review round; live isolation evidence remains qualification work | Pending |
| 5: owner login and account access | Direct owner terminal steps, exclusive worker lifecycle, safe credentials/login/grants and pending token handoff | Fake Telegram secrecy/cancel/repeat tests; no session copying or token printing; one review round | Pending |
| 6: four client adapters and readiness | Codex Desktop, Claude Code, OpenCode, Hermes; config preservation, direct token delivery, truthful verification | Actual-version contracts, synthetic config/secrecy/conflict checks; one review round; actual model tools still qualification work | Pending |
| 7: candidate packaging, CI and public material | Version 0.2.0 metadata, license/provenance/notices, selected clean snapshot, required workflows, both guides | Build/package/matrix/audit checks; one review round; owner creates new private repo/npm access before dependent remote gates | Pending |
| 8: qualification and release | Fresh no-Node independent/agent entries; owner test login/client tools; final snapshot SHA/CI; review and corrections before exact approvals/publication | Qualify candidate, review once, correct/reverify, obtain exact approvals, publish, then anonymous checks; post-publication failure requires approved remediation | Pending |

Stages extend issue #2 with required Linux (#14), native Windows (#15), four clients (#19), public acquisition (#20) and the accepted public roadmap. The narrower issue checklist is not silently declared complete. Safe updates/backups (#16), destructive uninstall (#18) and broader admin (#17) remain follow-ups, unless a defect makes the initial release unsafe.

The signed-manifest production trust anchor needs independent owner establishment before live privileged acquisition. Repository creation and npm access are intentionally deferred, not waived. Native Windows/Linux/minimum macOS/client support cannot be proved solely on the development Mac. Record unavailable environments/providers honestly and continue independent stages where possible.

## Stage evidence

Stage 1: decisions 54-60 and the terminal trust design replace the earlier proposal. No code/service/client change or real authentication is part of this design stage. Review candidate, report and corrected SHA are recorded after its one review round.

Stage 1 review: `/root/stage1_review` reviewed `fe902145911411a3449dbcec490493a32635d33e` once, read-only. One medium finding: the generic finish-checks-before-review rule put the final stage's review after publication. Corrected by explicitly requiring qualified-candidate review and corrections before approvals/publication; anonymous post-publication checks are last, and a failure requires owner-approved remediation. No high/critical/low findings. Documentation links/language, manifest and diff checks passed after correction; the reviewed source tree's build/typecheck/773 tests passed before this documentation-only correction. Corrected SHA: `adce0d16f3f0cab7db2b9c6d03b9164c4507c012`; no second independent round.

Prior unreviewed foundation: `e3815b6` passes build/typecheck and 773 tests (47 setup cases) on macOS arm64 / Node 24.10.0. Include it in stage 2 review; do not treat those tests as an independent review or live installation proof.

Stage 2 implementation: POSIX session ownership now uses a retained-inode kernel lease before compatibility-socket cleanup; still-running legacy socket-only daemons remain excluded. Setup uses the same primitive with a separate inode. New tests cover killed holders, four competing restarts, legacy exclusion, absent-socket ownership, idempotent release and unsafe inodes. The terminal owner action and four client identifiers replace the old unshipped GUI/Codex-only contract. Build/typecheck and 784 tests in 23 files pass on the development Mac. Linux helper execution and native Windows locking remain platform qualification work; no lab deployment or live Telegram client was used. One independent stage 2 review is pending.

Stage 2 review: `/root/stage2_review` reviewed `7380d40a1fabb677384fedd1f97ac35140262a1b` once, including the previously unreviewed setup foundation. Two medium findings: FIFO state could block read-only open/reconciliation, and stale socket reclamation could delete a regular/foreign object. Corrected all readers with pre-open regular-file checks plus O_NONBLOCK and retained descriptor validation; socket reclamation now requires owned socket type, a refused endpoint and unchanged inode, preserving unexpected objects. Added FIFO lease/journal/progress and regular/symlink/FIFO socket preservation regressions. No high/critical/low findings. Build/typecheck and 788 tests in 23 files pass after correction. No second review round, live Telegram, privilege installation or lab deployment.

Stage 2 corrected SHA: `fb4bd5e9bc227c8e786f46c4eec1cc13db07b25e`. Both medium findings are resolved by source changes and preservation regressions. Stage 3 starts from this corrected candidate.

Stage 3 implementation candidate: canonical pinned RSA-3072 signed manifests, authenticated exact runtime acquisition/catalog, bounded regular-file USTAR application archives, standalone verifier/extractor, POSIX no-Node verification/staging and PowerShell non-activating verification. Normal bundle building requires an exact clean source commit, 0.2.0 metadata and revalidated official runtime bytes; synthetic fixtures are explicit. Official Node 24.21.0 and 22.23.3 checksum signatures were verified against the pinned official release keyring. Both arm64 binaries ran the development-Mac suite (821 tests). PowerShell/native Windows execution and initial production trust/elevation/provisioning remain explicit later gates.

Minimum-macOS compatibility discovery: Apple lockf FD-only CLI was added after the older source branch, so stage 3 replaces that dependency with a tiny universal C helper targeting macOS 13.0. It is compiled for developers and bundled for users; no target compiler or paid Apple membership is required. Kernel tests pass against the bundled helper on the current Mac. This is not live macOS 13/Intel proof. Stage 3's one independent review includes the helper change.
