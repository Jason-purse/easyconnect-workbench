import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";

import { ConfigStore, DEFAULT_CONFIG } from "../src/services/config-store.js";

test("DEFAULT_CONFIG keeps maintainer auto-start disabled by default", () => {
  assert.equal(DEFAULT_CONFIG.app.launchAtLogin, false);
  assert.equal(DEFAULT_CONFIG.vpn.maintainerAutoStart, false);
  assert.equal(DEFAULT_CONFIG.vpn.maintainerIntervalSeconds, 300);
  assert.equal(DEFAULT_CONFIG.vpn.maintainerCycleTimeoutMs, 180000);
  assert.equal(DEFAULT_CONFIG.vpn.maintainerQuietHoursEnabled, true);
  assert.equal(DEFAULT_CONFIG.vpn.maintainerQuietStart, "18:30");
  assert.equal(DEFAULT_CONFIG.vpn.maintainerQuietEnd, "09:00");
  assert.equal(DEFAULT_CONFIG.vpn.lastKnownGateway, null);
  assert.equal(Object.hasOwn(DEFAULT_CONFIG, "portals"), false);
});

test("ConfigStore ignores legacy platform credentials when loading old config", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "easyconnect-workbench-config-"));

  try {
    await writeFile(
      path.join(tempDir, "config.json"),
      JSON.stringify({
        app: { launchAtLogin: true },
        vpn: { username: "demo-user", gateways: [{ host: "203.0.113.10", port: 9898 }] },
        portals: {
          build: { username: "legacy-build", password: "legacy-secret" },
          release: { username: "legacy-release", password: "legacy-secret" },
        },
      }),
    );

    const loaded = await new ConfigStore(tempDir).load();
    assert.equal(loaded.app.launchAtLogin, true);
    assert.equal(loaded.vpn.username, "demo-user");
    assert.equal(Object.hasOwn(loaded, "portals"), false);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("ConfigStore removes legacy platform credentials from disk on the next save", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "easyconnect-workbench-config-"));
  const configPath = path.join(tempDir, "config.json");

  try {
    await writeFile(
      configPath,
      JSON.stringify({
        app: { launchAtLogin: false },
        vpn: { username: "demo-user" },
        portals: {
          build: { username: "legacy-build", password: "legacy-build-secret" },
          release: { username: "legacy-release", password: "legacy-release-secret" },
        },
      }),
    );

    const store = new ConfigStore(tempDir);
    const loaded = await store.load();
    await store.save(loaded);

    const persisted = JSON.parse(await readFile(configPath, "utf8"));
    const serialized = JSON.stringify(persisted);
    assert.equal(Object.hasOwn(persisted, "portals"), false);
    assert.equal(serialized.includes("legacy-build-secret"), false);
    assert.equal(serialized.includes("legacy-release-secret"), false);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
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
        maintainerQuietHoursEnabled: false,
        maintainerQuietStart: "20:00",
        maintainerQuietEnd: "08:30",
      },
    });

    assert.equal(saved.vpn.maintainerAutoStart, true);
    assert.equal(saved.vpn.maintainerIntervalSeconds, 45);
    assert.equal(saved.vpn.maintainerQuietHoursEnabled, false);
    assert.equal(saved.vpn.maintainerQuietStart, "20:00");
    assert.equal(saved.vpn.maintainerQuietEnd, "08:30");
    assert.equal(saved.vpn.lastKnownGateway, null);

    const loaded = await store.load();
    assert.equal(loaded.vpn.maintainerAutoStart, true);
    assert.equal(loaded.vpn.maintainerIntervalSeconds, 45);
    assert.equal(loaded.vpn.maintainerQuietHoursEnabled, false);
    assert.equal(loaded.vpn.maintainerQuietStart, "20:00");
    assert.equal(loaded.vpn.maintainerQuietEnd, "08:30");
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
