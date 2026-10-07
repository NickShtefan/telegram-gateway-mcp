# Public 0.2.0 staged delivery journal

Owner instructions on October 8, 2026 authorize implementation through public release under decisions 54-60. Current source base is `e3815b6e42cf82c2371356338445105e892986f7` on draft PR #21. This is a development journal, not a release/support claim.

## Protocol

Finish each stage's implementation and required checks, commit its review candidate and start one separate read-only review agent. Record reviewed SHA, evidence and severity. Correct every confirmed medium/high/critical finding, rerun affected checks and record the corrected SHA. No automatic second review round. Low findings are recorded; do not broaden scope for them by default. A stage with unresolved medium-or-higher findings is not complete.

Synthetic fixtures and local reversible work proceed autonomously. Real owner terminal input/elevation, Telegram writes, merge/release approval and deferred repository/npm onboarding remain separate gates. Never publish an unqualified build or turn a review timeout into approval.

## Stages

| Stage | Scope | Completion gate | Status |
| --- | --- | --- | --- |
| 1: decisions and terminal trust design | Record answers; replace unaccepted native/Apple/separate-login proposal; establish release/platform/client scope | Coherent owner policy and trust transitions; one review round; corrected findings and docs checks | In progress |
| 2: foundation and session ownership | Bring current setup into terminal/four-client model; fix session-lock restart race, keep legacy-owner exclusion; strict safe status/resume | Build/typecheck/tests, killed-holder and competing-recovery tests; one review round and required corrections | Pending |
| 3: authenticated no-Node bootstrap | Versioned signed manifest, verified standalone Node/installer, protected staging and safe application archive | Tamper/identity/size/path/interrupt probes; test signing fixtures; one review round | Pending |
| 4: platform isolation | macOS launchd, Linux systemd and native Windows service/identity/ACL adapters, safe commands/progress publication | Platform adapter failure tests; no agent-writable privileged inputs; one review round; live isolation evidence remains qualification work | Pending |
| 5: owner login and account access | Direct owner terminal steps, exclusive worker lifecycle, safe credentials/login/grants and pending token handoff | Fake Telegram secrecy/cancel/repeat tests; no session copying or token printing; one review round | Pending |
| 6: four client adapters and readiness | Codex Desktop, Claude Code, OpenCode, Hermes; config preservation, direct token delivery, truthful verification | Actual-version contracts, synthetic config/secrecy/conflict checks; one review round; actual model tools still qualification work | Pending |
| 7: candidate packaging, CI and public material | Version 0.2.0 metadata, license/provenance/notices, selected clean snapshot, required workflows, both guides | Build/package/matrix/audit checks; one review round; owner creates new private repo/npm access before dependent remote gates | Pending |
| 8: qualification and release | Fresh no-Node independent/agent entries on declared platforms; owner test login, client tools; new snapshot SHA and remote CI; exact approvals; GitHub/npm release | All declared environments proved, one review round and corrections, separate owner merge/release approval, anonymous published-artifact checks | Pending |

Stages extend issue #2 with required Linux (#14), native Windows (#15), four clients (#19), public acquisition (#20) and the accepted public roadmap. The narrower issue checklist is not silently declared complete. Safe updates/backups (#16), destructive uninstall (#18) and broader admin (#17) remain follow-ups, unless a defect makes the initial release unsafe.

The signed-manifest production trust anchor needs independent owner establishment before live privileged acquisition. Repository creation and npm access are intentionally deferred, not waived. Native Windows/Linux/minimum macOS/client support cannot be proved solely on the development Mac. Record unavailable environments/providers honestly and continue independent stages where possible.

## Stage evidence

Stage 1: decisions 54-60 and the terminal trust design replace the earlier proposal. No code/service/client change or real authentication is part of this design stage. Review candidate, report and corrected SHA are recorded after its one review round.

Prior unreviewed foundation: `e3815b6` passes build/typecheck and 773 tests (47 setup cases) on macOS arm64 / Node 24.10.0. Include it in stage 2 review; do not treat those tests as an independent review or live installation proof.
