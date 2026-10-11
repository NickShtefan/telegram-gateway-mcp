# Owner setup wizard

Run the installed tg-mcp-owner setup as the original ordinary OS user. The launcher requests scoped elevation for the protected coordinator; do not run the launcher with sudo. Windows uses C:\ProgramData\TelegramMCPGateway\bin\tg-mcp-owner.cmd setup.

The wizard explains OWNER READY (human-controlled terminal and disabled agent/capture), local account/user labels with Enter defaults, Telegram API application creation, hidden phone/code/2FA entry and selected client configuration. Account id is not Telegram username; user id is not OS identity. API credentials are requested only when required; a failed first login does not cache an unverified pair. An existing session needing missing credentials is a repair error, not a new-login prompt.

One setup/session lease controls the private worker. The coordinator proves the fixed installed code, service identity and private state before dropping supplementary groups/gid/uid. Every MTProto call goes through the account limiter; session is durably saved before cleanup can terminate a hung login client. Workers/coordinator close their private pipes after their final frame, with bounded exit/cancellation. Prior supervisor registration/recovery/running state is captured in a protected marker and restored after cancellation, crashes or non-activating runs.

The login worker exits and releases its session before daemon startup. Service/listener ownership is proven before credential handoff. The original-user profile adapters write selected client credentials directly; tokens never appear in terminal/logs. A conflicting gateway entry needs explicit REPLACE consent and unrelated settings are preserved. Encrypted pending handoff persists until client configuration, SDK probe and token-hash acknowledgement succeed. The DB-only acknowledgement does not create another MTProto client.

Successful SDK setup prints safe evidence and tells the human which clients to restart and how to request an actual telegram_gateway tg_status call. SDK success is distinct from model tool loading. Defaults keep private chats/writes disabled. Repeat setup preserves sessions, grants and tokens; foreign/corrupt state or another release is not silently adopted.

Same-user software can observe human input/profile credentials, so agents and capture remain stopped during secret entry. Service isolation protects session/state from ordinary profiles; it is not a claim of protection from arbitrary software with the same user's privileges or approved sudo.
