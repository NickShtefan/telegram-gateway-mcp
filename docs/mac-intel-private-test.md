# Private installation check: Intel Mac

Target: macOS x64. The working Intel lab at /opt/telegram-gateway-mcp is excluded. Use another uninstalled Intel Mac or a clean VM; do not stop or alter the lab service.

## Steps and expected results

1. Obtain the owner-signed draft and trusted README/bootstrap. Private draft access is a prerequisite; do not use unsigned CI files as a user installer.
2. Select the matching archive from the README table. Download it and the pinned bootstrap into Downloads. Expected: no build, npm or local signing operation.
3. Run the three README commands exactly. Expected: checksum OK; signature/source/platform checks succeed; protected service provisioning ends with needs_api_credentials and the service is not yet started.
4. Run the installed owner wizard as an ordinary user. Explain/accept defaults or use stable local labels. Type OWNER READY only after agents/capture are stopped. Enter Telegram application credentials, phone/code/2FA directly into hidden prompts.
5. Select a client and approve only an explicitly shown conflicting-entry replacement. Expected: sdk_connectivity_verified true, tokens absent from output, command returns without hanging.
6. Restart the chosen client and request a real telegram_gateway tg_status call. Expected: the chosen account connected. Plain prose or SDK-only success is insufficient.
7. Repeat the same wizard/candidate with the same labels. Expected: no token rotation or new Telegram login. In a separate trial, cancel and resume while preserving state.
8. Record safe OS/client versions, source/public certificate/manifest hashes, step outcomes and error codes in [outsider-test.md](outsider-test.md). Current live result: **not run**. Never include secret values or recordings.

Each machine creates its own gateway session; never copy from another project/machine. Default private chats and writes remain closed. Real writes, migration, destructive uninstall and publication are separate owner actions.
