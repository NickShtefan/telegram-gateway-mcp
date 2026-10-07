# Open questions

The owner decides these questions. An agent may propose options and evidence, but must not choose for the owner. Accepted decisions are in [decisions.md](decisions.md).

## Awaiting owner confirmation

Decisions 20, 22, and 24 were proposed by an agent during implementation. They are marked "proposed" and apply until the owner says otherwise. The most visible are:

- **Install only from a root-owned installer copy at an exact commit SHA** (decision 22).
- **Populate the index only on a tool call; store chat text in the gateway database** (decision 24).

## Can be decided later

1. **Premium for the agent account.** Telegram-wide public-post full-text search requires Premium and has a daily quota. Is it needed?

## Open-source owner review completed

On October 6, 2026, the owner concluded the one-by-one question review and stated that the discussion was complete. Accepted decisions 33 through 50 are recorded. Do not continue the initial questionnaire by default. The items below are preparation follow-ups, including the deferred first public version and installation preparation. Closing the earlier review did not select its installation proposal; decision 51 subsequently selects an isolated service with convenient management on October 7.

Plan and rationale: [open-source-plan.md](open-source-plan.md). The owner chose a clean new repository with further development there (decision 33), MIT with `Copyright (c) 2026 NickShtefan` (decision 34), the repository name `telegram-mcp-gateway` and public title `Unofficial Telegram MCP Gateway` (decision 35, [research](naming-research.md)), npm publication in the first release (decision 36), and the unscoped npm name `telegram-mcp-gateway` (decision 37). The planned repository is `NickShtefan/telegram-mcp-gateway` (decision 38). Clean the current repository, transfer a vetted snapshot to the new private repository, verify the release, then open access and publish the package (decision 39). English is the only repository language, with no Russian edition (decision 43).

### Preparation follow-ups

1. **First release.** On October 6, the owner deferred choosing the first public version and stability designation. The proposed `0.1.0` is not accepted; resolve this before release-candidate verification and publication. Other preparation can continue. macOS and Linux are selected; Windows is desired (decision 40). Windows must run natively; the owner has a computer for testing (decision 41). The Node policy recommends 24 LTS or a newer verified LTS and supports Node 22 from 22.13 (decision 42). During release preparation, establish OS and client versions, exact Node versions, and test results. Resolve the npm account before publication: on October 6 the owner said they probably do not have one. Verify or recover an existing account, or register a new one; record the username and prepare publishing authentication. This does not block code cleanup or local packaging checks. Decision 50 retains `tg-mcp` as the public CLI command while the npm package is `telegram-mcp-gateway`. The owner deferred the installation model on October 6 because frequent `sudo` use would be inconvenient, then selected a separate service with convenient management on October 7 (decision 51). Define the owner interface, independent authorization mechanism and privilege prompts for setup, administration and updates while protecting sessions and executable code. The [installation redesign plan](installation-plan.md) records current gaps and acceptance checks. Current lab decisions 17 and 22 remain in force. See the comparison in [open-source-plan.md](open-source-plan.md). The npm name `tg-mcp` belongs to a third party. Keep the current repository private under decision 33.
2. **Public scenarios.** Agree data handling and demonstrations in light of Telegram's AI content terms, consent from the relevant users, and the API Terms' applicability to the gateway.
3. **Contributions and maintenance.** Decision 44 selects PRs with successful required checks and owner-approved merges for all development in the new repository, including owner/agent changes. It explicitly replaces decision 19's direct-push workflow there while retaining it in the current private repository. Configure and verify `main` protection during preparation. Decision 45 selects voluntary maintenance as the owner's availability allows, without guaranteed reply or fix deadlines. Decision 46 selects GitHub private vulnerability reporting, to be enabled and verified when opening the new repository. Decision 47 accepts external contributions under MIT with a PR rights confirmation, without mandatory CLA or DCO; implement this in the public contribution guide and PR template. Decision 48 selects separate owner release approval followed by a version tag, GitHub Release, and npm publication from the same verified commit. Decision 49 selects a concise Code of Conduct: respectful communication, no insults, harassment, or spam, and owner moderation. Prepare the public policy file, publishing mechanism, and authentication; the first public version and stability designation remain an owner question.
