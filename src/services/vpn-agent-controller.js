import { applyGatewaySelectionHint } from "./vpn-config-hints.js";
import { getMaintainerStatusWithQuietHours } from "./vpn-autostart.js";
import { formatSessionId, sanitizeDiagnosticTextForDisplay } from "./vpn-display.js";

const DATA_PLANE_CONFIRMATION_ATTEMPTS = 3;
const DATA_PLANE_CONFIRMATION_DELAY_MS = 500;
const DATA_PLANE_CONFIRMATION_MAX_ATTEMPTS = 9;

function createAgentError(message, code, details = {}) {
  const error = new Error(message);
  error.code = code;
  Object.assign(error, details);
  return error;
}

function normalizeGateway(gateway) {
  const host = `${gateway?.host ?? ""}`.trim();
  const port = Number.parseInt(`${gateway?.port ?? ""}`, 10) || null;
  return host && Number.isInteger(port) && port > 0 && port <= 65535
    ? { host, port }
    : null;
}

function normalizePositiveInteger(value, fallback) {
  const parsed = Number.parseInt(`${value ?? ""}`, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function hasConfiguredCredentials(config) {
  return Boolean(`${config?.vpn?.username ?? ""}`.trim() && config?.vpn?.password);
}

export function assertAgentMaintainerCredentials(config) {
  if (hasConfiguredCredentials(config)) {
    return;
  }
  throw createAgentError(
    "Configure EasyConnect credentials in Workbench before starting keepalive",
    "EASYCONNECT_AGENT_CONFIG_INCOMPLETE",
    { reason: "credentials-unconfigured" },
  );
}

function getConfiguredDataPlaneProbeTarget(config) {
  return `${config?.vpn?.dataPlaneProbeTarget ?? ""}`.trim();
}

function summarizeDataPlane(dataPlane = null) {
  if (!dataPlane) {
    return {
      configured: false,
      ok: null,
      state: "unavailable",
      target: null,
      route: null,
    };
  }

  return {
    configured: dataPlane.configured === true,
    ok: dataPlane.ok == null ? null : dataPlane.ok === true,
    state: dataPlane.state ?? null,
    target: dataPlane.target ?? null,
    protocol: dataPlane.protocol ?? null,
    route: dataPlane.route
      ? {
          interface: dataPlane.route.interface ?? null,
          gateway: dataPlane.route.gateway ?? null,
          tunneled: dataPlane.route.tunneled === true,
        }
      : null,
    observedAt: dataPlane.observedAt ?? null,
    durationMs: Number.isFinite(dataPlane.durationMs) ? dataPlane.durationMs : null,
    code: dataPlane.code ?? null,
    error:
      dataPlane.error == null
        ? null
        : sanitizeDiagnosticTextForDisplay(dataPlane.error),
  };
}

function getHealthReason({ appExecutableExists, controlPlaneOnline, dataPlane }) {
  if (appExecutableExists === false) {
    return "official-client-missing";
  }
  if (!controlPlaneOnline) {
    return "control-plane-offline";
  }
  if (dataPlane.configured !== true) {
    return "data-plane-unconfigured";
  }
  if (dataPlane.route?.tunneled !== true) {
    return "data-plane-not-tunneled";
  }
  if (dataPlane.ok !== true) {
    return dataPlane.ok == null ? "data-plane-pending" : "data-plane-unreachable";
  }
  return "vpn-ready";
}

function summarizeMaintainer(maintainerStatus = {}) {
  return {
    running: maintainerStatus.running === true,
    draining: maintainerStatus.draining === true,
    currentPhase: maintainerStatus.currentPhase ?? null,
    cycleCount: Number.isFinite(maintainerStatus.cycleCount) ? maintainerStatus.cycleCount : 0,
    gateway: normalizeGateway(maintainerStatus.gateway),
    startedAt: maintainerStatus.startedAt ?? null,
    stoppedAt: maintainerStatus.stoppedAt ?? null,
    lastEventAt: maintainerStatus.lastEventAt ?? null,
    lastError:
      maintainerStatus.lastError == null
        ? null
        : sanitizeDiagnosticTextForDisplay(maintainerStatus.lastError),
    quietHours: maintainerStatus.quietHours
      ? {
          active: maintainerStatus.quietHours.active === true,
          start: maintainerStatus.quietHours.start ?? null,
          end: maintainerStatus.quietHours.end ?? null,
          resumeAt: maintainerStatus.quietHours.resumeAt ?? null,
        }
      : { active: false },
  };
}

export function buildAgentVpnStatus({ snapshot = {}, maintainerStatus = {}, config = {} } = {}) {
  const status = snapshot.status ?? {};
  const sessionId = status.activeSession?.sessionId ?? null;
  const loginStatus = status.loginStatus?.status ?? null;
  const controlPlaneOnline = Boolean(sessionId && loginStatus === "1");
  const dataPlane = summarizeDataPlane(status.dataPlane);
  const reason = getHealthReason({
    appExecutableExists: snapshot.environmentInfo?.appExecutableExists,
    controlPlaneOnline,
    dataPlane,
  });

  return {
    healthy: reason === "vpn-ready",
    reason,
    controlPlane: {
      online: controlPlaneOnline,
      sessionId: sessionId ? formatSessionId(sessionId) : null,
      loginStatus,
      serviceState: status.serviceState
        ? {
            base: status.serviceState.base ?? null,
            l3vpn: status.serviceState.l3vpn ?? null,
            tcp: status.serviceState.tcp ?? null,
          }
        : null,
    },
    dataPlane,
    maintainer: summarizeMaintainer(maintainerStatus),
    gateway:
      normalizeGateway(maintainerStatus.gateway) ??
      normalizeGateway(config?.vpn?.lastKnownGateway) ??
      null,
  };
}

function summarizeRecovery(result = {}) {
  return {
    action: result.action ?? result.mode ?? null,
    gateway: normalizeGateway(result.gateway),
  };
}

function shouldConfirmDataPlaneFailure(summary) {
  return Boolean(
    summary?.reason === "data-plane-unreachable" &&
    summary.controlPlane?.online === true &&
    summary.dataPlane?.configured === true &&
    summary.dataPlane.route?.tunneled === true,
  );
}

export function createVpnAgentController({
  configStore,
  vpnService,
  vpnMaintainer,
  runVpnAction = (_key, operation) => Promise.resolve().then(operation),
  startMaintainer = async () => vpnMaintainer?.start?.(),
  stopMaintainer = async () => vpnMaintainer?.stop?.(),
  nowFn = () => Date.now(),
  delayFn = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
} = {}) {
  if (!configStore || !vpnService || !vpnMaintainer) {
    throw new Error("createVpnAgentController requires configStore, vpnService, and vpnMaintainer");
  }

  let activeRecovery = null;
  let activeMaintainerStart = null;
  let activeMaintainerStop = null;

  async function startMaintainerSingleFlight(options) {
    const ignoreQuietHours = options.ignoreQuietHours === true;
    const existing = activeMaintainerStart;
    if (existing) {
      if (!ignoreQuietHours || existing.ignoreQuietHours) {
        return existing.promise;
      }
      await existing.promise.catch(() => {});
      return startMaintainerSingleFlight(options);
    }

    const entry = {
      ignoreQuietHours,
      promise: null,
    };
    entry.promise = Promise.resolve()
      .then(async () => {
        if (ignoreQuietHours || vpnMaintainer.getStatus().running !== true) {
          assertAgentMaintainerCredentials(await configStore.load());
        }
        return startMaintainer(options);
      })
      .finally(() => {
        if (activeMaintainerStart === entry) {
          activeMaintainerStart = null;
        }
      });
    activeMaintainerStart = entry;
    return entry.promise;
  }

  function stopMaintainerSingleFlight() {
    if (activeMaintainerStop) {
      return activeMaintainerStop;
    }
    const pending = Promise.resolve()
      .then(() => stopMaintainer())
      .finally(() => {
        if (activeMaintainerStop === pending) {
          activeMaintainerStop = null;
        }
      });
    activeMaintainerStop = pending;
    return pending;
  }

  async function ensureMaintainerForHealthy(config, options) {
    let current = vpnMaintainer.getStatus();
    if (activeMaintainerStop) {
      await activeMaintainerStop;
      current = vpnMaintainer.getStatus();
    }
    if (!hasConfiguredCredentials(config)) {
      return current;
    }
    return startMaintainerSingleFlight(options);
  }

  async function readFreshStatus(config = null) {
    const resolvedConfig = config ?? await configStore.load();
    const snapshot = await vpnService.getSnapshot(resolvedConfig, {
      includeOfficialUi: false,
      includeDataPlane: true,
    });
    if (snapshot.status?.dataPlane) {
      vpnMaintainer.recordDataPlaneObservation(snapshot.status.dataPlane, {
        config: resolvedConfig,
        status: snapshot.status,
      });
    }
    const maintainerStatus = getMaintainerStatusWithQuietHours({
      config: resolvedConfig,
      status: vpnMaintainer.getStatus(),
      nowMs: nowFn(),
    });
    return {
      config: resolvedConfig,
      summary: buildAgentVpnStatus({ snapshot, maintainerStatus, config: resolvedConfig }),
    };
  }

  async function saveSelectedGateway(gateway) {
    if (!normalizeGateway(gateway)) {
      return;
    }
    await configStore.update((config) => applyGatewaySelectionHint(config, gateway));
  }

  async function confirmTransientDataPlaneFailure(fresh) {
    if (!shouldConfirmDataPlaneFailure(fresh.summary)) {
      return fresh;
    }

    let confirmedTarget = getConfiguredDataPlaneProbeTarget(fresh.config);
    let dataPlaneAttempt = 1;
    let totalDataPlaneAttempts = 1;
    const throwUnstableTarget = () => {
      throw createAgentError(
        "The data-plane probe target changed too often to confirm three consecutive failures",
        "EASYCONNECT_AGENT_VPN_UNHEALTHY",
        {
          reason: "data-plane-target-unstable",
          dataPlane: fresh.summary.dataPlane,
          status: fresh.summary,
        },
      );
    };
    while (shouldConfirmDataPlaneFailure(fresh.summary)) {
      if (dataPlaneAttempt >= DATA_PLANE_CONFIRMATION_ATTEMPTS) {
        const latestConfig = await configStore.load();
        const latestTarget = getConfiguredDataPlaneProbeTarget(latestConfig);
        if (latestTarget === confirmedTarget) {
          return { ...fresh, config: latestConfig };
        }
        if (totalDataPlaneAttempts >= DATA_PLANE_CONFIRMATION_MAX_ATTEMPTS) {
          throwUnstableTarget();
        }
        fresh = await readFreshStatus(latestConfig);
        totalDataPlaneAttempts += 1;
        if (!shouldConfirmDataPlaneFailure(fresh.summary)) {
          return fresh;
        }
        confirmedTarget = latestTarget;
        dataPlaneAttempt = 1;
        continue;
      }

      if (totalDataPlaneAttempts >= DATA_PLANE_CONFIRMATION_MAX_ATTEMPTS) {
        throwUnstableTarget();
      }
      await delayFn(DATA_PLANE_CONFIRMATION_DELAY_MS);
      const latestConfig = await configStore.load();
      fresh = await readFreshStatus(latestConfig);
      totalDataPlaneAttempts += 1;
      if (!shouldConfirmDataPlaneFailure(fresh.summary)) {
        return fresh;
      }
      const latestTarget = getConfiguredDataPlaneProbeTarget(latestConfig);
      if (latestTarget === confirmedTarget) {
        dataPlaneAttempt += 1;
      } else {
        confirmedTarget = latestTarget;
        dataPlaneAttempt = 1;
      }
    }
    return fresh;
  }

  function assertRecoveryConfig(config, summary) {
    if (!getConfiguredDataPlaneProbeTarget(config)) {
      throw createAgentError(
        "Configure an internal data-plane probe target in EasyConnect Workbench before using ensure",
        "EASYCONNECT_AGENT_CONFIG_INCOMPLETE",
        { reason: "data-plane-unconfigured", dataPlane: summary.dataPlane },
      );
    }
    if (!`${config?.vpn?.username ?? ""}`.trim() || !config?.vpn?.password) {
      throw createAgentError(
        "Configure EasyConnect credentials in Workbench before using ensure",
        "EASYCONNECT_AGENT_CONFIG_INCOMPLETE",
        { reason: "credentials-unconfigured" },
      );
    }
  }

  function assertRecoveryAllowedDuringQuietHours(config, summary, ignoreQuietHours) {
    const maintainerStatus = getMaintainerStatusWithQuietHours({
      config,
      status: vpnMaintainer.getStatus(),
      nowMs: nowFn(),
    });
    if (!maintainerStatus.quietHours.active || ignoreQuietHours) {
      return;
    }
    throw createAgentError(
      "Automatic VPN recovery is paused during configured quiet hours",
      "EASYCONNECT_AGENT_QUIET_HOURS",
      {
        reason: "quiet-hours",
        quietHours: maintainerStatus.quietHours,
        status: summary,
      },
    );
  }

  async function runRecovery(
    config,
    summary,
    { ignoreQuietHours = false, confirmedDataPlaneProbeTarget = null } = {},
  ) {
    return runVpnAction("agent-ensure", async () => {
      const activeConfig = await configStore.load().catch(() => config);
      let current = await readFreshStatus(activeConfig);
      if (confirmedDataPlaneProbeTarget) {
        const latestConfig = await configStore.load();
        if (
          getConfiguredDataPlaneProbeTarget(activeConfig) === confirmedDataPlaneProbeTarget &&
          getConfiguredDataPlaneProbeTarget(latestConfig) === confirmedDataPlaneProbeTarget
        ) {
          current = { ...current, config: latestConfig };
        } else {
          current = await readFreshStatus(latestConfig);
          current = await confirmTransientDataPlaneFailure(current);
        }
      } else {
        current = await confirmTransientDataPlaneFailure(current);
      }
      if (current.summary.healthy) {
        return {
          fresh: current,
          attempted: false,
          forced: false,
          attempts: [],
        };
      }
      const recoveryConfig = current.config;
      assertRecoveryConfig(recoveryConfig, summary);
      assertRecoveryAllowedDuringQuietHours(recoveryConfig, current.summary, ignoreQuietHours);
      const credentials = {
        username: `${recoveryConfig.vpn.username}`.trim(),
        password: recoveryConfig.vpn.password,
        remoteDebugPort: Number.parseInt(`${recoveryConfig.vpn.remoteDebugPort ?? 9222}`, 10) || 9222,
      };
      const first = await vpnService.recoverAndLogin(
        recoveryConfig,
        credentials.username,
        credentials.password,
        credentials.remoteDebugPort,
        [],
      );
      await saveSelectedGateway(first.gateway);
      let fresh = await readFreshStatus(await configStore.load());
      fresh = await confirmTransientDataPlaneFailure(fresh);
      if (fresh.summary.healthy) {
        return {
          fresh,
          attempted: true,
          forced: false,
          attempts: [summarizeRecovery(first)],
        };
      }

      const forceConfig = fresh.config;
      assertRecoveryConfig(forceConfig, fresh.summary);
      assertRecoveryAllowedDuringQuietHours(forceConfig, fresh.summary, ignoreQuietHours);
      const forceRemoteDebugPort =
        Number.parseInt(`${forceConfig.vpn.remoteDebugPort ?? 9222}`, 10) || 9222;
      await vpnService.recoverOfficialClient(forceConfig, {
        remoteDebugPort: forceRemoteDebugPort,
        reuseExisting: false,
      });
      const secondConfig = await configStore.load();
      assertRecoveryConfig(secondConfig, fresh.summary);
      assertRecoveryAllowedDuringQuietHours(secondConfig, fresh.summary, ignoreQuietHours);
      const second = await vpnService.recoverAndLogin(
        secondConfig,
        `${secondConfig.vpn.username}`.trim(),
        secondConfig.vpn.password,
        forceRemoteDebugPort,
        [],
      );
      await saveSelectedGateway(second.gateway);
      fresh = await readFreshStatus(await configStore.load());
      fresh = await confirmTransientDataPlaneFailure(fresh);
      return {
        fresh,
        attempted: true,
        forced: true,
        attempts: [summarizeRecovery(first), summarizeRecovery(second)],
      };
    });
  }

  async function runRecoverySingleFlight(config, summary, options) {
    const existing = activeRecovery;
    if (existing) {
      try {
        return await existing.promise;
      } catch (error) {
        const canRetryWithOverride =
          options.ignoreQuietHours === true &&
          existing.ignoreQuietHours !== true &&
          error?.code === "EASYCONNECT_AGENT_QUIET_HOURS";
        if (!canRetryWithOverride) {
          throw error;
        }
      }
      return runRecoverySingleFlight(config, summary, options);
    }

    const entry = {
      ignoreQuietHours: options.ignoreQuietHours === true,
      promise: null,
    };
    entry.promise = runRecovery(config, summary, options).finally(() => {
      if (activeRecovery === entry) {
        activeRecovery = null;
      }
    });
    activeRecovery = entry;
    return entry.promise;
  }

  async function ensureVpn(options = {}) {
    const ignoreQuietHours = options.ignoreQuietHours === true;
    let fresh = await readFreshStatus();
    const shouldConfirmInitialFailure = shouldConfirmDataPlaneFailure(fresh.summary);
    fresh = await confirmTransientDataPlaneFailure(fresh);
    const confirmedDataPlaneProbeTarget =
      shouldConfirmInitialFailure && shouldConfirmDataPlaneFailure(fresh.summary)
        ? getConfiguredDataPlaneProbeTarget(fresh.config)
        : null;

    if (fresh.summary.healthy) {
      const keepalive = await ensureMaintainerForHealthy(fresh.config, {
        ignoreQuietHours,
        gatewayCandidates: [],
      });
      return {
        command: "ensure",
        ...fresh.summary,
        action: "already-healthy",
        recovery: { attempted: false, forced: false, attempts: [] },
        keepalive: summarizeMaintainer(
          getMaintainerStatusWithQuietHours({
            config: fresh.config,
            status: keepalive ?? vpnMaintainer.getStatus(),
            nowMs: nowFn(),
          }),
        ),
      };
    }

    assertRecoveryConfig(fresh.config, fresh.summary);

    assertRecoveryAllowedDuringQuietHours(fresh.config, fresh.summary, ignoreQuietHours);

    const recovery = await runRecoverySingleFlight(fresh.config, fresh.summary, {
      ignoreQuietHours,
      confirmedDataPlaneProbeTarget,
    });
    fresh = recovery.fresh;
    if (!fresh.summary.healthy) {
      throw createAgentError(
        `VPN recovery completed but health is still ${fresh.summary.reason}`,
        "EASYCONNECT_AGENT_VPN_UNHEALTHY",
        {
          reason: fresh.summary.reason,
          dataPlane: fresh.summary.dataPlane,
          status: fresh.summary,
        },
      );
    }

    const keepalive = await ensureMaintainerForHealthy(fresh.config, {
      ignoreQuietHours,
      gatewayCandidates: [],
    });
    return {
      command: "ensure",
      ...fresh.summary,
      action: recovery.attempted ? "recovered" : "already-healthy",
      recovery: {
        attempted: recovery.attempted,
        forced: recovery.forced,
        attempts: recovery.attempts,
      },
      keepalive: summarizeMaintainer(
        getMaintainerStatusWithQuietHours({
          config: fresh.config,
          status: keepalive ?? vpnMaintainer.getStatus(),
          nowMs: nowFn(),
        }),
      ),
    };
  }

  async function handleRequest({ command, options = {} } = {}) {
    switch (command) {
      case "ping":
        return {
          command: "ping",
          ready: true,
          pid: process.pid,
        };
      case "status": {
        const fresh = await readFreshStatus();
        return { command: "status", ...fresh.summary };
      }
      case "config": {
        const config = await configStore.load();
        return {
          command: "config",
          credentials: {
            usernameConfigured: Boolean(`${config?.vpn?.username ?? ""}`.trim()),
            passwordConfigured: Boolean(config?.vpn?.password),
          },
          dataPlaneProbeTarget: `${config?.vpn?.dataPlaneProbeTarget ?? ""}`.trim() || null,
          dataPlaneProbeTimeoutMs:
            normalizePositiveInteger(config?.vpn?.dataPlaneProbeTimeoutMs, 5000),
          maintainerAutoStart: config?.vpn?.maintainerAutoStart === true,
          maintainerIntervalSeconds:
            normalizePositiveInteger(config?.vpn?.maintainerIntervalSeconds, 300),
          quietHours: {
            enabled: config?.vpn?.maintainerQuietHoursEnabled === true,
            start: config?.vpn?.maintainerQuietStart ?? "18:30",
            end: config?.vpn?.maintainerQuietEnd ?? "09:00",
          },
          lastKnownGateway: normalizeGateway(config?.vpn?.lastKnownGateway),
          gateways: (config?.vpn?.gateways ?? []).map(normalizeGateway).filter(Boolean),
        };
      }
      case "ensure":
        return ensureVpn(options);
      case "keepalive-start": {
        const status = await startMaintainerSingleFlight({
          ignoreQuietHours: options.ignoreQuietHours === true,
          gatewayCandidates: [],
        });
        return {
          command,
          ...summarizeMaintainer(status ?? vpnMaintainer.getStatus()),
        };
      }
      case "keepalive-stop": {
        const status = await stopMaintainerSingleFlight();
        return {
          command,
          ...summarizeMaintainer(status ?? vpnMaintainer.getStatus()),
        };
      }
      default:
        throw createAgentError(
          `Unknown EasyConnect agent command: ${command ?? "(missing)"}`,
          "EASYCONNECT_AGENT_UNKNOWN_COMMAND",
        );
    }
  }

  return {
    handleRequest,
    readFreshStatus,
  };
}
