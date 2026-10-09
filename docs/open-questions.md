# Open questions

The owner decides these questions. An agent may propose options and evidence, but must not choose for the owner. Accepted decisions are in [decisions.md](decisions.md).

## Awaiting owner confirmation

Decisions 20, 22, and 24 were proposed by an agent during implementation. They are marked "proposed" and apply until the owner says otherwise. The most visible are:

- **Install only from a root-owned installer copy at an exact commit SHA** (decision 22).
- **Populate the index only on a tool call; store chat text in the gateway database** (decision 24).

## Can be decided later

1. **Premium for the agent account.** Telegram-wide public-post full-text search requires Premium and has a daily quota. Is it needed?

## Release workstream decisions recorded

Owner answers on October 8 are recorded in decisions 54-60: public 0.2.0, macOS 13+ arm64/Intel plus Linux/native Windows, a terminal installer without paid Apple dependency, manual same-user owner entry with explicit capture/control limits, four automatic client adapters, owner-created repository/npm onboarding later, controlled Telegram test resources and one independent review round per stage. The [current trust design](installer-trust-design.md) replaces the unaccepted signed `.pkg`/separate-owner-login proposal. The [stage journal](release-progress.md) defines implementation and review gates.

Decisions 61-66 additionally select Ubuntu 24.04 LTS plus Arch Linux x64, confirmed installation of missing official OS prerequisites, Windows 11 Intel x64 qualification, owner-only local signing, and available macOS ARM/Intel test machines. The production private signing key stays outside agent and CI access.

Remaining owner actions are operational prerequisites, not a new architecture questionnaire: independently establish the production signing-key fingerprint, create the clean private repository, prepare npm access, provide the approved test environments/resources, enter real secrets and approve exact merge/release candidates. No secret values belong in documentation or chat.

## Open-source owner review completed

On October 6, 2026, the owner concluded the one-by-one question review and stated that the discussion was complete. Accepted decisions 33 through 50 are recorded. Do not continue the initial questionnaire by default. The items below are preparation follow-ups, including the deferred first public version and installation preparation. Closing the earlier review did not select its installation proposal; decision 51 subsequently selects an isolated service with convenient management on October 7.

Plan and rationale: [open-source-plan.md](open-source-plan.md). The owner chose a clean new repository with further development there (decision 33), MIT with `Copyright (c) 2026 NickShtefan` (decision 34), the repository name `telegram-mcp-gateway` and public title `Unofficial Telegram MCP Gateway` (decision 35, [research](naming-research.md)), npm publication in the first release (decision 36), and the unscoped npm name `telegram-mcp-gateway` (decision 37). The planned repository is `NickShtefan/telegram-mcp-gateway` (decision 38). Clean the current repository, transfer a vetted snapshot to the new private repository, verify the release, then open access and publish the package (decision 39). English is the only repository language, with no Russian edition (decision 43).

### Preparation follow-ups

1. **First release.** Decision 54 selects public version `0.2.0` on October 8. Do not infer a production guarantee; verify support and limitations before publication. macOS, Linux and native Windows are required under decision 54, extending decision 40. Windows must run natively; the owner has a computer for testing (decision 41). The Node policy recommends 24 LTS or a newer verified LTS and supports Node 22 from 22.13 (decision 42). During release preparation, establish OS and client versions, exact Node versions, and test results. Resolve the npm account before publication: on October 6 the owner said they probably do not have one. Verify or recover an existing account, or register a new one; record the username and prepare publishing authentication. This does not block code cleanup or local packaging checks. Decision 50 retains `tg-mcp` as the public CLI command while the npm package is `telegram-mcp-gateway`. The owner deferred the installation model on October 6 because frequent `sudo` use would be inconvenient, then selected a separate service with convenient management on October 7 (decision 51). Decisions 55/56 select a terminal installer and human-controlled same-user input with explicit operational limits; implement artifact trust and scoped privilege transitions while protecting sessions and executable code. The [installation redesign plan](installation-plan.md) records current gaps and acceptance checks. Current lab decisions 17 and 22 remain in force. See the comparison in [open-source-plan.md](open-source-plan.md). The npm name `tg-mcp` belongs to a third party. Keep the current repository private under decision 33.
2. **Public scenarios.** Agree data handling and demonstrations in light of Telegram's AI content terms, consent from the relevant users, and the API Terms' applicability to the gateway.
3. **Contributions and maintenance.** Decision 44 selects PRs with successful required checks and owner-approved merges for all development in the new repository, including owner/agent changes. It explicitly replaces decision 19's direct-push workflow there while retaining it in the current private repository. Configure and verify `main` protection during preparation. Decision 45 selects voluntary maintenance as the owner's availability allows, without guaranteed reply or fix deadlines. Decision 46 selects GitHub private vulnerability reporting, to be enabled and verified when opening the new repository. Decision 47 accepts external contributions under MIT with a PR rights confirmation, without mandatory CLA or DCO; implement this in the public contribution guide and PR template. Decision 48 selects separate owner release approval followed by a version tag, GitHub Release, and npm publication from the same verified commit. Decision 49 selects a concise Code of Conduct: respectful communication, no insults, harassment, or spam, and owner moderation. Prepare the public policy file, publishing mechanism, and authentication; version 0.2.0 is selected under decision 54; exact publication approval remains required.
