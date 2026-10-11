# Agent-assisted installation: 0.2.0 candidate

Use the same versioned artifacts, verifier and managed owner workflow as `install-owner.md`. The agent is a presenter/preparer, not the owner credential/elevation authority. The gateway itself runs no model, watches no chats and generates no agent tasks.

A reusable installation prompt:

> Prepare the owner-approved exact 0.2.0 platform bundle for Unofficial Telegram MCP Gateway. Inspect the OS/architecture and existing installation/port without opening gateway state. Use the versioned independently trusted verifier and expected signer/source identifiers. Do not execute agent-writable/unverified code elevated. Present the concrete installation locations, default core-only permissions and owner actions. Stop before human credentials/system authorization. The owner enters them in an ordinary human terminal with agents and capture stopped. After the owner finishes, distinguish protected provisioning, fresh service/listener/MCP evidence, selected profile configuration, client reload and actual model tool loading. Never ask for, print, copy or put credentials/session strings into chat, argv, environment, logs or screenshots. Do not assume a setup UUID or human “done” message grants authority. Preserve valid completed state and use controlled owner resources for verification.

The preparation steps are the same for both entries:

1. Select the exact verified platform/architecture/LTS candidate; do not choose another version silently. Inspect prerequisites and conflicts read-only. `setup preflight` is a bounded read-only command, not proof of installation state.
2. Prepare immutable verification information for the human. The human independently establishes verifier code, signer fingerprint and source commit, then owns elevation. Current private GitHub history is excluded from the public snapshot.
3. Hand off to the same trusted no-Node bootstrap and ordinary owner launcher described in `install-owner.md`. Stop all agent/capture operations during human input. Do not use browser/native automation, clipboard or screenshots to handle secrets.
4. Resume from actual protected installation receipts and service state. “Approved” or “finished” text does not replace inspection. Existing matching stages remain; foreign state, changed releases, denied permissions, invalid ACLs or uncertain writes require the documented next action.
5. Verify the intended service/process/listener, authenticated MCP/defaults and each selected client's actual tools separately. Provider installation/sign-in remains outside gateway setup. Use fake Telegram first, then the owner-controlled account/channel with a fresh local session. Every real write needs its own preview and owner consent before `tg_confirm`.

Default adapters target only the selected user's default profiles. Recognized custom profile overrides are rejected, with no guessed path or silent overwrite. The selected clients' bearer credentials are expected to be readable by their OS identity; Telegram/admin material remains service-private. No independent same-user input protection or human-write-consent enforcement is claimed.

Do not report release-ready from a generated definition, green tests or SDK connectivity. Record exact candidate/CI/artifact/runtime/client evidence and unresolved qualification gates. Repository creation, npm onboarding, required protections/private security reporting and exact owner merge/release approval remain separate publication gates. Never make the current private repository public or transfer its history.
