import test from "node:test";
import assert from "node:assert/strict";

import { createVpnActionGuard } from "../src/services/vpn-action-guard.js";

async function loadVpnMaintainer() {
  return import("../src/services/vpn-maintainer.js").catch(() => ({}));
}

function createDeferred() {
  let resolve;
  let reject;
  const promise = new Promise((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
}

test("VpnMaintainer holds the shared VPN guard for the full automatic cycle", async () => {
  const { VpnMaintainer } = await loadVpnMaintainer();
  const guard = createVpnActionGuard();
  const cycleEntered = createDeferred();
  const releaseCycle = createDeferred();
  let manualCalls = 0;

  const manager = new VpnMaintainer({
    actionRunner: (key, operation) => guard.run(key, operation, { scope: "maintainer" }),
    runtimeFactory: () => ({
      async disableOfficialAutoConnectBeforeLaunch() {
        return { ok: true, action: "disabled" };
      },
    }),
    ensureOnlineFn: async () => {
      cycleEntered.resolve();
      await releaseCycle.promise;
      return { action: "already-online" };
    },
    maintainOnlineFn: async ({ ensureOnlineFn, onCycle, signal }) => {
      const result = await ensureOnlineFn({ signal });
      await onCycle({ ok: true, result });
      await new Promise((resolve) => {
        if (signal.aborted) {
          resolve();
          return;
        }
        signal.addEventListener("abort", resolve, { once: true });
      });
    },
  });

  const started = manager.start({
    vpn: {
      username: "demo-user",
      password: "secret",
      gateways: [{ host: "198.51.100.20", port: 9898 }],
    },
  });

  try {
    await cycleEntered.promise;
    await assert.rejects(
      guard.run("recover-login", () => {
        manualCalls += 1;
        return { ok: true };
      }),
      (error) => {
        assert.equal(error.code, "EASYCONNECT_VPN_ACTION_IN_PROGRESS");
        assert.equal(error.activeKey, "maintainer-cycle");
        return true;
      },
    );
    assert.equal(manualCalls, 0);
  } finally {
    releaseCycle.resolve();
    await started;
    await manager.stop();
  }
});

test("VpnMaintainer holds the shared VPN guard while disabling official auto-connect", async () => {
  const { VpnMaintainer } = await loadVpnMaintainer();
  const guard = createVpnActionGuard();
  const initializationEntered = createDeferred();
  const releaseInitialization = createDeferred();
  let manualCalls = 0;

  const manager = new VpnMaintainer({
    actionRunner: (key, operation) => guard.run(key, operation, { scope: "maintainer" }),
    runtimeFactory: () => ({
      async disableOfficialAutoConnectBeforeLaunch() {
        initializationEntered.resolve();
        await releaseInitialization.promise;
        return { ok: true, action: "disabled" };
      },
    }),
    maintainOnlineFn: async ({ signal }) => {
      await new Promise((resolve) => {
        if (signal.aborted) {
          resolve();
          return;
        }
        signal.addEventListener("abort", resolve, { once: true });
      });
    },
  });
  const started = manager.start({
    vpn: {
      username: "demo-user",
      password: "secret",
      gateways: [{ host: "198.51.100.20", port: 9898 }],
    },
  });

  try {
    await initializationEntered.promise;
    await assert.rejects(
      guard.run("recover-login", () => {
        manualCalls += 1;
        return { ok: true };
      }),
      (error) => {
        assert.equal(error.code, "EASYCONNECT_VPN_ACTION_IN_PROGRESS");
        assert.equal(error.activeKey, "maintainer-initialize");
        return true;
      },
    );
    assert.equal(manualCalls, 0);
  } finally {
    releaseInitialization.resolve();
    await started;
    await manager.stop();
  }
});

test("VpnMaintainer coalesces concurrent starts before initialization completes", async () => {
  const { VpnMaintainer } = await loadVpnMaintainer();
  const initializationEntered = createDeferred();
  const releaseInitialization = createDeferred();
  const finishLoops = [];
  let runtimeCount = 0;
  let loopCount = 0;

  const manager = new VpnMaintainer({
    runtimeFactory: () => {
      runtimeCount += 1;
      return {
        async disableOfficialAutoConnectBeforeLaunch() {
          initializationEntered.resolve();
          await releaseInitialization.promise;
          return { ok: true, action: "disabled" };
        },
      };
    },
    maintainOnlineFn: async () => {
      loopCount += 1;
      await new Promise((resolve) => finishLoops.push(resolve));
    },
  });
  const config = {
    vpn: {
      username: "demo-user",
      password: "secret",
      gateways: [{ host: "198.51.100.20", port: 9898 }],
    },
  };
  const first = manager.start(config);
  await initializationEntered.promise;
  const second = manager.start(config);

  try {
    releaseInitialization.resolve();
    await Promise.all([first, second]);
    assert.equal(runtimeCount, 1);
    assert.equal(loopCount, 1);
  } finally {
    releaseInitialization.resolve();
    finishLoops.forEach((finish) => finish());
    await Promise.allSettled([first, second]);
    await manager.stop();
  }
});

test("VpnMaintainer stop waits for an in-flight start to publish its execution", async () => {
  const { VpnMaintainer } = await loadVpnMaintainer();
  const startEventEntered = createDeferred();
  const releaseStartEvent = createDeferred();

  const manager = new VpnMaintainer({
    eventLogger: {
      async write(event) {
        if (event === "maintainer-started") {
          startEventEntered.resolve();
          await releaseStartEvent.promise;
        }
      },
    },
    runtimeFactory: () => ({
      async disableOfficialAutoConnectBeforeLaunch() {
        return { ok: true, action: "disabled" };
      },
    }),
    maintainOnlineFn: async ({ signal }) => {
      await new Promise((resolve) => {
        if (signal.aborted) {
          resolve();
          return;
        }
        signal.addEventListener("abort", resolve, { once: true });
      });
    },
  });
  const config = {
    vpn: {
      username: "demo-user",
      password: "secret",
      gateways: [{ host: "198.51.100.20", port: 9898 }],
    },
  };
  const startPromise = manager.start(config);

  await startEventEntered.promise;
  let stopResolved = false;
  const stopPromise = manager.stop().then((status) => {
    stopResolved = true;
    return status;
  });

  try {
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(stopResolved, false);
    assert.equal(manager.getStatus().running, true);

    releaseStartEvent.resolve();
    await startPromise;
    const stopped = await stopPromise;
    assert.equal(stopped.running, false);
  } finally {
    releaseStartEvent.resolve();
    await Promise.allSettled([startPromise, stopPromise]);
    await manager.stop();
  }
});

test("VpnMaintainer defers an automatic cycle while a manual VPN action owns the guard", async () => {
  const { VpnMaintainer } = await loadVpnMaintainer();
  const guard = createVpnActionGuard();
  const manualAction = createDeferred();
  const beginCycle = createDeferred();
  const cycleRecorded = createDeferred();
  let ensureCalls = 0;
  let cycleEvent = null;
  let cycleControl = null;

  let activeManual = null;
  const manager = new VpnMaintainer({
    actionRunner: (key, operation) => guard.run(key, operation, { scope: "maintainer" }),
    runtimeFactory: () => ({
      async disableOfficialAutoConnectBeforeLaunch() {
        return { ok: true, action: "disabled" };
      },
    }),
    ensureOnlineFn: async () => {
      ensureCalls += 1;
      return { action: "already-online" };
    },
    maintainOnlineFn: async ({ ensureOnlineFn, onCycle, signal }) => {
      await beginCycle.promise;
      try {
        cycleEvent = {
          ok: true,
          result: await ensureOnlineFn({ signal }),
        };
      } catch (error) {
        cycleEvent = { ok: false, error };
      }
      cycleControl = await onCycle(cycleEvent);
      cycleRecorded.resolve();
      await new Promise((resolve) => {
        if (signal.aborted) {
          resolve();
          return;
        }
        signal.addEventListener("abort", resolve, { once: true });
      });
    },
  });

  try {
    await manager.start({
      vpn: {
        username: "demo-user",
        password: "secret",
        gateways: [{ host: "198.51.100.20", port: 9898 }],
        maintainerIntervalSeconds: 300,
      },
    });
    activeManual = guard.run("recover-login", () => manualAction.promise);
    beginCycle.resolve();
    await cycleRecorded.promise;

    assert.equal(ensureCalls, 0);
    assert.equal(cycleEvent.ok, true);
    assert.equal(cycleEvent.result.action, "keepalive-deferred-active-action");
    assert.equal(cycleEvent.result.activeAction, "recover-login");
    assert.deepEqual(cycleControl, { nextIntervalMs: 30000 });
    assert.equal(manager.getStatus().lastError, null);
  } finally {
    beginCycle.resolve();
    manualAction.resolve({ ok: true });
    await activeManual;
    await manager.stop();
  }
});

test("VpnMaintainer starts with configured gateway and captures cycle results", async () => {
  const { VpnMaintainer } = await loadVpnMaintainer();

  if (!VpnMaintainer) {
    assert.fail("VpnMaintainer is missing");
  }

  let finishLoop = null;
  const maintainCalls = [];
  let gatewayCandidateCalls = 0;
  const runtime = {
    async disableOfficialAutoConnectBeforeLaunch() {
      return { ok: true, action: "disabled" };
    },
    async getGatewayCandidates() {
      gatewayCandidateCalls += 1;
      return [{ host: "203.0.113.10", port: 9898 }];
    },
  };

  const manager = new VpnMaintainer({
    runtimeFactory: () => runtime,
    gatewayLoginFactory: ({ host, port }) => ({ host, port, kind: "gateway-login" }),
    maintainOnlineFn: async (options) => {
      maintainCalls.push(options);
      await options.onCycle({
        ok: true,
        result: {
          action: "already-online",
          activeSession: {
            token: "secret-token",
            sessionId: "session-1",
          },
        },
      });
      return new Promise((resolve) => {
        finishLoop = resolve;
      });
    },
  });

  const started = await manager.start({
    vpn: {
      username: "demo-user",
      password: "secret",
      appExecutable: "/Applications/EasyConnect.app/Contents/MacOS/EasyConnect",
      gateways: [{ host: "198.51.100.20", port: 9898 }],
      maintainerIntervalSeconds: 90,
    },
  });

  assert.equal(started.running, true);
  assert.deepEqual(started.gateway, { host: "198.51.100.20", port: 9898 });
  assert.equal(started.intervalSeconds, 90);
  assert.deepEqual(started.officialAutoConnectGuard, { ok: true, action: "disabled" });
  assert.equal(started.lastEvent?.ok, true);
  assert.equal(started.lastEvent?.result?.action, "already-online");
  assert.equal(started.lastEvent?.result?.activeSession?.token, undefined);
  assert.equal(maintainCalls.length, 1);
  assert.equal(typeof maintainCalls[0].ensureOnlineFn, "function");
  assert.equal(maintainCalls[0].intervalMs, 90000);
  assert.equal(gatewayCandidateCalls, 0);

  finishLoop();
  await manager.stop();
});

test("VpnMaintainer pauses automatic keepalive during quiet hours", async () => {
  const { VpnMaintainer } = await loadVpnMaintainer();

  if (!VpnMaintainer) {
    assert.fail("VpnMaintainer is missing");
  }

  let finishLoop = null;
  let ensureCalls = 0;
  let repairCalls = 0;
  let cycleControl = null;
  const manager = new VpnMaintainer({
    nowFn: () => new Date(2026, 0, 1, 19, 0, 0, 0).getTime(),
    runtimeFactory: () => ({
      async disableOfficialAutoConnectBeforeLaunch() {
        return { ok: true, action: "disabled" };
      },
      async getGatewayCandidates() {
        return [];
      },
    }),
    gatewayLoginFactory: ({ host, port }) => ({ host, port }),
    ensureOnlineFn: async () => {
      ensureCalls += 1;
      return {
        action: "already-online",
      };
    },
    repairOfficialUiFn: async () => {
      repairCalls += 1;
      return {
        action: "already-consistent",
      };
    },
    maintainOnlineFn: async ({ ensureOnlineFn, onCycle }) => {
      const result = await ensureOnlineFn({});
      cycleControl = await onCycle({
        ok: true,
        result,
      });
      return new Promise((resolve) => {
        finishLoop = resolve;
      });
    },
  });

  await manager.start({
    vpn: {
      username: "demo-user",
      password: "secret",
      gateways: [{ host: "198.51.100.20", port: 9898 }],
      maintainerQuietHoursEnabled: true,
      maintainerQuietStart: "18:30",
      maintainerQuietEnd: "09:00",
    },
  });

  await new Promise((resolve) => setTimeout(resolve, 0));
  const status = manager.getStatus();

  assert.equal(ensureCalls, 0);
  assert.equal(repairCalls, 0);
  assert.equal(status.cycleCount, 1);
  assert.equal(status.lastEvent?.result?.action, "keepalive-paused-quiet-hours");
  assert.equal(status.lastEvent?.result?.quietHours?.start, "18:30");
  assert.equal(status.lastEvent?.result?.quietHours?.end, "09:00");
  assert.equal(cycleControl?.nextIntervalMs, 14 * 60 * 60 * 1000);

  finishLoop();
  await manager.stop();
});

test("VpnMaintainer resumes automatic keepalive at quiet-hours end", async () => {
  const { VpnMaintainer } = await loadVpnMaintainer();

  if (!VpnMaintainer) {
    assert.fail("VpnMaintainer is missing");
  }

  let finishLoop = null;
  let ensureCalls = 0;
  const manager = new VpnMaintainer({
    nowFn: () => new Date(2026, 0, 2, 9, 0, 0, 0).getTime(),
    runtimeFactory: () => ({
      async getGatewayCandidates() {
        return [];
      },
    }),
    gatewayLoginFactory: ({ host, port }) => ({ host, port }),
    ensureOnlineFn: async () => {
      ensureCalls += 1;
      return {
        action: "already-online",
        activeSession: {
          sessionId: "session-1",
          token: "secret-session-token",
        },
        loginStatus: {
          status: "1",
        },
      };
    },
    maintainOnlineFn: async ({ ensureOnlineFn, onCycle }) => {
      const result = await ensureOnlineFn({});
      await onCycle({
        ok: true,
        result,
      });
      return new Promise((resolve) => {
        finishLoop = resolve;
      });
    },
  });

  await manager.start({
    vpn: {
      username: "demo-user",
      password: "secret",
      gateways: [{ host: "198.51.100.20", port: 9898 }],
      maintainerQuietHoursEnabled: true,
      maintainerQuietStart: "18:30",
      maintainerQuietEnd: "09:00",
    },
  });

  await new Promise((resolve) => setTimeout(resolve, 0));
  const status = manager.getStatus();

  assert.equal(ensureCalls, 1);
  assert.equal(status.lastEvent?.result?.action, "already-online");

  finishLoop();
  await manager.stop();
});

test("VpnMaintainer repairs official UI after a successful online cycle", async () => {
  const { VpnMaintainer } = await loadVpnMaintainer();

  if (!VpnMaintainer) {
    assert.fail("VpnMaintainer is missing");
  }

  let finishLoop = null;
  const repairCalls = [];
  const manager = new VpnMaintainer({
    runtimeFactory: () => ({
      async getGatewayCandidates() {
        return [];
      },
    }),
    gatewayLoginFactory: ({ host, port }) => ({ host, port }),
    ensureOnlineFn: async () => ({
      action: "already-online",
      activeSession: {
        sessionId: "session-1",
        token: "secret-session-token",
      },
      loginStatus: {
        status: "1",
      },
    }),
    repairOfficialUiFn: async (config, options) => {
      repairCalls.push({
        lastKnownGateway: config.vpn.lastKnownGateway,
        remoteDebugPort: options.remoteDebugPort,
        focusServiceTarget: options.focusServiceTarget ?? false,
        allowNativeWindowActivation: options.allowNativeWindowActivation ?? false,
        onlineAction: options.onlineAction,
        postRepairSettleMs: options.postRepairSettleMs,
      });
      return {
        action: "repair-official-ui",
        gateway: config.vpn.lastKnownGateway,
        bridge: {
          token: "secret-bridge-token",
          ok: true,
        },
      };
    },
    maintainOnlineFn: async ({ ensureOnlineFn, onCycle }) => {
      const result = await ensureOnlineFn({});
      await onCycle({
        ok: true,
        result,
      });
      return new Promise((resolve) => {
        finishLoop = resolve;
      });
    },
  });

  await manager.start({
    vpn: {
      username: "demo-user",
      password: "secret",
      remoteDebugPort: 9223,
      gateways: [{ host: "198.51.100.20", port: 9898 }],
    },
  });

  await new Promise((resolve) => setTimeout(resolve, 0));
  const status = manager.getStatus();

  assert.deepEqual(repairCalls, [
    {
      lastKnownGateway: { host: "198.51.100.20", port: 9898 },
      remoteDebugPort: 9223,
      focusServiceTarget: false,
      allowNativeWindowActivation: false,
      onlineAction: "already-online",
      postRepairSettleMs: 75_000,
    },
  ]);
  assert.equal(status.lastEvent?.ok, true);
  assert.equal(status.lastEvent?.result?.officialUiRepair?.action, "repair-official-ui");
  assert.equal(status.lastEvent?.result?.officialUiRepair?.bridge?.token, undefined);
  assert.equal(status.lastEvent?.result?.activeSession?.token, undefined);

  finishLoop();
  await manager.stop();
});

test("VpnMaintainer forwards the verified online status into official UI repair", async () => {
  const { VpnMaintainer } = await loadVpnMaintainer();

  if (!VpnMaintainer) {
    assert.fail("VpnMaintainer is missing");
  }

  let finishLoop = null;
  const repairCalls = [];
  const manager = new VpnMaintainer({
    runtimeFactory: () => ({
      async getGatewayCandidates() {
        return [];
      },
    }),
    gatewayLoginFactory: ({ host, port }) => ({ host, port }),
    ensureOnlineFn: async () => ({
      action: "already-online",
      activeSession: {
        sessionId: "session-1",
        token: "secret-session-token",
      },
      loginStatus: {
        status: "1",
      },
      serviceState: {
        base: "18",
        l3vpn: "18",
        tcp: "43",
      },
    }),
    repairOfficialUiFn: async (config, options) => {
      repairCalls.push({
        knownOnlineStatus: options.knownOnlineStatus,
        lastKnownGateway: config.vpn.lastKnownGateway,
        onlineAction: options.onlineAction,
      });
      return {
        action: "already-consistent",
      };
    },
    maintainOnlineFn: async ({ ensureOnlineFn, onCycle }) => {
      const result = await ensureOnlineFn({});
      await onCycle({
        ok: true,
        result,
      });
      return new Promise((resolve) => {
        finishLoop = resolve;
      });
    },
  });

  await manager.start({
    vpn: {
      username: "demo-user",
      password: "secret",
      gateways: [{ host: "198.51.100.20", port: 9898 }],
    },
  });

  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(repairCalls.length, 1);
  assert.deepEqual(repairCalls[0].lastKnownGateway, { host: "198.51.100.20", port: 9898 });
  assert.equal(repairCalls[0].knownOnlineStatus.loginStatus.status, "1");
  assert.equal(repairCalls[0].knownOnlineStatus.activeSession.sessionId, "session-1");

  finishLoop();
  await manager.stop();
});

test("VpnMaintainer forwards nested recovery online status into official UI repair", async () => {
  const { VpnMaintainer } = await loadVpnMaintainer();

  if (!VpnMaintainer) {
    assert.fail("VpnMaintainer is missing");
  }

  let finishLoop = null;
  const repairCalls = [];
  const manager = new VpnMaintainer({
    runtimeFactory: () => ({
      async getGatewayCandidates() {
        return [];
      },
    }),
    gatewayLoginFactory: ({ host, port }) => ({ host, port }),
    ensureOnlineFn: async () => ({
      action: "relogin-page-bridge",
      recovery: {
        mode: "reuse-existing-main-app",
      },
      online: {
        activeSession: {
          sessionId: "recovered-session",
          token: "secret-session-token",
        },
        loginStatus: {
          status: "1",
        },
        serviceState: {
          base: "18",
          l3vpn: "18",
          tcp: "43",
        },
      },
    }),
    repairOfficialUiFn: async (config, options) => {
      repairCalls.push({
        knownOnlineStatus: options.knownOnlineStatus,
        lastKnownGateway: config.vpn.lastKnownGateway,
        onlineAction: options.onlineAction,
      });
      return {
        action: "already-consistent",
      };
    },
    maintainOnlineFn: async ({ ensureOnlineFn, onCycle }) => {
      const result = await ensureOnlineFn({});
      await onCycle({
        ok: true,
        result,
      });
      return new Promise((resolve) => {
        finishLoop = resolve;
      });
    },
  });

  await manager.start({
    vpn: {
      username: "demo-user",
      password: "secret",
      gateways: [{ host: "198.51.100.20", port: 9898 }],
    },
  });

  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(repairCalls.length, 1);
  assert.deepEqual(repairCalls[0].lastKnownGateway, { host: "198.51.100.20", port: 9898 });
  assert.equal(repairCalls[0].knownOnlineStatus.action, undefined);
  assert.equal(repairCalls[0].knownOnlineStatus.recovery, undefined);
  assert.equal(repairCalls[0].knownOnlineStatus.loginStatus.status, "1");
  assert.equal(repairCalls[0].knownOnlineStatus.activeSession.sessionId, "recovered-session");
  assert.equal(repairCalls[0].knownOnlineStatus.activeSession.token, undefined);
  assert.equal(repairCalls[0].onlineAction, "relogin-page-bridge");

  finishLoop();
  await manager.stop();
});

test("VpnMaintainer throttles repeated official UI repair for stable already-online cycles", async () => {
  const { VpnMaintainer } = await loadVpnMaintainer();

  if (!VpnMaintainer) {
    assert.fail("VpnMaintainer is missing");
  }

  let finishLoop = null;
  let now = 1_000;
  let repairCalls = 0;
  const manager = new VpnMaintainer({
    nowFn: () => now,
    runtimeFactory: () => ({
      async getGatewayCandidates() {
        return [];
      },
    }),
    gatewayLoginFactory: ({ host, port }) => ({ host, port }),
    ensureOnlineFn: async () => ({
      action: "already-online",
      activeSession: {
        sessionId: "stable-session",
        token: "secret-session-token",
      },
      loginStatus: {
        status: "1",
      },
      serviceState: {
        base: "18",
        l3vpn: "18",
        tcp: "43",
      },
    }),
    repairOfficialUiFn: async () => {
      repairCalls += 1;
      return {
        action: "already-consistent",
      };
    },
    maintainOnlineFn: async ({ ensureOnlineFn, onCycle }) => {
      const first = await ensureOnlineFn({});
      await onCycle({
        ok: true,
        result: first,
      });

      now += 60_000;
      const second = await ensureOnlineFn({});
      await onCycle({
        ok: true,
        result: second,
      });

      return new Promise((resolve) => {
        finishLoop = resolve;
      });
    },
  });

  await manager.start({
    vpn: {
      username: "demo-user",
      password: "secret",
      gateways: [{ host: "198.51.100.20", port: 9898 }],
      officialUiRepairCooldownMs: 15 * 60 * 1000,
    },
  });

  await new Promise((resolve) => setTimeout(resolve, 0));
  const status = manager.getStatus();

  assert.equal(repairCalls, 1);
  assert.equal(status.cycleCount, 2);
  assert.equal(status.lastEvent?.result?.officialUiRepair?.action, "skip-recently-consistent");

  finishLoop();
  await manager.stop();
});

test("VpnMaintainer still repairs official UI after a real recovery inside cooldown", async () => {
  const { VpnMaintainer } = await loadVpnMaintainer();

  if (!VpnMaintainer) {
    assert.fail("VpnMaintainer is missing");
  }

  let finishLoop = null;
  let now = 1_000;
  let repairCalls = 0;
  let ensureCalls = 0;
  const manager = new VpnMaintainer({
    nowFn: () => now,
    runtimeFactory: () => ({
      async getGatewayCandidates() {
        return [];
      },
    }),
    gatewayLoginFactory: ({ host, port }) => ({ host, port }),
    ensureOnlineFn: async () => {
      ensureCalls += 1;
      return {
        action: ensureCalls === 1 ? "already-online" : "relogin-page-bridge",
        activeSession: {
          sessionId: "stable-session",
          token: "secret-session-token",
        },
        loginStatus: {
          status: "1",
        },
        serviceState: {
          base: "18",
          l3vpn: "18",
          tcp: "43",
        },
      };
    },
    repairOfficialUiFn: async () => {
      repairCalls += 1;
      return {
        action: "already-consistent",
      };
    },
    maintainOnlineFn: async ({ ensureOnlineFn, onCycle }) => {
      const first = await ensureOnlineFn({});
      await onCycle({
        ok: true,
        result: first,
      });

      now += 60_000;
      const second = await ensureOnlineFn({});
      await onCycle({
        ok: true,
        result: second,
      });

      return new Promise((resolve) => {
        finishLoop = resolve;
      });
    },
  });

  await manager.start({
    vpn: {
      username: "demo-user",
      password: "secret",
      gateways: [{ host: "198.51.100.20", port: 9898 }],
      officialUiRepairCooldownMs: 15 * 60 * 1000,
    },
  });

  await new Promise((resolve) => setTimeout(resolve, 0));
  const status = manager.getStatus();

  assert.equal(repairCalls, 2);
  assert.equal(status.cycleCount, 2);
  assert.equal(status.lastEvent?.result?.action, "relogin-page-bridge");
  assert.equal(status.lastEvent?.result?.officialUiRepair?.action, "already-consistent");

  finishLoop();
  await manager.stop();
});

test("VpnMaintainer skips repeated already-online repair after a successful residual cleanup", async () => {
  const { VpnMaintainer } = await loadVpnMaintainer();

  if (!VpnMaintainer) {
    assert.fail("VpnMaintainer is missing");
  }

  let finishLoop = null;
  let now = 1_000;
  let repairCalls = 0;
  const manager = new VpnMaintainer({
    nowFn: () => now,
    runtimeFactory: () => ({
      async getGatewayCandidates() {
        return [];
      },
    }),
    gatewayLoginFactory: ({ host, port }) => ({ host, port }),
    ensureOnlineFn: async () => ({
      action: "already-online",
      activeSession: {
        sessionId: "stable-session",
        token: "secret-session-token",
      },
      loginStatus: {
        status: "1",
      },
      serviceState: {
        base: "18",
        l3vpn: "18",
        tcp: "43",
      },
    }),
    repairOfficialUiFn: async () => {
      repairCalls += 1;
      return {
        action: "repair-official-ui",
        closedResidualTargets: [
          {
            id: "stale-notfound",
            result: { ok: true },
          },
        ],
      };
    },
    maintainOnlineFn: async ({ ensureOnlineFn, onCycle }) => {
      const first = await ensureOnlineFn({});
      await onCycle({
        ok: true,
        result: first,
      });

      now += 60_000;
      const second = await ensureOnlineFn({});
      await onCycle({
        ok: true,
        result: second,
      });

      now += 60_000;
      const third = await ensureOnlineFn({});
      await onCycle({
        ok: true,
        result: third,
      });

      return new Promise((resolve) => {
        finishLoop = resolve;
      });
    },
  });

  await manager.start({
    vpn: {
      username: "demo-user",
      password: "secret",
      gateways: [{ host: "198.51.100.20", port: 9898 }],
      officialUiRepairCooldownMs: 15 * 60 * 1000,
    },
  });

  await new Promise((resolve) => setTimeout(resolve, 0));
  const status = manager.getStatus();

  assert.equal(repairCalls, 1);
  assert.equal(status.cycleCount, 3);
  assert.equal(status.lastEvent?.result?.officialUiRepair?.action, "skip-recently-consistent");

  finishLoop();
  await manager.stop();
});

test("VpnMaintainer does not cache skipped background native window activation as stable", async () => {
  const { VpnMaintainer } = await loadVpnMaintainer();

  if (!VpnMaintainer) {
    assert.fail("VpnMaintainer is missing");
  }

  let finishLoop = null;
  let now = 1_000;
  let repairCalls = 0;
  const manager = new VpnMaintainer({
    nowFn: () => now,
    runtimeFactory: () => ({
      async getGatewayCandidates() {
        return [];
      },
    }),
    gatewayLoginFactory: ({ host, port }) => ({ host, port }),
    ensureOnlineFn: async () => ({
      action: "already-online",
      activeSession: {
        sessionId: "stable-session",
        token: "secret-session-token",
      },
      loginStatus: {
        status: "1",
      },
      serviceState: {
        base: "18",
        l3vpn: "18",
        tcp: "43",
      },
    }),
    repairOfficialUiFn: async () => {
      repairCalls += 1;
      return {
        action: "skip-native-window-activation-background",
        status: {
          officialUi: {
            reachable: true,
            hasServiceTarget: true,
            hasBlockingVisibleTarget: false,
            hasBlockingNativeAlert: false,
            needsNativeWindowRestore: true,
            needsNativeWindowConsolidation: false,
            hasDuplicateNativeWindows: false,
          },
        },
      };
    },
    maintainOnlineFn: async ({ ensureOnlineFn, onCycle }) => {
      const first = await ensureOnlineFn({});
      await onCycle({
        ok: true,
        result: first,
      });

      now += 60_000;
      const second = await ensureOnlineFn({});
      await onCycle({
        ok: true,
        result: second,
      });

      return new Promise((resolve) => {
        finishLoop = resolve;
      });
    },
  });

  await manager.start({
    vpn: {
      username: "demo-user",
      password: "secret",
      gateways: [{ host: "198.51.100.20", port: 9898 }],
      officialUiRepairCooldownMs: 15 * 60 * 1000,
    },
  });

  await new Promise((resolve) => setTimeout(resolve, 0));
  const status = manager.getStatus();

  assert.equal(repairCalls, 2);
  assert.equal(status.cycleCount, 2);
  assert.equal(status.lastEvent?.result?.officialUiRepair?.action, "skip-native-window-activation-background");

  finishLoop();
  await manager.stop();
});

test("VpnMaintainer skips repeated repair after restoring a hidden service target", async () => {
  const { VpnMaintainer } = await loadVpnMaintainer();

  if (!VpnMaintainer) {
    assert.fail("VpnMaintainer is missing");
  }

  let finishLoop = null;
  let now = 1_000;
  let repairCalls = 0;
  const manager = new VpnMaintainer({
    nowFn: () => now,
    runtimeFactory: () => ({
      async getGatewayCandidates() {
        return [];
      },
    }),
    gatewayLoginFactory: ({ host, port }) => ({ host, port }),
    ensureOnlineFn: async () => ({
      action: "already-online",
      activeSession: {
        sessionId: "stable-session",
        token: "secret-session-token",
      },
      loginStatus: {
        status: "1",
      },
      serviceState: {
        base: "18",
        l3vpn: "18",
        tcp: "43",
      },
    }),
    repairOfficialUiFn: async () => {
      repairCalls += 1;
      return {
        action: "restore-hidden-service-target",
        restoredFrom: {
          id: "visible-connect",
          kind: "connect",
        },
        restoreAttempts: [
          {
            id: "visible-connect",
            result: { ok: true },
          },
        ],
        navigation: { ok: true },
        serviceReload: { ok: true },
      };
    },
    maintainOnlineFn: async ({ ensureOnlineFn, onCycle }) => {
      const first = await ensureOnlineFn({});
      await onCycle({
        ok: true,
        result: first,
      });

      now += 60_000;
      const second = await ensureOnlineFn({});
      await onCycle({
        ok: true,
        result: second,
      });

      return new Promise((resolve) => {
        finishLoop = resolve;
      });
    },
  });

  await manager.start({
    vpn: {
      username: "demo-user",
      password: "secret",
      gateways: [{ host: "198.51.100.20", port: 9898 }],
      officialUiRepairCooldownMs: 15 * 60 * 1000,
    },
  });

  await new Promise((resolve) => setTimeout(resolve, 0));
  const status = manager.getStatus();

  assert.equal(repairCalls, 1);
  assert.equal(status.cycleCount, 2);
  assert.equal(status.lastEvent?.result?.officialUiRepair?.action, "skip-recently-consistent");
  assert.equal(status.lastEvent?.result?.officialUiRepair?.lastRepairAction, "restore-hidden-service-target");

  finishLoop();
  await manager.stop();
});

test("VpnMaintainer retries official UI repair when the previous residual cleanup failed", async () => {
  const { VpnMaintainer } = await loadVpnMaintainer();

  if (!VpnMaintainer) {
    assert.fail("VpnMaintainer is missing");
  }

  let finishLoop = null;
  let now = 1_000;
  let repairCalls = 0;
  const manager = new VpnMaintainer({
    nowFn: () => now,
    runtimeFactory: () => ({
      async getGatewayCandidates() {
        return [];
      },
    }),
    gatewayLoginFactory: ({ host, port }) => ({ host, port }),
    ensureOnlineFn: async () => ({
      action: "already-online",
      activeSession: {
        sessionId: "stable-session",
        token: "secret-session-token",
      },
      loginStatus: {
        status: "1",
      },
      serviceState: {
        base: "18",
        l3vpn: "18",
        tcp: "43",
      },
    }),
    repairOfficialUiFn: async () => {
      repairCalls += 1;
      return {
        action: repairCalls === 1 ? "repair-official-ui" : "already-consistent",
        closedResidualTargets: repairCalls === 1
          ? [
              {
                id: "stale-notfound",
                result: { ok: false, error: "timeout" },
              },
            ]
          : [],
      };
    },
    maintainOnlineFn: async ({ ensureOnlineFn, onCycle }) => {
      const first = await ensureOnlineFn({});
      await onCycle({
        ok: true,
        result: first,
      });

      now += 60_000;
      const second = await ensureOnlineFn({});
      await onCycle({
        ok: true,
        result: second,
      });

      return new Promise((resolve) => {
        finishLoop = resolve;
      });
    },
  });

  await manager.start({
    vpn: {
      username: "demo-user",
      password: "secret",
      gateways: [{ host: "198.51.100.20", port: 9898 }],
      officialUiRepairCooldownMs: 15 * 60 * 1000,
    },
  });

  await new Promise((resolve) => setTimeout(resolve, 0));
  const status = manager.getStatus();

  assert.equal(repairCalls, 2);
  assert.equal(status.cycleCount, 2);
  assert.equal(status.lastEvent?.result?.officialUiRepair?.action, "already-consistent");

  finishLoop();
  await manager.stop();
});

test("VpnMaintainer retries official UI repair when restore action leaves official UI inconsistent", async () => {
  const { VpnMaintainer } = await loadVpnMaintainer();

  if (!VpnMaintainer) {
    assert.fail("VpnMaintainer is missing");
  }

  let finishLoop = null;
  let now = 1_000;
  let repairCalls = 0;
  const manager = new VpnMaintainer({
    nowFn: () => now,
    runtimeFactory: () => ({
      async getGatewayCandidates() {
        return [];
      },
    }),
    gatewayLoginFactory: ({ host, port }) => ({ host, port }),
    ensureOnlineFn: async () => ({
      action: "already-online",
      activeSession: {
        sessionId: "stable-session",
        token: "secret-session-token",
      },
      loginStatus: {
        status: "1",
      },
      serviceState: {
        base: "18",
        l3vpn: "18",
        tcp: "43",
      },
    }),
    repairOfficialUiFn: async () => {
      repairCalls += 1;
      if (repairCalls === 1) {
        return {
          action: "restore-missing-service-target",
          restoreAttempts: [
            {
              id: "stale-notfound",
              result: { ok: true },
            },
          ],
          navigation: { ok: true },
          serviceReload: { ok: true },
          status: {
            officialUi: {
              reachable: true,
              hasServiceTarget: false,
              hasBlockingVisibleTarget: false,
              needsNativeWindowRestore: false,
              primaryTarget: {
                kind: "probe-failed",
              },
            },
          },
        };
      }

      return {
        action: "already-consistent",
        status: {
          officialUi: {
            reachable: true,
            hasServiceTarget: true,
            hasBlockingVisibleTarget: false,
            needsNativeWindowRestore: false,
            primaryTarget: {
              kind: "service",
            },
          },
        },
      };
    },
    maintainOnlineFn: async ({ ensureOnlineFn, onCycle }) => {
      const first = await ensureOnlineFn({});
      await onCycle({
        ok: true,
        result: first,
      });

      now += 60_000;
      const second = await ensureOnlineFn({});
      await onCycle({
        ok: true,
        result: second,
      });

      return new Promise((resolve) => {
        finishLoop = resolve;
      });
    },
  });

  await manager.start({
    vpn: {
      username: "demo-user",
      password: "secret",
      gateways: [{ host: "198.51.100.20", port: 9898 }],
      officialUiRepairCooldownMs: 15 * 60 * 1000,
    },
  });

  await new Promise((resolve) => setTimeout(resolve, 0));
  const status = manager.getStatus();

  assert.equal(repairCalls, 2);
  assert.equal(status.cycleCount, 2);
  assert.equal(status.lastEvent?.result?.officialUiRepair?.action, "already-consistent");

  finishLoop();
  await manager.stop();
});

test("VpnMaintainer does not persist a planned gateway for an already-online cycle", async () => {
  const { VpnMaintainer } = await loadVpnMaintainer();

  if (!VpnMaintainer) {
    assert.fail("VpnMaintainer is missing");
  }

  let finishLoop = null;
  const selectedGateways = [];
  const manager = new VpnMaintainer({
    runtimeFactory: () => ({
      async getGatewayCandidates() {
        return [];
      },
    }),
    gatewayLoginFactory: ({ host, port }) => ({ host, port }),
    ensureOnlineFn: async () => ({
      action: "already-online",
      activeSession: {
        sessionId: "session-1",
        token: "secret-session-token",
      },
      loginStatus: {
        status: "1",
      },
    }),
    onGatewaySelected: async (gateway) => {
      selectedGateways.push(gateway);
    },
    maintainOnlineFn: async ({ ensureOnlineFn, onCycle }) => {
      const result = await ensureOnlineFn({});
      await onCycle({
        ok: true,
        result,
      });
      return new Promise((resolve) => {
        finishLoop = resolve;
      });
    },
  });

  await manager.start({
    vpn: {
      username: "demo-user",
      password: "secret",
      gateways: [{ host: "198.51.100.20", port: 9898 }],
    },
  });

  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.deepEqual(selectedGateways, []);

  finishLoop();
  await manager.stop();
});

test("VpnMaintainer falls back to discovered gateway candidates and stops cleanly", async () => {
  const { VpnMaintainer } = await loadVpnMaintainer();

  if (!VpnMaintainer) {
    assert.fail("VpnMaintainer is missing");
  }

  let aborted = false;
  const runtime = {
    async getGatewayCandidates() {
      return [{ host: "203.0.113.10", port: 9000 }];
    },
  };

  const manager = new VpnMaintainer({
    runtimeFactory: () => runtime,
    gatewayLoginFactory: ({ host, port }) => ({ host, port }),
    maintainOnlineFn: ({ signal }) =>
      new Promise((resolve) => {
        signal.addEventListener(
          "abort",
          () => {
            aborted = true;
            resolve();
          },
          { once: true },
        );
      }),
  });

  const started = await manager.start({
    vpn: {
      username: "demo-user",
      password: "secret",
      gateways: [],
    },
  });

  assert.deepEqual(started.gateway, { host: "203.0.113.10", port: 9000 });
  assert.equal(started.running, true);

  const stopped = await manager.stop();
  assert.equal(aborted, true);
  assert.equal(stopped.running, false);
});

test("VpnMaintainer rejects start when no gateway can be resolved", async () => {
  const { VpnMaintainer } = await loadVpnMaintainer();

  if (!VpnMaintainer) {
    assert.fail("VpnMaintainer is missing");
  }

  const manager = new VpnMaintainer({
    runtimeFactory: () => ({
      async getGatewayCandidates() {
        return [];
      },
    }),
    gatewayLoginFactory: () => {
      throw new Error("should not build gatewayLogin without a gateway");
    },
    maintainOnlineFn: async () => {},
  });

  await assert.rejects(
    () =>
      manager.start({
        vpn: {
          username: "demo-user",
          password: "secret",
          gateways: [],
        },
      }),
    /gateway/i,
  );
});

test("VpnMaintainer can start from provided gateway candidates without runtime discovery", async () => {
  const { VpnMaintainer } = await loadVpnMaintainer();

  if (!VpnMaintainer) {
    assert.fail("VpnMaintainer is missing");
  }

  let summaryCalls = 0;
  let finishLoop = null;
  const manager = new VpnMaintainer({
    runtimeFactory: () => ({
      async getGatewayCandidates() {
        summaryCalls += 1;
        return [];
      },
    }),
    gatewayLoginFactory: ({ host, port }) => ({ host, port }),
    maintainOnlineFn: async ({ onCycle }) => {
      await onCycle({
        ok: true,
        result: {
          action: "already-online",
        },
      });
      return new Promise((resolve) => {
        finishLoop = resolve;
      });
    },
  });

  const started = await manager.start(
    {
      vpn: {
        username: "demo-user",
        password: "secret",
        gateways: [],
      },
    },
    {
      gatewayCandidates: [{ host: "203.0.113.10", port: 9000 }],
    },
  );

  assert.deepEqual(started.gateway, { host: "203.0.113.10", port: 9000 });
  assert.equal(summaryCalls, 0);

  finishLoop();
  await manager.stop();
});

test("VpnMaintainer falls back to lastKnownGateway before runtime discovery", async () => {
  const { VpnMaintainer } = await loadVpnMaintainer();

  if (!VpnMaintainer) {
    assert.fail("VpnMaintainer is missing");
  }

  let gatewayDiscoveryCalls = 0;
  let finishLoop = null;
  const manager = new VpnMaintainer({
    runtimeFactory: () => ({
      async getGatewayCandidates() {
        gatewayDiscoveryCalls += 1;
        return [];
      },
    }),
    gatewayLoginFactory: ({ host, port }) => ({ host, port }),
    maintainOnlineFn: async ({ onCycle }) => {
      await onCycle({
        ok: true,
        result: {
          action: "already-online",
        },
      });
      return new Promise((resolve) => {
        finishLoop = resolve;
      });
    },
  });

  const started = await manager.start({
    vpn: {
      username: "demo-user",
      password: "secret",
      gateways: [],
      lastKnownGateway: {
        host: "203.0.113.10",
        port: 9000,
      },
    },
  });

  assert.deepEqual(started.gateway, { host: "203.0.113.10", port: 9000 });
  assert.equal(gatewayDiscoveryCalls, 0);

  finishLoop();
  await manager.stop();
});

test("VpnMaintainer tries multiple gateways within one maintainer cycle", async () => {
  const { VpnMaintainer } = await loadVpnMaintainer();

  if (!VpnMaintainer) {
    assert.fail("VpnMaintainer is missing");
  }

  const attempts = [];
  let finishLoop = null;
  const manager = new VpnMaintainer({
    runtimeFactory: () => ({
      async getGatewayCandidates() {
        return [{ host: "198.51.100.20", port: 9898 }];
      },
    }),
    gatewayLoginFactory: ({ host, port }) => ({ host, port }),
    ensureOnlineFn: async (options) => {
      attempts.push(`${options.gatewayHost}:${options.gatewayPort}`);
      if (options.gatewayPort === 9000) {
        throw new Error("gateway 9000 offline");
      }

      return {
        action: "relogin-page-bridge",
      };
    },
    maintainOnlineFn: async ({ ensureOnlineFn, onCycle }) => {
      const result = await ensureOnlineFn({});
      await onCycle({
        ok: true,
        result,
      });
      return new Promise((resolve) => {
        finishLoop = resolve;
      });
    },
  });

  const started = await manager.start({
    vpn: {
      username: "demo-user",
      password: "secret",
      gateways: [
        { host: "203.0.113.10", port: 9000 },
        { host: "198.51.100.20", port: 9898 },
      ],
      lastKnownGateway: null,
    },
  });

  assert.deepEqual(attempts, ["203.0.113.10:9000", "198.51.100.20:9898"]);
  await new Promise((resolve) => setTimeout(resolve, 0));
  const status = manager.getStatus();
  assert.deepEqual(status.gateway, { host: "198.51.100.20", port: 9898 });
  assert.equal(status.lastEvent?.result?.action, "relogin-page-bridge");
  assert.deepEqual(status.lastEvent?.result?.gatewayAttempts, [
    { gateway: "203.0.113.10:9000", ok: false, error: "gateway 9000 offline" },
    { gateway: "198.51.100.20:9898", ok: true },
  ]);

  finishLoop();
  await manager.stop();
});

test("VpnMaintainer passes the configured cycle timeout to the maintainer loop", async () => {
  const { VpnMaintainer } = await loadVpnMaintainer();

  if (!VpnMaintainer) {
    assert.fail("VpnMaintainer is missing");
  }

  let finishLoop = null;
  const maintainCalls = [];
  const manager = new VpnMaintainer({
    runtimeFactory: () => ({
      async getGatewayCandidates() {
        return [];
      },
    }),
    gatewayLoginFactory: ({ host, port }) => ({ host, port }),
    maintainOnlineFn: async (options) => {
      maintainCalls.push(options);
      await options.onCycle({
        ok: false,
        error: new Error("stop after inspecting timeout"),
      });
      return new Promise((resolve) => {
        finishLoop = resolve;
      });
    },
  });

  await manager.start({
    vpn: {
      username: "demo-user",
      password: "secret",
      gateways: [
        { host: "198.51.100.20", port: 9898 },
        { host: "203.0.113.10", port: 9898 },
      ],
      maintainerCycleTimeoutMs: 180000,
    },
  });

  assert.equal(maintainCalls[0].cycleTimeoutMs, 180000);

  finishLoop();
  await manager.stop();
});

test("VpnMaintainer notifies when a later gateway succeeds", async () => {
  const { VpnMaintainer } = await loadVpnMaintainer();

  if (!VpnMaintainer) {
    assert.fail("VpnMaintainer is missing");
  }

  const selectedGateways = [];
  let finishLoop = null;
  const manager = new VpnMaintainer({
    runtimeFactory: () => ({
      async getGatewayCandidates() {
        return [{ host: "198.51.100.20", port: 9898 }];
      },
    }),
    gatewayLoginFactory: ({ host, port }) => ({ host, port }),
    ensureOnlineFn: async (options) => {
      if (options.gatewayPort === 9000) {
        throw new Error("gateway 9000 offline");
      }

      return {
        action: "relogin-page-bridge",
      };
    },
    onGatewaySelected: async (gateway) => {
      selectedGateways.push(`${gateway.host}:${gateway.port}`);
    },
    maintainOnlineFn: async ({ ensureOnlineFn, onCycle }) => {
      const result = await ensureOnlineFn({});
      await onCycle({
        ok: true,
        result,
      });
      return new Promise((resolve) => {
        finishLoop = resolve;
      });
    },
  });

  await manager.start({
    vpn: {
      username: "demo-user",
      password: "secret",
      gateways: [
        { host: "203.0.113.10", port: 9000 },
        { host: "198.51.100.20", port: 9898 },
      ],
      lastKnownGateway: null,
    },
  });

  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(selectedGateways, ["198.51.100.20:9898"]);

  finishLoop();
  await manager.stop();
});

test("VpnMaintainer preserves gatewayAttempts on failed cycles", async () => {
  const { VpnMaintainer } = await loadVpnMaintainer();

  if (!VpnMaintainer) {
    assert.fail("VpnMaintainer is missing");
  }

  let finishLoop = null;
  const manager = new VpnMaintainer({
    runtimeFactory: () => ({
      async getGatewayCandidates() {
        return [{ host: "203.0.113.10", port: 9000 }];
      },
    }),
    gatewayLoginFactory: ({ host, port }) => ({ host, port }),
    ensureOnlineFn: async () => {
      const error = new Error("Gateway requires captcha; automatic password login is blocked");
      error.gatewayAttempts = [{ gateway: "203.0.113.10:9000", ok: false, error: error.message }];
      throw error;
    },
    maintainOnlineFn: async ({ ensureOnlineFn, onCycle }) => {
      try {
        await ensureOnlineFn({});
      } catch (error) {
        await onCycle({
          ok: false,
          error,
        });
      }
      return new Promise((resolve) => {
        finishLoop = resolve;
      });
    },
  });

  await manager.start({
    vpn: {
      username: "demo-user",
      password: "secret",
      gateways: [{ host: "203.0.113.10", port: 9000 }],
    },
  });

  await new Promise((resolve) => setTimeout(resolve, 0));
  const status = manager.getStatus();
  assert.equal(status.lastEvent?.ok, false);
  assert.equal(status.lastEvent?.error, "Gateway requires captcha; automatic password login is blocked");
  assert.deepEqual(status.lastEvent?.gatewayAttempts, [
    { gateway: "203.0.113.10:9000", ok: false, error: "Gateway requires captcha; automatic password login is blocked" },
  ]);

  finishLoop();
  await manager.stop();
});

test("VpnMaintainer records the last phase on failed cycles", async () => {
  const { VpnMaintainer } = await loadVpnMaintainer();

  if (!VpnMaintainer) {
    assert.fail("VpnMaintainer is missing");
  }

  let finishLoop = null;
  const manager = new VpnMaintainer({
    runtimeFactory: () => ({
      async getGatewayCandidates() {
        return [];
      },
    }),
    gatewayLoginFactory: ({ host, port }) => ({ host, port }),
    ensureOnlineFn: async ({ onPhase }) => {
      onPhase?.("official-renderer-login");
      const error = new Error("Maintainer cycle timed out after 180000ms");
      error.code = "MAINTAINER_CYCLE_TIMEOUT";
      throw error;
    },
    maintainOnlineFn: async ({ ensureOnlineFn, onCycle, onPhase }) => {
      try {
        await ensureOnlineFn({ onPhase });
      } catch (error) {
        await onCycle({
          ok: false,
          error,
        });
      }
      return new Promise((resolve) => {
        finishLoop = resolve;
      });
    },
  });

  await manager.start({
    vpn: {
      username: "demo-user",
      password: "secret",
      gateways: [{ host: "198.51.100.20", port: 9898 }],
    },
  });

  await new Promise((resolve) => setTimeout(resolve, 0));
  const status = manager.getStatus();
  assert.equal(status.lastEvent?.ok, false);
  assert.equal(status.lastEvent?.code, "MAINTAINER_CYCLE_TIMEOUT");
  assert.equal(status.lastEvent?.lastPhase, "official-renderer-login");

  finishLoop();
  await manager.stop();
});

test("VpnMaintainer backs off after local service readiness failures", async () => {
  const { VpnMaintainer } = await loadVpnMaintainer();

  if (!VpnMaintainer) {
    assert.fail("VpnMaintainer is missing");
  }

  let finishLoop = null;
  const cycleControls = [];
  const manager = new VpnMaintainer({
    runtimeFactory: () => ({
      async getGatewayCandidates() {
        return [];
      },
    }),
    gatewayLoginFactory: ({ host, port }) => ({ host, port }),
    ensureOnlineFn: async () => {
      const error = new Error("Local EasyConnect service did not become ready");
      error.code = "EASYCONNECT_LOCAL_SERVICE_NOT_READY";
      error.diagnostics = {
        classification: "local-service-not-ready",
      };
      throw error;
    },
    maintainOnlineFn: async ({ ensureOnlineFn, onCycle }) => {
      try {
        await ensureOnlineFn({});
      } catch (error) {
        cycleControls.push(
          await onCycle({
            ok: false,
            error,
          }),
        );
      }
      return new Promise((resolve) => {
        finishLoop = resolve;
      });
    },
  });

  await manager.start({
    vpn: {
      username: "demo-user",
      password: "secret",
      gateways: [{ host: "198.51.100.20", port: 9898 }],
      maintainerIntervalSeconds: 300,
    },
  });

  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(manager.getStatus().lastEvent?.diagnostics?.classification, "local-service-not-ready");
  assert.deepEqual(cycleControls, [{ nextIntervalMs: 15 * 60 * 1000 }]);

  finishLoop();
  await manager.stop();
});

test("VpnMaintainer backs off after agent proxy readiness failures", async () => {
  const { VpnMaintainer } = await loadVpnMaintainer();

  if (!VpnMaintainer) {
    assert.fail("VpnMaintainer is missing");
  }

  let finishLoop = null;
  const cycleControls = [];
  const manager = new VpnMaintainer({
    runtimeFactory: () => ({
      async getGatewayCandidates() {
        return [];
      },
    }),
    gatewayLoginFactory: ({ host, port }) => ({ host, port }),
    ensureOnlineFn: async () => {
      const error = new Error("ECAgentProxy did not become ready before continuing EasyConnect recovery");
      error.code = "EASYCONNECT_AGENT_PROXY_NOT_READY";
      throw error;
    },
    maintainOnlineFn: async ({ ensureOnlineFn, onCycle }) => {
      try {
        await ensureOnlineFn({});
      } catch (error) {
        cycleControls.push(
          await onCycle({
            ok: false,
            error,
          }),
        );
      }
      return new Promise((resolve) => {
        finishLoop = resolve;
      });
    },
  });

  await manager.start({
    vpn: {
      username: "demo-user",
      password: "secret",
      gateways: [{ host: "198.51.100.20", port: 9898 }],
      maintainerIntervalSeconds: 300,
    },
  });

  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(manager.getStatus().lastEvent?.code, "EASYCONNECT_AGENT_PROXY_NOT_READY");
  assert.deepEqual(cycleControls, [{ nextIntervalMs: 15 * 60 * 1000 }]);

  finishLoop();
  await manager.stop();
});

test("VpnMaintainer backs off after same-user private kick failures", async () => {
  const { VpnMaintainer } = await loadVpnMaintainer();

  if (!VpnMaintainer) {
    assert.fail("VpnMaintainer is missing");
  }

  let finishLoop = null;
  const cycleControls = [];
  let killedMainApp = 0;
  const manager = new VpnMaintainer({
    runtimeFactory: () => ({
      async disableOfficialAutoConnectBeforeLaunch() {
        return { ok: true, action: "disabled" };
      },
      async killMainAppProcesses(options) {
        killedMainApp += 1;
        return { command: "EasyConnect", forced: options.force };
      },
      async getGatewayCandidates() {
        return [];
      },
    }),
    gatewayLoginFactory: ({ host, port }) => ({ host, port }),
    ensureOnlineFn: async () => {
      const error = new Error("EasyConnect logout detected: private same username login");
      error.code = "EASYCONNECT_PRIVATE_KICK";
      throw error;
    },
    maintainOnlineFn: async ({ ensureOnlineFn, onCycle }) => {
      try {
        await ensureOnlineFn({});
      } catch (error) {
        cycleControls.push(
          await onCycle({
            ok: false,
            error,
          }),
        );
      }
      return new Promise((resolve) => {
        finishLoop = resolve;
      });
    },
  });

  await manager.start({
    vpn: {
      username: "demo-user",
      password: "secret",
      gateways: [{ host: "198.51.100.20", port: 9898 }],
      maintainerIntervalSeconds: 300,
    },
  });

  await new Promise((resolve) => setTimeout(resolve, 0));
  const status = manager.getStatus();
  assert.equal(status.lastEvent?.code, "EASYCONNECT_PRIVATE_KICK");
  assert.equal(killedMainApp, 1);
  assert.equal(status.lastEvent?.privateKickCleanup?.killedMainApp?.forced, true);
  assert.deepEqual(cycleControls, [{ nextIntervalMs: 15 * 60 * 1000 }]);

  finishLoop();
  await manager.stop();
});

test("VpnMaintainer stops same-cycle gateway retries after local service readiness failures", async () => {
  const { VpnMaintainer } = await loadVpnMaintainer();

  if (!VpnMaintainer) {
    assert.fail("VpnMaintainer is missing");
  }

  const ensureCalls = [];
  let finishLoop = null;
  const manager = new VpnMaintainer({
    runtimeFactory: () => ({
      async getGatewayCandidates() {
        return [];
      },
    }),
    gatewayLoginFactory: ({ host, port }) => ({ host, port }),
    ensureOnlineFn: async (options) => {
      ensureCalls.push(`${options.gatewayHost}:${options.gatewayPort}`);
      const error = new Error("Local EasyConnect service did not become ready");
      error.code = "EASYCONNECT_LOCAL_SERVICE_NOT_READY";
      error.diagnostics = {
        classification: "local-service-not-ready",
      };
      throw error;
    },
    maintainOnlineFn: async ({ ensureOnlineFn, onCycle }) => {
      try {
        await ensureOnlineFn({});
      } catch (error) {
        await onCycle({
          ok: false,
          error,
        });
      }
      return new Promise((resolve) => {
        finishLoop = resolve;
      });
    },
  });

  await manager.start({
    vpn: {
      username: "demo-user",
      password: "secret",
      gateways: [
        { host: "198.51.100.20", port: 9898 },
        { host: "203.0.113.10", port: 9898 },
      ],
    },
  });

  await new Promise((resolve) => setTimeout(resolve, 0));
  const status = manager.getStatus();
  assert.deepEqual(ensureCalls, ["198.51.100.20:9898"]);
  assert.deepEqual(status.lastEvent?.gatewayAttempts?.map((attempt) => attempt.gateway), ["198.51.100.20:9898"]);

  finishLoop();
  await manager.stop();
});

test("VpnMaintainer stops same-cycle gateway retries after agent proxy readiness failures", async () => {
  const { VpnMaintainer } = await loadVpnMaintainer();

  if (!VpnMaintainer) {
    assert.fail("VpnMaintainer is missing");
  }

  const ensureCalls = [];
  let finishLoop = null;
  const manager = new VpnMaintainer({
    runtimeFactory: () => ({
      async getGatewayCandidates() {
        return [];
      },
    }),
    gatewayLoginFactory: ({ host, port }) => ({ host, port }),
    ensureOnlineFn: async (options) => {
      ensureCalls.push(`${options.gatewayHost}:${options.gatewayPort}`);
      const error = new Error("ECAgentProxy did not become ready before continuing EasyConnect recovery");
      error.code = "EASYCONNECT_AGENT_PROXY_NOT_READY";
      throw error;
    },
    maintainOnlineFn: async ({ ensureOnlineFn, onCycle }) => {
      try {
        await ensureOnlineFn({});
      } catch (error) {
        await onCycle({
          ok: false,
          error,
        });
      }
      return new Promise((resolve) => {
        finishLoop = resolve;
      });
    },
  });

  await manager.start({
    vpn: {
      username: "demo-user",
      password: "secret",
      gateways: [
        { host: "198.51.100.20", port: 9898 },
        { host: "203.0.113.10", port: 9898 },
      ],
    },
  });

  await new Promise((resolve) => setTimeout(resolve, 0));
  const status = manager.getStatus();
  assert.deepEqual(ensureCalls, ["198.51.100.20:9898"]);
  assert.deepEqual(status.lastEvent?.gatewayAttempts?.map((attempt) => attempt.gateway), ["198.51.100.20:9898"]);

  finishLoop();
  await manager.stop();
});

test("VpnMaintainer stops same-cycle gateway retries after same-user private kick failures", async () => {
  const { VpnMaintainer } = await loadVpnMaintainer();

  if (!VpnMaintainer) {
    assert.fail("VpnMaintainer is missing");
  }

  const ensureCalls = [];
  let finishLoop = null;
  const manager = new VpnMaintainer({
    runtimeFactory: () => ({
      async getGatewayCandidates() {
        return [];
      },
    }),
    gatewayLoginFactory: ({ host, port }) => ({ host, port }),
    ensureOnlineFn: async (options) => {
      ensureCalls.push(`${options.gatewayHost}:${options.gatewayPort}`);
      const error = new Error("EasyConnect logout detected: private same username login");
      error.code = "EASYCONNECT_PRIVATE_KICK";
      throw error;
    },
    maintainOnlineFn: async ({ ensureOnlineFn, onCycle }) => {
      try {
        await ensureOnlineFn({});
      } catch (error) {
        await onCycle({
          ok: false,
          error,
        });
      }
      return new Promise((resolve) => {
        finishLoop = resolve;
      });
    },
  });

  await manager.start({
    vpn: {
      username: "demo-user",
      password: "secret",
      gateways: [
        { host: "198.51.100.20", port: 9898 },
        { host: "203.0.113.10", port: 9898 },
      ],
    },
  });

  await new Promise((resolve) => setTimeout(resolve, 0));
  const status = manager.getStatus();
  assert.deepEqual(ensureCalls, ["198.51.100.20:9898"]);
  assert.deepEqual(status.lastEvent?.gatewayAttempts?.map((attempt) => attempt.gateway), ["198.51.100.20:9898"]);

  finishLoop();
  await manager.stop();
});

test("VpnMaintainer stays draining and keeps the guard while a timed-out cycle is still running", async () => {
  const { VpnMaintainer } = await loadVpnMaintainer();
  const guard = createVpnActionGuard();
  const stuckCycle = createDeferred();
  let ensureCalls = 0;
  let stopPromise = null;

  const manager = new VpnMaintainer({
    actionRunner: (key, operation) => guard.run(key, operation, { scope: "maintainer" }),
    runtimeFactory: () => ({
      async disableOfficialAutoConnectBeforeLaunch() {
        return { ok: true, action: "disabled" };
      },
    }),
    ensureOnlineFn: async () => {
      ensureCalls += 1;
      return stuckCycle.promise;
    },
  });

  try {
    await manager.start(
      {
        vpn: {
          username: "demo-user",
          password: "secret",
          gateways: [{ host: "198.51.100.20", port: 9898 }],
          maintainerIntervalSeconds: 1,
        },
      },
      { cycleTimeoutMs: 5 },
    );

    const deadline = Date.now() + 500;
    while (manager.getStatus().cycleCount < 1 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }

    const draining = manager.getStatus();
    assert.equal(ensureCalls, 1);
    assert.equal(draining.running, true);
    assert.equal(draining.draining, true);
    assert.equal(draining.lastEvent?.code, "MAINTAINER_CYCLE_TIMEOUT");
    await assert.rejects(
      guard.run("recover-login", () => ({ ok: true })),
      (error) => error.code === "EASYCONNECT_VPN_ACTION_IN_PROGRESS",
    );

    let stopped = false;
    stopPromise = manager.stop().then((status) => {
      stopped = true;
      return status;
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(stopped, false);

    stuckCycle.resolve({ action: "already-online" });
    const stoppedStatus = await stopPromise;
    assert.equal(stoppedStatus.running, false);
    assert.equal(stoppedStatus.draining, false);
    assert.deepEqual(await guard.run("recover-login", () => ({ ok: true })), { ok: true });
  } finally {
    stuckCycle.resolve({ action: "already-online" });
    await (stopPromise ?? manager.stop());
  }
});

test("VpnMaintainer resumes keepalive after a timed-out cycle finishes draining", async () => {
  const { VpnMaintainer } = await loadVpnMaintainer();
  const { maintainOnline } = await import("../src/easyconnect-bridge/maintainer.mjs");
  let ensureCalls = 0;
  let sleepCalls = 0;

  const manager = new VpnMaintainer({
    runtimeFactory: () => ({
      async disableOfficialAutoConnectBeforeLaunch() {
        return { ok: true, action: "disabled" };
      },
    }),
    ensureOnlineFn: ({ signal }) => {
      ensureCalls += 1;
      if (ensureCalls === 1) {
        return new Promise((_resolve, reject) => {
          signal.addEventListener(
            "abort",
            () => {
              setTimeout(() => {
                reject(Object.assign(new Error("delayed abort cleanup"), { name: "AbortError" }));
              }, 20);
            },
            { once: true },
          );
        });
      }

      return Promise.resolve({ action: "already-online" });
    },
    maintainOnlineFn: (options) =>
      maintainOnline({
        ...options,
        sleep: async (_ms, signal) => {
          sleepCalls += 1;
          if (sleepCalls === 1) {
            return;
          }
          await new Promise((resolve) => {
            if (signal.aborted) {
              resolve();
              return;
            }
            signal.addEventListener("abort", resolve, { once: true });
          });
        },
      }),
  });

  try {
    await manager.start(
      {
        vpn: {
          username: "demo-user",
          password: "secret",
          gateways: [{ host: "198.51.100.20", port: 9898 }],
          maintainerIntervalSeconds: 1,
        },
      },
      { cycleTimeoutMs: 5 },
    );

    const drainDeadline = Date.now() + 500;
    while (!manager.getStatus().draining && Date.now() < drainDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    assert.equal(manager.getStatus().draining, true);

    const recoveryDeadline = Date.now() + 500;
    while (manager.getStatus().cycleCount < 2 && Date.now() < recoveryDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 2));
    }

    const resumed = manager.getStatus();
    assert.equal(ensureCalls, 2);
    assert.equal(resumed.running, true);
    assert.equal(resumed.draining, false);
    assert.equal(resumed.cycleCount, 2);
    assert.equal(resumed.lastEvent?.ok, true);
    assert.equal(resumed.lastEvent?.result?.action, "already-online");
  } finally {
    await manager.stop();
  }
});

test("maintainOnline times out a stuck cycle and continues with the next interval", async () => {
  const { maintainOnline } = await import("../src/easyconnect-bridge/maintainer.mjs");

  const events = [];
  let attempts = 0;
  const controller = new AbortController();
  const sleeps = [];

  await maintainOnline({
    signal: controller.signal,
    intervalMs: 25,
    cycleTimeoutMs: 5,
    ensureOnlineFn: ({ signal }) => {
      attempts += 1;
      if (attempts === 1) {
        return new Promise((_resolve, reject) => {
          signal.addEventListener(
            "abort",
            () => reject(Object.assign(new Error("aborted by timeout"), { name: "AbortError" })),
            { once: true },
          );
        });
      }

      return Promise.resolve({
        action: "already-online",
      });
    },
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    onCycle: async (event) => {
      events.push(event);
      if (events.length === 2) {
        controller.abort();
      }
    },
  });

  assert.equal(attempts, 2);
  assert.equal(events.length, 2);
  assert.equal(events[0].ok, false);
  assert.match(events[0].error.message, /timed out/i);
  assert.equal(events[1].ok, true);
  assert.equal(events[1].result.action, "already-online");
  assert.deepEqual(sleeps, [25]);
});

test("maintainOnline lets cycle handlers extend the next retry interval", async () => {
  const { maintainOnline } = await import("../src/easyconnect-bridge/maintainer.mjs");

  const controller = new AbortController();
  const sleeps = [];
  let attempts = 0;

  await maintainOnline({
    signal: controller.signal,
    intervalMs: 25,
    ensureOnlineFn: async () => {
      attempts += 1;
      if (attempts === 1) {
        const error = new Error("Local EasyConnect service did not become ready");
        error.code = "EASYCONNECT_LOCAL_SERVICE_NOT_READY";
        throw error;
      }

      return { action: "already-online" };
    },
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    onCycle: async (event) => {
      if (event.ok) {
        controller.abort();
        return null;
      }

      return {
        nextIntervalMs: 15 * 60 * 1000,
      };
    },
  });

  assert.equal(attempts, 2);
  assert.deepEqual(sleeps, [15 * 60 * 1000]);
});
