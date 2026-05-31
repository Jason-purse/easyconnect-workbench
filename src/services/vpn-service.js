import {
  APP_SUPPORT_DIR,
  CACHE_DIR,
  LOGS_DIR,
  getBundleConfDir,
  EasyConnectRuntime,
} from "../easyconnect-bridge/runtime.mjs";
import { EasyConnectGatewayLogin } from "../easyconnect-bridge/login.mjs";
import { ensureOnline } from "../easyconnect-bridge/maintainer.mjs";
import { access } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { buildOfficialUiState } from "./official-ui-state.js";
import { buildRecoveryPlan, collectRecoveryGateways } from "./vpn-gateway-pool.js";

const OFFICIAL_UI_PROBE_EXPRESSION = `(() => ({
  href: location.href,
  title: document.title,
  visibilityState: document.visibilityState,
  hidden: document.hidden,
  bodyText: (document.body && document.body.innerText || "").slice(0, 800)
}))()`;

function getRemoteDebugPort(config = {}) {
  return Number.parseInt(`${config?.vpn?.remoteDebugPort ?? 9222}`, 10) || 9222;
}

function sanitizeDebugUrl(url = "") {
  return `${url}`
    .replace(/(twfid=)[^&]+/gi, "$1<redacted>")
    .replace(/([?&]token=)[^&]+/gi, "$1<redacted>")
    .replace(/[a-fA-F0-9]{16,64}/g, "<hex>");
}

function sanitizeBridgeResult(result) {
  if (!result) {
    return result;
  }

  const next = JSON.parse(JSON.stringify(result));
  delete next.token;
  return next;
}

function sanitizeRemoteDebugOperationResult(result) {
  if (!result || typeof result !== "object") {
    return result;
  }

  const sanitizeNode = (node) => {
    if (Array.isArray(node)) {
      return node.map(sanitizeNode);
    }

    if (!node || typeof node !== "object") {
      return typeof node === "string" ? sanitizeDebugUrl(node) : node;
    }

    const next = {};
    for (const [key, value] of Object.entries(node)) {
      if (typeof value === "string") {
        next[key] = key.toLowerCase().includes("url") || key.toLowerCase() === "error"
          ? sanitizeDebugUrl(value)
          : value;
        continue;
      }

      next[key] = sanitizeNode(value);
    }

    return next;
  };

  return sanitizeNode(JSON.parse(JSON.stringify(result)));
}

function normalizeGateway(gateway) {
  const host = `${gateway?.host ?? ""}`.trim();
  const port = Number.parseInt(`${gateway?.port ?? ""}`, 10) || null;
  if (!host || !port) {
    return null;
  }

  return { host, port };
}

function parseGatewayFromUrl(url = "") {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" || !parsed.pathname.startsWith("/portal")) {
      return null;
    }

    return normalizeGateway({
      host: parsed.hostname,
      port: Number.parseInt(parsed.port || "443", 10),
    });
  } catch {
    return null;
  }
}

function resolveRepairGateway(config = {}, officialUi = {}) {
  const serviceTarget = (officialUi.targets ?? []).find((target) => target.kind === "service");
  const targetGateway = parseGatewayFromUrl(serviceTarget?.url) ??
    (officialUi.targets ?? []).map((target) => parseGatewayFromUrl(target.url)).find(Boolean);

  return (
    targetGateway ??
    normalizeGateway(config?.vpn?.lastKnownGateway) ??
    (config?.vpn?.gateways ?? []).map(normalizeGateway).find(Boolean) ??
    null
  );
}

function targetUrlPartForRepair(target = {}) {
  const url = `${target?.url ?? ""}`;
  if (!url) {
    return null;
  }

  if (url.includes("/local/connect/connect.html")) {
    return "/local/connect/connect.html";
  }

  try {
    const parsed = new URL(url);
    return `${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch {
    return null;
  }
}

function sanitizeSession(session) {
  if (!session) {
    return null;
  }

  return {
    ...session,
    token: undefined,
  };
}

function buildLocalConnectTargetUrl(appExecutable) {
  const contentsDir = path.dirname(path.dirname(appExecutable));
  return pathToFileURL(path.join(contentsDir, "Resources", "Web", "local", "connect", "connect.html")).href;
}

function sanitizeSummary(summary) {
  const next = { ...summary };
  if (next.activeSession?.token) {
    next.activeSession = sanitizeSession(next.activeSession);
  }
  if (next.latestCachedToken?.token) {
    next.latestCachedToken = {
      ...next.latestCachedToken,
      token: undefined,
    };
  }
  return next;
}

function sanitizeEnsureOnlineResult(result) {
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

  if (next?.activeSession?.token) {
    next.activeSession = sanitizeSession(next.activeSession);
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

  if (next?.bootstrap?.token) {
    delete next.bootstrap.token;
  }

  if (next?.bridge?.token) {
    delete next.bridge.token;
  }

  if (next?.online?.activeSession?.token) {
    next.online.activeSession.token = undefined;
  }

  return next;
}

function isConnectNotfoundTarget(target = {}) {
  return `${target.url ?? ""}`.includes("/local/connect_notfound/connect_notfound.html");
}

function shouldCloseResidualOfficialTarget(target = {}) {
  if (!target.id) {
    return false;
  }

  return isConnectNotfoundTarget(target);
}

function shouldRepairResidualOfficialTarget(target = {}) {
  if (!target.id) {
    return false;
  }

  return target.visible && target.kind === "service-failed";
}

function buildOfficialUiResidualClosePlan(officialUi = {}) {
  const targets = officialUi.targets ?? [];

  return targets
    .filter((target) => shouldCloseResidualOfficialTarget(target))
    .map((target) => ({
      id: target.id,
      kind: target.kind,
      title: target.title,
      url: target.url,
    }));
}

function buildOfficialUiResidualRepairPlan(officialUi = {}) {
  const targets = officialUi.targets ?? [];

  return targets
    .filter((target) => shouldRepairResidualOfficialTarget(target))
    .map((target) => ({
      id: target.id,
      kind: target.kind,
      title: target.title,
      url: target.url,
    }));
}

function rankServiceTargetRestoreCandidate(target = {}) {
  if (!target.id || !target.url) {
    return 100;
  }

  const url = `${target.url ?? ""}`;
  if (url.includes("/local/connect_notfound/connect_notfound.html")) {
    return 0;
  }

  const visibleBonus = target.visible ? 0 : 10;
  const ranks = {
    "user-setting": 1,
    "vpn-status-manager": 2,
    connect: 3,
    "probe-failed": 4,
  };

  return (ranks[target.kind] ?? 100) + visibleBonus;
}

function buildOfficialUiServiceRestorePlan(officialUi = {}) {
  return [...(officialUi.targets ?? [])]
    .map((target) => ({
      id: target.id,
      kind: target.kind,
      title: target.title,
      url: target.url,
      visible: target.visible,
      rank: rankServiceTargetRestoreCandidate(target),
    }))
    .filter((target) => target.rank < 100)
    .sort((left, right) => left.rank - right.rank)
    .map(({ rank, ...target }) => target);
}

function officialUiNeedsRepair(officialUi = {}) {
  const closeTargets = buildOfficialUiResidualClosePlan(officialUi);
  const residualTargets = buildOfficialUiResidualRepairPlan(officialUi);
  return Boolean(officialUi?.hasServiceTarget && (closeTargets.length > 0 || residualTargets.length > 0));
}

function findPreferredServiceTarget(officialUi = {}) {
  return (
    (officialUi.targets ?? []).find((target) => target.kind === "service" && target.visible) ??
    (officialUi.targets ?? []).find((target) => target.kind === "service") ??
    null
  );
}

async function closeResidualOfficialWindowTargets(runtime, targets = [], options = {}) {
  if (targets.length === 0) {
    return [];
  }

  if (typeof runtime?.closeOfficialWindowTarget !== "function") {
    return targets.map((target) => ({
      ...target,
      result: {
        ok: false,
        error: "Runtime does not support official window close.",
      },
    }));
  }

  const closed = [];
  for (const target of targets) {
    try {
      closed.push({
        ...target,
        result: sanitizeRemoteDebugOperationResult(await runtime.closeOfficialWindowTarget(target.id ?? target.url, options)),
      });
    } catch (error) {
      closed.push({
        ...target,
        result: {
          ok: false,
          error: sanitizeDebugUrl(error?.message ?? String(error)),
        },
      });
    }
  }

  return closed;
}

async function bringServiceTargetToFront(runtime, serviceTarget, options = {}) {
  if (!serviceTarget?.url || typeof runtime?.bringRemoteDebugTargetToFront !== "function") {
    return null;
  }

  try {
    return sanitizeRemoteDebugOperationResult(await runtime.bringRemoteDebugTargetToFront(serviceTarget.id ?? serviceTarget.url, options));
  } catch (error) {
    return {
      ok: false,
      error: sanitizeDebugUrl(error?.message ?? String(error)),
      target: {
        id: serviceTarget.id,
        url: serviceTarget.url,
        title: serviceTarget.title,
      },
    };
  }
}

async function navigateResidualOfficialUiTargets(runtime, targets = [], serviceUrl, options = {}) {
  if (targets.length === 0 || typeof runtime?.navigateRemoteDebugTarget !== "function") {
    return [];
  }

  const navigated = [];
  for (const target of targets) {
    if (target.kind === "service") {
      continue;
    }

    try {
      navigated.push({
        ...target,
        result: sanitizeRemoteDebugOperationResult(await runtime.navigateRemoteDebugTarget(target.id ?? target.url, serviceUrl, options)),
      });
    } catch (error) {
      navigated.push({
        ...target,
        result: {
          ok: false,
          error: sanitizeDebugUrl(error?.message ?? String(error)),
        },
      });
    }
  }
  return navigated;
}

async function navigateServiceRestoreTarget(runtime, candidates = [], serviceUrl, options = {}) {
  if (candidates.length === 0 || typeof runtime?.navigateRemoteDebugTarget !== "function") {
    return {
      restoredFrom: null,
      navigation: null,
      attempts: [],
    };
  }

  const attempts = [];
  for (const candidate of candidates) {
    try {
      const result = sanitizeRemoteDebugOperationResult(
        await runtime.navigateRemoteDebugTarget(candidate.id ?? candidate.url, serviceUrl, options),
      );
      const attempt = {
        ...candidate,
        result,
      };
      attempts.push(attempt);

      if (result?.ok !== false) {
        return {
          restoredFrom: candidate,
          navigation: result,
          attempts,
        };
      }
    } catch (error) {
      attempts.push({
        ...candidate,
        result: {
          ok: false,
          error: sanitizeDebugUrl(error?.message ?? String(error)),
        },
      });
    }
  }

  return {
    restoredFrom: null,
    navigation: null,
    attempts,
  };
}

async function syncAndReloadOfficialServiceTarget(runtime, serviceTargetUrlPart, context, options = {}) {
  const { remoteDebugPort, portalTimeoutMs, pollMs } = options;

  await runtime.waitForRemoteDebugTarget(serviceTargetUrlPart, {
    remoteDebugPort,
    timeoutMs: portalTimeoutMs,
    pollMs,
  });

  const serviceSync = await runtime.syncPortalGlobalState(serviceTargetUrlPart, context, {
    remoteDebugPort,
    timeoutMs: portalTimeoutMs,
    pollMs,
    profile: "service",
    includeConfigWrites: false,
  });
  const bridge = sanitizeBridgeResult(
    await runtime.bootstrapViaPageBridge(serviceTargetUrlPart, context, {
      remoteDebugPort,
      timeoutMs: portalTimeoutMs,
      pollMs,
    }),
  );
  const serviceReload = await runtime.reloadPortalTarget(serviceTargetUrlPart, {
    remoteDebugPort,
    timeoutMs: portalTimeoutMs,
    pollMs,
  });

  await runtime.waitForRemoteDebugTarget(serviceTargetUrlPart, {
    remoteDebugPort,
    timeoutMs: portalTimeoutMs,
    pollMs,
  });

  return {
    serviceSync,
    bridge,
    serviceReload,
  };
}

async function describeOfficialUiState(runtime, remoteDebugPort) {
  if (
    typeof runtime?.getRemoteDebugTargets !== "function" ||
    typeof runtime?.evaluateOnRemoteDebugPageTarget !== "function"
  ) {
    return buildOfficialUiState({
      reachable: false,
      remoteDebugPort,
      error: "Runtime does not expose official UI target inspection",
    });
  }

  try {
    const targets = await runtime.getRemoteDebugTargets(remoteDebugPort);
    const probedTargets = await Promise.all(
      targets.map(async (target) => {
        const base = {
          id: target.id,
          type: target.type,
          title: target.title,
          url: sanitizeDebugUrl(target.url),
        };

        if (target.type !== "page" || !target.webSocketDebuggerUrl) {
          return base;
        }

        try {
          const result = await runtime.evaluateOnRemoteDebugPageTarget(target, OFFICIAL_UI_PROBE_EXPRESSION, {
            timeoutMs: 1500,
          });
          const value = result.evaluation?.result?.value ?? {};

          return {
            ...base,
            title: value.title ?? base.title,
            url: sanitizeDebugUrl(value.href ?? base.url),
            visibilityState: value.visibilityState ?? null,
            hidden: value.hidden ?? null,
            bodyText: value.bodyText ?? "",
          };
        } catch (error) {
          return {
            ...base,
            evaluationError: error?.message ?? String(error),
          };
        }
      }),
    );

    return buildOfficialUiState({
      reachable: true,
      remoteDebugPort,
      targets: probedTargets,
    });
  } catch (error) {
    return buildOfficialUiState({
      reachable: false,
      remoteDebugPort,
      error: error?.message ?? String(error),
    });
  }
}

export class VpnService {
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
    this.existsFn =
      options.existsFn ??
      (async (filePath) => {
        try {
          await access(filePath);
          return true;
        } catch {
          return false;
        }
      });
  }

  createRuntime(config = {}) {
    return this.runtimeFactory(config);
  }

  async getSnapshot(config = {}, options = {}) {
    const runtime = this.createRuntime(config);
    const includeOfficialUi = options.includeOfficialUi ?? true;
    const remoteDebugPort = getRemoteDebugPort(config);
    const activeSession = await runtime.describeActiveSession();

    const status = activeSession?.token
      ? {
          activeSession: sanitizeSession(activeSession),
          ...(await (async () => {
            const [loginStatus, serviceState, localRuntimeInfo] = await Promise.all([
              runtime.getLoginStatus(activeSession.token),
              runtime.getServiceState(activeSession.token),
              runtime.getLocalRuntimeInfo(activeSession.token).catch((error) => ({
                error: error?.message ?? String(error),
              })),
            ]);

            return {
              loginStatus,
              serviceState,
              localRuntimeInfo,
            };
          })()),
        }
      : {
          activeSession: null,
          latestCachedToken: await (async () => {
            const latestCachedToken = await runtime.describeLatestCachedToken();
            return latestCachedToken.token
              ? { ...latestCachedToken, token: undefined }
              : latestCachedToken;
          })(),
          loginStatus: null,
          serviceState: null,
          localRuntimeInfo: null,
        };

    const latestCachedTokenPromise = activeSession?.token
      ? Promise.resolve(null)
      : runtime.describeLatestCachedToken();

    const [bundleSettingPath, port, latestCachedToken, gatewayCandidates, appExecutableExists] = await Promise.all([
      runtime.getBundleSettingPath(),
      runtime.getPort(),
      latestCachedTokenPromise,
      runtime.getGatewayCandidates(),
      this.existsFn(runtime.appExecutable),
    ]);

    const environmentInfo = sanitizeSummary({
      appSupportDir: APP_SUPPORT_DIR,
      cacheDir: CACHE_DIR,
      logsDir: LOGS_DIR,
      appExecutable: runtime.appExecutable,
      appExecutableExists,
      bundleConfDir: getBundleConfDir(runtime.appExecutable),
      bundleSettingPath,
      port,
      activeSession,
      latestCachedToken,
      gatewayCandidates,
    });

    const officialUi = includeOfficialUi ? await describeOfficialUiState(runtime, remoteDebugPort) : null;

    return {
      status: {
        ...status,
        ...(includeOfficialUi ? { officialUi } : {}),
      },
      environmentInfo,
    };
  }

  async getStatus(config = {}) {
    const snapshot = await this.getSnapshot(config);
    return snapshot.status;
  }

  async getEnvironmentInfo(config = {}) {
    const snapshot = await this.getSnapshot(config, { includeOfficialUi: false });
    return snapshot.environmentInfo;
  }

  async getRecoveryPlan(config = {}, gatewayCandidates = []) {
    const runtime = this.createRuntime(config);
    let discoveredGateways = [];

    if ((gatewayCandidates ?? []).length === 0) {
      discoveredGateways = await runtime.getGatewayCandidates();
    }

    return buildRecoveryPlan(config, gatewayCandidates, discoveredGateways);
  }

  async probeRecoveryGateways(config = {}, gatewayCandidates = []) {
    const plan = await this.getRecoveryPlan(config, gatewayCandidates);
    const results = [];

    for (const gateway of plan.gateways) {
      try {
        const gatewayLogin = this.gatewayLoginFactory(gateway);
        const auth = await gatewayLogin.loginAuth();
        const passwordConfig = await gatewayLogin.passwordConfig(auth.cookie);
        const captchaRequired = passwordConfig.summary.useRandCode !== "0";

        results.push({
          host: gateway.host,
          port: gateway.port,
          source: gateway.source,
          reachable: true,
          captchaRequired,
          recommended: !captchaRequired,
        });
      } catch (error) {
        results.push({
          host: gateway.host,
          port: gateway.port,
          source: gateway.source,
          reachable: false,
          captchaRequired: null,
          recommended: false,
          error: error?.message ?? String(error),
        });
      }
    }

    return results;
  }

  async repairOfficialUi(config = {}, options = {}) {
    const runtime = this.createRuntime(config);
    const remoteDebugPort = options.remoteDebugPort ?? getRemoteDebugPort(config);
    const portalTimeoutMs = options.portalTimeoutMs ?? 45000;
    const pollMs = options.pollMs ?? 1000;
    const knownOnlineStatus = options.knownOnlineStatus ?? null;
    const focusServiceTarget = options.focusServiceTarget ?? false;
    const statusSnapshot = await this.getSnapshot(config);
    const status = statusSnapshot.status;

    const statusIsOnline =
      status?.loginStatus?.status === "1" &&
      !!status?.activeSession?.sessionId;
    const knownStatusIsOnline =
      knownOnlineStatus?.loginStatus?.status === "1" &&
      !!knownOnlineStatus?.activeSession?.sessionId;
    const onlineStatus = statusIsOnline ? status : knownStatusIsOnline ? {
      ...status,
      activeSession: knownOnlineStatus.activeSession,
      loginStatus: knownOnlineStatus.loginStatus,
      serviceState: knownOnlineStatus.serviceState ?? status.serviceState,
    } : status;

    if (!statusIsOnline && !knownStatusIsOnline) {
      return {
        action: "skip-offline",
        reason: "VPN tunnel is not online; UI repair will not trigger login.",
        status: onlineStatus,
      };
    }

    const officialUi = onlineStatus.officialUi;
    const closeResidualTargets = buildOfficialUiResidualClosePlan(officialUi);
    const residualTargets = buildOfficialUiResidualRepairPlan(officialUi);
    const gateway = resolveRepairGateway(config, officialUi);
    if (!gateway) {
      throw new Error("Cannot repair official UI without a known EasyConnect gateway");
    }

    const serviceTargetUrlPart = "/portal/#!/service";
    const serviceUrl = `https://${gateway.host}:${gateway.port}${serviceTargetUrlPart}`;
    const primaryTarget = officialUi?.primaryTarget ?? null;
    const context = {
      sessionId: onlineStatus.activeSession.sessionId,
      gatewayHost: gateway.host,
      gatewayPort: gateway.port,
      username: `${config?.vpn?.username ?? ""}`.trim(),
      browserType: "default",
      lang: "zh_CN",
      loginClientType: 3,
      trayType: 1,
      passwordConfigSummary: {},
    };

    if (!officialUi?.hasServiceTarget) {
      const restoreTargets = buildOfficialUiServiceRestorePlan(officialUi);
      const restore = await navigateServiceRestoreTarget(runtime, restoreTargets, serviceUrl, {
        remoteDebugPort,
        timeoutMs: 5000,
      });

      if (!restore.restoredFrom) {
        return {
          action: "skip-missing-service-target",
          reason: "VPN tunnel is online but no safe official UI target can be navigated back to the service page.",
          serviceUrl,
          restoreTargets,
          restoreAttempts: restore.attempts,
          closeResidualTargets,
          residualTargets,
          status: onlineStatus,
        };
      }

      const serviceRefresh = await syncAndReloadOfficialServiceTarget(runtime, serviceTargetUrlPart, context, {
        remoteDebugPort,
        portalTimeoutMs,
        pollMs,
      });

      return {
        action: "restore-missing-service-target",
        gateway,
        serviceUrl,
        from: primaryTarget
          ? {
              kind: primaryTarget.kind,
              title: primaryTarget.title,
              url: primaryTarget.url,
            }
          : null,
        restoredFrom: restore.restoredFrom,
        navigation: restore.navigation,
        restoreAttempts: restore.attempts,
        closedResidualTargets: [],
        repairedResidualTargets: [],
        ...serviceRefresh,
        status,
      };
    }

    const needsRepair = officialUiNeedsRepair(officialUi);
    if (!needsRepair) {
      return {
        action: "already-consistent",
        status: onlineStatus,
      };
    }

    const serviceRefresh = await syncAndReloadOfficialServiceTarget(runtime, serviceTargetUrlPart, context, {
      remoteDebugPort,
      portalTimeoutMs,
      pollMs,
    });
    const closedResidualTargets = await closeResidualOfficialWindowTargets(runtime, closeResidualTargets, {
      remoteDebugPort,
      timeoutMs: 5000,
    });
    const repairedResidualTargets = await navigateResidualOfficialUiTargets(runtime, residualTargets, serviceUrl, {
      remoteDebugPort,
      timeoutMs: 5000,
    });
    const focusedServiceTarget = focusServiceTarget
      ? await bringServiceTargetToFront(
          runtime,
          findPreferredServiceTarget(officialUi),
          {
            remoteDebugPort,
            timeoutMs: 5000,
          },
        )
      : null;

    return {
      action: "repair-official-ui",
      gateway,
      serviceUrl,
      from: primaryTarget
        ? {
            kind: primaryTarget.kind,
            title: primaryTarget.title,
            url: primaryTarget.url,
          }
        : null,
      navigation: null,
      ...serviceRefresh,
      closedResidualTargets,
      repairedResidualTargets,
      focusedServiceTarget,
      status,
    };
  }

  async prepareOfficialUiRepairSmokeTarget(config = {}, options = {}) {
    const runtime = this.createRuntime(config);
    const remoteDebugPort = options.remoteDebugPort ?? getRemoteDebugPort(config);
    const timeoutMs = options.timeoutMs ?? 5000;
    const pollMs = options.pollMs ?? 500;
    const targetUrl = buildLocalConnectTargetUrl(runtime.appExecutable);

    const resolveMutationSource = async () => {
      if (
        typeof runtime?.getRemoteDebugTargets !== "function" ||
        typeof runtime?.evaluateOnRemoteDebugPageTarget !== "function"
      ) {
        return {
          targetUrlPart: "/portal/#!/service",
          target: null,
        };
      }

      const officialUi = await describeOfficialUiState(runtime, remoteDebugPort);
      const portalTarget = (officialUi.targets ?? []).find(
        (target) => target.visible && target.kind !== "service" && target.url.includes("/portal/"),
      );
      const visibleServiceTarget = (officialUi.targets ?? []).find((target) => target.visible && target.kind === "service");
      const serviceTarget = (officialUi.targets ?? []).find((target) => target.kind === "service");
      const target = portalTarget ?? visibleServiceTarget ?? serviceTarget ?? null;

      return {
        targetUrlPart: targetUrlPartForRepair(target) ?? "/portal/#!/service",
        target,
      };
    };

    const prepareViaServiceTargetMutation = async (reason) => {
      if (!options.allowServiceTargetMutation || typeof runtime?.navigatePortalRoute !== "function") {
        return {
          action: "skip-no-test-target",
          reason,
          targetUrl,
        };
      }

      const mutationSource = await resolveMutationSource();
      const navigationOptions = {
        remoteDebugPort,
        timeoutMs,
        pollMs,
      };
      const navigation =
        typeof runtime?.navigateRemoteDebugTarget === "function"
          ? await runtime.navigateRemoteDebugTarget(mutationSource.targetUrlPart, targetUrl, navigationOptions)
          : await runtime.navigatePortalRoute(mutationSource.targetUrlPart, targetUrl, navigationOptions);
      let target = null;
      let waitError = null;

      if (typeof runtime?.waitForRemoteDebugTarget === "function") {
        try {
          target = await runtime.waitForRemoteDebugTarget("/local/connect/connect.html", {
            remoteDebugPort,
            timeoutMs,
            pollMs,
          });
        } catch (error) {
          waitError = error?.message ?? String(error);
        }
      }

      return {
        action: "prepared-by-mutating-service-target",
        targetUrl,
        prepareReason: reason,
        navigation,
        source: mutationSource.target
          ? {
              kind: mutationSource.target.kind,
              title: mutationSource.target.title,
              url: mutationSource.target.url,
            }
          : null,
        target: target
          ? {
              id: target.id ?? null,
              type: target.type ?? null,
              url: sanitizeDebugUrl(target.url ?? targetUrl),
            }
          : null,
        waitError,
      };
    };

    if (typeof runtime?.createRemoteDebugTarget !== "function") {
      return prepareViaServiceTargetMutation("DevTools target creation is not available in this runtime");
    }

    try {
      const target = await runtime.createRemoteDebugTarget(targetUrl, {
        remoteDebugPort,
        timeoutMs,
      });

      return {
        action: "prepared-test-target",
        targetUrl,
        target: target
          ? {
              id: target.id ?? null,
              type: target.type ?? null,
              url: sanitizeDebugUrl(target.url ?? targetUrl),
            }
          : null,
      };
    } catch (error) {
      return prepareViaServiceTargetMutation(error?.message ?? String(error));
    }
  }

  async launchOfficialClient(config = {}, options = {}) {
    const runtime = this.createRuntime(config);
    return runtime.launchMainAppUserMode(options);
  }

  async recoverOfficialClient(config = {}, options = {}) {
    const runtime = this.createRuntime(config);
    return runtime.recoverViaUserMode(options);
  }

  async getDebugTargets(config = {}, remoteDebugPort) {
    const runtime = this.createRuntime(config);
    return runtime.getRemoteDebugTargets(remoteDebugPort);
  }

  async portalLogin(config = {}, username, password, remoteDebugPort) {
    const runtime = this.createRuntime(config);
    return runtime.triggerPortalOfficialPasswordLogin({
      username,
      password,
      remoteDebugPort,
    });
  }

  async recoverAndLogin(config = {}, username, password, remoteDebugPort, gatewayCandidates = []) {
    const runtime = this.createRuntime(config);
    let gateways = collectRecoveryGateways(config, gatewayCandidates, []);
    if (gateways.length === 0) {
      gateways = collectRecoveryGateways(config, gatewayCandidates, await runtime.getGatewayCandidates());
    }

    let lastGateway = gateways[0] ?? null;
    const gatewayAttempts = [];

    const isCaptchaStyleError = (error) => /captcha|验证码|校验/i.test(error?.message ?? String(error ?? ""));

    const tryPortalFallback = async (error) => {
      const fallback = await runtime.recoverLoginViaUserDebug({
        username,
        password,
        remoteDebugPort,
      });

      if (fallback.online?.activeSession?.token) {
        fallback.online.activeSession = sanitizeSession(fallback.online.activeSession);
      }

      return {
        mode: "fallback-portal-debug",
        gateway: lastGateway,
        gatewayAttempts,
        error: error?.message ?? String(error),
        ...fallback,
      };
    };

    const tryPageBridgeFallback = async (error) => {
      const fallback = await runtime.recoverLoginViaPageBridge({
        gatewayLogin: this.gatewayLoginFactory(lastGateway),
        gatewayHost: lastGateway.host,
        gatewayPort: lastGateway.port,
        username,
        password,
        remoteDebugPort,
      });

      if (fallback.online?.activeSession?.token) {
        fallback.online.activeSession = sanitizeSession(fallback.online.activeSession);
      }

      return {
        mode: "fallback-page-bridge",
        gateway: lastGateway,
        gatewayAttempts,
        error: error?.message ?? String(error),
        ...fallback,
      };
    };

    let lastError = new Error("No gateway available for recoverAndLogin");

    for (const gateway of gateways) {
      lastGateway = gateway;
      try {
        const result = await this.ensureOnlineFn({
          runtime,
          gatewayLogin: this.gatewayLoginFactory(gateway),
          gatewayHost: gateway.host,
          gatewayPort: gateway.port,
          username,
          password,
          remoteDebugPort,
        });

        return {
          gateway,
          gatewayAttempts: [
            ...gatewayAttempts,
            {
              gateway: `${gateway.host}:${gateway.port}`,
              ok: true,
            },
          ],
          ...sanitizeEnsureOnlineResult(result),
        };
      } catch (error) {
        gatewayAttempts.push({
          gateway: `${gateway.host}:${gateway.port}`,
          ok: false,
          error: error?.message ?? String(error),
        });
        lastError = error;
      }
    }

    if (lastGateway && !isCaptchaStyleError(lastError)) {
      try {
        return await tryPageBridgeFallback(lastError);
      } catch (error) {
        lastError = error;
      }
    }

    return tryPortalFallback(lastError);
  }
}
