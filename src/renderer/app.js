import {
  describeOfficialUiConsistency,
  formatOfficialUiMetric,
} from "../services/official-ui-state.js";
import { describeMaintainerEvent, extractStatusFromRecoverResult } from "../services/vpn-status-labels.js";
import {
  formatAllowedGateways,
  formatGateway,
  formatGatewayProbeResults,
  formatMaintainerAction,
  formatMaintainerGateway,
  formatMaintainerLastError,
  formatRecoveryPlan,
  sanitizeEnvironmentInfoForDisplay,
} from "../services/vpn-display.js";
import { mergeConfigForRender } from "../services/vpn-render-config.js";

const $ = (id) => document.getElementById(id);

const PAGE_META = {
  "vpn-control": {
    kicker: "VPN Control",
    title: "EasyConnect",
    description: "管理账号、客户端路径、网关列表，以及官方恢复登录链路。",
    actions: ["refresh", "recover-login", "launch-client"],
  },
  "runtime-status": {
    kicker: "Runtime",
    title: "本地运行态",
    description: "查看当前 EasyConnect 运行状态、调试目标和关键环境路径。",
    actions: ["refresh", "debug-targets"],
  },
  "build-portal": {
    kicker: "Adapter",
    title: "构建站",
    description: "通过底层 API 读取我的应用和服务构建入口，页面只用于补充确认功能点。",
    actions: ["save-config"],
  },
  "release-portal": {
    kicker: "Adapter",
    title: "发版站",
    description: "聚合发布概览和发布记录，变更动作后续按目标环境二次确认接入。",
    actions: ["save-config"],
  },
  "trace-log": {
    kicker: "Trace",
    title: "最近结果",
    description: "查看当前工作台执行过的动作和返回结果。",
    actions: ["refresh"],
  },
};

const elements = {
  appLaunchAtLogin: $("app-launch-at-login"),
  vpnUsername: $("vpn-username"),
  vpnPassword: $("vpn-password"),
  vpnDebugPort: $("vpn-debug-port"),
  vpnMaintainerInterval: $("vpn-maintainer-interval"),
  vpnMaintainerAutoStart: $("vpn-maintainer-autostart"),
  vpnAppExecutable: $("vpn-app-executable"),
  vpnGateways: $("vpn-gateways"),
  buildUrl: $("build-url"),
  buildUsername: $("build-username"),
  buildPassword: $("build-password"),
  buildApiStatus: $("build-api-status"),
  buildAppsList: $("build-apps-list"),
  buildApiRaw: $("build-api-raw"),
  releaseUrl: $("release-url"),
  releaseUsername: $("release-username"),
  releasePassword: $("release-password"),
  releaseApiStatus: $("release-api-status"),
  releaseOverviewList: $("release-overview-list"),
  releaseRecordsList: $("release-records-list"),
  releaseApiRaw: $("release-api-raw"),
  statusBanner: $("status-banner"),
  vpnStatus: $("vpn-status"),
  actionLog: $("action-log"),
  metricLoginStatus: $("metric-login-status"),
  metricSessionId: $("metric-session-id"),
  metricClientState: $("metric-client-state"),
  metricOfficialUi: $("metric-official-ui"),
  metricGatewayCount: $("metric-gateway-count"),
  metricPreferredGateway: $("metric-preferred-gateway"),
  metricMaintainerState: $("metric-maintainer-state"),
  metricCurrentGateway: $("metric-current-gateway"),
  metricLastAction: $("metric-last-action"),
  metricLastError: $("metric-last-error"),
  metricAllowedGateways: $("metric-allowed-gateways"),
  runtimeClientPath: $("runtime-client-path"),
  runtimeBundleDir: $("runtime-bundle-dir"),
  runtimeLogsDir: $("runtime-logs-dir"),
  recoveryPlan: $("recovery-plan"),
  recoveryProbe: $("recovery-probe"),
  recoveryProbeMain: $("recovery-probe-main"),
  maintainerStatus: $("maintainer-status"),
  toast: $("toast"),
  toastTitle: $("toast-title"),
  toastText: $("toast-text"),
  toastClose: $("toast-close"),
  connectionStatusChip: $("connection-status-chip"),
  connectionTitle: $("connection-title"),
  nextStepCopy: $("next-step-copy"),
  timelineGateway: $("timeline-gateway"),
  timelineMaintainer: $("timeline-maintainer"),
  pageKicker: $("page-kicker"),
  pageTitle: $("page-title"),
  pageDescription: $("page-description"),
  pageActions: $("page-actions"),
  sections: Array.from(document.querySelectorAll(".page-section")),
  navItems: Array.from(document.querySelectorAll(".sidebar-nav__item")),
  headerButtons: {
    refresh: $("refresh-status"),
    "recover-login": $("recover-login"),
    "launch-client": $("launch-client"),
  },
};

let currentPage = "vpn-control";
let toastTimer = null;
let maintainerRefreshTimer = null;
let maintainerRefreshInFlight = false;
let lastEnvironmentInfo = null;
let currentActionName = null;

function safeStringify(value) {
  return JSON.stringify(value, null, 2);
}

function setNodeText(node, value) {
  if (node) {
    node.textContent = value;
  }
}

function setNodeDisabled(node, disabled) {
  if (!node) {
    return;
  }

  node.disabled = disabled;
}

function setActionBusy(button, busy) {
  if (!button) {
    return;
  }

  button.classList.toggle("is-busy", busy);
  button.setAttribute("aria-busy", busy ? "true" : "false");
  setNodeDisabled(button, busy);
}

function firstPresent(...values) {
  for (const value of values) {
    if (value != null && `${value}`.trim()) {
      return `${value}`.trim();
    }
  }

  return "-";
}

function formatRowTitle(row = {}) {
  return firstPresent(
    row.appName,
    row.appNameEn,
    row.appCode,
    row.applicationName,
    row.name,
    row.serviceName,
    row.customerName,
    row.customerNameCn,
  );
}

function formatRowMeta(row = {}) {
  return [
    firstPresent(row.customerName, row.customerNameCn, row.customerNameEn),
    firstPresent(row.appCode, row.appNameEn, row.serviceName),
    firstPresent(row.envName, row.namespace, row.status, row.publishStatus, row.buildStatus),
  ]
    .filter((value) => value && value !== "-")
    .join(" / ");
}

function renderMiniList(node, rows, emptyText) {
  if (!node) {
    return;
  }

  const items = Array.isArray(rows) ? rows.slice(0, 12) : [];
  if (items.length === 0) {
    node.innerHTML = `<div class="empty-state">${emptyText}</div>`;
    return;
  }

  node.innerHTML = items
    .map((row) => {
      const title = formatRowTitle(row);
      const meta = formatRowMeta(row);
      return `
        <div class="platform-row">
          <div>
            <strong>${escapeHtml(title)}</strong>
            <span>${escapeHtml(meta || "已返回记录，字段结构待继续归一")}</span>
          </div>
          <code>${escapeHtml(firstPresent(row.id, row.appId, row.customerId, row.taskId, row.publishId))}</code>
        </div>
      `;
    })
    .join("");
}

function escapeHtml(value) {
  return `${value ?? ""}`
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function setBannerState(title, text, variant = "idle") {
  elements.statusBanner.className = [
    "status-banner",
    variant === "ok" ? "status-banner--ok" : "",
    variant === "warn" ? "status-banner--warn" : "",
    variant === "error" ? "status-banner--error" : "",
  ]
    .filter(Boolean)
    .join(" ");

  const titleNode = elements.statusBanner.querySelector(".status-banner__title");
  const textNode = elements.statusBanner.querySelector(".status-banner__text");
  if (titleNode) {
    titleNode.textContent = title;
  }
  if (textNode) {
    textNode.textContent = text;
  }
}

function setConnectionSummary(title, text, variant = "idle") {
  setNodeText(elements.connectionTitle, title);
  setNodeText(elements.nextStepCopy, text);
  if (!elements.connectionStatusChip) {
    return;
  }

  elements.connectionStatusChip.className = [
    "connection-chip",
    variant === "ok" ? "connection-chip--ok" : "",
    variant === "warn" ? "connection-chip--warn" : "",
    variant === "error" ? "connection-chip--error" : "",
  ]
    .filter(Boolean)
    .join(" ");
  elements.connectionStatusChip.textContent = title;
}

function appendLog(title, payload) {
  const current = elements.actionLog?.textContent?.trim?.() ?? "";
  const block = [`[${new Date().toLocaleTimeString()}] ${title}`, safeStringify(payload)].join("\n");
  if (elements.actionLog) {
    elements.actionLog.textContent = current ? `${block}\n\n${current}` : block;
  }
}

function showToast(title, text = "", variant = "idle") {
  if (!elements.toast) {
    return;
  }

  if (toastTimer) {
    clearTimeout(toastTimer);
  }

  elements.toast.className = [
    "app-toast",
    variant === "ok" ? "app-toast--ok" : "",
    variant === "warn" ? "app-toast--warn" : "",
    variant === "error" ? "app-toast--error" : "",
  ]
    .filter(Boolean)
    .join(" ");

  elements.toast.classList.remove("hidden");
  setNodeText(elements.toastTitle, title);
  setNodeText(elements.toastText, text);

  toastTimer = setTimeout(() => {
    hideToast();
  }, 6000);
}

function hideToast() {
  if (!elements.toast) {
    return;
  }

  if (toastTimer) {
    clearTimeout(toastTimer);
    toastTimer = null;
  }

  elements.toast.classList.add("app-toast--dismissed");
  setTimeout(() => {
    elements.toast.classList.add("hidden");
    elements.toast.classList.remove("app-toast--dismissed");
  }, 220);
}

function withTimeout(promise, ms, label) {
  let timer = null;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`${label} timed out after ${ms}ms`));
    }, ms);
  });

  return Promise.race([promise, timeout]).finally(() => {
    if (timer) {
      clearTimeout(timer);
    }
  });
}

function bindClick(element, name, handler) {
  if (!element) {
    appendLog("缺少按钮节点", { name });
    return;
  }

  element.addEventListener("click", async () => {
    appendLog("点击", { name });
    showToast("已触发操作", name);
    currentActionName = name;
    setActionBusy(element, true);
    try {
      await handler();
    } catch {
      // Action-specific logging is handled in withAction/init.
    } finally {
      currentActionName = null;
      setActionBusy(element, false);
    }
  });
}

function collectConfig() {
  return {
    app: {
      launchAtLogin: Boolean(elements.appLaunchAtLogin.checked),
    },
    vpn: {
      username: elements.vpnUsername.value.trim(),
      password: elements.vpnPassword.value,
      remoteDebugPort: Number.parseInt(elements.vpnDebugPort.value, 10) || 9222,
      maintainerIntervalSeconds: Number.parseInt(elements.vpnMaintainerInterval.value, 10) || 300,
      maintainerAutoStart: Boolean(elements.vpnMaintainerAutoStart.checked),
      appExecutable: elements.vpnAppExecutable.value.trim(),
      gateways: elements.vpnGateways.value
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => {
          const [host, port] = line.split(":");
          return {
            host: (host ?? "").trim(),
            port: Number.parseInt((port ?? "").trim(), 10) || "",
          };
        }),
    },
    portals: {
      build: {
        url: elements.buildUrl.value.trim(),
        username: elements.buildUsername.value.trim(),
        password: elements.buildPassword.value,
      },
      release: {
        url: elements.releaseUrl.value.trim(),
        username: elements.releaseUsername.value.trim(),
        password: elements.releasePassword.value,
      },
    },
  };
}

function applyConfig(config) {
  elements.appLaunchAtLogin.checked = Boolean(config.app?.launchAtLogin);
  elements.vpnUsername.value = config.vpn.username ?? "";
  elements.vpnPassword.value = config.vpn.password ?? "";
  elements.vpnDebugPort.value = String(config.vpn.remoteDebugPort ?? 9222);
  elements.vpnMaintainerInterval.value = String(config.vpn.maintainerIntervalSeconds ?? 300);
  elements.vpnMaintainerAutoStart.checked = Boolean(config.vpn.maintainerAutoStart);
  elements.vpnAppExecutable.value = config.vpn.appExecutable ?? "";
  elements.vpnGateways.value = (config.vpn.gateways ?? []).map((item) => `${item.host}:${item.port}`).join("\n");

  elements.buildUrl.value = config.portals.build.url ?? "";
  elements.buildUsername.value = config.portals.build.username ?? "";
  elements.buildPassword.value = config.portals.build.password ?? "";

  elements.releaseUrl.value = config.portals.release.url ?? "";
  elements.releaseUsername.value = config.portals.release.username ?? "";
  elements.releasePassword.value = config.portals.release.password ?? "";
}

function renderMaintainerStatus(maintainerStatus) {
  setNodeText(elements.maintainerStatus, safeStringify(maintainerStatus));
  setNodeText(elements.metricMaintainerState, maintainerStatus?.running ? "运行中" : "已停止");
  setNodeText(elements.metricCurrentGateway, formatMaintainerGateway(maintainerStatus));
  setNodeText(elements.metricLastAction, formatMaintainerAction(maintainerStatus));
  setNodeText(elements.metricLastError, formatMaintainerLastError(maintainerStatus));
  setNodeText(
    elements.timelineMaintainer,
    maintainerStatus?.running
      ? `自动守护运行中，最近动作：${formatMaintainerAction(maintainerStatus)}。`
      : "自动守护未运行；需要手动启动或启用自启动。",
  );
  setNodeDisabled($("start-maintainer"), Boolean(maintainerStatus?.running));
  setNodeDisabled($("stop-maintainer"), !maintainerStatus?.running);
}

function renderRecoveryPlan(plan) {
  setNodeText(elements.recoveryPlan, formatRecoveryPlan(plan));
  const firstGateway = plan?.gatewayCandidates?.[0] ?? plan?.gateways?.[0] ?? null;
  setNodeText(
    elements.timelineGateway,
    firstGateway ? `优先尝试 ${formatGateway(firstGateway)}，失败后再进入候补网关。` : "等待恢复计划或网关预检结果。",
  );
}

function renderRecoveryProbe(results) {
  setNodeText(elements.recoveryProbe, formatGatewayProbeResults(results));
  setNodeText(elements.recoveryProbeMain, formatGatewayProbeResults(results));
}

function scheduleMaintainerRefresh(maintainerStatus) {
  if (maintainerRefreshTimer) {
    clearTimeout(maintainerRefreshTimer);
    maintainerRefreshTimer = null;
  }

  if (!maintainerStatus?.running) {
    return;
  }

  maintainerRefreshTimer = setTimeout(async () => {
    if (maintainerRefreshInFlight) {
      scheduleMaintainerRefresh(maintainerStatus);
      return;
    }

    maintainerRefreshInFlight = true;
    let refreshed = false;
    try {
      await refreshStatus({ silent: true });
      refreshed = true;
    } catch {
      // Keep the existing banner/toast state; the next refresh will retry.
    } finally {
      maintainerRefreshInFlight = false;
      if (!refreshed) {
        const nextStatus = await window.workbench.getMaintainerStatus().catch(() => maintainerStatus);
        scheduleMaintainerRefresh(nextStatus);
      }
    }
  }, 3000);
}

function renderStatus(status, environmentInfo, config, maintainerStatus) {
  lastEnvironmentInfo = environmentInfo;
  setNodeText(elements.vpnStatus, safeStringify(status));
  setNodeText(elements.metricLoginStatus, config?.vpn?.username ? config.vpn.username : status.loginStatus?.status ?? status.latestCachedToken?.loginStatus?.status ?? "-");
  setNodeText(elements.metricSessionId, status.activeSession?.sessionId ?? "-");
  setNodeText(
    elements.metricClientState,
    status.serviceState
      ? `base ${status.serviceState.base ?? "-"} / l3vpn ${status.serviceState.l3vpn ?? "-"} / tcp ${status.serviceState.tcp ?? "-"}`
      : environmentInfo?.appExecutableExists
        ? "客户端已发现"
        : "客户端未发现",
  );
  setNodeText(elements.metricOfficialUi, formatOfficialUiMetric(status.officialUi));
  setNodeText(elements.metricGatewayCount, String(config?.vpn?.gateways?.length ?? 0));
  setNodeText(elements.metricPreferredGateway, formatGateway(config?.vpn?.lastKnownGateway));
  setNodeText(elements.metricAllowedGateways, formatAllowedGateways(config).replaceAll("\n", " / "));

  setNodeText(elements.runtimeClientPath, environmentInfo?.appExecutable ?? "-");
  setNodeText(elements.runtimeBundleDir, environmentInfo?.bundleConfDir ?? "-");
  setNodeText(elements.runtimeLogsDir, environmentInfo?.logsDir ?? "-");
  renderMaintainerStatus(maintainerStatus);
  scheduleMaintainerRefresh(maintainerStatus);

  const officialUiSummary = describeOfficialUiConsistency(status);

  if (!environmentInfo?.appExecutableExists) {
    setBannerState("客户端未就绪", "EasyConnect 路径无效或本机未安装客户端。", "error");
    setConnectionSummary("客户端未就绪", "先修正 EasyConnect 路径；路径无效时不要触发恢复。", "error");
  } else if (officialUiSummary) {
    setBannerState(officialUiSummary.title, officialUiSummary.detail, officialUiSummary.variant);
    setConnectionSummary(officialUiSummary.title, officialUiSummary.detail, officialUiSummary.variant);
  } else if (maintainerStatus?.running) {
    const summary = describeMaintainerEvent(maintainerStatus?.lastEvent);
    setBannerState(summary.title, summary.detail, summary.variant);
    setConnectionSummary(summary.title, summary.detail, summary.variant);
  } else if (status.loginStatus?.status === "1") {
    setBannerState("VPN 在线", "本地运行态已进入 online。", "ok");
    setConnectionSummary("隧道已接管，本机网络可用", "保持自动守护开启即可。不要重复恢复，除非官方界面卡在登录页、网关页或加载失败。", "ok");
  } else if (status.latestCachedToken?.loginStatus?.status === "3") {
    setBannerState("检测到旧注销态", "可以直接走官方 recover/login 链路恢复。", "warn");
    setConnectionSummary("检测到旧注销态", "建议执行“恢复并登录 VPN”，让官方 renderer 登录链路重新接管本地服务。", "warn");
  } else {
    setBannerState("VPN 当前未在线", "客户端可拉起，等待后续恢复或登录。");
    setConnectionSummary("VPN 当前未在线", "先确认网关与凭据，再执行恢复并登录；portal 登录只作为高级诊断兜底。");
  }
}

function renderPage(page) {
  currentPage = page;
  const meta = PAGE_META[page];
  if (!meta) {
    return;
  }

  setNodeText(elements.pageKicker, meta.kicker);
  setNodeText(elements.pageTitle, meta.title);
  setNodeText(elements.pageDescription, meta.description);

  elements.sections.forEach((section) => {
    section.classList.toggle("is-active", section.id === `page-${page}`);
  });

  elements.navItems.forEach((item) => {
    item.classList.toggle("is-active", item.dataset.page === page);
  });

  Object.entries(elements.headerButtons).forEach(([key, button]) => {
    if (!button) {
      return;
    }

    button.classList.toggle("hidden", !meta.actions.includes(key));
  });

  [
    $("save-config"),
    $("recover-user-debug"),
    $("portal-login"),
    $("debug-targets"),
  ].forEach((button) => {
    if (button) {
      button.classList.toggle("hidden", !meta.actions.includes("debug-targets") && button.id === "debug-targets");
    }
  });

  appendLog("切换页面", { page });
}

async function withAction(title, action) {
  try {
    setBannerState(`${title} 中`, "正在执行本地动作，请看下面 Trace。");
    const result = await action();
    appendLog(title, result);
    return result;
  } catch (error) {
    const payload = { error: error?.message ?? String(error) };
    appendLog(`${title} 失败`, payload);
    setBannerState(`${title} 失败`, payload.error, "error");
    throw error;
  }
}

async function refreshStatus(options = {}) {
  const silent = options.silent ?? false;
  const currentConfig = collectConfig();
  const { status, environmentInfo } = await withTimeout(
    window.workbench.getVpnSnapshot({
      config: currentConfig,
      audit: options.audit ?? false,
      auditTrigger: options.auditTrigger ?? "manual-refresh",
    }),
    20000,
    "getVpnSnapshot",
  );
  const [config, maintainerStatus] = await Promise.all([
    withTimeout(window.workbench.getConfig(), 5000, "getConfig"),
    withTimeout(window.workbench.getMaintainerStatus(), 5000, "getMaintainerStatus"),
  ]);
  const renderConfig = mergeConfigForRender(currentConfig, config);
  const displayEnvironmentInfo = sanitizeEnvironmentInfoForDisplay(environmentInfo, renderConfig);
  const recoveryPlan = await withTimeout(
    window.workbench.getRecoveryPlan({
      config: renderConfig,
      gatewayCandidates: displayEnvironmentInfo?.gatewayCandidates ?? [],
    }),
    10000,
    "getRecoveryPlan",
  );

  renderStatus(status, displayEnvironmentInfo, renderConfig, maintainerStatus);
  renderRecoveryPlan(recoveryPlan);
  if (!silent) {
    appendLog("刷新状态", { status, environmentInfo: displayEnvironmentInfo, maintainerStatus, recoveryPlan });
  }
  return { config: renderConfig, status, environmentInfo: displayEnvironmentInfo, maintainerStatus, recoveryPlan };
}

async function saveConfig() {
  const saved = await withAction("保存配置", () => window.workbench.saveConfig(collectConfig()));
  applyConfig(saved);
  showToast("配置已保存", "本地工作台配置已经更新。", "ok");
}

function validatePortalCredentials(kind) {
  const url = kind === "build" ? elements.buildUrl.value.trim() : elements.releaseUrl.value.trim();
  const username = kind === "build" ? elements.buildUsername.value.trim() : elements.releaseUsername.value.trim();
  const password = kind === "build" ? elements.buildPassword.value : elements.releasePassword.value;
  if (!url || !username || !password) {
    const label = kind === "build" ? "构建站" : "发版站";
    const message = `先填写${label} URL、用户名和密码，再刷新平台 API。`;
    appendLog("前置校验失败", { action: `${kind}-platform-overview`, message });
    showToast("缺少平台配置", message, "warn");
    return false;
  }

  return true;
}

async function refreshBuildPlatformOverview() {
  if (!validatePortalCredentials("build")) {
    return null;
  }

  setNodeText(elements.buildApiStatus, "正在登录构建站并读取我的应用...");
  const result = await withAction("刷新构建站 API", () =>
    window.workbench.getBuildPlatformOverview({
      config: collectConfig(),
      pageSize: 15,
      pageNumber: 1,
    }),
  );

  const loginText = result.login?.ok ? "登录成功" : "登录未确认";
  setNodeText(
    elements.buildApiStatus,
    `${loginText} / 应用 ${result.applications?.rowCount ?? 0} 条 / cookie ${result.login?.cookieCount ?? 0}`,
  );
  renderMiniList(elements.buildAppsList, result.applications?.rows ?? [], "还没有应用数据。确认 VPN 在线后再刷新。");
  setNodeText(elements.buildApiRaw, safeStringify(result));
  showToast("构建站已刷新", `读取到 ${result.applications?.rowCount ?? 0} 条应用记录。`, "ok");
  return result;
}

async function refreshReleasePlatformOverview() {
  if (!validatePortalCredentials("release")) {
    return null;
  }

  setNodeText(elements.releaseApiStatus, "正在登录发版站并读取发布概览...");
  const result = await withAction("刷新发版站 API", () =>
    window.workbench.getReleasePlatformOverview({
      config: collectConfig(),
      pageSize: 10,
      pageNumber: 1,
    }),
  );

  const loginText = result.login?.ok ? "登录成功" : "登录未确认";
  setNodeText(
    elements.releaseApiStatus,
    `${loginText} / 概览 ${result.overview?.rowCount ?? 0} 条 / 记录 ${result.records?.rowCount ?? 0} 条`,
  );
  renderMiniList(elements.releaseOverviewList, result.overview?.rows ?? [], "还没有发布概览数据。");
  renderMiniList(elements.releaseRecordsList, result.records?.rows ?? [], "还没有发布记录数据。");
  setNodeText(elements.releaseApiRaw, safeStringify(result));
  showToast("发版站已刷新", `发布概览 ${result.overview?.rowCount ?? 0} 条，发布记录 ${result.records?.rowCount ?? 0} 条。`, "ok");
  return result;
}

async function launchClient() {
  const result = await withAction("拉起官方客户端", () =>
    window.workbench.launchOfficialClient({
      config: collectConfig(),
      remoteDebugPort: Number.parseInt(elements.vpnDebugPort.value, 10) || null,
    }),
  );
  showToast("客户端已拉起", "如果需要自动恢复登录，请继续点击恢复并登录。", "ok");
  return result;
}

async function recoverUserDebug() {
  const result = await withAction("只恢复客户端", () =>
    window.workbench.recoverOfficialClient({
      config: collectConfig(),
      remoteDebugPort: Number.parseInt(elements.vpnDebugPort.value, 10) || 9222,
    }),
  );
  showToast("恢复链路已执行", "官方客户端已按恢复模式重新拉起。", "ok");
  return result;
}

async function portalLogin() {
  if (!elements.vpnUsername.value.trim() || !elements.vpnPassword.value) {
    const message = "先填写 VPN 用户名和密码，再执行登录页登录。";
    appendLog("前置校验失败", { action: "portal-login", message });
    showToast("缺少凭据", message, "warn");
    return;
  }

  const result = await withAction("对登录页执行登录", () =>
    window.workbench.portalLogin({
      config: collectConfig(),
      username: elements.vpnUsername.value.trim(),
      password: elements.vpnPassword.value,
      remoteDebugPort: Number.parseInt(elements.vpnDebugPort.value, 10) || 9222,
    }),
  );
  await refreshStatus();
  showToast("登录请求已发出", "已调用官方 renderer 登录 API。", "ok");
  return result;
}

async function recoverAndLogin() {
  if (!elements.vpnUsername.value.trim() || !elements.vpnPassword.value) {
    const message = "先填写 VPN 用户名和密码，再执行恢复并登录。";
    appendLog("前置校验失败", { action: "recover-login", message });
    showToast("缺少凭据", message, "warn");
    return;
  }

  const result = await withAction("恢复并登录 VPN", () =>
    window.workbench.recoverAndLogin({
      config: collectConfig(),
      username: elements.vpnUsername.value.trim(),
      password: elements.vpnPassword.value,
      remoteDebugPort: Number.parseInt(elements.vpnDebugPort.value, 10) || 9222,
      gatewayCandidates: lastEnvironmentInfo?.gatewayCandidates ?? [],
    }),
  );
  const recoveredStatus = extractStatusFromRecoverResult(result);
  const recoverySummary = describeMaintainerEvent({
    ok: true,
    result,
  });
  const config = await window.workbench.getConfig();
  const environmentInfo = sanitizeEnvironmentInfoForDisplay(await window.workbench.getEnvironmentInfo(), config);
  const maintainerStatus = await window.workbench.getMaintainerStatus();
  renderStatus(recoveredStatus, environmentInfo, config, maintainerStatus);
  elements.vpnStatus.textContent = safeStringify(recoveredStatus);
  showToast(recoverySummary.title, recoverySummary.detail, recoverySummary.variant);
  return result;
}

async function repairOfficialUi() {
  const result = await withAction("修复官方界面", () =>
    window.workbench.repairOfficialUi({
      config: collectConfig(),
      remoteDebugPort: Number.parseInt(elements.vpnDebugPort.value, 10) || 9222,
      focusServiceTarget: true,
    }),
  );

  await refreshStatus();

  if (result.action === "skip-offline") {
    showToast("VPN 未在线", "官方界面修复不会触发登录，请先恢复 VPN。", "warn");
  } else if (result.action === "already-consistent") {
    showToast("官方界面正常", "当前官方窗口和底层隧道状态一致。", "ok");
  } else if (result.action === "skip-hidden-service-target") {
    showToast("官方界面待处理", "VPN 已在线但服务页处于隐藏状态，当前没有安全的前台窗口可恢复。", "warn");
  } else if (result.action === "restore-hidden-service-target" || result.action === "restore-missing-service-target") {
    showToast("官方服务页已恢复", "已把官方窗口从探测页或辅助页恢复到服务页。", "ok");
  } else {
    showToast("官方界面已修复", "已把官方窗口拉回服务页并刷新资源。", "ok");
  }

  return result;
}

async function debugTargets() {
  const result = await withAction("查看调试目标", () =>
    window.workbench.getDebugTargets({
      config: collectConfig(),
      remoteDebugPort: Number.parseInt(elements.vpnDebugPort.value, 10) || 9222,
    }),
  );
  showToast("调试目标已更新", "结果已经写入最近结果面板。", "ok");
  return result;
}

async function probeRecoveryPlan() {
  const result = await withAction("探测恢复链路", () =>
    window.workbench.probeRecoveryPlan({
      config: collectConfig(),
      gatewayCandidates: lastEnvironmentInfo?.gatewayCandidates ?? [],
    }),
  );
  renderRecoveryProbe(result);
  showToast("恢复链路预检完成", "已更新候选网关可达性与验证码要求。", "ok");
  return result;
}

async function startMaintainer(options = {}) {
  const shouldSave = options.saveConfig ?? true;
  const silent = options.silent ?? false;
  const title = shouldSave ? "保存并启动自动守护" : "启动自动守护";

  const saved = await withAction(title, async () => {
    if (shouldSave) {
      await window.workbench.saveConfig(collectConfig());
    }
    return window.workbench.startMaintainer({
      gatewayCandidates: lastEnvironmentInfo?.gatewayCandidates ?? [],
    });
  });

  applyConfig(await window.workbench.getConfig());
  await refreshStatus({ silent });
  if (!silent) {
    showToast("自动守护已启动", "守护器会在后台周期检查 VPN 状态。", "ok");
  }
  return saved;
}

async function stopMaintainer() {
  const result = await withAction("停止自动守护", () => window.workbench.stopMaintainer());
  await refreshStatus();
  showToast("自动守护已停止", "后台守护循环已经终止。", "ok");
  return result;
}

async function init() {
  if (!window.workbench) {
    throw new Error("window.workbench is unavailable");
  }

  if (elements.actionLog) {
    elements.actionLog.textContent = "等待操作";
  }
  renderPage(currentPage);
  appendLog("界面启动", {
    page: currentPage,
    hasWorkbench: typeof window.workbench,
  });

  elements.navItems.forEach((item) => {
    item.addEventListener("click", () => renderPage(item.dataset.page));
  });

  bindClick($("save-config"), "save-config", saveConfig);
  bindClick($("refresh-status"), "refresh-status", () =>
    refreshStatus({
      audit: true,
      auditTrigger: "refresh-status-button",
    }),
  );
  bindClick($("recover-login"), "recover-login", recoverAndLogin);
  bindClick($("launch-client"), "launch-client", launchClient);
  bindClick($("recover-user-debug"), "recover-user-debug", recoverUserDebug);
  bindClick($("repair-official-ui"), "repair-official-ui", repairOfficialUi);
  bindClick($("debug-targets"), "debug-targets", debugTargets);
  bindClick($("probe-recovery"), "probe-recovery", probeRecoveryPlan);
  bindClick($("portal-login"), "portal-login", portalLogin);
  bindClick($("start-maintainer"), "start-maintainer", startMaintainer);
  bindClick($("stop-maintainer"), "stop-maintainer", stopMaintainer);
  bindClick($("refresh-build-platform"), "refresh-build-platform", refreshBuildPlatformOverview);
  bindClick($("refresh-release-platform"), "refresh-release-platform", refreshReleasePlatformOverview);
  bindClick($("open-logs"), "open-logs", () => window.workbench.openLogsDir());
  bindClick($("open-config-dir"), "open-config-dir", () => window.workbench.openConfigDir());
  elements.toastClose?.addEventListener("click", hideToast);
  elements.toast?.addEventListener("mouseenter", () => {
    if (toastTimer) {
      clearTimeout(toastTimer);
      toastTimer = null;
    }
  });
  elements.toast?.addEventListener("mouseleave", () => {
    if (!elements.toast.classList.contains("hidden")) {
      toastTimer = setTimeout(hideToast, 6000);
    }
  });

  try {
    const config = await withTimeout(window.workbench.getConfig(), 5000, "getConfig");
    applyConfig(config);
  } catch (error) {
    appendLog("读取配置失败", { error: error?.message ?? String(error) });
    showToast("读取配置失败", error?.message ?? String(error), "warn");
  }

  try {
    const { config, maintainerStatus } = await refreshStatus();
    renderRecoveryProbe([]);
    if (config?.vpn?.maintainerAutoStart && !maintainerStatus?.running) {
      appendLog("自动守护自启动", {
        intervalSeconds: config.vpn.maintainerIntervalSeconds ?? 300,
      });
      await startMaintainer({ saveConfig: false, silent: true });
    }
    appendLog("界面已就绪", {
      page: currentPage,
    });
    showToast("界面已就绪", "按钮和菜单已经完成绑定。", "ok");
  } catch (error) {
    appendLog("初始状态刷新失败", { error: error?.message ?? String(error) });
    setBannerState("状态刷新失败", error?.message ?? String(error), "warn");
    showToast("初始状态刷新失败", error?.message ?? String(error), "warn");
  }
}

window.addEventListener("error", (event) => {
  appendLog("前端异常", {
    message: event.message,
    filename: event.filename,
    lineno: event.lineno,
    colno: event.colno,
  });
  showToast("前端异常", event.message, "error");
});

window.addEventListener("unhandledrejection", (event) => {
  const reason = event.reason?.message ?? String(event.reason);
  appendLog("未处理 Promise 异常", { reason });
  showToast("未处理 Promise 异常", reason, "error");
});

window.addEventListener("beforeunload", () => {
  if (maintainerRefreshTimer) {
    clearTimeout(maintainerRefreshTimer);
    maintainerRefreshTimer = null;
  }
});

init().catch((error) => {
  appendLog("初始化失败", { error: error?.message ?? String(error) });
  showToast("初始化失败", error?.message ?? String(error), "error");
});
