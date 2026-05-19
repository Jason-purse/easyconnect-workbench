import test from "node:test";
import assert from "node:assert/strict";

import { maybeStartMaintainerAutoStart } from "../src/services/vpn-autostart.js";

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
