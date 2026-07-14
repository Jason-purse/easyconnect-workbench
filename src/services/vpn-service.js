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
const BACKGROUND_NATIVE_WINDOW_ACTIVATION_SKIPPED_ACTION = "skip-native-window-activation-background";
const DEFAULT_NATIVE_WINDOW_SHOW_SETTLE_MS = 5000;

function getRemoteDebugPort(config = {}) {
  return Number.parseInt(`${config?.vpn?.remoteDebugPort ?? 9222}`, 10) || 9222;
}

function getOfficialUiPostRepairSettleMs(config = {}, options = {}) {
  const value = Number.parseInt(`${options.postRepairSettleMs ?? config?.vpn?.officialUiPostRepairSettleMs ?? 0}`, 10);
  return Number.isFinite(value) && value > 0 ? value : 0;
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
      const normalizedKey = key.replace(/[^a-z0-9]/gi, "").toLowerCase();
      if (/token|twfid|sessionid|cookie|password|secret|websocketdebuggerurl/.test(normalizedKey)) {
        next[key] = "<redacted>";
        continue;
      }

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

function shouldCloseResidualOfficialTarget(target = {}, context = {}) {
  if (!target.id) {
    return false;
  }

  if (context.onlineAction === "relogin-page-bridge" && target.kind === "user-setting") {
    return true;
  }

  if (isConnectNotfoundTarget(target)) {
    return true;
  }

  return false;
}

function shouldRepairResidualOfficialTarget(target = {}) {
  if (!target.id) {
    return false;
  }

  return target.visible && target.kind === "service-failed";
}

function findPreferredServiceTarget(officialUi = {}) {
  return (
    (officialUi.targets ?? []).find((target) => target.kind === "service" && target.visible) ??
    (officialUi.targets ?? []).find((target) => target.kind === "service") ??
    null
  );
}

function buildOfficialUiDuplicateServiceClosePlan(officialUi = {}, context = {}) {
  if (context.onlineAction !== "relogin-page-bridge" && !officialUi.hasDuplicateNativeWindows) {
    return [];
  }

  const serviceTargets = (officialUi.targets ?? []).filter((target) => target.id && target.kind === "service");
  if (serviceTargets.length <= 1) {
    return [];
  }

  const keepTarget = findPreferredServiceTarget({ targets: serviceTargets });
  return serviceTargets
    .filter((target) => target.id !== keepTarget?.id)
    .map((target) => ({
      id: target.id,
      kind: "duplicate-service",
      title: target.title,
      url: target.url,
      originalKind: target.kind,
    }));
}

function buildOfficialUiTransitionClosePlan(officialUi = {}, context = {}) {
  if (!officialUi.hasServiceTarget) {
    return [];
  }

  const loginTargets = (officialUi.targets ?? []).filter((target) => target.id && target.kind === "login");
  const serviceTargets = (officialUi.targets ?? []).filter((target) => target.id && target.kind === "service");
  if (loginTargets.length === 0 || serviceTargets.length === 0) {
    return [];
  }

  const closeTargets = context.onlineAction === "relogin-page-bridge"
    ? serviceTargets
    : loginTargets;
  const closeKind = context.onlineAction === "relogin-page-bridge"
    ? "pre-relogin-service"
    : null;

  return closeTargets.map((target) => ({
    id: target.id,
    kind: closeKind ?? target.kind,
    title: target.title,
    url: target.url,
    originalKind: target.kind,
  }));
}

function buildOfficialUiStaleConnectClosePlan(officialUi = {}) {
  if (!officialUi.hasVisibleServiceTarget) {
    return [];
  }

  return (officialUi.targets ?? [])
    .filter((target) => target.id && target.kind === "connect" && target.visible)
    .slice(0, 1)
    .map((target) => ({
      id: target.id,
      kind: "stale-connect",
      title: target.title,
      url: target.url,
      originalKind: target.kind,
    }));
}

function uniqueCloseTargets(targets = []) {
  const seen = new Set();
  return targets.filter((target) => {
    const key = target.id ?? target.url;
    if (!key || seen.has(key)) {
      return false;
    }

    seen.add(key);
    return true;
  });
}

function buildOfficialUiResidualClosePlan(officialUi = {}, context = {}) {
  const targets = officialUi.targets ?? [];

  const residualTargets = targets
    .filter((target) => shouldCloseResidualOfficialTarget(target, {
      ...context,
      hasServiceTarget: officialUi.hasServiceTarget,
    }))
    .map((target) => ({
      id: target.id,
      kind: target.kind,
      title: target.title,
      url: target.url,
    }));

  return uniqueCloseTargets([
    ...residualTargets,
    ...buildOfficialUiStaleConnectClosePlan(officialUi),
    ...buildOfficialUiTransitionClosePlan(officialUi, context),
    ...buildOfficialUiDuplicateServiceClosePlan(officialUi, context),
  ]);
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

function targetClosesServiceWindow(target = {}) {
  return target.originalKind === "service" || ["duplicate-service", "pre-relogin-service"].includes(target.kind);
}

async function getNativeWindowStateForClose(runtime) {
  if (typeof runtime?.getOfficialNativeWindowState !== "function") {
    return {
      ok: false,
      supported: false,
      error: "Runtime does not support native EasyConnect window inspection.",
    };
  }

  try {
    return await runtime.getOfficialNativeWindowState();
  } catch (error) {
    return {
      ok: false,
      supported: true,
      error: error?.message ?? String(error),
    };
  }
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
    login: 5,
  };

  return (ranks[target.kind] ?? 100) + visibleBonus;
}

function buildOfficialUiServiceRestorePlan(officialUi = {}) {
  const hasVisibleServiceTarget = officialUi.hasVisibleServiceTarget ??
    (officialUi.targets ?? []).some((target) => target.kind === "service" && target.visible);
  return [...(officialUi.targets ?? [])]
    .map((target) => ({
      id: target.id,
      kind: target.kind,
      title: target.title,
      url: target.url,
      visible: target.visible,
      originalKind: target.kind,
      rank: rankServiceTargetRestoreCandidate(target),
    }))
    .filter((target) => target.rank < 100 && (!hasVisibleServiceTarget || target.visible))
    .sort((left, right) => left.rank - right.rank)
    .map(({ rank, ...target }) => target);
}

function officialUiNeedsRepair(officialUi = {}, context = {}) {
  const closeTargets = buildOfficialUiResidualClosePlan(officialUi, context);
  const residualTargets = buildOfficialUiResidualRepairPlan(officialUi);
  return Boolean(
    officialUi?.hasServiceTarget &&
      (
        officialUi?.hasBlockingNativeAlert ||
        officialUi?.needsNativeWindowRestore ||
        officialUi?.needsNativeWindowConsolidation ||
        officialUi?.hasDuplicateNativeWindows ||
        closeTargets.length > 0 ||
        residualTargets.length > 0 ||
        officialUi?.hasBlockingVisibleTarget
      ),
  );
}

function officialUiIsServiceConsistent(officialUi = {}) {
  return Boolean(
    officialUi?.reachable &&
      officialUi.hasServiceTarget &&
      !officialUi.hasBlockingVisibleTarget &&
      !officialUi.hasBlockingNativeAlert &&
      !officialUi.needsNativeWindowRestore &&
      !officialUi.needsNativeWindowConsolidation &&
      !officialUi.hasDuplicateNativeWindows,
  );
}

function officialUiRequiresNativeWindowActivation(officialUi = {}) {
  return Boolean(
    officialUi?.hasBlockingNativeAlert ||
      officialUi?.needsNativeWindowRestore ||
      officialUi?.needsNativeWindowConsolidation ||
      officialUi?.hasDuplicateNativeWindows,
  );
}

function closePlanIsOnlyBackgroundSafeTargets(closeResidualTargets = []) {
  return closeResidualTargets.length > 0 &&
    closeResidualTargets.every((target) => ["duplicate-service", "stale-connect"].includes(target.kind));
}

function officialUiOnlyNeedsNativeWindowActivation(officialUi = {}, context = {}) {
  return Boolean(
    officialUi?.reachable &&
      officialUi.hasServiceTarget &&
      !officialUi.hasBlockingVisibleTarget &&
      (context.closeResidualTargets ?? []).length === 0 &&
      (context.residualTargets ?? []).length === 0 &&
      officialUiRequiresNativeWindowActivation(officialUi),
  );
}

function officialUiRepairShouldDeferToForeground(officialUi = {}, context = {}) {
  if (!officialUiRequiresNativeWindowActivation(officialUi)) {
    return false;
  }

  if (officialUi.hasBlockingNativeAlert) {
    return true;
  }

  return !closePlanIsOnlyBackgroundSafeTargets(context.closeResidualTargets ?? []) ||
    (context.residualTargets ?? []).length > 0;
}

function hasVisibleProbeFailedTarget(officialUi = {}) {
  return (officialUi.targets ?? []).some((target) => target.kind === "probe-failed" && target.visible);
}

function shouldAllowBackgroundVisibleNativeCleanup(officialUi = {}) {
  const nativeWindowState = officialUi?.nativeWindowState ?? {};
  const windowCount = nativeWindowState?.windowCount;
  return Boolean(
    officialUi?.reachable &&
      nativeWindowState?.ok &&
      nativeWindowState?.visible &&
      Number.isFinite(windowCount) &&
      windowCount > 0 &&
      hasVisibleProbeFailedTarget(officialUi) &&
      (officialUi.hasBlockingNativeAlert || officialUi.hasDuplicateNativeWindows || officialUi.needsNativeWindowConsolidation),
  );
}

function buildBackgroundLoginFallbackSkippedResult(officialUi = {}) {
  return {
    action: "skip-official-ui-login-fallback-background-native-window",
    reason: "Official UI still requires native EasyConnect window cleanup; background maintenance will not create additional login targets while native windows or alerts are unstable.",
    nativeWindowState: officialUi?.nativeWindowState ?? null,
  };
}

function buildBackgroundLoginFallbackMutationSkippedResult(officialUi = {}) {
  return {
    action: "skip-official-ui-login-fallback-background",
    reason: "Background official UI maintenance will not navigate EasyConnect to the login page because that can foreground native windows or modals.",
    primaryTarget: summarizeRepairSourceTarget(officialUi?.primaryTarget ?? null),
    nativeWindowState: officialUi?.nativeWindowState ?? null,
  };
}

function shouldSkipLoginFallbackForBackgroundNativeRepair(officialUi = {}, options = {}) {
  return options.allowNativeWindowActivation === false &&
    officialUiRequiresNativeWindowActivation(officialUi);
}

function shouldSkipLoginFallbackMutationInBackground(options = {}) {
  return options.allowNativeWindowActivation === false;
}

function shouldDeferServiceRestoreInBackground(officialUi = {}, options = {}) {
  if (options.allowNativeWindowActivation !== false) {
    return false;
  }

  if (!officialUi?.reachable) {
    return false;
  }

  return !officialUi.hasVisibleServiceTarget;
}

function buildIncompleteOfficialUiRestoreResultWithSafeFallback(action, reason, payload = {}, status = {}, safeFallback = null) {
  return buildIncompleteOfficialUiRestoreResult(
    action,
    reason,
    {
      ...payload,
      safeFallback,
    },
    status,
  );
}

function summarizeRepairSourceTarget(primaryTarget = null) {
  return primaryTarget
    ? {
        kind: primaryTarget.kind,
        title: primaryTarget.title,
        url: primaryTarget.url,
      }
    : null;
}

function buildBackgroundNativeWindowActivationSkippedResult({
  gateway,
  serviceUrl,
  primaryTarget,
  officialUi,
  status,
}) {
  return {
    action: BACKGROUND_NATIVE_WINDOW_ACTIVATION_SKIPPED_ACTION,
    reason: "Background official UI maintenance will not activate, show, or close native EasyConnect windows.",
    gateway,
    serviceUrl,
    from: summarizeRepairSourceTarget(primaryTarget),
    closedResidualTargets: [],
    repairedResidualTargets: [],
    dismissedNativeAlerts: null,
    consolidatedNativeWindows: null,
    shownOfficialWindow: null,
    focusedServiceTarget: null,
    nativeWindowActivation: {
      ok: true,
      action: "skipped-background-native-window-activation",
      reason: "Use manual official UI repair when the native EasyConnect window must be restored or consolidated.",
      nativeWindowState: officialUi?.nativeWindowState ?? null,
      needsNativeWindowRestore: Boolean(officialUi?.needsNativeWindowRestore),
      needsNativeWindowConsolidation: Boolean(officialUi?.needsNativeWindowConsolidation),
      hasDuplicateNativeWindows: Boolean(officialUi?.hasDuplicateNativeWindows),
      hasBlockingNativeAlert: Boolean(officialUi?.hasBlockingNativeAlert),
    },
    status,
  };
}

async function buildPostRepairStatus(runtime, remoteDebugPort, onlineStatus = {}) {
  const officialUi = await describeOfficialUiState(runtime, remoteDebugPort);
  return {
    ...onlineStatus,
    officialUi,
  };
}

async function buildSettledPostRepairStatus(runtime, remoteDebugPort, onlineStatus = {}, options = {}) {
  const immediateStatus = await buildPostRepairStatus(runtime, remoteDebugPort, onlineStatus);
  const settleMs = Number.parseInt(`${options.postRepairSettleMs ?? 0}`, 10) || 0;
  const settleState = options.settleState ?? null;
  if (settleMs <= 0 || settleState?.used) {
    return immediateStatus;
  }

  if (settleState) {
    settleState.used = true;
  }
  const delayFn = options.delayFn ?? ((ms) => new Promise((resolve) => {
    setTimeout(resolve, ms);
  }));
  await delayFn(settleMs);
  return buildPostRepairStatus(runtime, remoteDebugPort, onlineStatus);
}

function buildIncompleteOfficialUiRestoreResult(action, reason, payload = {}, status = {}) {
  return {
    ...payload,
    action,
    reason,
    status,
  };
}

function findLoginFallbackTarget(officialUi = {}) {
  return (
    findPreferredServiceTarget(officialUi) ??
    (officialUi.targets ?? []).find((target) => target.id && target.kind === "service-failed") ??
    (officialUi.targets ?? []).find((target) => target.id && target.visible) ??
    (officialUi.targets ?? []).find((target) => target.id) ??
    null
  );
}

async function navigateOfficialUiToLoginFallback(runtime, officialUi = {}, gateway = {}, options = {}) {
  const target = findLoginFallbackTarget(officialUi);
  if (!target?.id || typeof runtime?.navigateRemoteDebugTarget !== "function") {
    return {
      action: "skip-official-ui-login-fallback",
      reason: "No safe official UI target can be navigated back to the login page.",
      target: target
        ? {
            id: target.id,
            kind: target.kind,
            title: target.title,
            url: target.url,
          }
        : null,
    };
  }

  const loginUrl = `https://${gateway.host}:${gateway.port}/portal/#!/login`;
  if (target.kind === "login" && `${target.url ?? ""}`.includes("/portal/#!/login")) {
    return {
      action: "already-official-ui-login",
      reason: "Official UI is already on the login page; leave it there instead of repeatedly navigating it.",
      target: {
        id: target.id,
        kind: target.kind,
        title: target.title,
        url: target.url,
      },
      loginUrl,
    };
  }

  try {
    return {
      action: "navigate-official-ui-login",
      reason: "Official UI repair could not prove a usable service page; leave EasyConnect on the login page instead of a stale resource/error state.",
      target: {
        id: target.id,
        kind: target.kind,
        title: target.title,
        url: target.url,
      },
      loginUrl,
      result: sanitizeRemoteDebugOperationResult(
        await runtime.navigateRemoteDebugTarget(target.id ?? target.url, loginUrl, options),
      ),
    };
  } catch (error) {
    return {
      action: "navigate-official-ui-login-failed",
      reason: "Official UI repair could not prove a usable service page and login fallback navigation failed.",
      target: {
        id: target.id,
        kind: target.kind,
        title: target.title,
        url: target.url,
      },
      loginUrl,
      error: sanitizeDebugUrl(error?.message ?? String(error)),
    };
  }
}

async function buildIncompleteOfficialUiRestoreResultWithFallback(runtime, gateway, action, reason, payload = {}, status = {}, options = {}) {
  if (options.allowLoginFallbackNavigation === false) {
    return buildIncompleteOfficialUiRestoreResultWithSafeFallback(
      action,
      reason,
      payload,
      status,
      {
        action: "skip-official-ui-login-fallback-disabled",
        reason: "This repair run is not allowed to navigate EasyConnect back to the login page.",
        primaryTarget: summarizeRepairSourceTarget(status?.officialUi?.primaryTarget ?? null),
        nativeWindowState: status?.officialUi?.nativeWindowState ?? null,
      },
    );
  }

  if (shouldSkipLoginFallbackForBackgroundNativeRepair(status?.officialUi, options)) {
    return buildIncompleteOfficialUiRestoreResultWithSafeFallback(
      action,
      reason,
      payload,
      status,
      buildBackgroundLoginFallbackSkippedResult(status?.officialUi),
    );
  }

  if (shouldSkipLoginFallbackMutationInBackground(options)) {
    const target = findLoginFallbackTarget(status?.officialUi);
    if (target?.kind === "login" && `${target.url ?? ""}`.includes("/portal/#!/login")) {
      const loginUrl = `https://${gateway.host}:${gateway.port}/portal/#!/login`;
      return buildIncompleteOfficialUiRestoreResultWithSafeFallback(
        action,
        reason,
        payload,
        status,
        {
          action: "already-official-ui-login",
          reason: "Official UI is already on the login page; leave it there instead of repeatedly navigating it.",
          target: {
            id: target.id,
            kind: target.kind,
            title: target.title,
            url: target.url,
          },
          loginUrl,
        },
      );
    }

    return buildIncompleteOfficialUiRestoreResultWithSafeFallback(
      action,
      reason,
      payload,
      status,
      buildBackgroundLoginFallbackMutationSkippedResult(status?.officialUi),
    );
  }

  const safeFallback = await navigateOfficialUiToLoginFallback(runtime, status?.officialUi, gateway, options);
  return buildIncompleteOfficialUiRestoreResultWithSafeFallback(
    action,
    reason,
    payload,
    status,
    safeFallback,
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
  let nativeWindowState = null;
  for (const target of targets) {
    if (targetClosesServiceWindow(target)) {
      nativeWindowState ??= await getNativeWindowStateForClose(runtime);
      const windowCount = nativeWindowState?.ok ? nativeWindowState.windowCount : null;
      if (!nativeWindowState?.ok || !Number.isFinite(windowCount) || windowCount <= 1) {
        closed.push({
          ...target,
          result: {
            ok: true,
            action: "skipped-native-window-count",
            reason: "Skip closing a service target unless there is more than one native EasyConnect window.",
            nativeWindowState,
          },
        });
        continue;
      }
    }

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

async function showOfficialWindowForServiceTarget(runtime, serviceTarget, options = {}) {
  if (!serviceTarget?.url || typeof runtime?.showOfficialWindowTarget !== "function") {
    return {
      ok: false,
      error: "Runtime does not support official window show.",
    };
  }

  if (options.allowNativeWindowActivation === false) {
    return {
      ok: true,
      action: "skipped-background-native-window-activation",
      reason: "Background official UI maintenance will not show or activate native EasyConnect windows.",
      target: {
        id: serviceTarget.id,
        url: serviceTarget.url,
        title: serviceTarget.title,
      },
    };
  }

  try {
    return sanitizeRemoteDebugOperationResult(await runtime.showOfficialWindowTarget(serviceTarget.id ?? serviceTarget.url, options));
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

async function waitForOfficialServiceTarget(runtime, serviceTargetUrlPart, options = {}) {
  if (typeof runtime?.waitForRemoteDebugTarget !== "function") {
    return null;
  }

  try {
    return await runtime.waitForRemoteDebugTarget(serviceTargetUrlPart, options);
  } catch {
    return null;
  }
}

async function showOfficialWindowIfNativeMissing(runtime, serviceTarget, options = {}) {
  const nativeWindowState = await getNativeWindowStateForClose(runtime);
  const windowCount = nativeWindowState?.ok ? nativeWindowState.windowCount : null;
  if (!nativeWindowState?.ok || !Number.isFinite(windowCount) || windowCount > 0) {
    return null;
  }

  return {
    ...(await showOfficialWindowForServiceTarget(runtime, serviceTarget, options)),
    nativeWindowState,
  };
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

async function dismissOfficialNativeAlerts(runtime, alerts = [], options = {}) {
  if (alerts.length === 0) {
    return null;
  }

  if (options.allowNativeWindowActivation === false) {
    return {
      ok: true,
      action: "skipped-background-native-window-activation",
      reason: "Background official UI maintenance will not activate native EasyConnect alert windows.",
      alerts,
    };
  }

  if (typeof runtime?.dismissOfficialNativeAlerts !== "function") {
    return {
      ok: false,
      error: "Runtime does not support native EasyConnect alert dismissal.",
      alerts,
    };
  }

  try {
    return sanitizeRemoteDebugOperationResult(await runtime.dismissOfficialNativeAlerts(alerts, options));
  } catch (error) {
    return {
      ok: false,
      error: sanitizeDebugUrl(error?.message ?? String(error)),
      alerts,
    };
  }
}

async function closeExtraOfficialNativeWindows(runtime, officialUi = {}, options = {}) {
  if (!officialUi?.needsNativeWindowConsolidation && !officialUi?.hasDuplicateNativeWindows) {
    return null;
  }

  const currentNativeWindowState = await getNativeWindowStateForClose(runtime);
  const currentWindowCount = currentNativeWindowState?.ok ? currentNativeWindowState.windowCount : null;
  if (currentNativeWindowState?.ok && Number.isFinite(currentWindowCount) && currentWindowCount <= 1) {
    return {
      ok: true,
      action: "skipped-native-window-count",
      reason: "Native EasyConnect windows are already consolidated.",
      nativeWindowState: currentNativeWindowState,
    };
  }

  if (options.allowNativeWindowActivation === false) {
    return {
      ok: true,
      action: "skipped-background-native-window-activation",
      reason: "Background official UI maintenance will not activate native EasyConnect windows for consolidation.",
      nativeWindowState: currentNativeWindowState ?? officialUi.nativeWindowState ?? null,
    };
  }

  if (typeof runtime?.closeExtraOfficialNativeWindows !== "function") {
    return {
      ok: false,
      error: "Runtime does not support native EasyConnect window consolidation.",
      nativeWindowState: currentNativeWindowState ?? officialUi.nativeWindowState ?? null,
    };
  }

  try {
    return sanitizeRemoteDebugOperationResult(await runtime.closeExtraOfficialNativeWindows(options));
  } catch (error) {
    return {
      ok: false,
      error: sanitizeDebugUrl(error?.message ?? String(error)),
      nativeWindowState: officialUi.nativeWindowState ?? null,
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

async function retryMissingServiceRestore(runtime, officialUi, serviceUrl, serviceTargetUrlPart, context, options = {}) {
  const {
    remoteDebugPort,
    portalTimeoutMs,
    pollMs,
    onlineStatus,
    postRepairSettleMs,
    settleState,
    delayFn,
    allowNativeWindowActivation,
  } = options;
  const restoreTargets = buildOfficialUiServiceRestorePlan(officialUi);
  const restore = await navigateServiceRestoreTarget(runtime, restoreTargets, serviceUrl, {
    remoteDebugPort,
    timeoutMs: 5000,
  });

  if (!restore.restoredFrom) {
    return {
      reason: "post-repair-official-ui-inconsistent",
      restoredFrom: null,
      navigation: null,
      restoreAttempts: restore.attempts,
      status: await buildPostRepairStatus(runtime, remoteDebugPort, onlineStatus),
    };
  }

  const serviceRefresh = await trySyncAndReloadOfficialServiceTarget(runtime, serviceTargetUrlPart, context, {
    remoteDebugPort,
    portalTimeoutMs,
    pollMs,
  });
  const restoredServiceTarget = await waitForOfficialServiceTarget(runtime, serviceTargetUrlPart, {
    remoteDebugPort,
    timeoutMs: 5000,
  });
  const shownOfficialWindow = await showOfficialWindowIfNativeMissing(runtime, restoredServiceTarget, {
    remoteDebugPort,
    timeoutMs: 5000,
    allowNativeWindowActivation,
  });

  return {
    reason: "post-repair-official-ui-inconsistent",
    restoredFrom: restore.restoredFrom,
    navigation: restore.navigation,
    restoreAttempts: restore.attempts,
    shownOfficialWindow,
    ...serviceRefresh,
    status: await buildSettledPostRepairStatus(runtime, remoteDebugPort, onlineStatus, {
      postRepairSettleMs,
      settleState,
      delayFn,
    }),
  };
}

async function relaunchOfficialUiAndNavigateService(runtime, serviceUrl, options = {}) {
  const { remoteDebugPort, portalTimeoutMs, pollMs } = options;
  if (
    typeof runtime?.launchMainAppUserMode !== "function" ||
    typeof runtime?.waitForAnyRemoteDebugPageTarget !== "function" ||
    typeof runtime?.navigateRemoteDebugPageTarget !== "function"
  ) {
    return {
      relaunch: null,
      restoredFrom: null,
      navigation: null,
      error: "Runtime does not support official UI relaunch.",
    };
  }

  const relaunch = await runtime.launchMainAppUserMode({
    remoteDebugPort,
    reuseExisting: false,
  });
  const target = await runtime.waitForAnyRemoteDebugPageTarget({
    remoteDebugPort,
    timeoutMs: portalTimeoutMs,
    pollMs,
  });
  const navigation = sanitizeRemoteDebugOperationResult(
    await runtime.navigateRemoteDebugPageTarget(target, serviceUrl, {
      remoteDebugPort,
      timeoutMs: Math.min(portalTimeoutMs ?? 45000, 5000),
      pollMs,
    }),
  );

  return {
    relaunch,
    restoredFrom: {
      id: target.id,
      title: target.title,
      url: sanitizeDebugUrl(target.url),
    },
    navigation,
    error: null,
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

async function trySyncAndReloadOfficialServiceTarget(runtime, serviceTargetUrlPart, context, options = {}) {
  try {
    return await syncAndReloadOfficialServiceTarget(runtime, serviceTargetUrlPart, context, options);
  } catch (error) {
    return {
      serviceRefreshError: sanitizeDebugUrl(error?.message ?? String(error)),
    };
  }
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

    const nativeWindowState = typeof runtime?.getOfficialNativeWindowState === "function"
      ? await runtime.getOfficialNativeWindowState().catch((error) => ({
          ok: false,
          error: error?.message ?? String(error),
        }))
      : null;

    return buildOfficialUiState({
      reachable: true,
      remoteDebugPort,
      targets: probedTargets,
      nativeWindowState,
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
    this.delayFn =
      options.delayFn ??
      ((ms) => new Promise((resolve) => {
        setTimeout(resolve, ms);
      }));
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
    const allowNativeWindowActivation = options.allowNativeWindowActivation ?? true;
    const allowLoginFallbackNavigation = options.allowLoginFallbackNavigation ?? true;
    const onlineAction = options.onlineAction ?? null;
    const postRepairSettleMs = getOfficialUiPostRepairSettleMs(config, options);
    const postRepairSettleState = { used: false };
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
    const repairContext = { onlineAction };
    const closeResidualTargets = buildOfficialUiResidualClosePlan(officialUi, repairContext);
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

    if (!officialUi?.reachable) {
      const restore = await relaunchOfficialUiAndNavigateService(runtime, serviceUrl, {
        remoteDebugPort,
        portalTimeoutMs,
        pollMs,
      });

      if (!restore.restoredFrom) {
        return {
          action: "skip-unreachable-official-ui",
          reason: "VPN tunnel is online but the official EasyConnect DevTools endpoint is unreachable, and the runtime cannot relaunch the official UI.",
          serviceUrl,
          relaunch: restore.relaunch,
          navigation: restore.navigation,
          error: restore.error,
          status: onlineStatus,
        };
      }

      const serviceRefresh = await trySyncAndReloadOfficialServiceTarget(runtime, serviceTargetUrlPart, context, {
        remoteDebugPort,
        portalTimeoutMs,
        pollMs,
      });
      const restoredServiceTarget = await waitForOfficialServiceTarget(runtime, serviceTargetUrlPart, {
        remoteDebugPort,
        timeoutMs: 5000,
      });
      const shownOfficialWindow = await showOfficialWindowIfNativeMissing(runtime, restoredServiceTarget, {
        remoteDebugPort,
        timeoutMs: 5000,
        allowNativeWindowActivation,
      });
      const dismissedNativeAlerts = await dismissOfficialNativeAlerts(runtime, officialUi.blockingNativeAlerts ?? [], {
        remoteDebugPort,
        timeoutMs: 5000,
        allowNativeWindowActivation,
      });
      const postRepairStatus = await buildSettledPostRepairStatus(runtime, remoteDebugPort, onlineStatus, {
        postRepairSettleMs,
        settleState: postRepairSettleState,
        delayFn: this.delayFn,
      });
      const commonResult = {
        gateway,
        serviceUrl,
        from: null,
        relaunch: restore.relaunch,
        restoredFrom: restore.restoredFrom,
        navigation: restore.navigation,
        closedResidualTargets: [],
        repairedResidualTargets: [],
        focusedServiceTarget: null,
        shownOfficialWindow,
        ...serviceRefresh,
      };

      if (!officialUiIsServiceConsistent(postRepairStatus.officialUi)) {
        return await buildIncompleteOfficialUiRestoreResultWithFallback(
          runtime,
          gateway,
          "restore-unreachable-official-ui-incomplete",
          "Official UI relaunch/navigation completed, but the final EasyConnect page still is not a usable service target.",
          commonResult,
          postRepairStatus,
          {
            remoteDebugPort,
            timeoutMs: 5000,
            allowNativeWindowActivation,
            allowLoginFallbackNavigation,
          },
        );
      }

      return {
        action: "restore-unreachable-official-ui",
        ...commonResult,
        status: postRepairStatus,
      };
    }

    const needsVisibleServiceRestore =
      !officialUi?.hasServiceTarget ||
      (officialUi?.hasBlockingVisibleTarget && !officialUi?.hasVisibleServiceTarget && closeResidualTargets.length === 0);

    if (needsVisibleServiceRestore) {
      if (shouldDeferServiceRestoreInBackground(officialUi, { allowNativeWindowActivation })) {
        return await buildIncompleteOfficialUiRestoreResultWithFallback(
          runtime,
          gateway,
          officialUi?.hasServiceTarget
            ? "restore-hidden-service-target-incomplete"
            : "restore-missing-service-target-incomplete",
          officialUi?.hasServiceTarget
            ? "VPN tunnel is online and a service target exists, but background maintenance will not activate native windows or navigate unstable UI back to the service page."
            : "VPN tunnel is online but no visible service target is available; background maintenance will leave the official UI at the login page instead of repeatedly navigating it to service.",
          {
            serviceUrl,
            restoreTargets: buildOfficialUiServiceRestorePlan(officialUi),
            restoreAttempts: [],
            closeResidualTargets,
            residualTargets,
          },
          onlineStatus,
          {
            remoteDebugPort,
            timeoutMs: 5000,
            allowNativeWindowActivation,
            allowLoginFallbackNavigation,
          },
        );
      }

      const restoreTargets = buildOfficialUiServiceRestorePlan(officialUi);
      const restore = await navigateServiceRestoreTarget(runtime, restoreTargets, serviceUrl, {
        remoteDebugPort,
        timeoutMs: 5000,
      });

      if (!restore.restoredFrom) {
        return await buildIncompleteOfficialUiRestoreResultWithFallback(
          runtime,
          gateway,
          "repair-official-ui-incomplete",
          officialUi?.hasServiceTarget
            ? "VPN tunnel is online and a hidden service target exists, but no visible official UI target can be safely navigated back to the service page."
            : "VPN tunnel is online but no safe official UI target can be navigated back to the service page.",
          {
            serviceUrl,
            restoreTargets,
            restoreAttempts: restore.attempts,
            closeResidualTargets,
            residualTargets,
          },
          onlineStatus,
          {
            remoteDebugPort,
            timeoutMs: 5000,
            allowNativeWindowActivation,
            allowLoginFallbackNavigation,
          },
        );
      }

      const serviceRefresh = await trySyncAndReloadOfficialServiceTarget(runtime, serviceTargetUrlPart, context, {
        remoteDebugPort,
        portalTimeoutMs,
        pollMs,
      });
      const restoredServiceTarget = await waitForOfficialServiceTarget(runtime, serviceTargetUrlPart, {
        remoteDebugPort,
        timeoutMs: 5000,
      });
      const shownOfficialWindow = await showOfficialWindowIfNativeMissing(runtime, restoredServiceTarget, {
        remoteDebugPort,
        timeoutMs: 5000,
        allowNativeWindowActivation,
      });
      const dismissedNativeAlerts = await dismissOfficialNativeAlerts(runtime, officialUi.blockingNativeAlerts ?? [], {
        remoteDebugPort,
        timeoutMs: 5000,
        allowNativeWindowActivation,
      });
      const postRepairStatus = await buildSettledPostRepairStatus(runtime, remoteDebugPort, onlineStatus, {
        postRepairSettleMs,
        settleState: postRepairSettleState,
        delayFn: this.delayFn,
      });
      const restoreAction = officialUi?.hasServiceTarget ? "restore-hidden-service-target" : "restore-missing-service-target";
      const commonResult = {
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
        shownOfficialWindow,
        dismissedNativeAlerts,
        ...serviceRefresh,
      };

      if (!officialUiIsServiceConsistent(postRepairStatus.officialUi)) {
        const retry = await retryMissingServiceRestore(
          runtime,
          postRepairStatus.officialUi,
          serviceUrl,
          serviceTargetUrlPart,
          context,
          {
            remoteDebugPort,
            portalTimeoutMs,
            pollMs,
            onlineStatus,
            postRepairSettleMs,
            settleState: postRepairSettleState,
            delayFn: this.delayFn,
            allowNativeWindowActivation,
          },
        );

        if (officialUiIsServiceConsistent(retry.status?.officialUi)) {
          return {
            action: restoreAction,
            ...commonResult,
            retry,
            status: retry.status,
          };
        }

        return await buildIncompleteOfficialUiRestoreResultWithFallback(
          runtime,
          gateway,
          `${restoreAction}-incomplete`,
          "Official UI repair was attempted, but the final EasyConnect page still is not a usable service target.",
          {
            ...commonResult,
            retry,
          },
          retry.status ?? postRepairStatus,
          {
            remoteDebugPort,
            timeoutMs: 5000,
            allowNativeWindowActivation,
            allowLoginFallbackNavigation,
          },
        );
      }

      return {
        action: restoreAction,
        ...commonResult,
        status: postRepairStatus,
      };
    }

    const needsRepair = officialUiNeedsRepair(officialUi, repairContext);
    if (!needsRepair) {
      return {
        action: "already-consistent",
        status: onlineStatus,
      };
    }

    const serviceTargetForNativeRestore = findPreferredServiceTarget(officialUi);
    const allowBackgroundVisibleNativeCleanup = !allowNativeWindowActivation &&
      shouldAllowBackgroundVisibleNativeCleanup(officialUi);
    const nativeWindowActivationAllowed = allowNativeWindowActivation || allowBackgroundVisibleNativeCleanup;
    if (
      !nativeWindowActivationAllowed &&
      officialUiOnlyNeedsNativeWindowActivation(officialUi, { closeResidualTargets, residualTargets })
    ) {
      return buildBackgroundNativeWindowActivationSkippedResult({
        gateway,
        serviceUrl,
        primaryTarget,
        officialUi,
        status: onlineStatus,
      });
    }

    if (
      !nativeWindowActivationAllowed &&
      officialUiRepairShouldDeferToForeground(officialUi, { closeResidualTargets, residualTargets })
    ) {
      return buildBackgroundNativeWindowActivationSkippedResult({
        gateway,
        serviceUrl,
        primaryTarget,
        officialUi,
        status: onlineStatus,
      });
    }

    const onlyNeedsNativeWindowRestore = Boolean(
      officialUi?.needsNativeWindowRestore &&
        closeResidualTargets.length === 0 &&
        residualTargets.length === 0 &&
        !officialUi?.hasBlockingVisibleTarget,
    );

    if (onlyNeedsNativeWindowRestore) {
      const shownOfficialWindow = await showOfficialWindowForServiceTarget(runtime, serviceTargetForNativeRestore, {
        remoteDebugPort,
        timeoutMs: 5000,
        allowNativeWindowActivation: nativeWindowActivationAllowed,
      });
      const postRepairStatus = await buildSettledPostRepairStatus(runtime, remoteDebugPort, onlineStatus, {
        postRepairSettleMs: Math.max(postRepairSettleMs, DEFAULT_NATIVE_WINDOW_SHOW_SETTLE_MS),
        settleState: postRepairSettleState,
        delayFn: this.delayFn,
      });
      const commonResult = {
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
        closedResidualTargets: [],
        repairedResidualTargets: [],
        focusedServiceTarget: null,
        shownOfficialWindow,
      };

      if (!officialUiIsServiceConsistent(postRepairStatus.officialUi)) {
        return await buildIncompleteOfficialUiRestoreResultWithFallback(
          runtime,
          gateway,
          "repair-official-ui-incomplete",
          "Official UI repair attempted to show the EasyConnect service window, but the native window did not converge to a usable state.",
          commonResult,
          postRepairStatus,
          {
            remoteDebugPort,
            timeoutMs: 5000,
            allowNativeWindowActivation,
            allowLoginFallbackNavigation: false,
          },
        );
      }

      return {
        action: "repair-official-ui",
        ...commonResult,
        status: postRepairStatus,
      };
    }

    const serviceRefresh = await trySyncAndReloadOfficialServiceTarget(runtime, serviceTargetUrlPart, context, {
      remoteDebugPort,
      portalTimeoutMs,
      pollMs,
    });
    const closedResidualTargets = await closeResidualOfficialWindowTargets(runtime, closeResidualTargets, {
      remoteDebugPort,
      timeoutMs: 5000,
      allowNativeWindowActivation: nativeWindowActivationAllowed,
    });
    const repairedResidualTargets = await navigateResidualOfficialUiTargets(runtime, residualTargets, serviceUrl, {
      remoteDebugPort,
      timeoutMs: 5000,
    });
    const dismissedNativeAlerts = await dismissOfficialNativeAlerts(runtime, officialUi.blockingNativeAlerts ?? [], {
      remoteDebugPort,
      timeoutMs: 5000,
      allowNativeWindowActivation: nativeWindowActivationAllowed,
    });
    const consolidatedNativeWindows = await closeExtraOfficialNativeWindows(runtime, officialUi, {
      remoteDebugPort,
      timeoutMs: 5000,
      allowNativeWindowActivation: nativeWindowActivationAllowed,
    });
    const shownOfficialWindow = officialUi?.needsNativeWindowRestore
      ? await showOfficialWindowForServiceTarget(runtime, serviceTargetForNativeRestore, {
          remoteDebugPort,
          timeoutMs: 5000,
          allowNativeWindowActivation: nativeWindowActivationAllowed,
        })
      : null;
    const focusedServiceTarget = focusServiceTarget
      ? await bringServiceTargetToFront(
          runtime,
          serviceTargetForNativeRestore,
          {
            remoteDebugPort,
            timeoutMs: 5000,
          },
        )
      : null;
    const postRepairStatus = await buildSettledPostRepairStatus(runtime, remoteDebugPort, onlineStatus, {
      postRepairSettleMs,
      settleState: postRepairSettleState,
      delayFn: this.delayFn,
    });
    const commonResult = {
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
      dismissedNativeAlerts,
      consolidatedNativeWindows,
      shownOfficialWindow,
      focusedServiceTarget,
    };
    const failedResidualCloses = closedResidualTargets.filter((target) => target?.result?.ok !== true);
    const remainingStaleConnectTargets = buildOfficialUiStaleConnectClosePlan(postRepairStatus.officialUi);

    if (failedResidualCloses.length > 0 || remainingStaleConnectTargets.length > 0) {
      return await buildIncompleteOfficialUiRestoreResultWithFallback(
        runtime,
        gateway,
        "repair-official-ui-incomplete",
        "Official UI repair could not close all residual EasyConnect targets.",
        {
          ...commonResult,
          failedResidualCloses,
          remainingStaleConnectTargets,
        },
        postRepairStatus,
        {
          remoteDebugPort,
          timeoutMs: 5000,
          allowNativeWindowActivation,
          allowLoginFallbackNavigation,
        },
      );
    }

    const postRepairCloseTargets = buildOfficialUiResidualClosePlan(
      postRepairStatus.officialUi,
      repairContext,
    );
    const postRepairResidualTargets = buildOfficialUiResidualRepairPlan(postRepairStatus.officialUi);
    if (
      !nativeWindowActivationAllowed &&
      officialUiOnlyNeedsNativeWindowActivation(postRepairStatus.officialUi, {
        closeResidualTargets: postRepairCloseTargets,
        residualTargets: postRepairResidualTargets,
      })
    ) {
      return {
        ...buildBackgroundNativeWindowActivationSkippedResult({
          gateway,
          serviceUrl,
          primaryTarget: postRepairStatus.officialUi?.primaryTarget ?? null,
          officialUi: postRepairStatus.officialUi,
          status: postRepairStatus,
        }),
        ...commonResult,
        status: postRepairStatus,
      };
    }

    if (!officialUiIsServiceConsistent(postRepairStatus.officialUi)) {
      const retry = await retryMissingServiceRestore(
        runtime,
        postRepairStatus.officialUi,
        serviceUrl,
        serviceTargetUrlPart,
        context,
        {
          remoteDebugPort,
          portalTimeoutMs,
          pollMs,
          onlineStatus,
          postRepairSettleMs,
          settleState: postRepairSettleState,
          delayFn: this.delayFn,
          allowNativeWindowActivation: nativeWindowActivationAllowed,
        },
      );

      if (officialUiIsServiceConsistent(retry.status?.officialUi)) {
        return {
          action: "repair-official-ui",
          ...commonResult,
          retry,
          status: retry.status,
        };
      }

      return await buildIncompleteOfficialUiRestoreResultWithFallback(
        runtime,
        gateway,
        "repair-official-ui-incomplete",
        "Official UI repair was attempted, but the final EasyConnect page still is not a usable service target.",
        {
          ...commonResult,
          retry,
        },
        retry.status ?? postRepairStatus,
          {
            remoteDebugPort,
            timeoutMs: 5000,
            allowNativeWindowActivation,
            allowLoginFallbackNavigation,
          },
        );
      }

    return {
      action: "repair-official-ui",
      ...commonResult,
      status: postRepairStatus,
    };
  }

  async prepareOfficialUiRepairSmokeTarget(config = {}, options = {}) {
    const runtime = this.createRuntime(config);
    const remoteDebugPort = options.remoteDebugPort ?? getRemoteDebugPort(config);
    const timeoutMs = options.timeoutMs ?? 5000;
    const pollMs = options.pollMs ?? 500;
    const targetUrl = buildLocalConnectTargetUrl(runtime.appExecutable);

    const findPreparedTarget = async () => {
      if (
        typeof runtime?.getRemoteDebugTargets !== "function" ||
        typeof runtime?.evaluateOnRemoteDebugPageTarget !== "function"
      ) {
        return null;
      }

      const officialUi = await describeOfficialUiState(runtime, remoteDebugPort);
      return (officialUi.targets ?? []).find(
        (target) => target.id && ["connect", "probe-failed"].includes(target.kind),
      ) ?? null;
    };

    const buildPreparedTargetResult = (target, extra = {}) => ({
      action: "prepared-test-target",
      targetUrl,
      target: {
        id: target.id ?? null,
        type: target.type ?? null,
        url: sanitizeDebugUrl(target.url ?? targetUrl),
      },
      ...extra,
    });

    const existingTarget = await findPreparedTarget().catch(() => null);
    if (existingTarget) {
      return buildPreparedTargetResult(existingTarget, {
        reusedExistingTarget: true,
      });
    }

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

      return target
        ? buildPreparedTargetResult(target, { reusedExistingTarget: false })
        : {
            action: "skip-no-test-target",
            reason: "DevTools target creation returned no target.",
            targetUrl,
          };
    } catch (error) {
      const partiallyCreatedTarget = await findPreparedTarget().catch(() => null);
      if (partiallyCreatedTarget) {
        return buildPreparedTargetResult(partiallyCreatedTarget, {
          prepareReason: error?.message ?? String(error),
          reusedExistingTarget: false,
        });
      }

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
    return sanitizeRemoteDebugOperationResult(await runtime.getRemoteDebugTargets(remoteDebugPort));
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
