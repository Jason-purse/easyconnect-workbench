import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";

import { ConfigStore, DEFAULT_CONFIG } from "../src/services/config-store.js";

test("DEFAULT_CONFIG keeps maintainer auto-start disabled by default", () => {
  assert.equal(DEFAULT_CONFIG.app.launchAtLogin, false);
  assert.equal(DEFAULT_CONFIG.vpn.maintainerAutoStart, false);
  assert.equal(DEFAULT_CONFIG.vpn.maintainerIntervalSeconds, 300);
  assert.equal(DEFAULT_CONFIG.vpn.maintainerCycleTimeoutMs, 180000);
  assert.equal(DEFAULT_CONFIG.vpn.lastKnownGateway, null);
});

test("ConfigStore persists app launch-at-login preference", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "easyconnect-workbench-config-"));

  try {
    const store = new ConfigStore(tempDir);
    const saved = await store.save({
      app: {
        launchAtLogin: true,
      },
    });

    assert.equal(saved.app.launchAtLogin, true);

    const loaded = await store.load();
    assert.equal(loaded.app.launchAtLogin, true);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("ConfigStore persists maintainer auto-start and interval settings", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "easyconnect-workbench-config-"));

  try {
    const store = new ConfigStore(tempDir);
    const saved = await store.save({
      vpn: {
        username: "demo-user",
        password: "secret",
        maintainerAutoStart: true,
        maintainerIntervalSeconds: 45,
      },
    });

    assert.equal(saved.vpn.maintainerAutoStart, true);
    assert.equal(saved.vpn.maintainerIntervalSeconds, 45);
    assert.equal(saved.vpn.lastKnownGateway, null);

    const loaded = await store.load();
    assert.equal(loaded.vpn.maintainerAutoStart, true);
    assert.equal(loaded.vpn.maintainerIntervalSeconds, 45);
    assert.equal(loaded.vpn.username, "demo-user");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("ConfigStore persists lastKnownGateway as structured vpn state", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "easyconnect-workbench-config-"));

  try {
    const store = new ConfigStore(tempDir);
    const saved = await store.save({
      vpn: {
        lastKnownGateway: {
          host: "203.0.113.10",
          port: 9898,
        },
      },
    });

    assert.deepEqual(saved.vpn.lastKnownGateway, {
      host: "203.0.113.10",
      port: 9898,
    });

    const loaded = await store.load();
    assert.deepEqual(loaded.vpn.lastKnownGateway, {
      host: "203.0.113.10",
      port: 9898,
    });
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("ConfigStore keeps learned gateways when a save omits the gateway list", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "easyconnect-workbench-config-"));

  try {
    const store = new ConfigStore(tempDir);
    await store.save({
      vpn: {
        gateways: [{ host: "203.0.113.10", port: 9898 }],
        lastKnownGateway: { host: "203.0.113.10", port: 9898 },
      },
    });

    const saved = await store.save({
      vpn: {
        username: "demo-user",
        gateways: [],
      },
    });

    assert.equal(saved.vpn.username, "demo-user");
    assert.deepEqual(saved.vpn.gateways, [{ host: "203.0.113.10", port: 9898 }]);
    assert.deepEqual(saved.vpn.lastKnownGateway, { host: "203.0.113.10", port: 9898 });
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
