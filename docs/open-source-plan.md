# tg-mcp open-source preparation plan

Prepared October 5, 2026; updated with subsequent owner decisions.

Goal: publish source code that lets an external user understand the gateway's limits, install a verified version with their own credentials, and contribute through a clear process. Before publication, audit the selected snapshot and new repository materials, apply MIT, prepare installation, and prove release behavior.

The publication method, license, copyright line, name, npm distribution, package name, repository owner and address, cleanup and transfer order, target platforms, Node policy, English-only repository language, the PR/merge policy, maintenance commitment, private vulnerability channel, contribution terms, release approval workflow, conduct rules, and public CLI command have been selected. The owner concluded the initial question review on October 6, 2026. Deferred choices and preparation follow-ups are recorded in [open-questions.md](open-questions.md). Repository-wide language cleanup is complete and locally verified; see [plan.md](plan.md). General code cleanup, snapshot audit, license files, and publication remain ahead.

## Baseline

Verified at `e297ee2adb9d7afc47968c000d3f8781797c1d64` on `main` and GitHub on October 5, 2026. This is the plan's baseline, not a release candidate.

| Area | Baseline evidence | Remaining work |
|---|---|---|
| Repository | `NickShtefan/telegram-gateway-mcp` is private; default branch `main` | Prepare a clean snapshot for a new repository; audit everything that will become public |
| License | No `LICENSE` or package `license` field; GitHub detects no license | Apply the selected MIT license and copyright holder after rights and dependency review |
| Build | Build, typecheck, and 694 tests in 21 files pass on Node 24.10.0 | Clean installation and checks on declared Node versions and platforms |
| GitHub checks | No tracked `.github` files; GitHub API lists 0 workflows | CI, secret checks, external PR rules |
| Installation | Node `>=22.13`, `private: true`; macOS installer requires `GH_TOKEN` and the current repository address | Public installation without private GitHub access |
| Configuration and contributions | No `.env.example`, `CONTRIBUTING.md`, `SECURITY.md`, or `CHANGELOG.md` | Safe examples, maintenance rules, first release notes |
| Data and history | `.gitignore` excludes `.env`, sessions, SQLite, exports; `session.key` has no dedicated exclusion; 49 commits and two branches available locally | Audit snapshot files; do not transfer old commits or private GitHub material |
| User documentation | Detailed documentation initially in Russian; installation and examples tied to the lab | English-only repository under decision 43; general instructions without personal infrastructure |
| MCP and live Telegram | 23 tools; [plan.md](plan.md) distinguishes complete and partial verification | The same scenarios in three required clients; close live-verification gaps |

Secrets and personal data in the selected snapshot, rights to all code, and transitive dependencies have not been audited. Preparing the plan did not verify or modify the installed daemon.

## Accepted decisions

On October 5 the owner selected a clean new repository without the current private history. Further development moves there; the existing repository remains private (decision 33).

The public project uses standard MIT (decision 34). The copyright line agreed on October 6 is `Copyright (c) 2026 NickShtefan`. Choosing MIT does not replace provenance review or creating `LICENSE`.

English is the only repository language, with no Russian edition (decision 43). This includes documentation, comments, CLI and tool text, test descriptions and examples, scripts, and agent instructions. Communication with the owner remains in Russian. Preserve behavior, provenance, technical constraints, and Unicode coverage while translating.

The new repository's development uses PRs with successful required checks and owner-approved merges (decision 44), including owner/agent changes. This explicitly replaces decision 19's direct-push workflow there after the initial snapshot import. Current private preparation retains decision 19. CI and branch protection still need implementation and verification.

Maintenance is voluntary, as the owner's time and capacity allow, without guaranteed reply or fix deadlines (decision 45). State this in the future public README and contribution/security documentation; do not promise a response or remediation SLA.

Use GitHub private vulnerability reporting for the new repository (decision 46). Prepare `SECURITY.md` with this channel and activate and verify the reporting form when the repository becomes public. [GitHub documentation](https://docs.github.com/en/code-security/how-tos/report-and-fix-vulnerabilities/report-privately) confirms that the feature requires a public repository and explicit enablement; a security policy file alone does not activate it.

Accept external contributions under MIT with the PR author's confirmation that they have the right to submit the contribution under that license (decision 47). No separate CLA or mandatory DCO sign-off is required. Implement this in `CONTRIBUTING.md` and the PR template; provenance review and required third-party notices remain part of preparation and review.

Prepare a verified candidate commit, version metadata, and release notes; obtain separate owner approval for the exact SHA and version, then create the version tag, GitHub Release, and npm package from that same commit (decision 48). Document and implement the publishing mechanism during preparation. The first public version and stability designation, publishing account, and authentication remain unresolved.

Use a concise Code of Conduct: respectful communication, no insults, harassment, or spam, and owner moderation (decision 49). Prepare the public English `CODE_OF_CONDUCT.md` and link it from the contribution guide.

Retain `tg-mcp` as the public CLI command while the package and repository use `telegram-mcp-gateway` (decision 50). Preserve the existing bin entry and verify the command through clean installation of the public package. State-directory and environment-variable names are not changed by this decision.

## Scope

Preserve pure MCP, the pinned teleproto version, SQLite with new migrations, one process per session, and preview followed by `tg_confirm` for writes. Publication preparation does not justify adding watchers, models, schedulers, Bot API integration, or bridges to other projects.

The first release includes source in the new repository and an npm package (decisions 33 and 36). macOS and Linux are selected; Windows is desired (decision 40), with native execution and testing on the owner's computer (decision 41). MCP registries, Docker, and new tools can be considered separately. Claim platform or client support only after verification.

### Windows inspection, October 6, 2026

Agents are available on Windows: [Codex](https://learn.chatgpt.com/docs/windows/windows-app#native-sandbox) and [Claude Code](https://code.claude.com/docs/en/setup#set-up-on-windows) support native execution and WSL; [OpenCode](https://opencode.ai/docs/windows-wsl) supports native execution and recommends WSL. These sources establish client availability; connecting them to this gateway still needs verification.

Current native Windows adaptation points: `scripts/lab-install.sh` uses macOS and launchd; `src/core/lock.ts` uses a Unix socket file; `src/core/safeFs.ts` checks Unix permissions and ownership. [Node IPC](https://nodejs.org/docs/latest-v22.x/api/net.html#ipc-support) uses named pipes on Windows; [chmod](https://nodejs.org/docs/latest-v22.x/api/fs.html#fschmodpath-mode-callback) does not implement owner/group/other permission separation there. Adaptation must preserve one process per session and the selected isolation model. It has not been implemented; Linux and Windows have not been tested during preparation.

The owner selected native Windows and offered a Windows computer for testing (decision 41). Verify the prepared candidate there, recording Windows version, architecture, Node, installation, and gateway results. WSL runs the Linux version; record its actual verification status separately.

## 1 Owner decisions

**Deliverable:** agreed first-release scope and decisions in `decisions.md`, explicitly revising decisions 14 and 19 if needed.

The owner concluded the initial one-by-one question review on October 6, 2026. Decisions 33 through 50 record the selected policy. The following items carry into preparation; do not continue the initial questionnaire by default or treat closure as selecting the previously deferred version or installation proposals.

Decisions 33 through 50 select the publication method, MIT, copyright line, naming, npm publication, package name, repository owner and address, cleanup and transfer order, platforms, native Windows, Node policy, repository language, PR/merge rules, voluntary maintenance without guaranteed deadlines, GitHub private vulnerability reporting, MIT contributions with a PR rights confirmation without mandatory CLA or DCO, owner-approved releases from a verified commit, concise conduct rules with owner moderation, and the public CLI command. Repository: `NickShtefan/telegram-mcp-gateway`; npm package: `telegram-mcp-gateway`; CLI: `tg-mcp`; public title: `Unofficial Telegram MCP Gateway`. Clean the current repository, transfer a vetted snapshot to the new private repository, verify the release, then open access. Remaining matters:

- **npm account and execution.** The account is unconfirmed: on October 6 the owner said they probably do not have one. Verify/recover an existing account or register a new one before publishing, and record the package owner's username. The owner deferred the installation model on October 6 because frequent `sudo` use would be inconvenient, then selected an isolated service with convenient management on October 7 (decision 51). Define setup, routine administration and update privilege points for that model; the interface and authorization mechanism remain design work. Current lab decisions 17 and 22 remain in force; revise them explicitly if their scope changes. Decision 50 retains the `tg-mcp` CLI command; use `telegram-mcp-gateway` as the npm package name.
- **First public version.** On October 6, the owner deferred choosing the first public version and stability designation. The proposed `0.1.0` is not accepted; the current private package version does not select the public version. Resolve this before release-candidate verification and publication under decision 48. Other preparation can continue.
- **Supported environments.** macOS and Linux are selected, native Windows desired, and an owner's computer is available for testing. Decision 42 recommends Node 24 LTS and supports Node 22 from 22.13; a newer recommended LTS is allowed after gateway verification. On October 6, 24 is the latest LTS; 26 is Current, with LTS scheduled for October 28. Sources: [Node statuses](https://nodejs.org/en/about/previous-releases), [schedule](https://github.com/nodejs/Release/blob/main/schedule.json). Recheck LTS status during release preparation, establish OS/client versions, and record exact Node versions. Prove the final matrix; agree Windows status with the owner if blockers remain.
- **Contributions and maintenance.** Decision 44 requires PRs with successful checks and owner-approved merges for all development in the new repository. Configure and verify required checks and `main` protection. Decision 45 selects voluntary maintenance without guaranteed reply or fix deadlines, decision 46 selects GitHub private vulnerability reporting, and decision 47 defines MIT contributions with a PR rights confirmation without mandatory CLA or DCO. Decision 48 selects separate owner approval before publishing the tag, GitHub Release, and npm package from the same verified commit. Decision 49 selects concise conduct rules with owner moderation. Prepare the public policy files, publishing mechanism, and authentication, and agree the first public version and stability designation.

Separately agree documented Telegram data scenarios. The [Content Licensing Terms](https://telegram.org/tos/content-licensing) restrict AI use and describe exceptions involving explicit, informed, continuing consent from all relevant users, limited to specific content and context. Public channels, personal use, and low volume are not named substitutes for that consent.

For each public scenario, identify the data the agent receives, whose consent is required, and how its scope is respected. Owning a channel does not establish consent from every comment author. Initial demonstrations use synthetic data and controlled test chats with appropriate participant consent. Review the [API Terms](https://core.telegram.org/api/terms) for applicability: action consent, own `api_id`, app naming and presentation, and sponsored messages when accessing channels. Source licensing does not itself authorize use of other people's content.

**Review status:** the initial owner review is complete, with licensing, publication, contribution, maintenance, and release policies recorded. Resolve deferred choices during their preparation stages. Verify Telegram terms and applicability before adopting public scenarios; associated claims and demonstrations remain subject to that review.

## 2 Current repository cleanup and snapshot audit

**Deliverable:** cleaned code, a transfer manifest, and a report describing coverage, data classes found, remediation, and limitations. Never include secret values.

1. Record the pre-cleanup SHA and inventory files. Remove obsolete drafts, duplicates, temporary artifacts, and demonstrably unused code. Check references from code, builds, CLI, tests, and documentation; one missing import is insufficient evidence. List removed paths and reasons. Preserve working features, necessary tests, provenance, and mandatory notices. Translate all repository text into English under decision 43, including comments, examples, scripts, and tests; preserve meaningful Unicode coverage. Verify build and tests after changes. User data and account state are outside cleanup.
2. Record the post-cleanup source SHA and an explicit allowed-file manifest. Prepare a separate directory without the old `.git`, gateway state, client configuration, local data, or run outputs. Do not transfer old branches, tags, PR refs, or private GitHub materials.
3. Scan every snapshot file for secrets with values redacted in results. Add Telegram API hash, bearer-token, session-string, and encryption-key rules; complement scanning with manual documentation and fixture review. After the initial commit, verify no parents and no old commits in the new history.
4. Check phone numbers, real names/usernames, personal links/invites, chat IDs, host addresses, owner paths, and other project data. Distinguish public maintainer contacts, explicitly authorized examples, and other people's personal data.
5. Audit the new description, release, attachments, and CI logs before publication. Treat any transferred issue/document material as new public material. The chosen publication method does not require auditing or rewriting the entire private history; provenance remains part of stage 3.
6. Extend exclusions for `session.key`, gateway state, logs, and backups. Check the future release archive against an allowed-file manifest: no Telegram state, client configurations, or live-run output.
7. If an active secret is found, remove it from the unpublished snapshot and assess prior exposure and revocation separately. The owner terminates MTProto sessions and logs in again on the appropriate machine. If a secret entered a new commit, do not publish that history: prepare and recheck a corrected initial commit. Do not rewrite the old private history or force-push without separate authorization.

**Completion:** cleanup is justified by an explicit change list, build/tests pass, all selected publication materials are checked, confirmed leaks and necessary revocations are resolved, and rescanning is clean. Do not describe partial coverage as proof of no secrets. No Russian text remains in repository files; a Cyrillic scan and manual review support that claim.

## 3 License and provenance

**Deliverable:** `LICENSE`, agreed package metadata, and mandatory third-party notices.

- Verify authorship and rights for code, documentation, borrowed fragments, test data, and future images. Obtain rights-holder permission where needed.
- Check exact direct/transitive versions, actual license files, and required notices. The lock file currently labels teleproto, MCP SDK, and zod as MIT, big-integer as Unlicense; this is a starting point, not a full compatibility audit.
- Add the unmodified license text, correct copyright holder, and package `license`, `repository`, `homepage`, and `bugs` fields. Include `NOTICE` or a third-party license inventory where required by licenses and distribution contents.
- Implement decision 47's contribution terms: MIT with a PR rights confirmation, without mandatory CLA or DCO. Do not add use-field restrictions to standard open-source licensing; document Telegram and project rules separately.

**Completion:** provenance is verified, the owner selected the license, and all mandatory notices are included in source and distributed artifacts.

## 4 External installation and documentation

**Deliverable:** someone without lab access completes installation using the published instructions.

The owner requested that this workstream take priority on October 7, 2026, before installing the gateway on the main Mac. The [installation redesign plan](installation-plan.md) records the inspected implementation, concrete gaps, proposed user journey, implementation sequence and acceptance checks. Source inspection is complete. The owner selected a separate service with convenient management (decision 51); the owner interface and authorization mechanism remain design work.

Decision 52 selects a prompt-to-agent installation entry and installer-managed Node prerequisites. The design includes protected human participation for system approval and Telegram login, secret-safe progress/resume, token transfer without agent-visible stdout and verification after client reload. See the installation plan for the proposed contract and remaining implementation work.

Decision 53 requires the same installer to support complete independent installation. A human wizard and agent-facing progress share one implementation, protections and defaults. Installation itself requires no agent, model provider credentials or AI subscription; gateway readiness and model-client verification remain separate. Prepare and verify both public instruction paths.

### Installation ergonomics: model selected October 7, 2026

The owner wants further consideration of repeated `sudo` use. Review of [deploy.md](deploy.md) and [lab-install.sh](../scripts/lab-install.sh) confirms that the agent's stdio command runs as its caller, while `tg-mcp-admin` requires root and switches to the service user. Ordinary HTTP/stdio MCP calls do not require `sudo`; installation, updates, login, user/account administration, scopes, and doctor do in the existing lab workflow.

The following comparison led to decision 51 on October 7: prepare an isolated service with convenient owner management. The interface and privilege path are not implemented or verified across platforms.

| Candidate | Routine experience | Protection and unresolved work |
|---|---|---|
| Existing isolated lab model | MCP calls without `sudo`; installation, updates, and owner administration require it | Separate session owner and protected code/Node. Existing macOS procedure; general Linux/Windows installation remains unverified |
| Isolated daemon with an owner administration interface | Aim to remove repeated `sudo` for routine owner administration; initial setup and protected updates need a separately designed privilege path | Requires owner authorization unavailable to the agent, restricted admin operations, and protection of sessions, code, and runtime. Not implemented; platform feasibility and update procedure require proof |
| Same OS user for daemon and agent | Local development startup is available without switching to a service user | Does not provide decision 17's separation when the agent can access session keys or modify daemon code/Node. Public support and positioning remain owner choices |

For the selected isolated model, define owner actions and privilege prompts for setup, login, permissions, diagnosis, updates, and recovery on each target system. A new admin interface must preserve one process per session and keep administrative authority separate from agent MCP tokens. No implementation or lab-policy change was made during this review.

### Preparation work

- Rewrite README around gateway purpose, tools, platforms, installation, limits, and licensing. Separate private lab deployment from the general guide; remove personal details external users do not need. Use English only, without a parallel Russian edition (decision 43).
- Add `.env.example` with empty secret fields and safe defaults. Explain obtaining own API credentials, independent login on every machine, state storage, and issuing an MCP token. Never suggest borrowing sessions.
- Prepare the npm package with built code and the `tg-mcp` bin entry under decision 50, versioned installation without mandatory `GH_TOKEN`, and public metadata. Remove `private: true` during release preparation; retain protection in the current private package for now. Keep private installation working until publication. Preserve decision 22's isolation, linking the exact package version to a verified source SHA. Verify installer changes separately: the installer executes as root.
- Explain ordinary clone execution and isolated execution. If the agent can execute as the daemon user or modify its code/Node, session encryption does not provide decision 17's isolation. Preserve protected installation and updating.
- Prepare macOS, Linux, and native Windows installation, including PowerShell instructions. Check single-process ownership, paths, key/session protection, safe file operations, and daemon restart. Adapt Unix-dependent code and verify actual access rights on native Windows; disabling checks is not a valid port.
- Provide generic HTTP and stdio configurations for Claude Code, Codex, and OpenCode; describe Hermes with its actual verification status. Tokens in examples are placeholders only.
- Put access and confirmation limits near the start of README. `write` is off by default; `tg_confirm` must prompt in the client; the server does not attest human consent. Untrusted-text labels reduce prompt-injection risk without guaranteeing agent protection.
- Explain SQLite data, audit, index, exports, retention, and deletion. Model-side handling depends on the selected client/provider after data is passed to it. Explain updates, backups, and recovery with irreversible migrations in mind.
- Adapt public `use-cases.md` and `scenarios.md` examples to stage 1's agreed terms. Remove any promises of safe bulk automation or immunity from Telegram limits if found.

**Completion:** installation and connection work without owner-specific files, public source acquisition is prepared, README claims match evidence, and installation preserves session ownership and isolation. Check anonymous GitHub download immediately after opening access in stage 7.

## 5 Automated checks and external contributions

**Deliverable:** verifiable PRs and clear maintainer rules.

- Add CI: `npm ci --ignore-scripts`, `npm run build`, `npm run typecheck`, `npm test`. The minimum Node must match `engines`; the matrix includes macOS, Linux, and native Windows under decisions 40 and 41. Verify SQLite/FTS5 behavior, not just compilation. Test clean package installation and execution in every declared environment; establish Windows status through its own run.
- Under decision 42, test Node 22.13, the latest 22 update, and the latest update of the recommended LTS (currently 24). If a newer LTS exists during preparation, run the same matrix before changing the recommendation. Record exact Node versions and results in the candidate report.
- Add secret and dependency checks with a clear process for findings. Do not automatically update teleproto: review changes and perform live verification under decision 26.
- Check `npm pack --dry-run`, then the actual tarball: only required files, working `tg-mcp` CLI under decision 50 and imports, clean JSON-RPC stdout. Install the tarball in a clean environment without the original checkout or private GitHub access, and verify that installation provides the `tg-mcp` command.
- Review user/account isolation, scope revocation, repeated confirmation, restart during a write, FLOOD_WAIT, deadlines, session locking, and safe-file tests. Add tests only for real gaps and changes.
- Add `CONTRIBUTING.md`, `SECURITY.md`, `CODE_OF_CONDUCT.md`, issue/PR templates, and a changelog in English. Document decision 46's GitHub private vulnerability channel, supported versions, and the prohibition on submitting secrets, sessions, or private chat content. Prepare the instructions before opening access; enable and verify the form in stage 7. Document decision 45's voluntary maintenance without guaranteed reply or fix deadlines. Implement decision 47's MIT contribution terms and PR rights confirmation without mandatory CLA or DCO. Implement decision 49's concise conduct rules with owner moderation and link the policy from the contribution guide.
- Implement decision 44: require PRs and successful checks on the new repository's `main`, with owner approval before merging. This applies to owner, agent, and external changes after the initial snapshot import; direct development pushes are excluded. Decision 19 remains in force for current private preparation. External PR workflows must not receive Telegram sessions, publishing secrets, or privileged access. Do not run untrusted code on the lab machine. Release execution is separate from PR checking.
- Prepare decision 48's release procedure: candidate version metadata, release notes, relevant checks, separate owner approval of the exact SHA and version, and publication from that commit. Keep publishing authentication separate from external PR checks and preserve the approval requirement in the selected execution mechanism.

**Completion:** CI passes the agreed matrix, external PRs cannot access secrets, and contribution/security requirements are clear. Verify actual `main` protection settings.

## 6 Release candidate verification

**Deliverable:** one exact SHA report, with independent code, installation, and client evidence.

1. Create an initial commit in a separate local repository without old history. Repeat clean installation, build, typecheck, tests, and CI at that new SHA. Record new SHA, Node versions, platforms, artifact contents, and checksum; record the private source SHA separately. The commit hashes differ; snapshot contents prove correspondence.

   Remote CI needs the new repository created by the owner. Under the private-preparation model, transfer the initial commit there for checks before opening access. Until then, only local checks are proven; GitHub CI remains unverified.
2. Before opening access, install a verified local archive of that SHA in a clean environment and complete the remaining public guide. Explicitly record that anonymous source acquisition is still unverified and will be checked in stage 7. The test-account owner enters login code/2FA themselves, creating a new session on that machine. Verify start, restart, no second client, file rights, updates, and recovery after a failed update. Do not copy sessions or roll back the database schema.

   On the owner's Windows computer, install and run CLI/daemon natively from PowerShell. Check MCP connection, second-process rejection, restart, and actual key/session access rights. Record Windows version, architecture, Node, SHA, and results; WSL runs count as Linux-environment checks.
3. Run the same prepared `scenarios.md` prompt through `claude -p`, `codex exec`, and `opencode run`. Compare tool calls, access, and confirmation order; identical model prose is unnecessary. Save sanitized evidence for every promised scenario. Resolve the lab's missing OpenCode model provider recorded in `plan.md` before claiming completion.
4. Verify live writes only on the owner's channel/test account, with preview and consent before `tg_confirm`. Close `plan.md` gaps: `send_as`, reaction removal, `reply_to`, `link_preview`, successful callback, and rejection after a button changes. If an action remains incompletely verified, limit its declared status or defer support claims.
5. Use synthetic data and authorized test chats for public demos. Never include sessions, tokens, phone numbers, or private chats in recordings, reports, or releases.

**Completion:** no unresolved blocking failures, every declared client passes the required scenario, and each feature is verified or accurately limited. Green Telegram-double tests do not prove installation or live behavior.

## 7 Open access and first release

**Deliverable:** a public repository and npm version corresponding to the verified candidate.

- Prepare the owner's npm account: verify existing access or create an account, choose username/public-contact email, and verify email. Configure 2FA for interactive publishing; decide automated publishing authentication with the workflow. Record public account information only. An account is unnecessary for code cleanup and local packaging. Sources: [npm account setup](https://docs.npmjs.com/creating-a-new-npm-user-account/), [publishing authentication](https://docs.npmjs.com/requiring-2fa-for-package-publishing-and-settings-modification/).
- Prepare a concise owner approval package under decision 48: exact SHA, version, license, audit report, CI/live results, supported environments, installation guide, and release notes. The verified candidate must already contain the selected version metadata. Obtain separate owner approval for release publication.
- Recheck initial-commit files, repository description, and artifacts immediately before publication: new sensitive material may have appeared after the audit.
- Under decision 39, the owner creates the repository privately before remote CI. After accepting stage 6's report and approving publication under decision 48, open access to the verified candidate without old branches, tags, or private history; create the version tag and GitHub Release at the approved new SHA. Do not call the existing `0.1.0` stable without a separate decision.
- Publish the package from that same approved new-repository commit under its agreed name and version (decision 48). Link version and contents to the source SHA; check anonymous installation of that exact published version and CLI execution. Never share publishing credentials with external PR checks.
- Continue development in the new repository after transfer. Update links/installer; keep the old repository private and do not introduce automatic synchronization of both histories.
- Immediately check anonymous clone/installation without a GitHub token, links, license, release contents, branch protection, and absence of personal data.
- Enable issues and GitHub private vulnerability reporting under decision 46 when opening the new repository. Verify that `Report a vulnerability` is available and that `SECURITY.md` points to the private form. MCP catalogs remain a separate step with an owner-selected name and verified build if needed.

Making a repository private again does not revoke downloaded copies or public forks ([GitHub documentation](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/managing-repository-settings/setting-repository-visibility)). If a leak is found after publication, revoke secrets and stop the source first, then remove material and notify affected users through an agreed process.

**Completion:** the verified SHA and corresponding npm package are published; a new user installs the published version without private access; licensing and the contribution process work.

## Sequence and responsibility

| Stage | Dependencies | Responsibility |
|---|---|---|
| 1 Owner decisions | Baseline review | Owner chooses; agent prepares options and evidence |
| 2 Cleanup and audit | Decision 39's sequence | Agent cleans/audits; owner decides secret revocation |
| 3 Licensing | Owner selection and provenance | Agent prepares; owner confirms rights and license |
| 4 Installation and docs | Names, environments, acceptable scenarios | Agent prepares/verifies; owner performs sudo/login |
| 5 CI and contributions | Matrix/maintenance policy; new private repo for remote checks | Agent prepares; owner creates repository under decision 39 |
| 6 Candidate | Stages 2, 3, 4, 5 complete | Agent verifies exact SHA; owner confirms live writes |
| 7 Publication | Stage 6 report accepted | Open access and publish npm within agreed scope |

After stage 1, audit, licensing, docs, and CI can progress independently where dependencies are closed. Changes after candidate verification require repeating affected checks at the new SHA.

## Publication gates

- [x] Initial owner question review concluded; decisions 33 through 50 recorded.
- [ ] Deferred first-release choices resolved during preparation; any revisions to decisions 14, 17, 19, and 22 explicit.
- [ ] Current repository cleaned before transfer; removed paths/reasons listed; build/tests prove behavior.
- [x] English-only repository content under decision 43; no Russian edition or remaining Russian prose in tracked files.
- [ ] Snapshot and new-repository materials audited; initial commit has no parents/old refs; personal data removed or authorized; necessary secret revocations resolved.
- [ ] Licensing, material rights, and mandatory notices verified.
- [ ] Generic installation from the verified snapshot works without lab access; anonymous GitHub download is prepared and checked immediately after opening.
- [ ] Declared platforms and Node versions verified; CI, build, typecheck, tests pass.
- [ ] One scenario completes in Claude Code, Codex, and OpenCode; live status is accurate.
- [ ] Public scenarios account for Telegram terms/consent; `tg_confirm`, session access, and prompt-injection limits explained.
- [ ] PR rules, private vulnerability channel, release approval procedure, and public conduct policy exist.
- [ ] npm owner identified, email verified, publishing authentication prepared.
- [ ] Owner approves publication of the exact SHA and knows which materials become public.

The owner concluded the one-by-one question review on October 6, 2026. Decisions through 50 establish publication, licensing, naming, npm distribution, repository ownership, cleanup/transfer, platforms, native Windows, Node, English-only content, PR/merge rules, voluntary maintenance, GitHub private vulnerability reporting, MIT contribution terms without mandatory CLA or DCO, owner-approved releases from one verified commit, concise conduct rules with owner moderation, and the `tg-mcp` public CLI command. npm account verification/registration and publishing authentication/mechanism carry into preparation. The first public version remains deferred. Decision 51 selects an isolated service with convenient owner management; implement and verify its setup, authorization and update procedures during installation preparation. Current lab decisions remain in force. Repository-wide language cleanup is complete; general cleanup and snapshot audit follow with a report containing no secret values. Publication happens at the release stage after candidate verification and approval.
