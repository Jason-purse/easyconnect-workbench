---
name: easyconnect-vpn-cli
description: Use when company or private-network project work may require the authorized EasyConnect VPN, especially before database access, internal API calls, integration or browser automation, or automated tests, or when those operations fail and VPN health must be separated from an application defect. Uses the installed easyconnect-vpn CLI for fresh data-plane verification, explicit recovery, and keepalive control.
---

# EasyConnect VPN CLI

Use the installed `easyconnect-vpn` command. It is a thin client to EasyConnect Workbench and does not reimplement login or expose stored credentials.

## Required Gate

Before a company-network database, API, integration, browser automation, or automated-test operation, run:

```bash
easyconnect-vpn --json status
```

Proceed only when the exit code is `0`, `healthy` is `true`, `dataPlane.ok` is `true`, and `dataPlane.route.tunneled` is `true`. This is stronger than checking the EasyConnect session alone because a stale session can report control-plane online while the internal route is unusable.

## Recovery

When `status` exits `3`, inspect `reason` before acting:

- `data-plane-unconfigured` or `credentials-unconfigured`: stop and have the user configure Workbench. Do not invent endpoints or credentials.
- Other offline or unreachable states: run `easyconnect-vpn --json ensure`.

When the control plane and tunneled route remain online but the internal target probe fails, each `ensure` decision to recover or escalate to a forced client restart requires three consecutive fresh failures, 500 ms apart; any successful attempt avoids that recovery step. If `ensure` reports `quiet-hours`, do not bypass automatically. Only for an explicit active task that currently requires private-network access, rerun it with `--ignore-quiet-hours`.

Then rerun `status` and require the full gate again. `ensure` may restart the official EasyConnect process and core services only after normal recovery still leaves the data plane unhealthy. Do not use it when the user has prohibited VPN interruption.

Do not add `--timeout-seconds` or wrap `ensure` in a client deadline. Mutating commands wait for the Workbench-owned operation to finish so an Agent never reports timeout while VPN state is still changing; the timeout option is only for read-only `status` and `config`.

## Keepalive

Normal `ensure` starts keepalive. Use explicit lifecycle commands only when the task requires them:

```bash
easyconnect-vpn --json keepalive start
easyconnect-vpn --json keepalive stop
```

Production quiet hours remain active unless the command explicitly includes `--ignore-quiet-hours`.

## Failure Handling

- Exit `2`: correct syntax with `easyconnect-vpn --help`.
- Exit `3`: treat VPN health or configuration as the current blocker; do not diagnose the application or database as broken yet.
- Exit `4`: verify `/Applications/EasyConnect Workbench.app` exists and reinstall the entry from the Workbench repo with `npm run install:cli`.
- Other nonzero exit: report `error.code` and `error.message`; do not run smoke verification as a normal recovery command.

Never run `verify:mvp-installed` or `smoke:*` during ordinary company-project activity. Those acceptance tools may deliberately disconnect or mutate VPN state.
