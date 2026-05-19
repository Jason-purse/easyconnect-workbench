# EasyConnect Workbench

EasyConnect Workbench is a local Electron helper for macOS users who need a clearer, more reliable control surface around an already-installed Sangfor EasyConnect VPN client.

It does not include EasyConnect, does not replace EasyConnect, and does not bypass authentication. It launches and observes the official local client, keeps the VPN session alive when possible, and explains recovery failures in a way that is easier to act on than the default client UI.

## What It Does

- Stores local VPN settings: username, password, gateway list, debug port, and EasyConnect executable path.
- Starts the official EasyConnect client from the Workbench UI.
- Restores a VPN session through the official renderer/API bridge, with backend session grafting only as a fallback.
- Keeps a background maintainer running from the tray: lightweight online checks when connected, recovery attempts when offline.
- Repairs visible official-client UI drift when the VPN is already online but the EasyConnect window is stuck on a loading, login, or gateway page.
- Shows human-readable status for common failure modes such as unreachable gateways, captcha-required login, local service not ready, private-kick logout, or inconsistent official UI state.
- Packages as a macOS `.app` without bundling the official EasyConnect runtime.

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
npm test
npm start
```

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

This command can stop and restart the installed Workbench app while verifying lifecycle, packaging, hidden startup, VPN recovery, and CPU behavior.

## Configuration Notes

Workbench stores its local config under the app's user data directory, for example:

```text
~/Library/Application Support/easyconnect-workbench/config.json
```

The current MVP stores the VPN password in local JSON. That is acceptable for a small personal utility, but you should protect the machine and never commit this file.

Gateway examples in tests and docs use documentation-only addresses such as `203.0.113.10` and `198.51.100.20`. Replace them with your own authorized gateway inside the app UI or local config.

## Project Boundary

This repository is an open-source workbench around a locally installed official client. It is not a VPN implementation, a credential bypass, or a redistributed EasyConnect runtime.

The project exists to make a fragile operational workflow observable and recoverable: status inspection, controlled launch, session recovery, keepalive, user-facing diagnosis, and local packaging.

## License

MIT
