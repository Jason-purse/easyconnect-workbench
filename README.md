# EasyConnect Workbench

EasyConnect Workbench is a focused macOS companion for one job: automatically restoring an authorized EasyConnect connection and keeping it healthy without turning the desktop into an operations console.

It does not include or replace EasyConnect, and it does not bypass authentication. It drives the already-installed official client, keeps recovery inside configured hours, lives quietly in the tray, and presents the current connection state and next action in one compact window.

## What It Does

- Automatically logs in and restores the VPN through the installed official EasyConnect client.
- Keeps the connection alive with lightweight checks and controlled recovery attempts.
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

`qa:renderer-keyboard` serves the real renderer on a temporary loopback port and drives it with the pinned Playwright CLI against a fully stubbed `window.workbench`. It verifies the settings drawer's focus trap, Escape focus restoration, and Enter submission without starting Electron, EasyConnect, or any VPN operation.

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

## Installed Smoke Verification

`verify:mvp-installed` is intentionally local-environment dependent. It reads gateways from the saved Workbench config by default, or from `EASYCONNECT_VERIFY_GATEWAYS`.

```bash
EASYCONNECT_VERIFY_GATEWAYS="vpn.example.com:9898" npm run verify:mvp-installed
```

This command can stop and restart the installed Workbench app while verifying lifecycle, packaging, hidden startup, controlled VPN recovery, configuration safety, and idle CPU behavior. Run it only when temporarily disconnecting the current VPN is acceptable.

## Configuration Notes

Workbench stores its local config under the app's user data directory, for example:

```text
~/Library/Application Support/easyconnect-workbench/config.json
```

The current app stores the VPN password in local JSON. Protect the machine and never commit or share this file.

Gateway examples in tests and docs use documentation-only addresses such as `203.0.113.10` and `198.51.100.20`. Replace them with your own authorized gateway inside the app UI or local config.

## Project Boundary

This repository is an open-source workbench around a locally installed official client. It is not a VPN implementation, a credential bypass, or a redistributed EasyConnect runtime.

The product boundary is deliberately narrow: automatic login, connection recovery, keepalive, quiet hours, tray residency, local settings, and user-facing diagnosis. Build, release, publishing, and unrelated platform aggregation are not product responsibilities.

## License

MIT
