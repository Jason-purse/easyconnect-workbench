# EasyConnect Workbench

EasyConnect Workbench is a focused macOS companion for one job: automatically restoring an authorized EasyConnect connection and keeping it healthy without turning the desktop into an operations console.

It does not include or replace EasyConnect, and it does not bypass authentication. It drives the already-installed official client, keeps recovery inside configured hours, lives quietly in the tray, and presents the current connection state and next action in one compact window.

## What It Does

- Automatically logs in and restores the VPN through the installed official EasyConnect client.
- Keeps the connection alive with lightweight checks and controlled recovery attempts.
- Verifies a configured internal endpoint through a `utun*` route before claiming the connection is protected.
- Respects configurable quiet hours, including the default `18:30-09:00` overnight pause.
- Lives in the macOS tray and shows the current connection, maintainer, gateway, session, and service state.
- Keeps account, gateway, launch-at-login, interval, and diagnostic settings local to this machine.
- Explains recoverable failures and keeps raw recovery data behind an advanced diagnostic section.
- Packages and verifies as a macOS `.app` without bundling the official EasyConnect runtime.

## Intended Use

This project is for authorized personal or team environments where users already have valid EasyConnect credentials and permission to access the VPN gateway.

Do not use it against systems you are not authorized to access. Do not publish your real gateway, username, password, logs, session IDs, cookies, tokens, or local configuration.

## Requirements

- macOS
- Node.js 20+
- An installed official EasyConnect client, usually at:

```text
/Applications/EasyConnect.app/Contents/MacOS/EasyConnect
```

## Development

```bash
npm install
npm run build:css
npm test
npm run qa:renderer-keyboard
npm start
```

`qa:renderer-keyboard` serves the real renderer on a temporary loopback port and drives it with a discovered Playwright CLI against a fully stubbed `window.workbench`. It checks `PLAYWRIGHT_CLI`, `CODEX_HOME`, `~/.codex/bin`, then `PATH`. The QA covers keyboard behavior and sanitized activity details without starting Electron, EasyConnect, or any VPN operation.

## Packaging

```bash
npm run package:mac
```

The packaged app is written to:

```text
dist.noindex/EasyConnect Workbench.app
```

The `.noindex` suffix keeps macOS Spotlight from showing the local build output as a second launchable app. The intended installed entry is:

```text
/Applications/EasyConnect Workbench.app
```

## Agent CLI

After installing the packaged app, install the command and its Codex skill:

```bash
npm run install:cli
```

The installer creates stable links at `~/.local/bin/easyconnect-vpn` and `$CODEX_HOME/skills/easyconnect-vpn-cli` (or `~/.codex/skills/easyconnect-vpn-cli`). Both links point into the installed app bundle and remain valid when that bundle is replaced in place.

Use JSON output for scripts and agents:

```bash
easyconnect-vpn --json status
easyconnect-vpn --json ensure
easyconnect-vpn --json keepalive start
easyconnect-vpn --json keepalive stop
easyconnect-vpn --json config
```

`status` is read-only and succeeds only when the official control plane is online and the configured internal target is currently reachable through a `utun*` route. `ensure` is idempotent while healthy. When the control plane and tunneled route remain online but the internal target probe fails, each decision to recover or escalate to a forced client restart requires three consecutive fresh failures with 500 ms between attempts; any successful attempt avoids that recovery step. Mutating `ensure` and keepalive commands wait for Workbench's authoritative result instead of reporting a client timeout while the underlying VPN action continues; `--timeout-seconds` is accepted only by read-only `status` and `config`. Quiet hours are respected by default. Use `--ignore-quiet-hours` only for an explicit active task that requires VPN access during the configured pause.

Exit code `0` means ready/success, `2` means invalid usage, `3` means VPN health or configuration is not ready, and `4` means the installed Workbench command service is unavailable. The CLI never returns the stored username or password, and session identifiers are masked in command output.

## Installed Smoke Verification

`verify:mvp-installed` is intentionally local-environment dependent. It reads gateways from the saved Workbench config by default, or from `EASYCONNECT_VERIFY_GATEWAYS`.

```bash
EASYCONNECT_VERIFY_GATEWAYS="vpn.example.com:9898" npm run verify:mvp-installed
```

This command can stop and restart the installed Workbench app while verifying lifecycle, packaging, hidden startup, controlled VPN recovery, configuration safety, and idle CPU behavior. Run it only when temporarily disconnecting the current VPN is acceptable.

Foreground repair of the third-party EasyConnect native window is intentionally separate from this MVP verifier. Use `npm run smoke:packaged-official-ui-repair` only as an opt-in diagnostic on an unlocked desktop.

## Configuration Notes

Workbench stores its local config under the app's user data directory, for example:

```text
~/Library/Application Support/easyconnect-workbench/config.json
```

The current app stores the VPN password in local JSON. Protect the machine and never commit or share this file.

Gateway examples in tests and docs use documentation-only addresses such as `203.0.113.10` and `198.51.100.20`. Replace them with your own authorized gateway inside the app UI or local config.

Configure an authorized internal data-plane target in Settings to distinguish a usable tunnel from stale local EasyConnect state. Supported forms are `tcp://host:port`, `http://host/path`, and `https://host/path`; for example, `tcp://192.0.2.10:443`. A successful probe only counts when macOS routes the selected address through a `utun*` interface. Workbench reports the connection as unverified when no target is configured, and it never ships with a private target as a default.

## Project Boundary

This repository is an open-source workbench around a locally installed official client. It is not a VPN implementation, a credential bypass, or a redistributed EasyConnect runtime.

The product boundary is deliberately narrow: automatic login, connection recovery, keepalive, quiet hours, tray residency, local settings, and user-facing diagnosis. Build, release, publishing, and unrelated platform aggregation are not product responsibilities.

## License

MIT
