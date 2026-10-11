# User installation

The current user entry is [README Installation](../README.md#installation). Choose the signed archive for your platform, download bootstrap from the pinned immutable source, then run the three commands: automatic bootstrap checksum check, authorized installation and ordinary-user wizard. No Node/npm, compilation, user signature or manually entered hashes are required.

The bootstrap accepts a transport archive. It safely reads only nine fixed regular files in private staging, verifies the pinned DER certificate and RSA signature, obtains the source SHA from the authenticated manifest, validates each payload and only then executes bundled Node. Legacy folder/source invocations remain for maintainer diagnostics, not the normal user route.

POSIX service identity/code/state are separate from the owner profile. Windows uses a virtual service account and administrator-owned ACLs; the short wizard command is `C:\ProgramData\TelegramMCPGateway\bin\tg-mcp-owner.cmd setup`. Initial installation creates an unstarted service, then the ordinary-user wizard performs protected login/client handoff and SDK verification. Default tools are core, with private chats and writes closed.

Keep the same candidate across cancellation/resume. Another source/certificate, foreign installation or corrupted state is not silently adopted. Do not delete/copy sessions or reinstall over an uncertain result. Provider sign-in and actual model tool loading remain separate from SDK connectivity.

Maintainer release signing is in [release-qualification.md](release-qualification.md). Human test checklists: [ARM Mac](mac-arm-private-test.md), [Intel Mac](mac-intel-private-test.md), [Windows](windows-private-test.md), [Linux](linux-private-test.md), [README-only acceptance](outsider-test.md).
