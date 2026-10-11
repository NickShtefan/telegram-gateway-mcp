# Owner draft preparation and qualification

End users follow README Installation. They never build or sign a package. Only the owner prepares a signed draft, in an ordinary private terminal with agents and capture stopped.

## One owner command

Freeze a reviewed commit and its successful Platform foundations CI run. Check out that exact commit in a clean development checkout with dependencies installed. The owner command builds its local helper, downloads all five candidates, verifies artifact digests and manifest hashes from the corresponding CI job logs, and prompts for the encrypted signing key passphrase once:

```sh
npm run release:draft -- --sha FROZEN_FULL_COMMIT_SHA --run SUCCESSFUL_CI_RUN_NUMBER
```

These two identifiers are maintainer inputs, never user installation inputs. The default repository is `NickShtefan/telegram-gateway-mcp`, tag `v0.2.0`. To prepare a distinctly named private test draft, pass `--tag v0.2.0-test.1`. The command rejects a mismatched existing tag/release; it never replaces or publishes one.

Default owner-only file paths (the agent must not inspect them):

- `/Users/nikolayshkolenko/Projects/KEYS/tg-mcp-signing/owner-signing-key.pem`
- `/Users/nikolayshkolenko/Projects/KEYS/tg-mcp-signing/owner-signing-certificate.pem`

If your local filenames differ, supply `--key /your/local/key.pem --certificate /your/local/certificate.pem` yourself. Never put the passphrase in argv/environment, chat, CI or logs. No key/certificate onboarding or rotation is performed. The existing encrypted PKCS#8 RSA-3072 key must be owner-only; the certificate must match the embedded DER fingerprint `f6d3d70c8909d302f24c6853dfb82dad1ab7a2a2006221699002117b6a22c682`.

## Expected result

Before the password prompt all five candidate identities, manifests and payloads have passed verification. After the prompt every candidate is checked again before any signature is written. The output directory contains:

- Five signed archives: macos-arm64, macos-x64, linux-x64, linux-arm64 (`.tar.gz`), windows-x64 (`.zip`).
- `bootstrap-posix.sh`, `bootstrap-windows.ps1`, `SHA256SUMS`.
- Local release notes and diagnostic/download work files; only the eight public assets above are uploaded.

The final result says `draft_release_created` and `published: false`. GitHub Release is created with `--draft` against the frozen SHA. No repository, visibility change, npm package or published release is created. If a failure occurs, preserve the local output and inspect the draft before retrying; an existing draft/tag is not silently overwritten. Missing/expired seven-day CI artifacts require a new successful run of the same chosen source, not a silent source substitution.

## Trust and access

The release target and CI candidates have one source SHA. Manifests bind the exact source/runtime/platform and are signed by the owner. End-user bootstrap derives source SHA only after signature verification. The README pins independently authenticated bootstrap source/checksums; adjacent release assets and unsigned SHA256SUMS alone cannot establish that trust. See README limitations.

Private drafts require authorized GitHub access. The owner can hand the public signed files to a tester without handing over a private key. No anonymous availability is claimed before separate publication/visibility approval. See [outsider-test.md](outsider-test.md).

## Required live qualification

Use fresh, otherwise uninstalled macOS and Windows environments with a new empty ordinary user. A new user on a machine with a global gateway installation is not a clean-install test. Do not delete another user's gateway to make a test pass. Intel lab at `/opt/telegram-gateway-mcp` is excluded.

Follow only README plus the signed draft and record each place that required external help. Also qualify available Intel macOS, Ubuntu 24.04 x64/arm64 and Arch x64 using their checklists. Each machine gets its own fresh Telegram session through gateway login. Never copy sessions. Default checks are read-only; any write needs its own preview and owner consent on the controlled account/channel.

The final qualification review is one independent round before merge/publication; correct medium-or-higher findings and reverify. Merge, publish, repository visibility and npm remain exact owner decisions. A changed final release SHA requires its own artifacts/verification.
