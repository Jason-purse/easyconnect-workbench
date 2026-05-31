import { EasyConnectRuntime } from "../easyconnect-bridge/runtime.mjs";
import { EasyConnectGatewayLogin } from "../easyconnect-bridge/login.mjs";
import { ensureOnline, maintainOnline } from "../easyconnect-bridge/maintainer.mjs";
import { redactMaintainerEvent } from "./maintainer-log.js";
import { collectRecoveryGateways } from "./vpn-gateway-pool.js";

const LOCAL_SERVICE_FAILURE_BACKOFF_MS = 15 * 60 * 1000;
const OFFICIAL_UI_REPAIR_COOLDOWN_MS = 15 * 60 * 1000;
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

function getRemoteDebugPort(config = {}) {
  return Number.parseInt(`${config?.vpn?.remoteDebugPort ?? 9222}`, 10) || 9222;
}

function getOfficialUiRepairCooldownMs(config = {}) {
  const value = Number.parseInt(`${config?.vpn?.officialUiRepairCooldownMs ?? OFFICIAL_UI_REPAIR_COOLDOWN_MS}`, 10);
  return Number.isFinite(value) && value >= 0 ? value : OFFICIAL_UI_REPAIR_COOLDOWN_MS;
}

function getMaintainerCycleTimeoutMs(config = {}, options = {}) {
  return (
    Number.parseInt(`${options.cycleTimeoutMs ?? config?.vpn?.maintainerCycleTimeoutMs ?? 180000}`, 10) ||
    180000
  );
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

function isOperationResultOk(value) {
  if (!value || typeof value !== "object") {
    return true;
  }

  return value.ok !== false;
}

function isSuccessfulOfficialUiRepair(repair = {}) {
  if (repair.action === "already-consistent") {
    return true;
  }

  if (repair.action !== "repair-official-ui") {
    return false;
  }

  const operationResults = [
    ...(repair.closedResidualTargets ?? []).map((target) => target?.result),
    ...(repair.repairedResidualTargets ?? []).map((target) => target?.result),
    repair.serviceReload,
    repair.navigation,
  ].filter(Boolean);

  return operationResults.every(isOperationResultOk);
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
    this.nowFn = options.nowFn ?? (() => Date.now());
    this.onGatewaySelected = options.onGatewaySelected ?? (async () => {});
    this.eventLogger = options.eventLogger ?? null;
    this.controller = null;
    this.activeRun = null;
    this.lastOfficialUiRepair = null;
    this.state = {
      running: false,
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
    };
  }

  getStatus() {
    return cloneState(this.state);
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
      });

      if (["already-consistent", "repair-official-ui"].includes(repair?.action)) {
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

  async start(config = {}, options = {}) {
    if (this.state.running) {
      return this.getStatus();
    }

    const username = `${config?.vpn?.username ?? ""}`.trim();
    const password = config?.vpn?.password ?? "";
    if (!username || !password) {
      throw new Error("VpnMaintainer requires vpn username and password");
    }

    const runtime = this.runtimeFactory(config);
    const officialAutoConnectGuard = await this.disableOfficialAutoConnect(runtime, config);
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
    const ensureOnlineAcrossGateways = async (maintainOptions) => {
      let lastError = new Error("VpnMaintainer could not recover any gateway");
      const gatewayAttempts = [];

      for (const gatewayCandidate of gateways) {
        try {
          const result = await this.ensureOnlineFn({
            ...maintainOptions,
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
          if (error?.code === "EASYCONNECT_PRIVATE_KICK") {
            const privateKickCleanup = await this.cleanupOfficialUiAfterPrivateKick(runtime, config);
            attempt.privateKickCleanup = privateKickCleanup;
            error.privateKickCleanup = privateKickCleanup;
          }
          gatewayAttempts.push(attempt);
          if (isRecoveryInfrastructureReadinessFailure(error)) {
            error.gatewayAttempts = gatewayAttempts;
            throw error;
          }
        }
      }

      lastError.gatewayAttempts = gatewayAttempts;
      throw lastError;
    };

    this.controller = controller;
    this.activeRun = runId;
    this.lastOfficialUiRepair = null;
    this.state = {
      running: true,
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

        this.state.cycleCount += 1;
        this.state.lastEventAt = new Date().toISOString();
        this.state.currentPhase = null;
        this.state.phaseUpdatedAt = null;
        if (event.ok && event.result?.gateway?.host && event.result?.gateway?.port) {
          this.state.gateway = event.result.gateway;
          await this.onGatewaySelected(event.result.gateway);
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
              diagnostics: event.error?.diagnostics,
              privateKickCleanup: event.error?.privateKickCleanup,
              gatewayAttempts: event.error?.gatewayAttempts,
            };
        this.state.lastError = event.ok ? null : this.state.lastEvent.error;
        await this.writeEvent("maintainer-cycle", {
          runId,
          cycleCount: this.state.cycleCount,
          ...this.state.lastEvent,
        });
        if (!event.ok && isRecoveryInfrastructureReadinessFailure(event.error)) {
          return {
            nextIntervalMs: Math.max(intervalSeconds * 1000, LOCAL_SERVICE_FAILURE_BACKOFF_MS),
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
      .finally(() => {
        if (this.activeRun !== runId) {
          return;
        }

        this.state.running = false;
        this.state.stoppedAt = new Date().toISOString();
        this.controller = null;
        this.activeRun = null;
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

  async stop() {
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
