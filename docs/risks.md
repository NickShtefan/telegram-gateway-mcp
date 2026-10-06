# Risks

Ordered from highest impact to lower impact.

## High

**Account restriction or ban.** User-account automation can attract Telegram restrictions. Use a separate number, conservative limits (60 requests/minute and 500 ms spacing per account), and no bulk joins/messages. Accounts may be frozen read-only, with appeal through @SpamBot. The gateway does not detect this in advance: it recognizes Telegram errors and returns `ACCOUNT_FROZEN` with an explanation. Human-like behavior is not a guarantee against enforcement.

**Messaging strangers.** Complaints can cause `PEER_FLOOD`, restricting messaging to mutual contacts. The gateway caps new dialogs (default 5/day, owner-configurable under decision 27); no bulk messaging; the agent identifies itself as an assistant. Private-chat `send`/`open` removes individual grants only: per-message confirmation and daily limits remain.

**Commitments on the owner's behalf.** An agent may promise too much. The gateway does not interpret message content; sends require `tg_confirm`. The agent manages negotiation boundaries (money, address, meeting time). Money transfers are unsupported.

**Replies in other people's channels.** Frequent comments on every post can appear as spam, inviting admin bans or account restrictions. Default gateway caps are 20 replies and 30 reactions/day; each action requires confirmation. The owner decides repeat replies under one post (decision 29).

**Telegram AI terms.** Content Licensing and AI Scraping restrict AI use of platform data and define consent-based exceptions. Gateways exposing third-party chats to models face applicability questions, including similar MCP servers. Business bot terms separately restrict forwarding messages to third-party APIs without permission. This remains an unresolved publication gate in [open-source-plan.md](open-source-plan.md). Personal use, low volume, and an owner-selected chat do not establish the required consent.

**One session in multiple processes.** Concurrent session use causes `AUTH_KEY_DUPLICATED` and session revocation. Only the daemon owns sessions; it holds a socket lock. Stdio opens none; `doctor --connect` requires a stopped daemon. Gateway sessions are independent of other projects.

**Agent theft of a session.** Shell-enabled agents compromised through prompt injection could read a session and encryption key, obtaining full account access. The daemon therefore runs as a separate macOS user with database/key/`.env` inaccessible to agents; root owns its code/Node (decisions 17 and 22).

## Medium

**Single-maintainer MTProto library.** GramJS is archived; the gateway uses teleproto (decision 26). A malicious library update could steal a session. Mitigation: exact version pin, lock-file integrity hash, `--ignore-scripts` installation. Version 1.229.1 was checked for absence of installation scripts and unrelated network addresses. Updates require deliberate review and verification.

**Incomplete search.** `messages.searchGlobal` searches account-member chats, not all Telegram. `channels.searchPosts` supports public hashtags. Telegram-wide full-text post search has Premium/quota restrictions and is not used by this gateway.

**Prompt injection from chats/peers.** Mitigations: untrusted-text labels, separate `write` toolset, preview/`tg_confirm` (decision 23), default-closed private chats, audit. The gateway does not start agents; the client manages permissions for unattended agent schedules.

**Private conversations.** Unrestricted access would expose everything the account can see. Private chats require individual grants or `send`/`open` (decision 27). `open` exposes all account private conversations and their untrusted text.

**User separation.** Both users' client tokens/files live under one macOS user. Gateway tokens separate logical access, but a shell-enabled agent could read another user's Claude Code token. This limits mistakes, not malicious same-user access.

**Closed-chat gatekeepers.** Marketplace bots often allow about a minute for verification. Joining does not solve it. `tg_press_button` can press a simple owner-confirmed callback (decision 31), but preview/consent/confirmation may exceed the window; manual verification is more reliable. No image/task CAPTCHA solving.

**Bot buttons.** A button can vote, buy, delete, or accept terms; bot-defined labels may not describe the real action. The two-step preview shows author, label, and position; confirmation reloads the message and rejects changed buttons. Links, payment, login, and 2FA-password buttons are unsupported. The gateway cannot infer the action behind a callback; the owner decides.

**Personal data.** Listings can include seller names/phones. Exports hash authors and mask phones unless explicitly requested. `tg_index` stores chat text and author names in the daemon-owned database, inaccessible to agents; remove indexes by command or account deletion.

**Missed posts.** The gateway does not watch channels (decision 25). Agents should compare post IDs to the last read ID rather than rely on time, so schedule gaps do not lose posts.

**Hung MTProto requests.** Network failures can leave calls unresolved indefinitely, blocking an account queue for days without deadlines. Every gateway call is time-bounded; hangs exit/restart the process. Treat teleproto behavior as inherited from GramJS until proven otherwise.

**Paid actions.** Premium users may require Stars for stranger messages (`ALLOW_PAYMENT_REQUIRED`); public-post search above quota can also cost Stars. The gateway pays nothing and returns `PAYMENT_REQUIRED`, asking the agent to consult the owner.

**Confirmation without an independent intermediary.** The owner's agent calls `tg_confirm` after consent (decision 23); the gateway cannot attest actual consent. A compromised agent could confirm itself. Keep `tg_confirm` in client ask-permission mode; gateway caps/private-chat policy remain independent of the agent.

## Low

**Oversized responses.** Clients truncate or warn about large tool responses (Claude Code: `MAX_MCP_OUTPUT_TOKENS`). Use per-message character limits, default 20 results, and cursors.

**Image cost.** Images consume hundreds/thousands of model tokens; thumbnails are the default.

**stdout logs.** MTProto library logging uses `console.log` by default and breaks stdio JSON-RPC. The gateway replaces it with a stderr logger, verified by a test.

## Telegram rules

Sources behind the risks above were checked October 1, 2026. The publication plan records unresolved applicability/consent questions separately.

- **Content Licensing and AI Scraping** ([terms](https://telegram.org/tos/content-licensing)): restrict platform-data collection/use for AI training and operation. Consent exceptions are scoped to specific chats/content; consent in one chat does not transfer to another. The page has no date.
- **API Terms** ([terms](https://core.telegram.org/api/terms)): no actions on a user's behalf without their knowledge and consent.
- **Spam enforcement.** Complaints can trigger contact-only messaging (`PEER_FLOOD`). Freeze metadata (`freeze_since_date`, `freeze_until_date`, `freeze_appeal_url`) appears in `help.getAppConfig` ([configuration](https://core.telegram.org/api/config)); frozen accounts are read-only and appeal through @SpamBot.
- **Paid messages.** Premium users may charge strangers Stars (`ALLOW_PAYMENT_REQUIRED`, `allow_paid_stars`); public-post search above daily quota also costs Stars.
- **AI comment spam:** commercial automated comments using account farms, account warmup, and simulated typing. Telegram treats this as spam. Do not import supposed anti-ban techniques into the gateway.
