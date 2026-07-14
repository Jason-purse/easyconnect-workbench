import test from "node:test";
import assert from "node:assert/strict";

import {
  getMaintainerStatusWithQuietHours,
  maybeStartMaintainerAutoStart,
  startMaintainerWithQuietHoursGuard,
} from "../src/services/vpn-autostart.js";

test("getMaintainerStatusWithQuietHours exposes the authoritative current window", () => {
  const config = {
    vpn: {
      maintainerQuietHoursEnabled: true,
      maintainerQuietStart: "18:30",
      maintainerQuietEnd: "09:00",
    },
  };

  const quiet = getMaintainerStatusWithQuietHours({
    config,
    status: { running: false, lastEvent: null },
    nowMs: new Date(2026, 0, 1, 19, 0, 0, 0).getTime(),
  });
  assert.equal(quiet.quietHours.active, true);

  const resumed = getMaintainerStatusWithQuietHours({
    config,
    status: {
      running: false,
      lastEvent: { result: { action: "keepalive-paused-quiet-hours" } },
    },
    nowMs: new Date(2026, 0, 2, 9, 0, 0, 0).getTime(),
  });
  assert.equal(resumed.quietHours.active, false);
});

test("createVpnSmokeConfig applies VPN overrides and disables quiet hours without mutating config", async () => {
  const { createVpnSmokeConfig } = await import("../src/services/vpn-autostart.js");
  assert.equal(typeof createVpnSmokeConfig, "function");

  const config = {
    app: { launchAtLogin: true },
    vpn: {
      maintainerQuietHoursEnabled: true,
      maintainerIntervalSeconds: 300,
    },
  };
  const smokeConfig = createVpnSmokeConfig(
    config,
    { maintainerIntervalSeconds: 10 },
    { ignoreQuietHours: true },
  );

  assert.notEqual(smokeConfig, config);
  assert.notEqual(smokeConfig.vpn, config.vpn);
  assert.equal(smokeConfig.app, config.app);
  assert.equal(smokeConfig.vpn.maintainerIntervalSeconds, 10);
  assert.equal(smokeConfig.vpn.maintainerQuietHoursEnabled, false);
  assert.equal(config.vpn.maintainerIntervalSeconds, 300);
  assert.equal(config.vpn.maintainerQuietHoursEnabled, true);
});

test("startMaintainerWithQuietHoursGuard does not enter VpnMaintainer.start during quiet hours", async () => {
  const calls = [];
  const result = await startMaintainerWithQuietHoursGuard({
    config: {
      vpn: {
        maintainerQuietHoursEnabled: true,
        maintainerQuietStart: "18:30",
        maintainerQuietEnd: "09:00",
      },
    },
    vpnMaintainer: {
      getStatus() {
        calls.push("getStatus");
        return { running: false };
      },
      async start() {
        calls.push("start");
        return { running: true };
      },
    },
    nowMs: new Date(2026, 0, 1, 19, 0, 0, 0).getTime(),
  });

  assert.deepEqual(calls, ["getStatus"]);
  assert.equal(result.running, false);
  assert.equal(result.quietHours.active, true);
  assert.equal(result.startSuppressed, true);
});

test("startMaintainerWithQuietHoursGuard starts normally after quiet hours", async () => {
  const calls = [];
  const config = {
    vpn: {
      maintainerQuietHoursEnabled: true,
      maintainerQuietStart: "18:30",
      maintainerQuietEnd: "09:00",
    },
  };
  const result = await startMaintainerWithQuietHoursGuard({
    config,
    gatewayCandidates: [{ host: "203.0.113.10", port: 9898 }],
    vpnMaintainer: {
      getStatus() {
        return { running: false };
      },
      async start(receivedConfig, options) {
        calls.push({ receivedConfig, options });
        return { running: true };
      },
    },
    nowMs: new Date(2026, 0, 2, 9, 0, 0, 0).getTime(),
  });

  assert.deepEqual(calls, [
    {
      receivedConfig: config,
      options: { gatewayCandidates: [{ host: "203.0.113.10", port: 9898 }] },
    },
  ]);
  assert.equal(result.running, true);
  assert.equal(result.quietHours.active, false);
});

test("maybeStartMaintainerAutoStart leaves disabled auto-start untouched", async () => {
  const calls = [];
  const result = await maybeStartMaintainerAutoStart({
    configStore: {
      async load() {
        calls.push("load");
        return {
          vpn: {
            maintainerAutoStart: false,
          },
        };
      },
    },
    vpnMaintainer: {
      getStatus() {
        calls.push("getStatus");
        return { running: false };
      },
      async start() {
        calls.push("start");
      },
    },
  });

  assert.deepEqual(result, {
    ok: true,
    started: false,
    reason: "disabled",
  });
  assert.deepEqual(calls, ["load"]);
});

test("maybeStartMaintainerAutoStart starts maintainer without persisting the planned gateway", async () => {
  const saved = [];
  const config = {
    vpn: {
      maintainerAutoStart: true,
      username: "demo-user",
      password: "secret",
      gateways: [],
    },
  };

  const result = await maybeStartMaintainerAutoStart({
    configStore: {
      async load() {
        return config;
      },
      async save(nextConfig) {
        saved.push(nextConfig);
        return nextConfig;
      },
    },
    vpnMaintainer: {
      getStatus() {
        return { running: false };
      },
      async start(receivedConfig, options) {
        assert.equal(receivedConfig, config);
        assert.deepEqual(options, { gatewayCandidates: [] });
        return {
          running: true,
          gateway: {
            host: "203.0.113.10",
            port: 9898,
          },
        };
      },
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.started, true);
  assert.equal(result.status.running, true);
  assert.deepEqual(saved, []);
});

test("maybeStartMaintainerAutoStart pauses automatic keepalive during quiet hours and schedules resume", async () => {
  const calls = [];
  let scheduled = null;
  let now = new Date(2026, 0, 1, 19, 0, 0, 0).getTime();
  const result = await maybeStartMaintainerAutoStart({
    nowFn: () => now,
    scheduleFn(callback, delayMs) {
      scheduled = {
        callback,
        delayMs,
      };
      return {
        unref() {},
      };
    },
    configStore: {
      async load() {
        calls.push("load");
        return {
          vpn: {
            maintainerAutoStart: true,
            maintainerQuietHoursEnabled: true,
            maintainerQuietStart: "18:30",
            maintainerQuietEnd: "09:00",
          },
        };
      },
    },
    vpnMaintainer: {
      getStatus() {
        calls.push("getStatus");
        return { running: false };
      },
      async start() {
        calls.push("start");
        return {
          running: true,
        };
      },
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.started, false);
  assert.equal(result.reason, "quiet-hours");
  assert.equal(result.quietHours.start, "18:30");
  assert.equal(result.quietHours.end, "09:00");
  assert.equal(typeof result.quietHours.nowLocal, "string");
  assert.equal(typeof result.quietHours.resumeAt, "string");
  assert.equal(result.scheduledResume, true);
  assert.equal(result.nextStartMs, 14 * 60 * 60 * 1000);
  assert.equal(scheduled.delayMs, 14 * 60 * 60 * 1000);
  assert.deepEqual(calls, ["load"]);

  now = new Date(2026, 0, 2, 9, 0, 0, 0).getTime();
  await scheduled.callback();

  assert.deepEqual(calls, ["load", "load", "getStatus", "start"]);
});

test("quiet-hours resume retries a transient VPN guard conflict without piling timers", async () => {
  const scheduled = [];
  let now = new Date(2026, 0, 1, 19, 0, 0, 0).getTime();
  let startAttempts = 0;
  const result = await maybeStartMaintainerAutoStart({
    nowFn: () => now,
    scheduleFn(callback, delayMs) {
      scheduled.push({ callback, delayMs });
      return { unref() {} };
    },
    configStore: {
      async load() {
        return {
          vpn: {
            maintainerAutoStart: true,
            maintainerQuietHoursEnabled: true,
            maintainerQuietStart: "18:30",
            maintainerQuietEnd: "09:00",
          },
        };
      },
    },
    vpnMaintainer: {
      getStatus() {
        return { running: false };
      },
      async start() {
        startAttempts += 1;
        if (startAttempts === 1) {
          const error = new Error("VPN action recover-login is already in progress");
          error.code = "EASYCONNECT_VPN_ACTION_IN_PROGRESS";
          error.activeKey = "recover-login";
          throw error;
        }
        return { running: true };
      },
    },
    logger: {
      warn() {},
    },
  });

  assert.equal(result.reason, "quiet-hours");
  assert.equal(scheduled.length, 1);
  const initialResume = scheduled.shift();
  now = new Date(2026, 0, 2, 9, 0, 0, 0).getTime();
  await initialResume.callback();

  assert.equal(startAttempts, 1);
  assert.equal(scheduled.length, 1);
  assert.ok(scheduled[0].delayMs > 0);
  assert.ok(scheduled[0].delayMs <= 30_000);

  const retry = scheduled.shift();
  await retry.callback();

  assert.equal(startAttempts, 2);
  assert.equal(scheduled.length, 0);
});

test("maybeStartMaintainerAutoStart can explicitly bypass quiet hours for smoke verification", async () => {
  const calls = [];
  const config = {
    vpn: {
      maintainerAutoStart: true,
      maintainerQuietHoursEnabled: true,
      maintainerQuietStart: "18:30",
      maintainerQuietEnd: "09:00",
    },
  };
  const result = await maybeStartMaintainerAutoStart({
    ignoreQuietHours: true,
    nowFn: () => new Date(2026, 0, 1, 19, 0, 0, 0).getTime(),
    configStore: {
      async load() {
        calls.push("load");
        return config;
      },
    },
    vpnMaintainer: {
      getStatus() {
        calls.push("getStatus");
        return { running: false };
      },
      async start(receivedConfig) {
        calls.push("start");
        assert.notEqual(receivedConfig, config);
        assert.equal(receivedConfig.vpn.maintainerQuietHoursEnabled, false);
        assert.equal(config.vpn.maintainerQuietHoursEnabled, true);
        return { running: true };
      },
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.started, true);
  assert.equal(result.status.running, true);
  assert.deepEqual(calls, ["load", "getStatus", "start"]);
});

test("maybeStartMaintainerAutoStart reports start failures without throwing", async () => {
  const logs = [];
  const result = await maybeStartMaintainerAutoStart({
    configStore: {
      async load() {
        return {
          vpn: {
            maintainerAutoStart: true,
          },
        };
      },
    },
    vpnMaintainer: {
      getStatus() {
        return { running: false };
      },
      async start() {
        throw new Error("missing password");
      },
    },
    logger: {
      warn(...args) {
        logs.push(args);
      },
    },
  });

  assert.deepEqual(result, {
    ok: false,
    started: false,
    error: "missing password",
  });
  assert.equal(logs.length, 1);
});

test("maybeStartMaintainerAutoStart preserves transient VPN guard failure metadata", async () => {
  const result = await maybeStartMaintainerAutoStart({
    configStore: {
      async load() {
        return {
          vpn: {
            maintainerAutoStart: true,
          },
        };
      },
    },
    vpnMaintainer: {
      getStatus() {
        return { running: false };
      },
      async start() {
        const error = new Error("VPN action recover-login is already in progress");
        error.code = "EASYCONNECT_VPN_ACTION_IN_PROGRESS";
        error.activeKey = "recover-login";
        throw error;
      },
    },
    logger: {
      warn() {},
    },
  });

  assert.deepEqual(result, {
    ok: false,
    started: false,
    error: "VPN action recover-login is already in progress",
    code: "EASYCONNECT_VPN_ACTION_IN_PROGRESS",
    activeKey: "recover-login",
  });
});
