# Decisions

Current gateway decisions. Statuses: **accepted** (confirmed by the owner), **proposed** (chosen by the agent during implementation; the owner has not objected and may revoke it).

Numbers remain stable because code and other documents reference them. Superseded decisions are reduced to one line. Previous wording and removals remain in this private repository's Git history.

Changes must be explicit: record a new decision and explain why the previous one no longer applies.

The owner concluded the initial open-source question review on October 6, 2026, after decisions 33 through 50. The first public version and public installation model were deferred during that review. Decision 51 selects the isolated installation direction during preparation on October 7; the first public version and administration mechanism remain preparation follow-ups. Closing the earlier review did not select either deferred proposal; see [open-questions.md](open-questions.md) and [open-source-plan.md](open-source-plan.md).

## 1. One process owns sessions (proposed)

The `tg-mcp serve` daemon owns MTProto connections, the request queue, and caches. Agents connect over Streamable HTTP. For stdio-only clients, `tg-mcp stdio` forwards JSON-RPC to the daemon without opening sessions. A Unix socket in the gateway directory enforces single-process ownership.

Reason: two processes using the same session cause `AUTH_KEY_DUPLICATED`, and Telegram invalidates the session.

## 2. Tools-only contract (proposed)

Resources, prompts, and elicitation are not supported by every client; tools are. Schemas are flat: strings, numbers, booleans, enums, and arrays of these, without unions or nested objects. Names use `tg_*` snake_case; the core toolset contains at most 10-12 tools.

Reason: all tool descriptions enter agent context at startup; extra tools consume tokens and model attention.

## 3. Core is independent of MCP (proposed)

Core and services have no MCP or transport dependencies. Storage uses a port with a SQLite implementation.

Reason: installation requires no external services, and independent core logic is easier to test.

## 4. Writes are disabled by default and use two steps (proposed)

Write tools belong to the explicitly enabled `write` toolset. They only prepare actions; `tg_confirm` executes them. See decision 23.

Reason: two-step confirmation works in every client, unlike elicitation.

## 5. Long operations become jobs (proposed)

Ordinary calls finish in about 30 seconds. Export and indexing wait up to 20 seconds, then return `job_id`; the same tool reads status using that ID. FLOOD_WAIT exceeding the waiting budget returns an error immediately with `retry_after`.

Reason: clients have different tool-call timeouts.

## 6. Telegram text is untrusted (proposed)

Every returned message has explicit content boundaries. Chat titles and names are sanitized; server instructions prohibit obeying commands from this content. Private conversations stay closed until the owner opens them (decision 27).

Reason: public chats and contacts provide a prompt-injection channel, especially when writes are enabled.

## 7. The gateway provides data; the agent interprets it (proposed)

The gateway contains no model or model API keys. Agents produce summaries, parse prices, assess channels, write replies, and conduct negotiations. The gateway returns original text and numbers without verdicts.

Reason: the gateway stays provider-independent and does not decide for the agent.

## 8. Large results go into files (proposed)

`tg_export` writes JSONL or CSV and returns a path, row count, and five examples. Images also become files. Summaries use brief history mode.

Reason: every client can run code. Thousands of listings consume context, and code aggregates them more reliably than a model.

## 9. Writes use the connected account (accepted 2026-10-01)

The gateway never chooses an identity. An agent account writes as that account; connecting the owner's personal account is an explicit owner choice. Channel administrators may reply as the channel with `send_as`.

Reason: owner instruction.

## 10. Rules and assignments (superseded by decision 25)

## 11. Dedicated project directory (accepted 2026-10-01)

Development uses `~/Projects/CODE/Chanel/tg-mcp`. No code is shared with other projects; the gateway is self-contained.

Reason: owner request.

## 12. Daemon runs on the lab machine (accepted 2026-10-01)

The daemon runs on `macbook-pro-lab.local` (macOS, Intel, Node 22), alongside agents. Agents connect to `127.0.0.1`; exports and images use the same disk. launchd supervises the daemon with `KeepAlive`. Development uses the main Mac.

Each machine creates its own session through login. Never copy sessions between machines: duplicated keys cause `AUTH_KEY_DUPLICATED`.

Reason: owner instruction; agents already run there.

## 13. Account and Business-bot conversations (superseded by decisions 23 and 25)

## 14. Name and installation (accepted 2026-10-01)

Current private repository: `telegram-gateway-mcp`; local directory and CLI: `tg-mcp`. The package is unpublished with `"private": true`. A root-owned installer deploys a specified commit SHA to the lab machine (decision 22).

Never run `npx tg-mcp`: that npm name belongs to another package, which npx would download and execute.

Reason: owner instruction.

Decision 33 defines the move to a public repository, decision 35 its name, decision 36 npm publication, and decision 50 retains the `tg-mcp` CLI command for the public project. Current installation and private mode apply until migration.

## 15. Read any channel (accepted 2026-10-01, amended by decision 25)

Public channels and groups can be read without joining. Private chats require membership; `tg_join` uses confirmation. There is no watched-chat registry; the agent reads history when needed.

## 16. Multiple users and accounts (accepted 2026-10-01)

Two people use the gateway: the owner and the owner's wife. Each connects personal Telegram accounts; some accounts are shared.

- **User:** a bearer token for caller identity and a default account. Store only the token hash.
- **Account:** a Telegram session and access grants. One process owns all sessions; each account has its own queue and limits. Shared users share the queue to protect the account.
- **Call:** Telegram tools accept an optional `account`; only owned and granted accounts are accessible. Scopes, approvals, jobs, and audit belong to users.
- **Login:** each person logs in independently (`tg-mcp login --account <name>`), receiving the code on their own phone.

Limitation: both people's agents run as macOS user `nick` and can access each other's tokens. Gateway separation prevents mistakes, not a prompt-injected agent's deliberate impersonation. Sessions have separate protection (decision 17).

Reason: owner instruction.

## 17. Dedicated macOS service user (accepted 2026-10-01)

The lab daemon runs as `tgmcp`, separately from agent user `nick`. Sessions, encryption key, database, and `.env` belong to the service user and are inaccessible to agents. The owner creates the user and LaunchDaemon with administrator privileges.

Consequences:

- Exports and images go into a shared directory readable by agents.
- Login, users, scopes, and doctor use `sudo tg-mcp-admin`; agents cannot administer them.
- The stdio proxy only forwards requests.

Reason: agents have shell access as nick. Without isolation, prompt injection could steal both session and encryption key, compromising the account. Owner decision.

## 18. Shared accounts (accepted 2026-10-01)

For accounts granted to several users:

- Only the requesting user can confirm a write; other users cannot see its approval.
- Daily write caps apply per account, not per user.
- All account users can search its local indexes; only the index creator can delete an index.

Reason: owner agreement. All users expose the same Telegram account to risk, so caps are shared.

## 19. Developer-agent workflow and SQLite driver (accepted 2026-10-01)

- **SQLite:** built-in `node:sqlite`, without native compilation. FTS5 is available on both machines. A storage port allows driver replacement.
- **Git:** commit after each completed step with green tests and immediately push to private `main`.
- **Lab machine:** the agent may build, test, and inspect over SSH. The owner runs supplied commands requiring sudo. The account holder enters login codes and 2FA passwords.

Reason: owner decision to allow autonomous development.

This direct-push workflow continues only in the current private repository. Decision 44 replaces it with PRs, successful checks, and owner-approved merges for development in the new repository after the initial snapshot import.

## 20. Implementation details (proposed)

- **Stateless HTTP:** a new MCP server per request. After a hang and daemon restart, clients retry calls.
- **No structuredContent:** compact text only; clients passing both text and structure would duplicate model context.
- **tg_status is always available:** agents always see their accounts and pauses.
- **Root-owned lab code and Node:** Homebrew belongs to nick, so the daemon uses a separate Node copy under `/opt/telegram-gateway-mcp`. Updates require sudo; see [deploy.md](deploy.md).
- **No linter:** strict tsc and tests provide checks.

Reason: implementation choices under decision 19.

## 21. Separate approval bot (revoked by owner 2026-10-01; see decision 23)

## 22. Review changes (proposed)

The code received two independent reviews, covering security and correctness. Current outcomes follow.

Installation and files:

- **Do not trust agent-writable clones:** run only the root-owned `/opt/telegram-gateway-mcp/install.sh`; fetch a full GitHub commit SHA and build as root.
- **Shared exports:** use `/opt/telegram-gateway-mcp/files`. Never follow symlinks or use directories writable by others.
- **Localhost only:** other interfaces require `TG_MCP_ALLOW_REMOTE=1`; HTTP sends tokens without encryption.

Agent access:

- **Message search:** one chat category per call through `where`: channels by default, groups, or private chats. Return only private conversations opened for reading (decision 30), without hidden match counts.
- **Names and titles:** treat them as untrusted text and remove invisible characters and line breaks.

Write confirmation:

- Sanitize text before preview so the confirmed text exactly matches the outgoing text.
- Expired confirmations execute nothing.
- Interrupted actions are not retried after restart and close with an unknown outcome.

Limiter:

- FLOOD_WAIT under five minutes pauses the account. Longer waits pause only the affected method, such as contacts.ResolveUsername for a day; other methods remain usable.
- SLOWMODE_WAIT pauses one chat, not the account.
- Before exiting on a hanging call, reject waiting calls and allow 300 ms to record outcomes.

Other:

- **No account registration:** abort login for unregistered phone numbers rather than letting the library create an account and accept Telegram terms.
- **Retention:** audit 90 days, resolved write requests 7 days.
- **Entity cache:** remove reassigned usernames from former chats to prevent sending approved messages to the wrong destination.

Reason: conservative agent access choices; the owner may revoke any proposed choice.

## 23. Owner's agent confirms writes, without a bot (accepted 2026-10-01)

The gateway remains an MCP server; only the owner's agent talks to the owner. There is no separate approval bot.

Write flow:

1. A write tool (`tg_reply`, `tg_send`, `tg_react`, `tg_join`) returns a preview with action, destination, account, exact text, and `approval_id`, without executing it.
2. The agent shows this preview to the owner in their conversation.
3. After owner consent, the agent calls `tg_confirm`. The gateway executes the action. `text` replaces wording; `action=reject` cancels it.

Requests live for 30 minutes, allowing time for preview and response. There is no draft queue.

Limitation: agents can technically call tg_confirm without asking; the gateway cannot observe human consent. Remaining safeguards:

- Client permissions: leave tg_confirm in ask mode in Claude Code ([connect.md](connect.md)).
- Gateway-enforced caps, private chats closed by default, and permanently blocked service chats.
- Untrusted-content labels and instructions prohibiting confirmation requested by Telegram content.

Reason: owner decision. A separate bot adds another intermediary, token, and failure mode.

## 24. Dialogs, reactions, discovery, statistics, and indexes (proposed)

Implementation choices for five owner-requested capabilities:

- **tg_list_dialogs in core:** enables fuzzy chat discovery. Lists channels and groups by default; private chats require type=private and read access (decision 27). Owner-blocked chats are hidden.
- **Reactions are writes:** preview and tg_confirm; standard emoji only.
- **Statistics without verdicts:** calculate reach, engagement, dispersion, and trends. Scores, niche, manipulation risk, and advertising price estimates remain agent judgments (decision 7).
- **Subscriber snapshots:** Telegram exposes historical growth only to admins. Store observed counts once daily and report differences beginning with the first observation.
- **Explicit indexing:** tg_index populates and refreshes only chats explicitly requested by the agent.
- **FTS5 trigrams:** SQLite has no morphology engine; case-insensitive substrings match forms such as bicycle/bicycles. Words shorter than three characters are not indexed.
- **Indexed text:** stored in the service user's database, inaccessible to agents. Deleting indexes or accounts removes message and search rows. Post comments are not indexed.

Reason: implementation choices under decision 19; the owner may revoke them.

## 25. Pure MCP: a tool, not an agent (accepted 2026-10-01)

Without a tool call, the gateway does not watch chats, launch agents, write assignments, manage rules or tasks, or interpret data.

Gateway state includes sessions, chat caches, write approvals and journals for caps, participant snapshots, explicitly populated local indexes, tool-started export/indexing jobs, and audit. These do not make it an agent.

The daemon's only periodic work is once-a-minute expiration and database retention cleanup. It maintains connections but makes no autonomous Telegram requests.

Agents handle recurring monitoring and negotiations using their own schedules or loops, such as Hermes scheduling or Claude Code loops. They read history, remember goals and conversations, ask the owner, and use the gateway for reading and confirmed writes. See [connect.md](connect.md).

Reason: owner decision for a simpler gateway without model-launch costs, autonomous decisions, or account activity.

Tradeoff: recurring tasks and negotiation state live on the agent side.

## 26. MTProto library: teleproto (accepted 2026-10-02)

Use exactly pinned `teleproto` 1.229.1, the GramJS fork recommended by its authors when they archived the `telegram` package in July 2026.

Verified during migration:

- No package installation scripts, process launches, or eval; network endpoints belong to Telegram.
- Compatible session format; existing gateway sessions work without another login.
- The test fake serializes requests with real library classes, detecting newly required protocol fields.

The gateway deliberately does not configure login CAPTCHA bypass through reCaptchaCallback.

Risk: the fork has one maintainer. Review changes, run tests, and verify a live account before upgrades ([risks.md](risks.md)).

## 27. Private-chat modes and configurable daily caps (accepted 2026-10-02)

**Private-chat mode:** the owner sets it per gateway user/account pair, effective immediately without restart:

```
tg-mcp scope private <user> <account> closed|send|open
```

- `closed` (default): only conversations opened with scope allow are accessible.
- `send`: agents may prepare messages to any person through tg_send but cannot read conversations unless scope allow opens them.
- `open`: agents may read and write any private conversation; tg_list_dialogs type=private lists them.

Service chats remain blocked, scope deny overrides the mode, and every message requires tg_confirm. Recheck scopes at confirmation: closing access after preview prevents sending.

Reason for separate send/read modes: owners see and approve outgoing messages. Reading exposes contacts' personal data and untrusted instructions without per-read confirmation.

**Daily caps:** defaults of 20 replies, 5 new conversations, 5 joins, and 30 reactions per account are conservative gateway choices, not Telegram rules. Telegram does not publish thresholds. Caps prevent accumulating risky stranger contacts through individual approvals until complaints cause PEER_FLOOD. Configure the daemon's .env; 0 removes a cap:

```
TG_MCP_LIMIT_NEW_DIALOGS=20
TG_MCP_LIMIT_REPLIES=20
TG_MCP_LIMIT_JOINS=5
TG_MCP_LIMIT_REACTIONS=30
```

The example overrides the default new-conversation cap. doctor and tg_status report effective values. Invalid numeric values fail startup rather than silently using defaults.

Tradeoff: open mode exposes all private conversations, including Saved Messages. For the owner's personal account, send mode with specific scope allow rules is more conservative.

## 28. No bridge to other projects' archives (accepted 2026-10-02)

The gateway reads only Telegram and its own SQLite database, never other projects' databases.

Reason: owner decision. The unimplemented initial bridge idea would add another database and dependencies on external schemas.

## 29. No one-reply-per-post cap (accepted 2026-10-02)

Accounts may reply repeatedly under one post. Every reply still requires preview and tg_confirm and counts toward the daily reply cap. The former limit allowed one reply per post per account.

Reason: owner decision. Humans decide conversation frequency. The cap originally prevented multiple automation rules replying to one post; those rules no longer exist, and the cap blocked comment conversations.

Pending-request deduplication remains: while one draft awaits a decision, do not prepare a second draft for the same post. Another reply can be prepared after confirmation or rejection.

## 30. Link previews, reply targets, and private search (accepted 2026-10-02)

The owner requested removal of three unjustified restrictions:

- **Link previews:** tg_reply and tg_send accept link_preview. Disabled by default because Telegram-generated cards are not visible in the action preview. Enabling it is explicitly stated in the preview.
- **Specific reply targets:** tg_reply with a comment link (...?comment=N) replies within that comment's thread. tg_send reply_to targets a chat message ID. Do not include the target's untrusted text in the action preview.
- **Private search:** tg_search_messages where=private returns only conversations opened for reading by scope allow or open mode. Closed/send modes with no allowed conversations return nothing. Service chats remain hidden.

Reason: owner decision. Humans choose writing and search behavior; the gateway enforces exact confirmed text and authorized reads.

## 31. Inline buttons are visible and use two-step presses (accepted 2026-10-02)

Issue 1 requested displaying and pressing a bot's inline keyboard.

- **Reading:** tg_get_message and full history show buttons: with row.column, label, kind, and destination for URL buttons. Brief mode reports only the button count. Never expose callback bytes. Labels and destinations are untrusted.
- **Pressing:** tg_press_button prepares a position-based preview; tg_confirm executes after owner consent. Callback bytes come from the message, never agent arguments. Reread at confirmation and refuse changed buttons.
- **Callbacks only:** do not open links, web apps, sign-in flows, payments, games, inline-mode switches, or buttons requiring the account's 2FA password.
- **Bot response:** return toast, alert, or URL as untrusted text. BOT_RESPONSE_TIMEOUT means pressed without a timely bot answer, not failed execution.
- **No daily press cap:** the owner confirms every press; audit retains calls.
- **Meaning is the owner's choice:** gatekeeper verification buttons such as 'I am not a bot' use the same confirmed callback flow. The owner revoked the former manual-only CAPTCHA-button rule. The gateway does not interpret images, solve challenges, or act autonomously.

Reason for the write gate: buttons may vote, purchase within a bot, delete content, or accept terms; the bot controls their labels. ReplyKeyboardMarkup buttons are ordinary text messages through tg_send, outside this feature.

## 32. Full mode displays hidden links (accepted 2026-10-02)

Full message/history mode adds hidden links: after text, showing linked words and destinations. Explicit URLs remain in text; URL-button destinations appear with their labels (decision 31). Brief mode shows neither, preserving two lines per message.

Reason: owner decision. A post saying 'details here' without its destination is unusable to an agent. Addresses are untrusted; the gateway never opens them.

## 33. Public project starts from a clean snapshot (accepted 2026-10-05)

The owner creates a new repository containing a prepared, verified snapshot without this private repository's commit history. New history begins there, and further development moves there after migration.

The current repository stays private with its existing history. Do not change its visibility, rewrite history, or automatically transfer issues, PRs, logs, or artifacts. Audit the selected snapshot and new repository materials; auditing all old private history is not a prerequisite for the new publication.

Check the snapshot for secrets and personal data and retain required third-party notices. Removing old commits does not replace this audit. Source and first public-repository commit SHAs differ; the preparation report connects them through file contents and a snapshot checksum. Verify releases on the new repository's commit.

Decision 35 selects the name, 38 selects owner/address, and 39 defines cleanup and publication order. Decision 44 defines PR and merge rules for further development in the new repository. Decision 19 continues to authorize commits and pushes to current private main until migration.

Reason: the owner wants to open the finished tool and develop it with a fresh public history.

## 34. Standard MIT license (accepted 2026-10-05)

Use standard MIT without field-of-use restrictions, allowing personal, commercial, and closed-source use, modification, and redistribution.

Recipients retain copyright and license notices in copies or substantial portions. MIT does not require disclosing modifications or oblige the author to provide support or updates. It disclaims warranties and limits liability without guaranteeing immunity from every obligation. Source: [MIT license text](https://opensource.org/license/mit).

The owner approved this copyright line on 2026-10-06: `Copyright (c) 2026 NickShtefan`.

Before adding LICENSE, verify material provenance and dependency notices. The project license does not replace Telegram terms or third-party licenses. Until these checks are complete, MIT remains the choice for the future release.

Reason: free use and distribution without an obligation to maintain others' installations.

## 35. Public name: telegram-mcp-gateway (accepted 2026-10-06)

Repository: `telegram-mcp-gateway`. Display title: `Unofficial Telegram MCP Gateway`.

Reason: Telegram and MCP identify the category; gateway describes the shared-daemon architecture. The telegram-mcp substring fits official MCP Registry search. Research found no published exact-name GitHub/npm match; evidence and limitations are in [naming-research.md](naming-research.md). This guarantees neither ranking nor name reservation.

This applies to the future open project. The owner creates the repository (33), under the selected account/address (38), following decision 39. npm publication and its name are selected in 36/37; decision 50 retains the `tg-mcp` CLI command. State directories and environment variables are not renamed by these naming decisions. Current private package and repository names remain until the relevant preparation step.

## 36. First public release includes npm (accepted 2026-10-06)

Publish a ready-to-use npm package in the first public release; Git installation remains an additional development path.

Decision 37 selects the package name. Include verified build/CLI, license, and required notices without secrets or personal data. Verify package contents and installation on a candidate from the new repository ([open-source-plan.md](open-source-plan.md)).

This selects the future release scope. Publication follows candidate preparation, audit, licensing, and release checks. Isolation and the installer from decision 22 require npm-specific preparation and verification; npm does not remove isolation requirements.

Reason: owner choice during installation-method discussion.

## 37. Public npm name: telegram-mcp-gateway (accepted 2026-10-06)

Use the unscoped `telegram-mcp-gateway`, matching the new repository name.

Reason: one name connects discovery and installation. Availability evidence and limitations are in [naming-research.md](naming-research.md). The name is not reserved; recheck before publication.

Apply it during future release preparation. This does not rename the current private package, tg-mcp command, state directory, or environment variables. npm publishing identity and release execution remain preparation questions.

## 38. Personal GitHub account NickShtefan (accepted 2026-10-06)

Create the future repository under `NickShtefan`: [github.com/NickShtefan/telegram-mcp-gateway](https://github.com/NickShtefan/telegram-mcp-gateway).

Reason: owner approval of their personal account and the selected name.

The owner creates it under decisions 33/39. The selected address changes neither the current private remote nor npm publishing identity.

## 39. Clean current files, then migrate and publish (accepted 2026-10-06)

Agreed preparation order:

1. Remove obsolete/temporary materials, duplicates, and proven unused code from the current private repository. Preserve working features, necessary tests, and third-party notices. Verify build and tests.
2. Prepare and audit the public snapshot for secrets, personal data, provenance, and licensing. Record source SHA and transferred file list.
3. The owner creates an empty private `NickShtefan/telegram-mcp-gateway`. Transfer the snapshot as a first commit without parents or old history.
4. Run CI and release checks on the new commit, including npm package contents and clean installation.
5. After accepting the verified release, make the new repository public and publish npm under decision 36.

Cleanup uses ordinary file changes, preserving private history (33), live Telegram sessions, and user data. Define transfer contents separately; necessary private operational materials may remain in the current repository outside the public snapshot.

Reason: the owner wants clean code and a verified release before opening access.

## 40. macOS/Linux first; Windows desired (accepted 2026-10-06)

Prepare macOS and Linux support for the first release, with Windows included if possible. Verify every declared environment through installation, checks, and gateway operation.

Decision 41 specifies Windows execution. Native Windows and WSL 2 are distinct environments; Linux/WSL checks do not prove native Windows support. OS/Node versions and final supported environments remain preparation work.

Reason: serve Windows agent users too. Client support and current gateway limitations are in [open-source-plan.md](open-source-plan.md).

## 41. Native Windows, tested on owner's computer (accepted 2026-10-06)

Target native Windows execution, including PowerShell. WSL runs the Linux version and does not substitute for native Windows preparation or proof.

The owner has a Windows computer for candidate testing: installation, CLI/daemon, MCP connection, restart, second-process locking, and session-file protection. Record Windows version, architecture, and Node. Create a new gateway-owned Telegram session by logging in on that machine.

Reason: owner approval and offered test hardware. Adaptation and tests have not run; expected WSL compatibility is also unverified.

## 42. Latest tested Node LTS, retaining Node 22 (accepted 2026-10-06)

Recommend Node 24 LTS and support Node 22 from 22.13. A newer recommended branch is allowed once it has LTS status and the gateway passes release checks on it.

As of 2026-10-06, Node 24 is the newest LTS; Node 22 remains LTS and Node 26 is Current. Node 26 LTS is scheduled for 2026-10-28. Recheck branch status before release and record exact versions. Sources: [Node statuses](https://nodejs.org/en/about/previous-releases), [Node schedule](https://github.com/nodejs/Release/blob/main/schedule.json).

The planned matrix covers minimum 22.13, the current Node 22 patch, and the current recommended LTS patch on declared systems. New LTS support requires build, type checks, tests, SQLite/FTS5, clean package installation, and gateway startup. Do not claim compatibility before proof.

Reason: owner accepted these versions and allowed a newer LTS. Matrix execution and environment updates remain release preparation.

## 43. English-only repository (accepted 2026-10-06)

The owner selected English for the entire repository, without a Russian edition, and requested removing Russian prose now. Translate documentation, code comments, tool/CLI messages and examples, test names and fixtures, scripts, and agent instructions. New commit messages are English. Conversation with the owner remains in Russian.

Preserve accepted decisions, security constraints, required attribution, runtime behavior, and support for Unicode Telegram content. English repository content does not limit Telegram data to English. Preserve existing private Git history under decision 33; the new repository receives only the vetted English snapshot.

Reason: owner instruction during open-source preparation. Language cleanup is a concrete prerequisite, separate from the remaining obsolete-code, provenance, secrets, and release audits.

## 44. Public development through PRs and owner-approved merges (accepted 2026-10-06)

After importing the initial vetted snapshot into `NickShtefan/telegram-mcp-gateway` under decisions 33 and 39, all development changes go through pull requests, including changes prepared by the owner or an agent. Required checks must succeed before merging, and the owner approves the merge. Agents may prepare and update PRs but must obtain the owner's explicit approval before merging. Direct development pushes to the new repository's `main` are not part of this workflow.

Configure the new repository's `main` protection and required CI checks during preparation, and verify the actual settings before publication. This decision records the policy; the new repository, CI, and protection rules have not been created or configured by this step. Decision 45 defines the maintenance commitment, decision 46 selects the private vulnerability channel, decision 47 defines contribution terms, and decision 48 defines release approval and publication.

Decision 19 remains in force for the current private `telegram-gateway-mcp`: completed, tested preparation steps are committed and pushed to its `main`. The initial parentless snapshot import remains governed by decisions 33 and 39.

Reason: the owner approved PRs with successful checks and retained approval of merges into the public project.

## 45. Voluntary maintenance without guaranteed deadlines (accepted 2026-10-06)

The owner maintains the open-source project as time and capacity allow. There are no guaranteed deadlines for replies or fixes. Describe this maintenance model clearly in the future public README and contribution/security documentation; do not introduce a response or remediation SLA without a new owner decision.

This defines the maintenance commitment. Decision 46 selects the reporting channel, decision 47 defines contribution terms, and decision 48 defines release approval and publication. PRs and merges continue to follow decision 44.

Reason: the owner explicitly confirmed maintenance according to their availability, without guaranteed response or fix timelines.

## 46. Private vulnerability reports through GitHub (accepted 2026-10-06)

Use GitHub's private vulnerability reporting for the future `NickShtefan/telegram-mcp-gateway` repository. Enable it when the new repository becomes public and verify that the `Report a vulnerability` form is available. Document this channel in the future `SECURITY.md`, including instructions not to submit secrets, sessions, or private chat content. Maintenance remains voluntary without guaranteed reply or fix deadlines under decision 45.

GitHub's reporting feature requires a public repository and explicit enablement; adding `SECURITY.md` does not enable it. Source: [GitHub private vulnerability reporting](https://docs.github.com/en/code-security/how-tos/report-and-fix-vulnerabilities/report-privately). This decision selects the channel; activation and verification remain publication tasks.

Reason: the owner approved GitHub's private form for vulnerability reports, to be enabled when opening the new repository.

## 47. MIT contributions with a PR rights confirmation (accepted 2026-10-06)

Accept external contributions to the future public project under the same MIT license selected in decision 34. The PR author confirms that they have the right to submit the contribution under MIT. Do not require a separate contributor license agreement (CLA) or mandatory Developer Certificate of Origin (DCO) sign-off for each commit.

Document these terms in the future `CONTRIBUTING.md` and include the rights confirmation in the PR template. Review material provenance and preserve required third-party attribution and license notices. The PR and merge workflow remains governed by decision 44. Public contribution files and templates have not been created by this step.

GitHub's default contribution terms apply the repository license and require the contributor to have the right to license the submitted content; a separate agreement can supersede that default. Source: [GitHub contributions under the repository license](https://docs.github.com/en/site-policy/github-terms/github-terms-of-service#6-contributions-under-repository-license).

Reason: the owner approved MIT contributions with a PR rights confirmation, without mandatory CLA or DCO.

## 48. Owner-approved releases from one verified commit (accepted 2026-10-06)

For releases from the new repository, prepare a verified candidate commit, version number, and release notes. Version metadata must already be in the candidate before verification. Present the exact commit SHA, version, changes, and relevant check results to the owner for separate release approval.

After that approval, create the version tag at the approved commit, publish the GitHub Release for that tag, and publish the npm package from the same commit. Keep the released version and package contents tied to the verified SHA. Changes to the candidate require repeating affected checks and obtaining approval for the updated candidate. PR merge approval under decision 44 does not by itself authorize a release.

Implement and document this procedure during release preparation. This decision records the workflow; no tag, GitHub Release, or npm publication was created by this step. The first public version and stability designation, publishing account, authentication, and execution mechanism remain preparation questions. The clean initial import and first publication continue to follow decisions 33 and 39.

Reason: the owner approved preparing a checked commit, version, and change list, followed by separate owner approval and tag, GitHub Release, and npm publication from that same commit.

## 49. Concise conduct rules with owner moderation (accepted 2026-10-06)

Use a short project Code of Conduct: communicate respectfully; insults, harassment, and spam are prohibited. The owner decides moderation actions in project discussions and reviews.

Prepare the English `CODE_OF_CONDUCT.md` and link it from the public contribution guide during publication preparation. This decision records the agreed rules and moderation responsibility; the public policy file has not been created by this step. Maintenance remains voluntary under decision 45.

Reason: the owner approved concise conduct rules with respectful communication, no insults, harassment, or spam, and moderation decisions retained by the owner.

## 50. Public CLI command remains tg-mcp (accepted 2026-10-06)

Keep `tg-mcp` as the public CLI command, including `tg-mcp serve` and `tg-mcp stdio`. The npm package and new repository remain `telegram-mcp-gateway` under decisions 35 and 37. The existing command already uses this name, so no CLI rename is required.

Retain the `tg-mcp` bin entry when preparing the public package, and verify that clean installation provides the command. Public installation instructions must use the selected npm package name; the prohibition on running the third-party `npx tg-mcp` remains in force. This decision does not rename the state directory or environment variables, change the installation/isolation model, or publish the package.

Reason: the owner approved retaining the CLI command while using the agreed public package name.

## 51. Isolated service with convenient owner management (accepted 2026-10-07)

Prepare the public installation around a separate OS service identity, protecting Telegram sessions, the database, encryption key, configuration, executable code and Node runtime from agent shells. The owner selected this direction over same-user execution when prioritizing installation redesign on the main Mac.

Make setup and owner management easier. Ordinary MCP calls already require no `sudo`; reduce fragmented setup and repeated manual administration without giving agents service-user or administrative authority. Initial protected installation and updates require an appropriate owner-authorized privilege path. The owner interface, authorization mechanism and exact privilege prompts remain design work; this decision does not select a browser UI or promise passwordless administration.

Current lab decisions 17/22 remain in force. Keep its installation working while preparing and testing the new workflow. Test the first implementation on the main Mac with a new gateway-created session, followed by the selected Linux and native Windows environments. Platform isolation must be verified rather than inferred from Unix file modes.

The [installation redesign plan](installation-plan.md) records the current implementation, gaps, proposed user journey and acceptance checks. This decision authorizes the chosen design direction; it does not record an executed installation, a live login, platform proof or publication.

Reason: the owner chose a separate service with convenient management when asked to resolve the previously deferred installation model.

## 52. Agent-assisted installation with protected owner steps (accepted 2026-10-07)

The preferred installation entry is a prompt given to the user's agent. The agent follows versioned project instructions, inspects the computer, prepares installation, connects the selected MCP client and verifies the result. The installer supplies the service's protected Node runtime; external users should not need to install Node.js/npm separately just to set up the gateway. This extends the isolated service direction in decision 51 and retains npm distribution under decision 36.

The owner accepts that system authorization, Telegram application credentials, login codes and 2FA require human participation. Design resumable handoffs so these steps do not require restarting installation or sending secrets to the agent conversation. Keep the gateway pure MCP: the installation agent remains an external client, with no embedded model, provider key or agent execution added to the gateway.

The exact bootstrap artifact, protected owner-entry mechanism, status interface, token handoff and client adapters remain implementation/design work. This decision does not choose a browser panel, QR login or any existing command as the complete installer. It does not authorize running installation or logging in during scenario planning.

Reason: the owner broadly accepted installer-managed prerequisites and requested that a prompt to an agent be the preferred installation experience, while recognizing necessary credential/OTP/2FA steps.
