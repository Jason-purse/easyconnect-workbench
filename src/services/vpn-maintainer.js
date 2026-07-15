import { EasyConnectRuntime } from "../easyconnect-bridge/runtime.mjs";
import { EasyConnectGatewayLogin } from "../easyconnect-bridge/login.mjs";
import { ensureOnline, maintainOnline } from "../easyconnect-bridge/maintainer.mjs";
import { redactMaintainerEvent } from "./maintainer-log.js";
import { describeVpnDataPlaneProbe } from "./vpn-data-plane-probe.js";
import { collectRecoveryGateways } from "./vpn-gateway-pool.js";

const LOCAL_SERVICE_FAILURE_BACKOFF_MS = 15 * 60 * 1000;
const ACTIVE_ACTION_RETRY_MAX_MS = 30 * 1000;
const DATA_PLANE_FAILURE_RETRY_MAX_MS = 30 * 1000;
const OFFICIAL_UI_REPAIR_COOLDOWN_MS = 15 * 60 * 1000;
const OFFICIAL_UI_POST_REPAIR_SETTLE_MS = 75 * 1000;
const DEFAULT_QUIET_START = "18:30";
const DEFAULT_QUIET_END = "09:00";
const SUCCESSFUL_OFFICIAL_UI_REPAIR_ACTIONS = new Set([
  "already-consistent",
  "repair-official-ui",
  "restore-unreachable-official-ui",
  "restore-hidden-service-target",
  "restore-missing-service-target",
]);
const RECOVERY_INFRASTRUCTURE_FAILURE_CODES = new Set([
  "EASYCONNECT_LOCAL_SERVICE_NOT_READY",
  "EASYCONNECT_AGENT_PROXY_NOT_READY",
  "EASYCONNECT_PRIVATE_KICK",
]);

function sanitizeResult(result) {
  const next = JSON.parse(JSON.stringify(result));
  const sanitizeGatewayExchange = (exchange) => {
    if (!exchange) {
      return;
    }

    delete exchange.cookie;
    delete exchange.xml;
    delete exchange.twfId;

    if (exchange.response) {
      delete exchange.response.body;
      if (exchange.response.headers) {
        delete exchange.response.headers.twfid;
        delete exchange.response.headers["set-cookie"];
      }
    }

    if (exchange.summary) {
      delete exchange.summary.twfId;
      delete exchange.summary.cookieTwfId;
      delete exchange.summary.bodyTwfId;
      delete exchange.summary.effectiveTwfId;
    }
  };

  if (next?.activeSession) {
    delete next.activeSession.token;
  }

  sanitizeGatewayExchange(next?.auth);
  sanitizeGatewayExchange(next?.passwordConfig);

  if (next?.login?.summary) {
    delete next.login.summary.cookieTwfId;
    delete next.login.summary.bodyTwfId;
    delete next.login.summary.effectiveTwfId;
  }
  if (next?.loginSummary) {
    delete next.loginSummary.cookieTwfId;
    delete next.loginSummary.bodyTwfId;
    delete next.loginSummary.effectiveTwfId;
    delete next.loginSummary.twfId;
  }
  if (next?.bootstrap) {
    delete next.bootstrap.token;
  }
  if (next?.bridge) {
    delete next.bridge.token;
  }
  if (next?.officialUiRepair?.bridge) {
    delete next.officialUiRepair.bridge.token;
  }
  if (next?.officialUiRepair?.status?.activeSession?.token) {
    next.officialUiRepair.status.activeSession.token = undefined;
  }
  if (next?.officialUiRepair?.status?.latestCachedToken?.token) {
    next.officialUiRepair.status.latestCachedToken.token = undefined;
  }
  if (next?.online?.activeSession?.token) {
    next.online.activeSession.token = undefined;
  }
  return next;
}

function cloneState(state) {
  return JSON.parse(JSON.stringify(state));
}

function getDataPlaneObservedAt(dataPlane, fallbackMs) {
  const observedAt = `${dataPlane?.observedAt ?? ""}`;
  return Number.isFinite(Date.parse(observedAt)) ? observedAt : new Date(fallbackMs).toISOString();
}

function getRemoteDebugPort(config = {}) {
  return Number.parseInt(`${config?.vpn?.remoteDebugPort ?? 9222}`, 10) || 9222;
}

function getOfficialUiRepairCooldownMs(config = {}) {
  const value = Number.parseInt(`${config?.vpn?.officialUiRepairCooldownMs ?? OFFICIAL_UI_REPAIR_COOLDOWN_MS}`, 10);
  return Number.isFinite(value) && value >= 0 ? value : OFFICIAL_UI_REPAIR_COOLDOWN_MS;
}

function getOfficialUiPostRepairSettleMs(config = {}) {
  const value = Number.parseInt(`${config?.vpn?.officialUiPostRepairSettleMs ?? OFFICIAL_UI_POST_REPAIR_SETTLE_MS}`, 10);
  return Number.isFinite(value) && value >= 0 ? value : OFFICIAL_UI_POST_REPAIR_SETTLE_MS;
}

function getMaintainerCycleTimeoutMs(config = {}, options = {}) {
  return (
    Number.parseInt(`${options.cycleTimeoutMs ?? config?.vpn?.maintainerCycleTimeoutMs ?? 180000}`, 10) ||
    180000
  );
}

function parseQuietTime(value, fallback) {
  const text = `${value ?? fallback}`.trim();
  const match = /^(\d{1,2})[:.](\d{1,2})$/.exec(text);
  if (!match) {
    return parseQuietTime(fallback, "00:00");
  }

  const hours = Number.parseInt(match[1], 10);
  const minutes = Number.parseInt(match[2], 10);
  if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) {
    return parseQuietTime(fallback, "00:00");
  }

  return {
    label: `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`,
    minutes: hours * 60 + minutes,
  };
}

function getLocalMinuteOfDay(date) {
  return date.getHours() * 60 + date.getMinutes();
}

function buildLocalTime(date, minuteOfDay, dayOffset = 0) {
  const hours = Math.floor(minuteOfDay / 60);
  const minutes = minuteOfDay % 60;
  return new Date(
    date.getFullYear(),
    date.getMonth(),
    date.getDate() + dayOffset,
    hours,
    minutes,
    0,
    0,
  );
}

export function getQuietHoursState(config = {}, nowMs = Date.now()) {
  if (config?.vpn?.maintainerQuietHoursEnabled !== true) {
    return {
      active: false,
    };
  }

  const start = parseQuietTime(config?.vpn?.maintainerQuietStart, DEFAULT_QUIET_START);
  const end = parseQuietTime(config?.vpn?.maintainerQuietEnd, DEFAULT_QUIET_END);
  const now = new Date(nowMs);
  const minute = getLocalMinuteOfDay(now);
  let active = false;
  let endDate = null;

  if (start.minutes === end.minutes) {
    active = true;
    endDate = buildLocalTime(now, end.minutes, 1);
  } else if (start.minutes < end.minutes) {
    active = minute >= start.minutes && minute < end.minutes;
    endDate = buildLocalTime(now, end.minutes, 0);
  } else {
    active = minute >= start.minutes || minute < end.minutes;
    endDate = buildLocalTime(now, end.minutes, minute >= start.minutes ? 1 : 0);
  }

  if (!active) {
    return {
      active: false,
      start: start.label,
      end: end.label,
    };
  }

  const nextIntervalMs = Math.max(endDate.getTime() - now.getTime(), 1000);
  return {
    active: true,
    start: start.label,
    end: end.label,
    nowLocal: now.toLocaleString(),
    resumeAt: endDate.toLocaleString(),
    nextIntervalMs,
  };
}

function buildQuietHoursPausedResult(quietHours) {
  return {
    action: "keepalive-paused-quiet-hours",
    reason: `Automatic keepalive is paused between ${quietHours.start} and ${quietHours.end}.`,
    quietHours: {
      start: quietHours.start,
      end: quietHours.end,
      nowLocal: quietHours.nowLocal,
      resumeAt: quietHours.resumeAt,
    },
    nextIntervalMs: quietHours.nextIntervalMs,
  };
}

function withLastKnownGateway(config = {}, gateway = {}) {
  return {
    ...config,
    vpn: {
      ...(config.vpn ?? {}),
      lastKnownGateway: {
        host: gateway.host,
        port: gateway.port,
      },
    },
  };
}

function getResultOnline(result = {}) {
  return result?.online ?? result;
}

function isRecoveryInfrastructureReadinessFailure(error) {
  if (!error) {
    return false;
  }

  if (RECOVERY_INFRASTRUCTURE_FAILURE_CODES.has(error.code)) {
    return true;
  }

  if (error.diagnostics?.classification === "local-service-not-ready") {
    return true;
  }

  return Array.isArray(error.gatewayAttempts) && error.gatewayAttempts.some((attempt) => (
    RECOVERY_INFRASTRUCTURE_FAILURE_CODES.has(attempt.code) ||
    attempt.diagnostics?.classification === "local-service-not-ready"
  ));
}

function isDataPlaneFailure(error) {
  return `${error?.code ?? ""}`.startsWith("VPN_DATA_PLANE_");
}

function createDataPlaneFailure(dataPlane, dataPlaneProbeRevision) {
  const error = new Error(`VPN data-plane probe failed for ${dataPlane?.target ?? "the configured target"}`);
  error.code = dataPlane?.code ?? "VPN_DATA_PLANE_UNREACHABLE";
  error.dataPlane = dataPlane;
  error.dataPlaneProbeRevision = dataPlaneProbeRevision;
  return error;
}

function getDataPlaneProbeConfig(config = {}) {
  return {
    vpn: {
      dataPlaneProbeTarget: `${config?.vpn?.dataPlaneProbeTarget ?? ""}`.trim(),
      dataPlaneProbeTimeoutMs: config?.vpn?.dataPlaneProbeTimeoutMs,
    },
  };
}

function isOperationResultOk(value) {
  if (!value || typeof value !== "object") {
    return true;
  }

  return value.ok !== false;
}

function isSuccessfulOfficialUiRepair(repair = {}) {
  if (repair.action === "already-consistent") {
    return isConsistentOfficialUiRepairStatus(repair.status);
  }

  if (repair.action === "skip-native-window-activation-background") {
    return isNativeWindowActivationOnlyRepairStatus(repair.status);
  }

  if (!SUCCESSFUL_OFFICIAL_UI_REPAIR_ACTIONS.has(repair.action)) {
    return false;
  }

  const operationResults = [
    ...(repair.closedResidualTargets ?? []).map((target) => target?.result),
    ...(repair.repairedResidualTargets ?? []).map((target) => target?.result),
    ...(repair.restoreAttempts ?? []).map((target) => target?.result),
    repair.dismissedNativeAlerts,
    repair.serviceReload,
    repair.navigation,
  ].filter(Boolean);

  return operationResults.every(isOperationResultOk) && isConsistentOfficialUiRepairStatus(repair.status);
}

function isNativeWindowActivationOnlyRepairStatus(status = null) {
  const officialUi = status?.officialUi;
  if (!officialUi) {
    return false;
  }

  return Boolean(
    officialUi.reachable &&
      officialUi.hasServiceTarget &&
      !officialUi.hasBlockingVisibleTarget &&
      (
        officialUi.hasBlockingNativeAlert ||
        officialUi.needsNativeWindowRestore ||
        officialUi.needsNativeWindowConsolidation ||
        officialUi.hasDuplicateNativeWindows
      ),
  );
}

function isConsistentOfficialUiRepairStatus(status = null) {
  const officialUi = status?.officialUi;
  if (!officialUi) {
    return true;
  }

  return Boolean(
    officialUi.reachable &&
      officialUi.hasServiceTarget &&
      !officialUi.hasBlockingVisibleTarget &&
      !officialUi.hasBlockingNativeAlert &&
      !officialUi.needsNativeWindowRestore &&
      !officialUi.needsNativeWindowConsolidation &&
      !officialUi.hasDuplicateNativeWindows,
  );
}

export class VpnMaintainer {
  constructor(options = {}) {
    this.runtimeFactory =
      options.runtimeFactory ??
      ((config = {}) =>
        new EasyConnectRuntime({
          appExecutable: config?.vpn?.appExecutable,
        }));
    this.gatewayLoginFactory =
      options.gatewayLoginFactory ??
      ((gateway) =>
        new EasyConnectGatewayLogin({
          host: gateway.host,
          port: gateway.port,
        }));
    this.ensureOnlineFn = options.ensureOnlineFn ?? ensureOnline;
    this.maintainOnlineFn = options.maintainOnlineFn ?? maintainOnline;
    this.repairOfficialUiFn = options.repairOfficialUiFn ?? null;
    this.dataPlaneProbeFn = options.dataPlaneProbeFn ?? null;
    this.actionRunner =
      options.actionRunner ?? ((_key, operation) => Promise.resolve().then(operation));
    this.nowFn = options.nowFn ?? (() => Date.now());
    this.onGatewaySelected = options.onGatewaySelected ?? (async () => {});
    this.eventLogger = options.eventLogger ?? null;
    this.controller = null;
    this.activeRun = null;
    this.activeCyclePromise = null;
    this.activeCycleMetadata = null;
    this.startPromise = null;
    this.stopPromise = null;
    this.execution = null;
    this.lastOfficialUiRepair = null;
    this.dataPlaneProbeConfig = getDataPlaneProbeConfig();
    this.dataPlaneProbeRevision = 0;
    this.dataPlaneProbeDescriptor = describeVpnDataPlaneProbe(this.dataPlaneProbeConfig, "pending");
    this.state = {
      running: false,
      draining: false,
      drainingSince: null,
      gateway: null,
      intervalSeconds: null,
      cycleTimeoutMs: null,
      startedAt: null,
      stoppedAt: null,
      cycleCount: 0,
      currentPhase: null,
      phaseUpdatedAt: null,
      lastEventAt: null,
      lastEvent: null,
      lastError: null,
      dataPlaneProbe: cloneState(this.dataPlaneProbeDescriptor),
      dataPlaneProbeRevision: this.dataPlaneProbeRevision,
      dataPlaneObservation: null,
    };
  }

  getStatus() {
    return cloneState(this.state);
  }

  updateDataPlaneProbeConfig(config = {}) {
    const nextConfig = getDataPlaneProbeConfig(config);
    const targetChanged =
      nextConfig.vpn.dataPlaneProbeTarget !== this.dataPlaneProbeConfig.vpn.dataPlaneProbeTarget;
    this.dataPlaneProbeConfig = nextConfig;
    this.dataPlaneProbeDescriptor = describeVpnDataPlaneProbe(nextConfig, "pending");
    if (targetChanged) {
      this.dataPlaneProbeRevision += 1;
      this.state.lastEventAt = null;
      this.state.lastEvent = null;
      this.state.lastError = null;
      this.state.dataPlaneObservation = null;
    }
    this.state.dataPlaneProbe = cloneState(this.dataPlaneProbeDescriptor);
    this.state.dataPlaneProbeRevision = this.dataPlaneProbeRevision;
  }

  recordDataPlaneObservation(dataPlane, options = {}) {
    if (!dataPlane || typeof dataPlane !== "object") {
      return false;
    }

    const observationConfig = options.config
      ? getDataPlaneProbeConfig(options.config)
      : this.dataPlaneProbeConfig;
    if (
      observationConfig.vpn.dataPlaneProbeTarget !==
      this.dataPlaneProbeConfig.vpn.dataPlaneProbeTarget
    ) {
      return false;
    }

    const expectedProbe = this.dataPlaneProbeDescriptor;
    const targetMatches =
      Boolean(expectedProbe.configured) === Boolean(dataPlane.configured) &&
      (expectedProbe.configured !== true || expectedProbe.target === dataPlane.target);
    if (!targetMatches) {
      return false;
    }

    const status = options.status ?? {};
    this.state.dataPlaneObservation = {
      observedAt: getDataPlaneObservedAt(dataPlane, this.nowFn()),
      dataPlaneProbeRevision: this.dataPlaneProbeRevision,
      activeSession: status.activeSession?.sessionId
        ? { sessionId: status.activeSession.sessionId }
        : null,
      loginStatus: status.loginStatus?.status != null
        ? { status: status.loginStatus.status }
        : null,
      dataPlane: cloneState(dataPlane),
    };
    return true;
  }

  async writeEvent(event, payload = {}) {
    try {
      await this.eventLogger?.write?.(event, redactMaintainerEvent(payload));
    } catch {
      // Logging must never break the VPN maintainer loop.
    }
  }

  async repairOfficialUiAfterOnline(config, gateway, onlineResult) {
    if (!this.repairOfficialUiFn) {
      return null;
    }

    const now = this.nowFn();
    const cooldownMs = getOfficialUiRepairCooldownMs(config);
    const online = getResultOnline(onlineResult);
    const sessionId = online?.activeSession?.sessionId ?? null;
    const lastRepairIsReusable = Boolean(this.lastOfficialUiRepair?.reusable);
    const canSkipStableOnlineRepair =
      onlineResult?.action === "already-online" &&
      lastRepairIsReusable &&
      this.lastOfficialUiRepair?.sessionId === sessionId &&
      now - this.lastOfficialUiRepair.at < cooldownMs;

    if (canSkipStableOnlineRepair) {
      return {
        action: "skip-recently-consistent",
        reason: "official UI was already repaired for the current online session",
        cooldownMs,
        lastRepairAction: this.lastOfficialUiRepair.action,
      };
    }

    try {
      const repair = await this.repairOfficialUiFn(withLastKnownGateway(config, gateway), {
        remoteDebugPort: getRemoteDebugPort(config),
        knownOnlineStatus: sanitizeResult(online),
        onlineAction: onlineResult?.action ?? null,
        postRepairSettleMs: getOfficialUiPostRepairSettleMs(config),
        allowNativeWindowActivation: false,
      });

      if (SUCCESSFUL_OFFICIAL_UI_REPAIR_ACTIONS.has(repair?.action)) {
        this.lastOfficialUiRepair = {
          at: now,
          action: repair.action,
          sessionId,
          reusable: isSuccessfulOfficialUiRepair(repair),
        };
      }

      return repair;
    } catch (error) {
      return {
        action: "repair-error",
        error: error?.message ?? String(error),
      };
    }
  }

  async disableOfficialAutoConnect(runtime, config = {}) {
    if (typeof runtime?.disableOfficialAutoConnectBeforeLaunch !== "function") {
      return {
        ok: false,
        action: "unsupported",
        reason: "runtime does not expose disableOfficialAutoConnectBeforeLaunch",
      };
    }

    try {
      return await runtime.disableOfficialAutoConnectBeforeLaunch({
        remoteDebugPort: getRemoteDebugPort(config),
      });
    } catch (error) {
      return {
        ok: false,
        action: "error",
        error: error?.message ?? String(error),
      };
    }
  }

  async cleanupOfficialUiAfterPrivateKick(runtime, config = {}) {
    const officialAutoConnectGuard = await this.disableOfficialAutoConnect(runtime, config);
    let killedMainApp = null;

    if (typeof runtime?.killMainAppProcesses !== "function") {
      killedMainApp = {
        ok: false,
        action: "unsupported",
        reason: "runtime does not expose killMainAppProcesses",
      };
    } else {
      try {
        killedMainApp = {
          ok: true,
          ...(await runtime.killMainAppProcesses({ force: true })),
        };
      } catch (error) {
        killedMainApp = {
          ok: false,
          error: error?.message ?? String(error),
        };
      }
    }

    return {
      reason: "private-kick",
      officialAutoConnectGuard,
      killedMainApp,
    };
  }

  start(config = {}, options = {}) {
    if (this.state.running) {
      return Promise.resolve(this.getStatus());
    }
    if (this.startPromise) {
      return this.startPromise;
    }

    const startPromise = this.startRun(config, options);
    this.startPromise = startPromise;
    const clear = () => {
      if (this.startPromise === startPromise) {
        this.startPromise = null;
      }
    };
    startPromise.then(clear, clear);
    return startPromise;
  }

  async startRun(config = {}, options = {}) {
    if (this.state.running) {
      return this.getStatus();
    }

    const username = `${config?.vpn?.username ?? ""}`.trim();
    const password = config?.vpn?.password ?? "";
    if (!username || !password) {
      throw new Error("VpnMaintainer requires vpn username and password");
    }

    this.updateDataPlaneProbeConfig(config);
    const runtime = this.runtimeFactory(config);
    const officialAutoConnectGuard = await this.actionRunner("maintainer-initialize", () =>
      this.disableOfficialAutoConnect(runtime, config),
    );
    let gateways = collectRecoveryGateways(
      config,
      options.gatewayCandidates ?? [],
      [],
    );

    if (gateways.length === 0) {
      gateways = collectRecoveryGateways(
        config,
        options.gatewayCandidates ?? [],
        await runtime.getGatewayCandidates(),
      );
    }
    const gateway = gateways[0] ?? null;
    if (!gateway) {
      throw new Error("VpnMaintainer could not resolve a gateway");
    }

    const intervalSeconds = Number.parseInt(`${config?.vpn?.maintainerIntervalSeconds ?? 300}`, 10) || 300;
    const cycleTimeoutMs = getMaintainerCycleTimeoutMs(config, options);
    const controller = new AbortController();
    const runId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const ensureOnlineAcrossGateways = async (maintainOptions = {}) => {
      const cycleSignal = maintainOptions.signal ?? controller.signal;
      const quietHours = getQuietHoursState(config, this.nowFn());
      if (quietHours.active) {
        return buildQuietHoursPausedResult(quietHours);
      }

      const cycleMetadata = {
        dataPlaneProbeConfig: this.dataPlaneProbeConfig,
        dataPlaneProbeRevision: this.dataPlaneProbeRevision,
      };
      this.activeCycleMetadata = cycleMetadata;
      let cyclePromise = null;
      try {
        cyclePromise = this.actionRunner("maintainer-cycle", async () => {
          let lastError = new Error("VpnMaintainer could not recover any gateway");
          const gatewayAttempts = [];

          for (const gatewayCandidate of gateways) {
            try {
              const result = await this.ensureOnlineFn({
                ...maintainOptions,
                signal: cycleSignal,
                runtime,
                gatewayLogin: this.gatewayLoginFactory(gatewayCandidate),
                gatewayHost: gatewayCandidate.host,
                gatewayPort: gatewayCandidate.port,
                username,
                password,
                onPhase: (phase) => {
                  if (this.activeRun !== runId) {
                    return;
                  }

                  this.state.currentPhase = phase;
                  this.state.phaseUpdatedAt = new Date().toISOString();
                  maintainOptions.onPhase?.(phase);
                  void this.writeEvent("maintainer-phase", {
                    runId,
                    phase,
                    gateway: {
                      host: gatewayCandidate.host,
                      port: gatewayCandidate.port,
                    },
                  });
                },
              });
              const dataPlaneResult = this.dataPlaneProbeFn
                ? await this.dataPlaneProbeFn(cycleMetadata.dataPlaneProbeConfig, {
                    signal: cycleSignal,
                  })
                : {
                    configured: false,
                    ok: null,
                    state: "unconfigured",
                    target: null,
                  };
              const dataPlane = {
                ...dataPlaneResult,
                observedAt: getDataPlaneObservedAt(dataPlaneResult, this.nowFn()),
              };
              const dataPlaneProbeRevision = cycleMetadata.dataPlaneProbeRevision;
              if (dataPlane.configured && dataPlane.ok !== true) {
                throw createDataPlaneFailure(dataPlane, dataPlaneProbeRevision);
              }
              const officialUiRepair = await this.repairOfficialUiAfterOnline(config, gatewayCandidate, result);
              const usedGateway = result.action !== "already-online";

              return {
                ...(usedGateway ? { gateway: gatewayCandidate } : {}),
                gatewayAttempts: [
                  ...gatewayAttempts,
                  {
                    gateway: `${gatewayCandidate.host}:${gatewayCandidate.port}`,
                    ok: true,
                  },
                ],
                ...result,
                dataPlane,
                dataPlaneProbeRevision,
                ...(officialUiRepair ? { officialUiRepair } : {}),
              };
            } catch (error) {
              lastError = error;
              const attempt = {
                gateway: `${gatewayCandidate.host}:${gatewayCandidate.port}`,
                ok: false,
                error: error?.message ?? String(error),
              };
              if (error?.code) {
                attempt.code = error.code;
              }
              if (error?.diagnostics) {
                attempt.diagnostics = error.diagnostics;
              }
              if (error?.dataPlane) {
                attempt.dataPlane = error.dataPlane;
              }
              if (Number.isInteger(error?.dataPlaneProbeRevision)) {
                attempt.dataPlaneProbeRevision = error.dataPlaneProbeRevision;
              }
              if (error?.code === "EASYCONNECT_PRIVATE_KICK") {
                const privateKickCleanup = await this.cleanupOfficialUiAfterPrivateKick(runtime, config);
                attempt.privateKickCleanup = privateKickCleanup;
                error.privateKickCleanup = privateKickCleanup;
              }
              gatewayAttempts.push(attempt);
              if (controller.signal.aborted && error?.name === "AbortError") {
                error.gatewayAttempts = gatewayAttempts;
                throw error;
              }
              if (isRecoveryInfrastructureReadinessFailure(error) || isDataPlaneFailure(error)) {
                error.gatewayAttempts = gatewayAttempts;
                throw error;
              }
            }
          }

          lastError.gatewayAttempts = gatewayAttempts;
          throw lastError;
        });
        this.activeCyclePromise = cyclePromise;
        return await cyclePromise;
      } catch (error) {
        if (error?.code === "EASYCONNECT_VPN_ACTION_IN_PROGRESS") {
          return {
            action: "keepalive-deferred-active-action",
            activeAction: error.activeKey ?? null,
            nextIntervalMs: Math.min(intervalSeconds * 1000, ACTIVE_ACTION_RETRY_MAX_MS),
          };
        }

        throw error;
      } finally {
        if (this.activeCyclePromise === cyclePromise) {
          this.activeCyclePromise = null;
        }
        if (this.activeCycleMetadata === cycleMetadata) {
          this.activeCycleMetadata = null;
        }
      }
    };

    this.controller = controller;
    this.activeRun = runId;
    this.lastOfficialUiRepair = null;
    this.state = {
      running: true,
      draining: false,
      drainingSince: null,
      gateway: {
        host: gateway.host,
        port: gateway.port,
      },
      intervalSeconds,
      cycleTimeoutMs,
      startedAt: new Date().toISOString(),
      stoppedAt: null,
      cycleCount: 0,
      currentPhase: null,
      phaseUpdatedAt: null,
      lastEventAt: null,
      lastEvent: null,
      lastError: null,
      dataPlaneProbe: cloneState(this.dataPlaneProbeDescriptor),
      dataPlaneProbeRevision: this.dataPlaneProbeRevision,
      dataPlaneObservation: null,
      officialAutoConnectGuard,
    };

    await this.writeEvent("maintainer-started", {
      runId,
      gateway: this.state.gateway,
      gateways,
      intervalSeconds,
      cycleTimeoutMs,
      username,
      officialAutoConnectGuard,
    });

    const execution = this.maintainOnlineFn({
      signal: controller.signal,
      intervalMs: intervalSeconds * 1000,
      cycleTimeoutMs,
      runtime,
      username,
      password,
      ensureOnlineFn: ensureOnlineAcrossGateways,
      onCycle: async (event) => {
        if (this.activeRun !== runId) {
          return;
        }

        if (
          !event.ok &&
          event.error?.code === "MAINTAINER_CYCLE_TIMEOUT" &&
          !Number.isInteger(event.error?.dataPlaneProbeRevision) &&
          Number.isInteger(this.activeCycleMetadata?.dataPlaneProbeRevision)
        ) {
          event.error.dataPlaneProbeRevision = this.activeCycleMetadata.dataPlaneProbeRevision;
        }
        const eventDataPlaneProbeRevision = event.ok
          ? event.result?.dataPlaneProbeRevision
          : event.error?.dataPlaneProbeRevision;
        const drainingCycle =
          !event.ok &&
          event.error?.code === "MAINTAINER_CYCLE_TIMEOUT" &&
          this.activeCyclePromise;

        const isStaleDataPlaneCycle = () =>
          Number.isInteger(eventDataPlaneProbeRevision) &&
          eventDataPlaneProbeRevision !== this.dataPlaneProbeRevision;
        const ignoreStaleDataPlaneCycle = async () => {
          this.state.currentPhase = null;
          this.state.phaseUpdatedAt = null;
          await this.writeEvent("maintainer-cycle-stale-data-plane", {
            runId,
            ignoredProbeRevision: eventDataPlaneProbeRevision,
            currentProbeRevision: this.dataPlaneProbeRevision,
          });
          if (drainingCycle) {
            try {
              await drainingCycle;
            } catch {
              // The obsolete cycle has no user-facing state to preserve.
            }
          }
          return {
            nextIntervalMs: Math.min(intervalSeconds * 1000, DATA_PLANE_FAILURE_RETRY_MAX_MS),
          };
        };

        if (isStaleDataPlaneCycle()) {
          return ignoreStaleDataPlaneCycle();
        }

        const cycleLastPhase = this.state.currentPhase;
        const selectedGateway =
          event.ok && event.result?.gateway?.host && event.result?.gateway?.port
            ? event.result.gateway
            : null;
        if (selectedGateway) {
          await this.onGatewaySelected(selectedGateway);
        }
        if (this.activeRun !== runId) {
          return;
        }

        if (isStaleDataPlaneCycle()) {
          return ignoreStaleDataPlaneCycle();
        }

        this.state.cycleCount += 1;
        this.state.lastEventAt = new Date().toISOString();
        this.state.currentPhase = null;
        this.state.phaseUpdatedAt = null;
        if (selectedGateway) {
          this.state.gateway = selectedGateway;
        }
        this.state.lastEvent = event.ok
          ? {
              ok: true,
              result: sanitizeResult(event.result),
            }
          : {
              ok: false,
              error: event.error?.message ?? String(event.error),
              code: event.error?.code,
              lastPhase: cycleLastPhase,
              diagnostics: event.error?.diagnostics,
              privateKickCleanup: event.error?.privateKickCleanup,
              gatewayAttempts: event.error?.gatewayAttempts,
              dataPlane: event.error?.dataPlane,
              dataPlaneProbeRevision: event.error?.dataPlaneProbeRevision,
            };
        this.state.lastError = event.ok ? null : this.state.lastEvent.error;
        if (drainingCycle) {
          this.state.draining = true;
          this.state.drainingSince = new Date().toISOString();
          this.state.currentPhase = "draining-cycle";
          this.state.phaseUpdatedAt = this.state.drainingSince;
        }
        await this.writeEvent("maintainer-cycle", {
          runId,
          cycleCount: this.state.cycleCount,
          ...this.state.lastEvent,
        });
        if (drainingCycle) {
          try {
            await drainingCycle;
          } catch {
            // The timeout event already records this cycle's user-facing failure.
          }
          if (this.activeRun === runId) {
            this.state.draining = false;
            this.state.drainingSince = null;
            this.state.currentPhase = null;
            this.state.phaseUpdatedAt = null;
          }
        }
        if (!event.ok && isRecoveryInfrastructureReadinessFailure(event.error)) {
          return {
            nextIntervalMs: Math.max(intervalSeconds * 1000, LOCAL_SERVICE_FAILURE_BACKOFF_MS),
          };
        }
        if (!event.ok && isDataPlaneFailure(event.error)) {
          return {
            nextIntervalMs: Math.min(intervalSeconds * 1000, DATA_PLANE_FAILURE_RETRY_MAX_MS),
          };
        }
        if (event.ok && Number.isFinite(event.result?.nextIntervalMs) && event.result.nextIntervalMs > 0) {
          return {
            nextIntervalMs: event.result.nextIntervalMs,
          };
        }
        return null;
      },
    })
      .catch((error) => {
        if (this.activeRun !== runId) {
          return;
        }

        this.state.lastError = error?.message ?? String(error);
        void this.writeEvent("maintainer-error", {
          runId,
          error: this.state.lastError,
        });
      })
      .finally(async () => {
        const activeCyclePromise = this.activeCyclePromise;
        if (activeCyclePromise) {
          this.state.draining = true;
          this.state.drainingSince ??= new Date().toISOString();
          try {
            await activeCyclePromise;
          } catch {
            // The cycle result is already represented by the maintainer event.
          }
        }

        if (this.activeRun !== runId) {
          return;
        }

        this.state.running = false;
        this.state.draining = false;
        this.state.drainingSince = null;
        this.state.currentPhase = null;
        this.state.phaseUpdatedAt = null;
        this.state.stoppedAt = new Date().toISOString();
        this.controller = null;
        this.activeRun = null;
        if (this.execution === execution) {
          this.execution = null;
        }
        void this.writeEvent("maintainer-stopped", {
          runId,
          cycleCount: this.state.cycleCount,
          lastError: this.state.lastError,
        });
      });

    this.execution = execution;
    await new Promise((resolve) => setImmediate(resolve));
    return this.getStatus();
  }

  stop() {
    if (this.stopPromise) {
      return this.stopPromise;
    }

    const stopPromise = this.stopRun();
    this.stopPromise = stopPromise;
    const clear = () => {
      if (this.stopPromise === stopPromise) {
        this.stopPromise = null;
      }
    };
    stopPromise.then(clear, clear);
    return stopPromise;
  }

  async stopRun() {
    const startPromise = this.startPromise;
    if (startPromise) {
      try {
        await startPromise;
      } catch {
        // A failed start leaves no loop to stop.
      }
    }

    if (!this.controller) {
      this.state.running = false;
      return this.getStatus();
    }

    const execution = this.execution;
    this.controller.abort();
    await execution;

    return this.getStatus();
  }
}
