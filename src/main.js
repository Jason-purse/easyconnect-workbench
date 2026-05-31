import path from "node:path";
import { fileURLToPath } from "node:url";
import { app, BrowserWindow, ipcMain, shell, Menu, nativeImage, Tray } from "electron";
import { ConfigStore } from "./services/config-store.js";
import { VpnService } from "./services/vpn-service.js";
import { VpnMaintainer } from "./services/vpn-maintainer.js";
import { runOfficialUiRepairSmoke } from "./services/vpn-official-ui-repair-smoke.js";
import { applyGatewaySelectionHint, applyProbeHints, applySnapshotHints } from "./services/vpn-config-hints.js";
import { mergeConfigForRender } from "./services/vpn-render-config.js";
import { maybeStartMaintainerAutoStart } from "./services/vpn-autostart.js";
import { buildTrayStatusLabels, buildTrayStatusSignature, buildTrayTooltip } from "./services/app-tray-state.js";
import { createMaintainerLogger } from "./services/maintainer-log.js";
import {
  assertMaintainerFailure,
  assertGatewayConfigUnchanged,
  assertMaintainerOnline,
  assertMaintainerRecoveredFromOffline,
  assertNoPersistedGateways,
  summarizeAutostartResult,
  summarizeMaintainerStatus,
} from "./services/vpn-smoke-summary.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TRAY_REFRESH_INTERVAL_MS = 15000;

let mainWindow = null;
let appTray = null;
let trayRefreshTimer = null;
let trayStatusSignature = null;
let isQuitting = false;
let configStore = null;
let vpnService = null;
let vpnMaintainer = null;

function configureAppPaths() {
  app.setName("EasyConnect Workbench");
  app.setPath("userData", path.join(app.getPath("appData"), "easyconnect-workbench"));
}

configureAppPaths();

const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
}

function hasArg(name, argv = process.argv) {
  return argv.includes(name);
}

function isSmokeRun(argv = process.argv) {
  return argv.some((item) => item.startsWith("--smoke-"));
}

function shouldStartHidden(argv = process.argv) {
  if (hasArg("--hidden", argv)) {
    return true;
  }

  if (argv !== process.argv) {
    return false;
  }

  try {
    const settings = app.getLoginItemSettings();
    return Boolean(settings.wasOpenedAsHidden || settings.wasOpenedAtLogin);
  } catch {
    return false;
  }
}

function applyLoginItemSettings(config = {}) {
  const openAtLogin = Boolean(config?.app?.launchAtLogin);
  if (isSmokeRun()) {
    return {
      supported: app.isPackaged,
      applied: false,
      openAtLogin,
      reason: "login item settings are skipped during smoke runs",
    };
  }

  if (!app.isPackaged) {
    return {
      supported: false,
      applied: false,
      openAtLogin,
      reason: "login item settings are only applied from the packaged app",
    };
  }

  app.setLoginItemSettings({
    openAtLogin,
    openAsHidden: true,
  });

  return {
    supported: true,
    applied: true,
    openAtLogin,
  };
}

function getNumberArg(name, fallback) {
  const prefix = `${name}=`;
  const raw = process.argv.find((item) => item.startsWith(prefix))?.slice(prefix.length);
  const value = Number.parseInt(`${raw ?? ""}`, 10);

  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function writeSmokeEvent(event, payload = {}) {
  console.log(JSON.stringify({ event, ...payload }));
}

function summarizeRuntimeSnapshot(snapshot = {}) {
  const activeSession = snapshot.activeSession
    ? {
        tokenRedacted: snapshot.activeSession.tokenRedacted ?? null,
        sessionId: snapshot.activeSession.sessionId ?? null,
        derivedTokenMatches: snapshot.activeSession.derivedTokenMatches ?? null,
      }
    : null;

  return {
    activeSession,
    loginStatus: snapshot.loginStatus ?? null,
    serviceState: snapshot.serviceState ?? null,
    error: snapshot.error ?? null,
  };
}

async function getRuntimeSnapshot(runtime) {
  const activeSession = await runtime.describeActiveSession();
  if (!activeSession?.token) {
    return {
      activeSession: null,
      loginStatus: null,
      serviceState: null,
    };
  }

  try {
    const [loginStatus, serviceState] = await Promise.all([
      runtime.getLoginStatus(activeSession.token),
      runtime.getServiceState(activeSession.token),
    ]);

    return {
      activeSession,
      loginStatus,
      serviceState,
    };
  } catch (error) {
    return {
      activeSession,
      loginStatus: null,
      serviceState: null,
      error: error?.message ?? String(error),
    };
  }
}

function isRuntimeSnapshotOnline(snapshot) {
  return Boolean(snapshot?.activeSession?.sessionId && snapshot?.loginStatus?.status === "1");
}

async function waitForRuntimeOffline(runtime, timeoutMs, pollMs = 500) {
  const startedAt = Date.now();
  let snapshot = null;

  while (Date.now() - startedAt < timeoutMs) {
    snapshot = await getRuntimeSnapshot(runtime);
    if (!isRuntimeSnapshotOnline(snapshot)) {
      return snapshot;
    }

    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }

  const error = new Error("Timed out waiting for forced VPN offline state");
  error.snapshot = snapshot;
  error.status = vpnMaintainer.getStatus();
  throw error;
}

async function waitForMaintainerCycle(minCycleCount, timeoutMs, pollMs = 250) {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const status = vpnMaintainer.getStatus();
    if (status.cycleCount >= minCycleCount && status.lastEvent) {
      return status;
    }

    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }

  const status = vpnMaintainer.getStatus();
  const error = new Error(`Timed out waiting for maintainer cycle ${minCycleCount}`);
  error.status = status;
  throw error;
}

async function waitForMaintainerFirstCycle(timeoutMs, pollMs = 250) {
  return waitForMaintainerCycle(1, timeoutMs, pollMs);
}

async function runVpnAutostartSmoke() {
  const timeoutMs = getNumberArg("--smoke-timeout-ms", 120000);
  const autostart = await maybeStartMaintainerAutoStart({
    configStore,
    vpnMaintainer,
  });

  writeSmokeEvent("autostart", { result: summarizeAutostartResult(autostart) });

  if (!autostart.ok || !autostart.started) {
    throw new Error(`VPN autostart did not start: ${autostart.error ?? autostart.reason ?? "unknown"}`);
  }

  const status = await waitForMaintainerFirstCycle(timeoutMs);
  writeSmokeEvent("first-cycle", { status: summarizeMaintainerStatus(status) });

  assertMaintainerOnline(status, "VPN autostart");

  return status;
}

async function runVpnKeepaliveSmoke() {
  const timeoutMs = getNumberArg("--smoke-timeout-ms", 180000);
  const intervalSeconds = getNumberArg("--smoke-interval-seconds", 10);
  const offlineTimeoutMs = getNumberArg("--smoke-offline-timeout-ms", Math.max(4000, intervalSeconds * 1000 - 1500));
  const config = await configStore.load();
  const smokeConfig = {
    ...config,
    vpn: {
      ...(config.vpn ?? {}),
      maintainerAutoStart: true,
      maintainerIntervalSeconds: intervalSeconds,
    },
  };

  const started = await vpnMaintainer.start(smokeConfig);
  writeSmokeEvent("started", { status: summarizeMaintainerStatus(started) });

  const firstCycle = assertMaintainerOnline(
    await waitForMaintainerCycle(1, timeoutMs),
    "VPN keepalive initial",
  );
  writeSmokeEvent("initial-online", { status: summarizeMaintainerStatus(firstCycle) });

  const runtime = vpnService.createRuntime(smokeConfig);
  const killed = await runtime.killMainAppProcesses({ force: true });
  writeSmokeEvent("forced-disconnect", { killed });

  const offline = await waitForRuntimeOffline(runtime, offlineTimeoutMs);
  writeSmokeEvent("offline-observed", { snapshot: summarizeRuntimeSnapshot(offline) });

  const recovered = assertMaintainerOnline(
    await waitForMaintainerCycle(firstCycle.cycleCount + 1, timeoutMs),
    "VPN keepalive recovery",
  );
  writeSmokeEvent("recovered", { status: summarizeMaintainerStatus(recovered) });

  return recovered;
}

async function runVpnOfflineRecoverySmoke() {
  const timeoutMs = getNumberArg("--smoke-timeout-ms", 180000);
  const intervalSeconds = getNumberArg("--smoke-interval-seconds", 10);
  const offlineTimeoutMs = getNumberArg("--smoke-offline-timeout-ms", 30000);
  const config = await configStore.load();
  const smokeConfig = {
    ...config,
    vpn: {
      ...(config.vpn ?? {}),
      maintainerAutoStart: true,
      maintainerIntervalSeconds: intervalSeconds,
    },
  };

  const runtime = vpnService.createRuntime(smokeConfig);
  const killed = await runtime.killMainAppProcesses({ force: true });
  writeSmokeEvent("forced-disconnect", { killed });

  const offline = await waitForRuntimeOffline(runtime, offlineTimeoutMs);
  writeSmokeEvent("offline-observed", { snapshot: summarizeRuntimeSnapshot(offline) });

  const started = await vpnMaintainer.start(smokeConfig);
  writeSmokeEvent("recovery-started", { status: summarizeMaintainerStatus(started) });

  const recovered = assertMaintainerRecoveredFromOffline(
    await waitForMaintainerCycle(1, timeoutMs),
    "VPN offline recovery",
  );
  writeSmokeEvent("recovered", { status: summarizeMaintainerStatus(recovered) });

  return {
    offline,
    recovered,
  };
}

async function runVpnFailureStateSmoke() {
  const timeoutMs = getNumberArg("--smoke-timeout-ms", 180000);
  const intervalSeconds = getNumberArg("--smoke-interval-seconds", 10);
  const config = await configStore.load();
  const invalidGateways = [
    {
      host: "127.0.0.1",
      port: 1,
    },
    {
      host: "127.0.0.2",
      port: 1,
    },
  ];
  const failureConfig = {
    ...config,
    vpn: {
      ...(config.vpn ?? {}),
      maintainerAutoStart: true,
      maintainerIntervalSeconds: intervalSeconds,
      lastKnownGateway: invalidGateways[0],
      gateways: invalidGateways,
    },
  };

  const runtime = vpnService.createRuntime(config);
  const killed = await runtime.killMainAppProcesses({ force: true });
  writeSmokeEvent("forced-disconnect", { killed });

  const offline = await waitForRuntimeOffline(runtime, 15000);
  writeSmokeEvent("offline-observed", { snapshot: summarizeRuntimeSnapshot(offline) });

  const started = await vpnMaintainer.start(failureConfig);
  writeSmokeEvent("failure-started", { status: summarizeMaintainerStatus(started) });

  const failed = assertMaintainerFailure(
    await waitForMaintainerCycle(1, timeoutMs),
    "VPN failure-state",
  );
  writeSmokeEvent("failure-state", { status: summarizeMaintainerStatus(failed) });

  await vpnMaintainer.stop();
  const afterFailureConfig = assertGatewayConfigUnchanged(
    config,
    await configStore.load(),
    "VPN failure-state",
  );
  writeSmokeEvent("config-unchanged-after-failure", {
    lastKnownGateway: afterFailureConfig.vpn?.lastKnownGateway ?? null,
    gateways: afterFailureConfig.vpn?.gateways ?? [],
  });

  const restoredStart = await vpnMaintainer.start({
    ...config,
    vpn: {
      ...(config.vpn ?? {}),
      maintainerAutoStart: true,
      maintainerIntervalSeconds: intervalSeconds,
    },
  });
  writeSmokeEvent("restore-started", { status: summarizeMaintainerStatus(restoredStart) });

  const restored = assertMaintainerOnline(
    await waitForMaintainerCycle(1, timeoutMs),
    "VPN failure-state restore",
  );
  writeSmokeEvent("restored", { status: summarizeMaintainerStatus(restored) });

  const afterRestoreConfig = assertNoPersistedGateways(
    await configStore.load(),
    invalidGateways,
    "VPN failure-state restore",
  );
  writeSmokeEvent("config-clean-after-restore", {
    lastKnownGateway: afterRestoreConfig.vpn?.lastKnownGateway ?? null,
    gateways: afterRestoreConfig.vpn?.gateways ?? [],
  });

  return {
    failed,
    restored,
  };
}

async function runVpnOfficialUiRepairSmoke() {
  const config = await configStore.load();
  const result = await runOfficialUiRepairSmoke({
    vpnService,
    config,
    allowServiceTargetMutation: hasArg("--smoke-allow-ui-mutation"),
    onlineWaitMs: getNumberArg("--smoke-online-wait-ms", 15000),
  });

  writeSmokeEvent("official-ui-repair", { result });

  return result;
}

async function runAppLifecycleSmoke() {
  createAppTray();
  createWindow();

  await new Promise((resolve) => setTimeout(resolve, 250));

  if (!appTray) {
    throw new Error("App lifecycle smoke did not create tray");
  }

  if (!mainWindow || mainWindow.isDestroyed()) {
    throw new Error("App lifecycle smoke did not create main window");
  }

  mainWindow.close();
  await new Promise((resolve) => setTimeout(resolve, 250));

  const hiddenAfterClose = !mainWindow.isVisible() && !mainWindow.isDestroyed();
  if (!hiddenAfterClose) {
    throw new Error("Main window close should hide the window without destroying it");
  }

  showMainWindow();
  await new Promise((resolve) => setTimeout(resolve, 250));

  const visibleAfterShow = mainWindow.isVisible() && !mainWindow.isDestroyed();
  if (!visibleAfterShow) {
    throw new Error("Main window should be visible after tray show action");
  }

  return {
    trayCreated: true,
    hiddenAfterClose,
    visibleAfterShow,
  };
}

async function runAppHiddenStartSmoke() {
  createAppTray();

  await new Promise((resolve) => setTimeout(resolve, 250));

  if (!appTray) {
    throw new Error("App hidden-start smoke did not create tray");
  }

  if (BrowserWindow.getAllWindows().length !== 0) {
    throw new Error("Hidden start should not create a browser window");
  }

  showMainWindow();
  await new Promise((resolve) => setTimeout(resolve, 250));

  if (!mainWindow || mainWindow.isDestroyed() || !mainWindow.isVisible()) {
    throw new Error("Tray show action should create and show the browser window");
  }

  return {
    trayCreated: true,
    windowCountBeforeShow: 0,
    visibleAfterShow: true,
  };
}


function createTrayIcon() {
  if (process.platform === "darwin") {
    const icon = nativeImage.createFromNamedImage("NSStatusAvailable", [-1]);
    if (!icon.isEmpty()) {
      icon.setTemplateImage(true);
      return icon;
    }
  }

  return nativeImage.createFromDataURL(
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=",
  );
}

function showMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createWindow();
    return;
  }

  if (mainWindow.isMinimized()) {
    mainWindow.restore();
  }

  mainWindow.show();
  mainWindow.focus();
}

function runTrayAction(action) {
  Promise.resolve()
    .then(action)
    .catch((error) => {
      console.error("[tray]", error);
    })
    .finally(() => {
      updateTrayMenu();
    });
}

async function startMaintainerFromTray() {
  const config = await configStore.load();
  return vpnMaintainer.start(config);
}

function updateTrayMenu() {
  if (!appTray || !vpnMaintainer) {
    return;
  }

  const status = vpnMaintainer.getStatus();
  const signature = buildTrayStatusSignature(status);
  if (signature === trayStatusSignature) {
    return;
  }

  trayStatusSignature = signature;
  const labels = buildTrayStatusLabels(status);
  appTray.setToolTip(buildTrayTooltip(status));
  appTray.setContextMenu(
    Menu.buildFromTemplate([
      {
        label: labels.title,
        enabled: false,
      },
      {
        label: labels.detail,
        enabled: false,
      },
      {
        label: `网关: ${labels.gateway}`,
        enabled: false,
      },
      {
        label: `会话: ${labels.session}`,
        enabled: false,
      },
      {
        label: `最近动作: ${labels.action}`,
        enabled: false,
      },
      {
        type: "separator",
      },
      {
        label: "打开控制台",
        click: () => showMainWindow(),
      },
      {
        label: "启动 / 恢复 VPN 守护",
        enabled: labels.canStart,
        click: () => runTrayAction(startMaintainerFromTray),
      },
      {
        label: "停止 VPN 守护",
        enabled: labels.canStop,
        click: () => runTrayAction(() => vpnMaintainer.stop()),
      },
      {
        label: "刷新托盘状态",
        click: () => updateTrayMenu(),
      },
      {
        type: "separator",
      },
      {
        label: "打开日志目录",
        click: () =>
          runTrayAction(async () => {
            const info = await vpnService.getEnvironmentInfo(await configStore.load());
            await shell.openPath(info.logsDir);
          }),
      },
      {
        label: "打开配置目录",
        click: () => runTrayAction(() => shell.openPath(app.getPath("userData"))),
      },
      {
        type: "separator",
      },
      {
        label: "退出 EasyConnect Workbench",
        click: () => {
          isQuitting = true;
          app.quit();
        },
      },
    ]),
  );
}

function startTrayRefresh() {
  if (trayRefreshTimer) {
    clearInterval(trayRefreshTimer);
  }

  trayRefreshTimer = setInterval(updateTrayMenu, TRAY_REFRESH_INTERVAL_MS);
  // Keep this timer referenced: hidden launch has no BrowserWindow, so the tray
  // heartbeat is the Workbench process residency guard when maintainer is idle.
}

function createAppTray() {
  if (appTray) {
    return appTray;
  }

  appTray = new Tray(createTrayIcon());
  appTray.on("click", () => showMainWindow());
  updateTrayMenu();
  startTrayRefresh();

  return appTray;
}

function createWindow() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    showMainWindow();
    return mainWindow;
  }

  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 1080,
    minHeight: 760,
    title: "EasyConnect Workbench",
    backgroundColor: "#f4efe6",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, "renderer", "index.html"));

  mainWindow.on("close", (event) => {
    if (isQuitting) {
      return;
    }

    event.preventDefault();
    mainWindow.hide();
    updateTrayMenu();
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
    updateTrayMenu();
  });

  return mainWindow;
}

function registerIpc() {
  const resolveConfig = async (payload = {}) => {
    const storedConfig = await configStore.load();
    return payload.config ? mergeConfigForRender(payload.config, storedConfig) : storedConfig;
  };

  ipcMain.handle("config:get", async () => configStore.load());

  ipcMain.handle("config:save", async (_event, nextConfig) => {
    const saved = await configStore.save(nextConfig);
    applyLoginItemSettings(saved);
    return saved;
  });

  ipcMain.handle("vpn:snapshot", async (_event, payload = {}) => {
    const config = payload.config ?? (await configStore.load());
    const snapshot = await vpnService.getSnapshot(config);
    const storedConfig = await configStore.load();
    const hintedConfig = applySnapshotHints(storedConfig, snapshot);
    if (hintedConfig !== storedConfig) {
      await configStore.save(hintedConfig);
    }
    return snapshot;
  });
  ipcMain.handle("vpn:status", async () => vpnService.getStatus(await configStore.load()));
  ipcMain.handle("vpn:info", async () => vpnService.getEnvironmentInfo(await configStore.load()));
  ipcMain.handle("vpn:recovery-plan", async (_event, payload = {}) =>
    vpnService.getRecoveryPlan(await resolveConfig(payload), payload.gatewayCandidates ?? []),
  );
  ipcMain.handle("vpn:probe-recovery", async (_event, payload = {}) => {
    const config = await resolveConfig(payload);
    const results = await vpnService.probeRecoveryGateways(config, payload.gatewayCandidates ?? []);
    const storedConfig = await configStore.load();
    const hintedConfig = applyProbeHints(storedConfig, results);
    if (hintedConfig !== storedConfig) {
      await configStore.save(hintedConfig);
    }
    return results;
  });

  ipcMain.handle("vpn:launch-user", async (_event, payload = {}) => {
    const nextPayload = typeof payload === "number" ? { remoteDebugPort: payload } : payload;
    return vpnService.launchOfficialClient(await resolveConfig(nextPayload), {
      remoteDebugPort: nextPayload.remoteDebugPort ?? null,
    });
  });

  ipcMain.handle("vpn:recover-user", async (_event, payload = {}) => {
    const nextPayload = typeof payload === "number" ? { remoteDebugPort: payload } : payload;
    return vpnService.recoverOfficialClient(await resolveConfig(nextPayload), {
      remoteDebugPort: nextPayload.remoteDebugPort ?? null,
    });
  });

  ipcMain.handle("vpn:debug-targets", async (_event, payload = {}) =>
    vpnService.getDebugTargets(await resolveConfig(payload), payload.remoteDebugPort ?? 9222),
  );

  ipcMain.handle("vpn:portal-login", async (_event, payload = {}) =>
    vpnService.portalLogin(
      await resolveConfig(payload),
      payload.username ?? "",
      payload.password ?? "",
      payload.remoteDebugPort ?? 9222,
    ),
  );

  ipcMain.handle("vpn:recover-login", async (_event, payload = {}) => {
    const config = await resolveConfig(payload);
    const result = await vpnService.recoverAndLogin(
      config,
      payload.username ?? "",
      payload.password ?? "",
      payload.remoteDebugPort ?? 9222,
      payload.gatewayCandidates ?? [],
    );

    if (result.gateway?.host && result.gateway?.port) {
      const hintedConfig = applyGatewaySelectionHint(config, result.gateway);
      if (hintedConfig !== config) {
        await configStore.save(hintedConfig);
      }
    }

    return result;
  });

  ipcMain.handle("vpn:repair-official-ui", async (_event, payload = {}) =>
    vpnService.repairOfficialUi(await resolveConfig(payload), {
      remoteDebugPort: payload.remoteDebugPort ?? null,
      focusServiceTarget: payload.focusServiceTarget ?? true,
    }),
  );

  ipcMain.handle("vpn:maintainer-status", async () => vpnMaintainer.getStatus());
  ipcMain.handle("vpn:maintainer-start", async (_event, payload = {}) => {
    const config = await configStore.load();
    const status = await vpnMaintainer.start(config, {
      gatewayCandidates: payload.gatewayCandidates ?? [],
    });

    updateTrayMenu();
    return status;
  });
  ipcMain.handle("vpn:maintainer-stop", async () => {
    const status = await vpnMaintainer.stop();
    updateTrayMenu();
    return status;
  });

  ipcMain.handle("app:open-logs", async () => {
    const info = await vpnService.getEnvironmentInfo(await configStore.load());
    return shell.openPath(info.logsDir);
  });

  ipcMain.handle("app:open-config-dir", async () => shell.openPath(app.getPath("userData")));
}

app.whenReady().then(async () => {
  configureAppPaths();
  configStore = new ConfigStore(app.getPath("userData"));
  vpnService = new VpnService();
  vpnMaintainer = new VpnMaintainer({
    eventLogger: createMaintainerLogger(path.join(app.getPath("home"), "Library", "Logs", "easyconnect-workbench")),
    repairOfficialUiFn: (config, options) => vpnService.repairOfficialUi(config, options),
    onGatewaySelected: async (gateway) => {
      const config = await configStore.load();
      const hintedConfig = applyGatewaySelectionHint(config, gateway);
      if (hintedConfig !== config) {
        await configStore.save(hintedConfig);
      }
    },
  });
  registerIpc();
  applyLoginItemSettings(await configStore.load());
  if (hasArg("--smoke-vpn-autostart")) {
    try {
      await runVpnAutostartSmoke();
      await vpnMaintainer.stop();
      app.exit(0);
    } catch (error) {
      writeSmokeEvent("error", {
        message: error?.message ?? String(error),
        status: summarizeMaintainerStatus(error?.status ?? vpnMaintainer.getStatus()),
      });
      await vpnMaintainer.stop();
      app.exit(1);
    }
    return;
  }

  if (hasArg("--smoke-vpn-keepalive")) {
    try {
      await runVpnKeepaliveSmoke();
      await vpnMaintainer.stop();
      app.exit(0);
    } catch (error) {
      writeSmokeEvent("error", {
        message: error?.message ?? String(error),
        status: summarizeMaintainerStatus(error?.status ?? vpnMaintainer.getStatus()),
        snapshot: error?.snapshot ? summarizeRuntimeSnapshot(error.snapshot) : null,
      });
      await vpnMaintainer.stop();
      app.exit(1);
    }
    return;
  }

  if (hasArg("--smoke-vpn-offline-recovery")) {
    try {
      await runVpnOfflineRecoverySmoke();
      await vpnMaintainer.stop();
      app.exit(0);
    } catch (error) {
      writeSmokeEvent("error", {
        message: error?.message ?? String(error),
        status: summarizeMaintainerStatus(error?.status ?? vpnMaintainer.getStatus()),
        snapshot: error?.snapshot ? summarizeRuntimeSnapshot(error.snapshot) : null,
      });
      await vpnMaintainer.stop();
      app.exit(1);
    }
    return;
  }

  if (hasArg("--smoke-vpn-failure-state")) {
    try {
      await runVpnFailureStateSmoke();
      await vpnMaintainer.stop();
      app.exit(0);
    } catch (error) {
      writeSmokeEvent("error", {
        message: error?.message ?? String(error),
        status: summarizeMaintainerStatus(error?.status ?? vpnMaintainer.getStatus()),
        snapshot: error?.snapshot ? summarizeRuntimeSnapshot(error.snapshot) : null,
      });
      await vpnMaintainer.stop();
      app.exit(1);
    }
    return;
  }

  if (hasArg("--smoke-official-ui-repair")) {
    try {
      await runVpnOfficialUiRepairSmoke();
      await vpnMaintainer.stop();
      app.exit(0);
    } catch (error) {
      writeSmokeEvent("error", {
        message: error?.message ?? String(error),
        repair: error?.repair ?? null,
        status: summarizeMaintainerStatus(vpnMaintainer.getStatus()),
      });
      await vpnMaintainer.stop();
      app.exit(1);
    }
    return;
  }

  if (hasArg("--smoke-app-lifecycle")) {
    try {
      const result = await runAppLifecycleSmoke();
      writeSmokeEvent("app-lifecycle", result);
      await vpnMaintainer.stop();
      app.exit(0);
    } catch (error) {
      writeSmokeEvent("error", {
        message: error?.message ?? String(error),
        status: summarizeMaintainerStatus(vpnMaintainer.getStatus()),
      });
      await vpnMaintainer.stop();
      app.exit(1);
    }
    return;
  }

  if (hasArg("--smoke-app-hidden-start")) {
    try {
      const result = await runAppHiddenStartSmoke();
      writeSmokeEvent("app-hidden-start", result);
      await vpnMaintainer.stop();
      app.exit(0);
    } catch (error) {
      writeSmokeEvent("error", {
        message: error?.message ?? String(error),
        status: summarizeMaintainerStatus(vpnMaintainer.getStatus()),
      });
      await vpnMaintainer.stop();
      app.exit(1);
    }
    return;
  }

  await maybeStartMaintainerAutoStart({
    configStore,
    vpnMaintainer,
  });
  createAppTray();
  if (!shouldStartHidden()) {
    createWindow();
  }

  app.on("activate", () => {
    showMainWindow();
  });
});

app.on("second-instance", (_event, argv) => {
  if (isSmokeRun(argv) || shouldStartHidden(argv)) {
    return;
  }

  showMainWindow();
});

app.on("window-all-closed", () => {
  if (isQuitting && process.platform !== "darwin") {
    app.quit();
  }
});

app.on("before-quit", async () => {
  isQuitting = true;
  if (trayRefreshTimer) {
    clearInterval(trayRefreshTimer);
    trayRefreshTimer = null;
  }

  if (vpnMaintainer) {
    await vpnMaintainer.stop();
  }
});
