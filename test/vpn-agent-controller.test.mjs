import test from "node:test";
import assert from "node:assert/strict";

import {
  buildAgentVpnStatus,
  createVpnAgentController,
} from "../src/services/vpn-agent-controller.js";

function createDeferred() {
  let resolve;
  let reject;
  const promise = new Promise((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
}

function createConfig(overrides = {}) {
  return {
    vpn: {
      username: "3912",
      password: "secret-value",
      remoteDebugPort: 9222,
      maintainerQuietHoursEnabled: false,
      maintainerQuietStart: "18:30",
      maintainerQuietEnd: "09:00",
      dataPlaneProbeTarget: "tcp://192.168.150.199:1521",
      gateways: [{ host: "vpn.example.test", port: 9898 }],
      ...overrides,
    },
  };
}

function createSnapshot({
  login = "1",
  sessionId = "session-1",
  dataPlaneConfigured = true,
  dataPlaneOk = true,
  tunneled = true,
  dataPlaneTarget = "tcp://192.168.150.199:1521",
} = {}) {
  return {
    status: {
      activeSession: sessionId ? { sessionId } : null,
      loginStatus: login == null ? null : { status: login },
      serviceState: { base: "18", l3vpn: "18", tcp: "43" },
      dataPlane: {
        configured: dataPlaneConfigured,
        ok: dataPlaneConfigured ? dataPlaneOk : null,
        state: dataPlaneConfigured ? (dataPlaneOk ? "reachable" : "unreachable") : "unconfigured",
        target: dataPlaneConfigured ? dataPlaneTarget : null,
        route: dataPlaneConfigured ? { interface: tunneled ? "utun5" : "en0", tunneled } : null,
        observedAt: "2026-07-15T10:00:00.000Z",
      },
    },
    environmentInfo: {
      appExecutableExists: true,
    },
  };
}

function createHarness({
  config = createConfig(),
  snapshots = [createSnapshot()],
  nowMs = Date.parse("2026-07-15T10:00:00.000Z"),
  nowFn = null,
  onRecover = null,
  onForceRecover = null,
  singleFlightActions = false,
  actionGate = null,
  initialMaintainerStatus = {},
  startMaintainerFn = null,
  stopMaintainerFn = null,
  onSnapshot = null,
  snapshotFn = null,
  confirmationDelayFn = null,
} = {}) {
  const calls = [];
  const snapshotTargets = [];
  let snapshotIndex = 0;
  let maintainerStatus = {
    running: false,
    currentPhase: null,
    cycleCount: 0,
    gateway: null,
    ...initialMaintainerStatus,
  };
  let storedConfig = config;
  const activeActions = new Map();
  const controller = createVpnAgentController({
    configStore: {
      async load() {
        return storedConfig;
      },
      async update(updater) {
        storedConfig = await updater(storedConfig);
        calls.push(["config-update", storedConfig.vpn.lastKnownGateway ?? null]);
        return storedConfig;
      },
    },
    vpnService: {
      async getSnapshot(activeConfig, options) {
        calls.push(["snapshot", options]);
        snapshotTargets.push(activeConfig?.vpn?.dataPlaneProbeTarget ?? null);
        const currentIndex = snapshotIndex;
        const selected = snapshotFn
          ? snapshotFn({ index: currentIndex, config: activeConfig })
          : snapshots[Math.min(snapshotIndex, snapshots.length - 1)];
        snapshotIndex += 1;
        onSnapshot?.({
          index: currentIndex,
          config: activeConfig,
          setConfig(nextConfig) {
            storedConfig = nextConfig;
          },
        });
        return structuredClone(selected);
      },
      async recoverAndLogin() {
        calls.push(["recover"]);
        onRecover?.();
        return {
          action: "relogin-page-bridge",
          gateway: { host: "vpn.example.test", port: 9898 },
        };
      },
      async recoverOfficialClient(_config, options) {
        calls.push(["force-recover", options]);
        onForceRecover?.();
        return { mode: "relaunch-main-app" };
      },
    },
    vpnMaintainer: {
      getStatus() {
        return structuredClone(maintainerStatus);
      },
      recordDataPlaneObservation(dataPlane, options) {
        calls.push(["observation", dataPlane.ok, options.status.loginStatus?.status]);
        return true;
      },
    },
    runVpnAction(key, operation) {
      calls.push(["action", key]);
      if (singleFlightActions && activeActions.has(key)) {
        return activeActions.get(key);
      }
      const action = Promise.resolve().then(async () => {
        await actionGate?.(key);
        return operation();
      });
      if (!singleFlightActions) {
        return action;
      }
      const tracked = action.finally(() => activeActions.delete(key));
      activeActions.set(key, tracked);
      return tracked;
    },
    async startMaintainer(options) {
      calls.push(["start-maintainer", options]);
      const override = await startMaintainerFn?.(options, structuredClone(maintainerStatus));
      maintainerStatus = {
        ...maintainerStatus,
        ...(override ?? { running: true }),
      };
      return structuredClone(maintainerStatus);
    },
    async stopMaintainer() {
      calls.push(["stop-maintainer"]);
      const override = await stopMaintainerFn?.(structuredClone(maintainerStatus));
      maintainerStatus = {
        ...maintainerStatus,
        running: false,
        draining: false,
        ...override,
      };
      return structuredClone(maintainerStatus);
    },
    nowFn: () => nowFn?.() ?? nowMs,
    async delayFn(ms) {
      calls.push(["confirmation-delay", ms]);
      await confirmationDelayFn?.(ms);
    },
  });

  return { controller, calls, snapshotTargets, getConfig: () => storedConfig };
}

test("buildAgentVpnStatus requires current configured tunneled data-plane evidence", () => {
  const healthy = buildAgentVpnStatus({
    snapshot: createSnapshot(),
    maintainerStatus: { running: true },
    config: createConfig(),
  });
  assert.equal(healthy.healthy, true);
  assert.equal(healthy.reason, "vpn-ready");
  assert.equal(healthy.controlPlane.sessionId, "sess…on-1");
  assert.equal(healthy.dataPlane.route.interface, "utun5");

  const missingRouteSnapshot = createSnapshot();
  delete missingRouteSnapshot.status.dataPlane.route;
  const missingRoute = buildAgentVpnStatus({
    snapshot: missingRouteSnapshot,
    maintainerStatus: { running: true },
    config: createConfig(),
  });
  assert.equal(missingRoute.healthy, false);
  assert.equal(missingRoute.reason, "data-plane-not-tunneled");

  const staleControlPlane = buildAgentVpnStatus({
    snapshot: createSnapshot({ dataPlaneOk: false }),
    maintainerStatus: { running: true },
    config: createConfig(),
  });
  assert.equal(staleControlPlane.healthy, false);
  assert.equal(staleControlPlane.reason, "data-plane-unreachable");

  const unconfigured = buildAgentVpnStatus({
    snapshot: createSnapshot({ dataPlaneConfigured: false }),
    maintainerStatus: { running: true },
    config: createConfig({ dataPlaneProbeTarget: "" }),
  });
  assert.equal(unconfigured.healthy, false);
  assert.equal(unconfigured.reason, "data-plane-unconfigured");
});

test("buildAgentVpnStatus sanitizes diagnostic text for CLI output", () => {
  const snapshot = createSnapshot();
  snapshot.status.dataPlane.error = "probe failed password=secret-value sessionId=session-secret";
  const result = buildAgentVpnStatus({
    snapshot,
    maintainerStatus: {
      running: true,
      lastError: "recover failed token=token-secret",
    },
    config: createConfig(),
  });

  const output = JSON.stringify(result);
  assert.equal(output.includes("secret-value"), false);
  assert.equal(output.includes("session-secret"), false);
  assert.equal(output.includes("token-secret"), false);
  assert.match(result.dataPlane.error, /password=<redacted>/);
  assert.match(result.maintainer.lastError, /token=<redacted>/);
});

test("status performs a fresh headless snapshot and returns no credentials", async () => {
  const { controller, calls } = createHarness();
  const result = await controller.handleRequest({ command: "status", options: {} });

  assert.equal(result.healthy, true);
  assert.deepEqual(calls[0], [
    "snapshot",
    { includeOfficialUi: false, includeDataPlane: true },
  ]);
  assert.equal(JSON.stringify(result).includes("secret-value"), false);
  assert.equal(JSON.stringify(result).includes("3912"), false);
});

test("config reports readiness without returning username or password", async () => {
  const { controller } = createHarness();
  const result = await controller.handleRequest({ command: "config", options: {} });

  assert.deepEqual(result.credentials, {
    usernameConfigured: true,
    passwordConfigured: true,
  });
  assert.equal(result.dataPlaneProbeTarget, "tcp://192.168.150.199:1521");
  assert.equal(result.password, undefined);
  assert.equal(JSON.stringify(result).includes("secret-value"), false);
  assert.equal(JSON.stringify(result).includes("3912"), false);
});

test("ensure is idempotent when healthy and starts background maintenance", async () => {
  const { controller, calls } = createHarness();
  const result = await controller.handleRequest({ command: "ensure", options: {} });

  assert.equal(result.healthy, true);
  assert.equal(result.action, "already-healthy");
  assert.equal(calls.some(([name]) => name === "recover"), false);
  assert.deepEqual(
    calls.find(([name]) => name === "start-maintainer"),
    ["start-maintainer", { ignoreQuietHours: false, gatewayCandidates: [] }],
  );
});

test("ensure does not require recovery credentials while the VPN is already healthy", async () => {
  const { controller, calls } = createHarness({
    config: createConfig({ username: "", password: "" }),
    startMaintainerFn() {
      throw new Error("maintainer requires configured credentials");
    },
  });

  const result = await controller.handleRequest({ command: "ensure", options: {} });

  assert.equal(result.healthy, true);
  assert.equal(result.action, "already-healthy");
  assert.equal(calls.some(([name]) => name === "recover"), false);
  assert.equal(calls.some(([name]) => name === "start-maintainer"), false);
});

test("healthy ensure reuses an already-running maintainer through the idempotent start adapter", async () => {
  const { controller, calls } = createHarness({
    initialMaintainerStatus: { running: true, currentPhase: "data-plane-probe" },
  });

  const result = await controller.handleRequest({ command: "ensure", options: {} });

  assert.equal(result.healthy, true);
  assert.equal(result.action, "already-healthy");
  assert.equal(result.keepalive.running, true);
  assert.equal(calls.filter(([name]) => name === "start-maintainer").length, 1);
});

test("ensure requires three consecutive tunneled data-plane failures before recovering", async () => {
  const quietConfig = createConfig({
    maintainerQuietHoursEnabled: true,
    maintainerQuietStart: "18:30",
    maintainerQuietEnd: "09:00",
  });
  const { controller, calls } = createHarness({
    config: quietConfig,
    snapshots: [
      createSnapshot({ dataPlaneOk: false }),
      createSnapshot({ dataPlaneOk: false }),
      createSnapshot(),
    ],
    nowMs: Date.parse("2026-07-15T11:00:00.000Z"),
  });

  const result = await controller.handleRequest({ command: "ensure", options: {} });

  assert.equal(result.healthy, true);
  assert.equal(result.action, "already-healthy");
  assert.equal(calls.filter(([name]) => name === "snapshot").length, 3);
  assert.deepEqual(
    calls.filter(([name]) => name === "confirmation-delay"),
    [["confirmation-delay", 500], ["confirmation-delay", 500]],
  );
  assert.equal(calls.some(([name]) => name === "recover"), false);
});

test("ensure reconfirms three failures after the active data-plane target changes", async () => {
  const firstTarget = "tcp://192.168.150.199:1521";
  const secondTarget = "tcp://192.168.150.200:1521";
  const secondConfig = createConfig({ dataPlaneProbeTarget: secondTarget });
  let recovered = false;
  const { controller, calls, snapshotTargets } = createHarness({
    config: createConfig({ dataPlaneProbeTarget: firstTarget }),
    snapshotFn({ config }) {
      return createSnapshot({
        dataPlaneOk: recovered,
        dataPlaneTarget: config.vpn.dataPlaneProbeTarget,
      });
    },
    onSnapshot({ index, setConfig }) {
      if (index === 2) {
        setConfig(secondConfig);
      }
    },
    onRecover() {
      recovered = true;
    },
  });

  const result = await controller.handleRequest({ command: "ensure", options: {} });
  const firstRecoveryIndex = calls.findIndex(([name]) => name === "recover");
  assert.notEqual(firstRecoveryIndex, -1, "the regression must exercise the recovery boundary");
  const probesBeforeRecovery = calls
    .slice(0, firstRecoveryIndex)
    .filter(([name]) => name === "snapshot").length;

  assert.equal(result.healthy, true);
  const targetsBeforeRecovery = snapshotTargets.slice(0, probesBeforeRecovery);
  assert.deepEqual(targetsBeforeRecovery.slice(0, 3), [
    firstTarget,
    firstTarget,
    firstTarget,
  ]);
  assert.deepEqual(targetsBeforeRecovery.slice(-3), [
    secondTarget,
    secondTarget,
    secondTarget,
  ]);
});

test("ensure restarts confirmation when the target changes during the retry sequence", async () => {
  const firstTarget = "tcp://192.168.150.199:1521";
  const secondTarget = "tcp://192.168.150.200:1521";
  const finalTarget = "tcp://192.168.150.201:1521";
  let recovered = false;
  let firstTargetProbes = 0;
  let changedDuringConfirmation = false;
  const { controller, calls, snapshotTargets } = createHarness({
    config: createConfig({ dataPlaneProbeTarget: firstTarget }),
    snapshotFn({ config }) {
      return createSnapshot({
        dataPlaneOk: recovered,
        dataPlaneTarget: config.vpn.dataPlaneProbeTarget,
      });
    },
    onSnapshot({ config, setConfig }) {
      const target = config.vpn.dataPlaneProbeTarget;
      if (target === firstTarget) {
        firstTargetProbes += 1;
        if (firstTargetProbes === 3) {
          setConfig(createConfig({ dataPlaneProbeTarget: secondTarget }));
        }
      } else if (target === secondTarget && !changedDuringConfirmation) {
        changedDuringConfirmation = true;
        setConfig(createConfig({ dataPlaneProbeTarget: finalTarget }));
      }
    },
    onRecover() {
      recovered = true;
    },
  });

  const result = await controller.handleRequest({ command: "ensure", options: {} });
  const firstRecoveryIndex = calls.findIndex(([name]) => name === "recover");
  const probesBeforeRecovery = calls
    .slice(0, firstRecoveryIndex)
    .filter(([name]) => name === "snapshot").length;

  assert.equal(result.healthy, true);
  assert.deepEqual(snapshotTargets.slice(0, probesBeforeRecovery).slice(-3), [
    finalTarget,
    finalTarget,
    finalTarget,
  ]);
});

test("ensure bounds confirmation when the active data-plane target keeps changing", async () => {
  let delayCount = 0;
  const { controller, calls, snapshotTargets } = createHarness({
    snapshotFn({ config }) {
      return createSnapshot({
        dataPlaneOk: false,
        dataPlaneTarget: config.vpn.dataPlaneProbeTarget,
      });
    },
    onSnapshot({ index, setConfig }) {
      setConfig(createConfig({
        dataPlaneProbeTarget: `tcp://192.168.151.${index + 1}:1521`,
      }));
    },
    confirmationDelayFn() {
      delayCount += 1;
      if (delayCount > 12) {
        const error = new Error("confirmation did not stop while the target kept changing");
        error.code = "TEST_UNBOUNDED_CONFIRMATION";
        throw error;
      }
    },
  });

  await assert.rejects(
    controller.handleRequest({ command: "ensure", options: {} }),
    (error) => {
      assert.equal(error?.code, "EASYCONNECT_AGENT_VPN_UNHEALTHY");
      assert.equal(error?.reason, "data-plane-target-unstable");
      return true;
    },
  );
  assert.equal(snapshotTargets.length <= 9, true);
  assert.equal(calls.some(([name]) => name === "recover"), false);
});

test("ensure refuses an unhealthy recovery during quiet hours unless explicitly overridden", async () => {
  const quietConfig = createConfig({
    maintainerQuietHoursEnabled: true,
    maintainerQuietStart: "18:30",
    maintainerQuietEnd: "09:00",
  });
  const { controller, calls } = createHarness({
    config: quietConfig,
    snapshots: [createSnapshot({ login: "0", sessionId: null, dataPlaneOk: false })],
    nowMs: Date.parse("2026-07-15T11:00:00.000Z"),
  });

  await assert.rejects(
    controller.handleRequest({ command: "ensure", options: {} }),
    (error) => {
      assert.equal(error.code, "EASYCONNECT_AGENT_QUIET_HOURS");
      assert.equal(error.quietHours.active, true);
      return true;
    },
  );
  assert.equal(calls.some(([name]) => name === "recover"), false);
});

test("ensure recovers an offline VPN, persists the selected gateway, and starts keepalive", async () => {
  const { controller, calls, getConfig } = createHarness({
    snapshots: [
      createSnapshot({ login: "0", sessionId: null, dataPlaneOk: false }),
      createSnapshot({ login: "0", sessionId: null, dataPlaneOk: false }),
      createSnapshot(),
    ],
  });

  const result = await controller.handleRequest({ command: "ensure", options: {} });

  assert.equal(result.healthy, true);
  assert.equal(result.action, "recovered");
  assert.equal(calls.filter(([name]) => name === "recover").length, 1);
  assert.equal(calls.some(([name]) => name === "force-recover"), false);
  assert.deepEqual(getConfig().vpn.lastKnownGateway, {
    host: "vpn.example.test",
    port: 9898,
  });
  assert.equal(calls.some(([name]) => name === "start-maintainer"), true);
});

test("ensure confirms a transient post-recovery data-plane failure before forcing restart", async () => {
  const { controller, calls } = createHarness({
    snapshots: [
      createSnapshot({ login: "0", sessionId: null, dataPlaneOk: false }),
      createSnapshot({ login: "0", sessionId: null, dataPlaneOk: false }),
      createSnapshot({ dataPlaneOk: false }),
      createSnapshot(),
    ],
  });

  const result = await controller.handleRequest({ command: "ensure", options: {} });

  assert.equal(result.healthy, true);
  assert.equal(result.recovery.forced, false);
  assert.equal(calls.filter(([name]) => name === "recover").length, 1);
  assert.equal(calls.some(([name]) => name === "force-recover"), false);
  assert.deepEqual(
    calls.filter(([name]) => name === "confirmation-delay"),
    [["confirmation-delay", 500]],
  );
});

test("ensure confirms a transient failure first observed by the in-action recheck", async () => {
  const { controller, calls } = createHarness({
    snapshots: [
      createSnapshot({ login: "0", sessionId: null, dataPlaneOk: false }),
      createSnapshot({ dataPlaneOk: false }),
      createSnapshot(),
    ],
  });

  const result = await controller.handleRequest({ command: "ensure", options: {} });

  assert.equal(result.healthy, true);
  assert.equal(result.action, "already-healthy");
  assert.equal(result.recovery.attempted, false);
  assert.equal(calls.some(([name]) => name === "recover"), false);
  assert.deepEqual(
    calls.filter(([name]) => name === "confirmation-delay"),
    [["confirmation-delay", 500]],
  );
});

test("ensure reconfirms a changed target before escalating to forced recovery", async () => {
  const firstTarget = "tcp://192.168.150.199:1521";
  const secondTarget = "tcp://192.168.150.200:1521";
  const secondConfig = createConfig({ dataPlaneProbeTarget: secondTarget });
  const snapshots = [
    ...Array.from({ length: 7 }, () =>
      createSnapshot({ dataPlaneOk: false, dataPlaneTarget: firstTarget })),
    ...Array.from({ length: 3 }, () =>
      createSnapshot({ dataPlaneOk: false, dataPlaneTarget: secondTarget })),
    createSnapshot({ dataPlaneTarget: secondTarget }),
  ];
  const { controller, calls, snapshotTargets } = createHarness({
    config: createConfig({ dataPlaneProbeTarget: firstTarget }),
    snapshots,
    onSnapshot({ index, setConfig }) {
      if (index === 6) {
        setConfig(secondConfig);
      }
    },
  });

  const result = await controller.handleRequest({
    command: "ensure",
    options: { ignoreQuietHours: true },
  });
  const forceRecoveryIndex = calls.findIndex(([name]) => name === "force-recover");
  const probesBeforeForceRecovery = calls
    .slice(0, forceRecoveryIndex)
    .filter(([name]) => name === "snapshot").length;

  assert.equal(result.recovery.forced, true);
  assert.deepEqual(snapshotTargets.slice(0, probesBeforeForceRecovery).slice(-3), [
    secondTarget,
    secondTarget,
    secondTarget,
  ]);
});

test("ensure does not escalate to forced recovery after quiet hours begin", async () => {
  let currentTime = Date.parse("2026-07-15T10:00:00.000Z");
  const config = createConfig({
    maintainerQuietHoursEnabled: true,
    maintainerQuietStart: "18:30",
    maintainerQuietEnd: "09:00",
  });
  const { controller, calls } = createHarness({
    config,
    snapshots: [
      createSnapshot({ login: "0", sessionId: null, dataPlaneOk: false }),
      createSnapshot({ login: "0", sessionId: null, dataPlaneOk: false }),
      createSnapshot({ dataPlaneOk: false }),
      createSnapshot({ dataPlaneOk: false }),
      createSnapshot({ dataPlaneOk: false }),
    ],
    nowFn: () => currentTime,
    onRecover() {
      currentTime = Date.parse("2026-07-15T19:00:00.000Z");
    },
  });

  await assert.rejects(
    controller.handleRequest({ command: "ensure", options: {} }),
    (error) => error?.code === "EASYCONNECT_AGENT_QUIET_HOURS",
  );

  assert.equal(calls.filter(([name]) => name === "recover").length, 1);
  assert.equal(calls.some(([name]) => name === "force-recover"), false);
});

test("ensure does not log in again when quiet hours begin during a forced client restart", async () => {
  let currentTime = Date.parse("2026-07-15T10:00:00.000Z");
  const { controller, calls } = createHarness({
    config: createConfig({
      maintainerQuietHoursEnabled: true,
      maintainerQuietStart: "18:30",
      maintainerQuietEnd: "09:00",
    }),
    snapshots: [
      createSnapshot({ dataPlaneOk: false }),
      createSnapshot({ dataPlaneOk: false }),
      createSnapshot({ dataPlaneOk: false }),
      createSnapshot({ dataPlaneOk: false }),
      createSnapshot({ dataPlaneOk: false }),
      createSnapshot({ dataPlaneOk: false }),
      createSnapshot({ dataPlaneOk: false }),
      createSnapshot(),
    ],
    nowFn: () => currentTime,
    onForceRecover() {
      currentTime = Date.parse("2026-07-15T19:00:00.000Z");
    },
  });

  await assert.rejects(
    controller.handleRequest({ command: "ensure", options: {} }),
    (error) => error?.code === "EASYCONNECT_AGENT_QUIET_HOURS",
  );

  assert.equal(calls.some(([name]) => name === "force-recover"), true);
  assert.equal(calls.filter(([name]) => name === "recover").length, 1);
});

test("ensure force-recovers a stale control plane only after a normal recovery still fails the data plane", async () => {
  const { controller, calls } = createHarness({
    snapshots: [
      createSnapshot({ dataPlaneOk: false }),
      createSnapshot({ dataPlaneOk: false }),
      createSnapshot({ dataPlaneOk: false }),
      createSnapshot({ dataPlaneOk: false }),
      createSnapshot({ dataPlaneOk: false }),
      createSnapshot({ dataPlaneOk: false }),
      createSnapshot({ dataPlaneOk: false }),
      createSnapshot(),
    ],
  });

  const result = await controller.handleRequest({
    command: "ensure",
    options: { ignoreQuietHours: true },
  });

  assert.equal(result.healthy, true);
  assert.equal(result.recovery.forced, true);
  assert.equal(calls.filter(([name]) => name === "recover").length, 2);
  const firstRecoveryIndex = calls.findIndex(([name]) => name === "recover");
  assert.equal(
    calls.slice(0, firstRecoveryIndex).filter(([name]) => name === "snapshot").length,
    4,
  );
  assert.deepEqual(
    calls.find(([name]) => name === "force-recover"),
    ["force-recover", { remoteDebugPort: 9222, reuseExisting: false }],
  );
  assert.deepEqual(
    calls.find(([name]) => name === "start-maintainer"),
    ["start-maintainer", { ignoreQuietHours: true, gatewayCandidates: [] }],
  );
});

test("concurrent ensure requests share recovery and recheck health inside the action", async () => {
  const offline = createSnapshot({ login: "0", sessionId: null, dataPlaneOk: false });
  const { controller, calls } = createHarness({
    snapshots: [offline, offline, offline, createSnapshot()],
  });

  const [first, second] = await Promise.all([
    controller.handleRequest({ command: "ensure", options: {} }),
    controller.handleRequest({ command: "ensure", options: {} }),
  ]);

  assert.equal(first.healthy, true);
  assert.equal(second.healthy, true);
  assert.equal(calls.filter(([name]) => name === "recover").length, 1);
});

test("an explicit quiet-hours override retries after a shared normal ensure is rejected", async () => {
  let currentTime = Date.parse("2026-07-15T10:00:00.000Z");
  let releaseAction;
  const actionGate = new Promise((resolve) => {
    releaseAction = resolve;
  });
  const offline = createSnapshot({ login: "0", sessionId: null, dataPlaneOk: false });
  const { controller, calls } = createHarness({
    config: createConfig({
      maintainerQuietHoursEnabled: true,
      maintainerQuietStart: "18:30",
      maintainerQuietEnd: "09:00",
    }),
    snapshots: [offline, offline, offline, offline, createSnapshot()],
    nowFn: () => currentTime,
    actionGate: () => actionGate,
  });

  const normalEnsure = controller.handleRequest({ command: "ensure", options: {} });
  while (!calls.some(([name]) => name === "action")) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  const overrideEnsure = controller.handleRequest({
    command: "ensure",
    options: { ignoreQuietHours: true },
  });
  while (calls.filter(([name]) => name === "snapshot").length < 2) {
    await new Promise((resolve) => setImmediate(resolve));
  }

  currentTime = Date.parse("2026-07-15T19:00:00.000Z");
  releaseAction();

  await assert.rejects(
    normalEnsure,
    (error) => error?.code === "EASYCONNECT_AGENT_QUIET_HOURS",
  );
  const overrideResult = await overrideEnsure;
  assert.equal(overrideResult.healthy, true);
  assert.equal(overrideResult.action, "recovered");
  assert.equal(calls.filter(([name]) => name === "recover").length, 1);
});

test("ensure fails before recovery when the data-plane target is unconfigured", async () => {
  const { controller, calls } = createHarness({
    config: createConfig({ dataPlaneProbeTarget: "" }),
    snapshots: [createSnapshot({ dataPlaneConfigured: false })],
  });

  await assert.rejects(
    controller.handleRequest({ command: "ensure", options: {} }),
    (error) => error?.code === "EASYCONNECT_AGENT_CONFIG_INCOMPLETE",
  );
  assert.equal(calls.some(([name]) => name === "recover"), false);
});

test("keepalive commands use the controller-owned maintainer actions", async () => {
  const { controller, calls } = createHarness();
  const started = await controller.handleRequest({
    command: "keepalive-start",
    options: { ignoreQuietHours: true },
  });
  const stopped = await controller.handleRequest({ command: "keepalive-stop", options: {} });

  assert.equal(started.running, true);
  assert.equal(stopped.running, false);
  assert.equal(calls.some(([name]) => name === "start-maintainer"), true);
  assert.equal(calls.some(([name]) => name === "stop-maintainer"), true);
});

test("keepalive start reports missing credentials as incomplete configuration", async () => {
  const { controller, calls } = createHarness({
    config: createConfig({ username: "", password: "" }),
    startMaintainerFn() {
      throw new Error("VpnMaintainer requires vpn username and password");
    },
  });

  await assert.rejects(
    controller.handleRequest({ command: "keepalive-start", options: {} }),
    (error) => {
      assert.equal(error.code, "EASYCONNECT_AGENT_CONFIG_INCOMPLETE");
      assert.equal(error.reason, "credentials-unconfigured");
      return true;
    },
  );
  assert.equal(calls.some(([name]) => name === "start-maintainer"), false);
});

test("keepalive override validates credentials before replacing a running maintainer", async () => {
  const { controller, calls } = createHarness({
    config: createConfig({ username: "", password: "" }),
    initialMaintainerStatus: { running: true },
  });

  await assert.rejects(
    controller.handleRequest({
      command: "keepalive-start",
      options: { ignoreQuietHours: true },
    }),
    (error) => error?.code === "EASYCONNECT_AGENT_CONFIG_INCOMPLETE",
  );
  assert.equal(calls.some(([name]) => name === "start-maintainer"), false);
  assert.equal(calls.some(([name]) => name === "stop-maintainer"), false);
});

test("an explicit quiet-hours override runs after an ordinary keepalive start", async () => {
  const firstStarted = createDeferred();
  const releaseFirst = createDeferred();
  let startCount = 0;
  const { controller, calls } = createHarness({
    async startMaintainerFn(options) {
      startCount += 1;
      if (startCount === 1) {
        firstStarted.resolve();
        await releaseFirst.promise;
        return { running: false, startSuppressed: true };
      }
      assert.equal(options.ignoreQuietHours, true);
      return { running: true, startSuppressed: false };
    },
  });

  const ordinary = controller.handleRequest({ command: "keepalive-start", options: {} });
  await firstStarted.promise;
  const override = controller.handleRequest({
    command: "keepalive-start",
    options: { ignoreQuietHours: true },
  });

  try {
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(calls.filter(([name]) => name === "start-maintainer").length, 1);
    releaseFirst.resolve();
    assert.equal((await ordinary).running, false);
    assert.equal((await override).running, true);
    assert.deepEqual(
      calls
        .filter(([name]) => name === "start-maintainer")
        .map(([, options]) => options.ignoreQuietHours),
      [false, true],
    );
  } finally {
    releaseFirst.resolve();
  }
});

test("healthy ensure restarts keepalive after a concurrent stop finishes draining", async () => {
  const stopStarted = createDeferred();
  const releaseStop = createDeferred();
  const { controller, calls } = createHarness({
    initialMaintainerStatus: { running: true },
    async stopMaintainerFn() {
      stopStarted.resolve();
      await releaseStop.promise;
      return { running: false, draining: false };
    },
  });

  const stopping = controller.handleRequest({ command: "keepalive-stop", options: {} });
  await stopStarted.promise;
  const ensuring = controller.handleRequest({ command: "ensure", options: {} });

  try {
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(calls.some(([name]) => name === "start-maintainer"), false);
    releaseStop.resolve();
    assert.equal((await stopping).running, false);
    const result = await ensuring;
    assert.equal(result.healthy, true);
    assert.equal(result.keepalive.running, true);
    assert.equal(calls.filter(([name]) => name === "stop-maintainer").length, 1);
    assert.equal(calls.filter(([name]) => name === "start-maintainer").length, 1);
  } finally {
    releaseStop.resolve();
  }
});

test("config normalizes producer values to the CLI protocol ranges", async () => {
  const { controller } = createHarness({
    config: createConfig({
      dataPlaneProbeTimeoutMs: -1,
      maintainerIntervalSeconds: -30,
      lastKnownGateway: { host: "last.example.test", port: 70000 },
      gateways: [
        { host: "valid.example.test", port: 443 },
        { host: "high.example.test", port: 70000 },
        { host: "negative.example.test", port: -1 },
      ],
    }),
  });

  const result = await controller.handleRequest({ command: "config", options: {} });

  assert.equal(result.dataPlaneProbeTimeoutMs, 5000);
  assert.equal(result.maintainerIntervalSeconds, 300);
  assert.equal(result.lastKnownGateway, null);
  assert.deepEqual(result.gateways, [{ host: "valid.example.test", port: 443 }]);
});
