# README-only installation acceptance

This is an execution checklist, not a claim of completed live qualification. Automated archive/signature/parser tests do not replace a new-user install.

## Environment and access

Use a fresh macOS arm64 VM or otherwise uninstalled test Mac and a fresh Windows 11 x64 VM/test computer. Create a new empty ordinary OS user yourself. Do not reuse a global installation, copy a Telegram session, change the Intel lab, or ask an agent to handle a signing key/password/login code.

Start with only README and the owner-signed draft. GitHub private drafts need authorized access and are not visible to anonymous/read-only outsiders in the same way as a public release. The owner must arrange appropriate draft access or hand over the public signed assets plus an independently trusted README/bootstrap. Record this limitation as an access prerequisite, not a successful anonymous test.

## Trial

1. Let the tester choose the correct asset using only README. Record confusion around arm64/Intel, Linux architecture and draft access.
2. Download the archive and immutable bootstrap. Run the three README commands; no Node/npm, compiler, local signing or typed hashes may be required.
3. Approve system changes manually. On Linux inspect/confirm only the displayed official-source prerequisite transaction with `INSTALL`.
4. Complete wizard defaults, API application creation, phone/code/2FA and client selection. Secrets remain in the human terminal with agents/capture stopped.
5. Restart the selected client and observe a real `telegram_gateway` / `tg_status` call. SDK success without model tool loading is incomplete.
6. Repeat the same setup without a new login/token. Test cancellation/retry on the same candidate in a separate controlled run. Preserve state on failures.

## Evidence sheet

| Target | OS/build and candidate SHA | Commands before wizard | Needed help or external lookup | SDK / model tool result | Result |
| --- | --- | --- | --- | --- | --- |
| New macOS arm64 user | Pending owner execution | Pending | Pending | Pending | Not run |
| New Windows 11 x64 user | Pending owner execution | Pending | Pending | Pending | Not run |
| Intel macOS (not lab) | Pending | Pending | Pending | Pending | Not run |
| Ubuntu 24.04 x64/arm64 | Pending | Pending | Pending | Pending | Not run |
| Arch x64 | Pending; record snapshot/package versions | Pending | Pending | Pending | Not run |

Record only safe metadata/error codes and where wording failed. Do not attach client-profile contents, tokens, sessions, secret-terminal recordings or screenshots. Mark a row passed only after executing it. Publication is outside this checklist.
