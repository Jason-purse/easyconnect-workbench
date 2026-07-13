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
  formatSessionId,
  sanitizeDiagnosticValueForDisplay,
  sanitizeMaintainerStatusForDisplay,
  sanitizeEnvironmentInfoForDisplay,
  sanitizeVpnStatusForDisplay,
} from "../services/vpn-display.js";
import { mergeConfigForRender } from "../services/vpn-render-config.js";
import {
  deriveConnectionView,
  deriveMaintainerActivity,
  deriveMaintainerView,
  describeMaintainerStartResult,
} from "./view-state.js";
import { createLatestRequestCoordinator } from "./refresh-coordinator.js";
import { persistSettingsAndRefresh } from "./settings-workflow.js";

const MAX_ACTIVITY_ENTRIES = 50;
const RECENT_ACTIVITY_ENTRIES = 4;
const MAINTAINER_REFRESH_INTERVAL_MS = 3000;
const QUIET_REFRESH_INTERVAL_MS = 30000;
const $ = (id) => document.getElementById(id);
const runLatestRefresh = createLatestRequestCoordinator();

const elements = {
  appShell: document.querySelector(".app-shell"),
  appLaunchAtLogin: $("app-launch-at-login"),
  vpnUsername: $("vpn-username"),
  vpnPassword: $("vpn-password"),
  vpnDebugPort: $("vpn-debug-port"),
  vpnMaintainerInterval: $("vpn-maintainer-interval"),
  vpnMaintainerAutoStart: $("vpn-maintainer-autostart"),
  vpnQuietHoursEnabled: $("vpn-quiet-hours-enabled"),
  vpnQuietStart: $("vpn-quiet-start"),
  vpnQuietEnd: $("vpn-quiet-end"),
  vpnAppExecutable: $("vpn-app-executable"),
  vpnGateways: $("vpn-gateways"),
  connectionBand: document.querySelector(".connection-band"),
  connectionState: $("connection-state"),
  connectionTitle: $("connection-title"),
  connectionDetail: $("connection-detail"),
  connectionPrimaryAction: $("connection-primary-action"),
  maintainerAction: $("maintainer-action"),
  metricLoginStatus: $("metric-login-status"),
  metricSessionId: $("metric-session-id"),
  metricClientState: $("metric-client-state"),
  metricOfficialUi: $("metric-official-ui"),
  metricPreferredGateway: $("metric-preferred-gateway"),
  metricMaintainerState: $("metric-maintainer-state"),
  metricCurrentGateway: $("metric-current-gateway"),
  metricLastAction: $("metric-last-action"),
  metricLastError: $("metric-last-error"),
  metricAllowedGateways: $("metric-allowed-gateways"),
  vpnStatus: $("vpn-status"),
  maintainerStatus: $("maintainer-status"),
  recoveryPlan: $("recovery-plan"),
  recoveryProbe: $("recovery-probe"),
  diagnosticResult: $("diagnostic-result"),
  recentActivityList: $("recent-activity-list"),
  activityList: $("activity-list"),
  actionNotice: $("action-notice"),
  actionNoticeTitle: $("action-notice-title"),
  actionNoticeDetail: $("action-notice-detail"),
  settingsDrawer: $("settings-drawer"),
  settingsBackdrop: $("settings-backdrop"),
  settingsForm: $("settings-form"),
  settingsFeedback: $("settings-feedback"),
  settingsFeedbackTitle: $("settings-feedback-title"),
  settingsFeedbackDetail: $("settings-feedback-detail"),
  viewPanels: Array.from(document.querySelectorAll("[data-view-panel]")),
  viewButtons: Array.from(document.querySelectorAll("[data-view]")),
};

let currentView = "overview";
let currentConnectionAction = "refresh";
let currentMaintainerAction = "start";
let maintainerRefreshTimer = null;
let maintainerRefreshInFlight = false;
let lastEnvironmentInfo = null;
let lastSettingsFocus = null;
let lastMaintainerEventAt = null;
let lastMaintainerCycleCount = null;
let lastMaintainerStartedAt = null;
let activityEntries = [];

function safeStringify(value) {
  return JSON.stringify(value, null, 2);
}

function setNodeText(node, value) {
  if (node) {
    node.textContent = value == null ? "" : String(value);
  }
}

function refreshIcons() {
  if (window.lucide?.createIcons) {
    window.lucide.createIcons({
      attrs: {
        width: 18,
        height: 18,
        "stroke-width": 1.8,
        "aria-hidden": "true",
      },
    });
  }
}

function setActionBusy(button, busy) {
  if (!button) {
    return;
  }

  button.classList.toggle("is-busy", busy);
  button.setAttribute("aria-busy", busy ? "true" : "false");
  if (busy) {
    button.disabled = true;
    return;
  }

  button.disabled =
    (button === elements.maintainerAction && currentMaintainerAction === null) ||
    (button === elements.connectionPrimaryAction && currentConnectionAction === null);
}

function formatActivityTime(timestamp) {
  return new Intl.DateTimeFormat("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(new Date(timestamp));
}

function renderActivityList(node, entries) {
  if (!node) {
    return;
  }

  node.replaceChildren();
  if (entries.length === 0) {
    const empty = document.createElement("li");
    empty.className = "activity-empty";
    empty.textContent = "暂无活动记录";
    node.append(empty);
    return;
  }

  for (const entry of entries) {
    const item = document.createElement("li");
    item.className = "activity-item";
    item.dataset.tone = entry.tone;

    const marker = document.createElement("span");
    marker.className = "activity-item__marker";
    marker.setAttribute("aria-hidden", "true");

    const content = document.createElement("div");
    content.className = "activity-item__content";
    const title = document.createElement("strong");
    title.textContent = entry.title;
    const detail = document.createElement("span");
    detail.textContent = entry.detail;
    content.append(title, detail);

    const time = document.createElement("time");
    time.dateTime = entry.timestamp;
    time.textContent = formatActivityTime(entry.timestamp);

    item.append(marker, content, time);
    node.append(item);
  }
}

function renderActivities() {
  renderActivityList(elements.recentActivityList, activityEntries.slice(0, RECENT_ACTIVITY_ENTRIES));
  renderActivityList(elements.activityList, activityEntries);
}

function appendActivity(title, detail = "", tone = "neutral", timestamp = new Date().toISOString()) {
  activityEntries.unshift({
    id: crypto.randomUUID?.() ?? String(Date.now()),
    timestamp,
    title,
    detail: sanitizeDiagnosticValueForDisplay(detail),
    tone,
  });
  activityEntries = activityEntries.slice(0, MAX_ACTIVITY_ENTRIES);
  renderActivities();
}

function showActionNotice(title, detail = "", tone = "neutral") {
  if (!elements.actionNotice) {
    return;
  }

  elements.actionNotice.classList.remove("is-hidden");
  elements.actionNotice.dataset.tone = tone;
  setNodeText(elements.actionNoticeTitle, title);
  setNodeText(elements.actionNoticeDetail, sanitizeDiagnosticValueForDisplay(detail));
}

function hideActionNotice() {
  elements.actionNotice?.classList.add("is-hidden");
}

function showSettingsFeedback(title, detail = "", tone = "neutral", { focus = false } = {}) {
  if (!elements.settingsFeedback) {
    return;
  }

  elements.settingsFeedback.classList.remove("is-hidden");
  elements.settingsFeedback.dataset.tone = tone;
  setNodeText(elements.settingsFeedbackTitle, title);
  setNodeText(elements.settingsFeedbackDetail, sanitizeDiagnosticValueForDisplay(detail));
  if (focus) {
    elements.settingsFeedback.focus();
  }
}

function hideSettingsFeedback() {
  elements.settingsFeedback?.classList.add("is-hidden");
}

function getSettingsFocusableElements() {
  if (!elements.settingsDrawer) {
    return [];
  }

  return Array.from(
    elements.settingsDrawer.querySelectorAll(
      'button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), details > summary, [tabindex]:not([tabindex="-1"])',
    ),
  ).filter((element) => !element.closest("[hidden]") && element.getClientRects().length > 0);
}

function trapSettingsFocus(event) {
  if (event.key !== "Tab" || !elements.settingsDrawer?.classList.contains("is-open")) {
    return;
  }

  const focusable = getSettingsFocusableElements();
  if (focusable.length === 0) {
    event.preventDefault();
    elements.settingsDrawer.focus();
    return;
  }

  const first = focusable[0];
  const last = focusable.at(-1);
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

function renderView(view) {
  currentView = view === "activity" ? "activity" : "overview";

  for (const panel of elements.viewPanels) {
    const isActive = panel.dataset.viewPanel === currentView;
    panel.classList.toggle("is-active", isActive);
    panel.hidden = !isActive;
  }

  for (const button of elements.viewButtons) {
    const isActive = button.dataset.view === currentView;
    button.classList.toggle("is-active", isActive);
    button.setAttribute("aria-selected", isActive ? "true" : "false");
  }
}

function openSettings() {
  lastSettingsFocus = document.activeElement;
  hideSettingsFeedback();
  elements.appShell?.setAttribute("inert", "");
  elements.settingsDrawer?.removeAttribute("inert");
  elements.settingsDrawer?.classList.add("is-open");
  elements.settingsDrawer?.setAttribute("aria-hidden", "false");
  elements.settingsBackdrop?.classList.remove("is-hidden");
  document.body.classList.add("has-open-drawer");
  window.setTimeout(() => elements.vpnUsername?.focus(), 0);
}

function closeSettings() {
  elements.settingsDrawer?.setAttribute("inert", "");
  elements.settingsDrawer?.classList.remove("is-open");
  elements.settingsDrawer?.setAttribute("aria-hidden", "true");
  elements.settingsBackdrop?.classList.add("is-hidden");
  document.body.classList.remove("has-open-drawer");
  elements.appShell?.removeAttribute("inert");
  if (lastSettingsFocus instanceof HTMLElement) {
    lastSettingsFocus.focus();
  }
  lastSettingsFocus = null;
}

function togglePasswordVisibility() {
  const isVisible = elements.vpnPassword.type === "text";
  elements.vpnPassword.type = isVisible ? "password" : "text";
  const button = $("toggle-password");
  button?.setAttribute("aria-label", isVisible ? "显示密码" : "隐藏密码");
  const icon = button?.querySelector("[data-lucide]");
  icon?.setAttribute("data-lucide", isVisible ? "eye" : "eye-off");
  refreshIcons();
}

function withTimeout(promise, ms, label) {
  let timer = null;
  const timeout = new Promise((_, reject) => {
    timer = window.setTimeout(() => {
      reject(new Error(label + " timed out after " + ms + "ms"));
    }, ms);
  });

  return Promise.race([promise, timeout]).finally(() => {
    if (timer) {
      window.clearTimeout(timer);
    }
  });
}

function bindClick(element, name, handler) {
  if (!element) {
    appendActivity("界面节点缺失", name, "error");
    return;
  }

  element.addEventListener("click", async () => {
    setActionBusy(element, true);
    try {
      await handler();
    } catch {
      // withAction records the user-facing failure.
    } finally {
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
      maintainerQuietHoursEnabled: Boolean(elements.vpnQuietHoursEnabled.checked),
      maintainerQuietStart: elements.vpnQuietStart.value || "18:30",
      maintainerQuietEnd: elements.vpnQuietEnd.value || "09:00",
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
  };
}

function applyConfig(config) {
  elements.appLaunchAtLogin.checked = Boolean(config.app?.launchAtLogin);
  elements.vpnUsername.value = config.vpn?.username ?? "";
  elements.vpnPassword.value = config.vpn?.password ?? "";
  elements.vpnDebugPort.value = String(config.vpn?.remoteDebugPort ?? 9222);
  elements.vpnMaintainerInterval.value = String(config.vpn?.maintainerIntervalSeconds ?? 300);
  elements.vpnMaintainerAutoStart.checked = Boolean(config.vpn?.maintainerAutoStart);
  elements.vpnQuietHoursEnabled.checked = Boolean(config.vpn?.maintainerQuietHoursEnabled);
  elements.vpnQuietStart.value = config.vpn?.maintainerQuietStart ?? "18:30";
  elements.vpnQuietEnd.value = config.vpn?.maintainerQuietEnd ?? "09:00";
  elements.vpnAppExecutable.value = config.vpn?.appExecutable ?? "";
  elements.vpnGateways.value = (config.vpn?.gateways ?? [])
    .map((item) => item.host + ":" + item.port)
    .join("\n");
}

function describeConnectionDetail(connectionView, status, config) {
  if (connectionView.detail) {
    return connectionView.detail;
  }

  const officialUiSummary = describeOfficialUiConsistency(status);
  if (officialUiSummary) {
    return officialUiSummary.detail;
  }

  if (connectionView.tone === "online") {
    return "EasyConnect 已在线。自动守护会持续检查隧道和官方客户端状态。";
  }
  if (connectionView.tone === "quiet") {
    return (
      "静默时段 " +
      (config?.vpn?.maintainerQuietStart ?? "18:30") +
      " - " +
      (config?.vpn?.maintainerQuietEnd ?? "09:00") +
      " 内不会自动重连。"
    );
  }
  if (connectionView.tone === "error") {
    return "在设置中确认 EasyConnect 安装路径后再检查连接。";
  }
  return "连接当前不可用。Workbench 可以通过官方登录链路恢复 VPN。";
}

function renderMaintainerStatus(config, maintainerStatus) {
  const maintainerView = deriveMaintainerView({ config, maintainerStatus });
  currentMaintainerAction = maintainerView.action;
  setNodeText(elements.metricMaintainerState, maintainerView.label);
  setNodeText(elements.metricLastAction, formatMaintainerAction(maintainerStatus));
  setNodeText(elements.metricLastError, formatMaintainerLastError(maintainerStatus));
  setNodeText(elements.maintainerAction, maintainerView.actionLabel);
  elements.maintainerAction.disabled = maintainerView.action === null;
  elements.maintainerAction.dataset.action = maintainerView.action ?? "";
  setNodeText(elements.maintainerStatus, safeStringify(sanitizeMaintainerStatusForDisplay(maintainerStatus)));
  const activity = deriveMaintainerActivity({
    maintainerStatus,
    previousEventAt: lastMaintainerEventAt,
    previousCycleCount: lastMaintainerCycleCount,
    previousStartedAt: lastMaintainerStartedAt,
  });
  if (activity) {
    lastMaintainerEventAt = activity.eventAt;
    lastMaintainerCycleCount = activity.cycleCount;
    lastMaintainerStartedAt = activity.startedAt;
    appendActivity(activity.title, activity.detail, activity.tone, activity.timestamp);
  }
  return maintainerView;
}

function renderStatus(status, environmentInfo, config, maintainerStatus) {
  lastEnvironmentInfo = environmentInfo;
  const connectionView = deriveConnectionView({ status, environmentInfo, maintainerStatus });
  const maintainerView = renderMaintainerStatus(config, maintainerStatus);
  const currentGateway = formatMaintainerGateway(maintainerStatus);
  const fallbackGateway = formatGateway(config?.vpn?.lastKnownGateway);

  currentConnectionAction = connectionView.primaryAction;
  elements.connectionBand.dataset.tone = connectionView.tone;
  setNodeText(elements.connectionState, connectionView.label);
  setNodeText(elements.connectionTitle, connectionView.title);
  setNodeText(
    elements.connectionDetail,
    sanitizeDiagnosticValueForDisplay(describeConnectionDetail(connectionView, status, config)),
  );
  setNodeText(elements.connectionPrimaryAction, connectionView.primaryLabel);
  elements.connectionPrimaryAction.dataset.action = connectionView.primaryAction;
  elements.connectionPrimaryAction.disabled = connectionView.primaryAction === null;

  setNodeText(elements.metricCurrentGateway, currentGateway === "-" ? fallbackGateway : currentGateway);
  setNodeText(elements.metricLoginStatus, config?.vpn?.username || status.loginStatus?.status || "-");
  setNodeText(elements.metricSessionId, formatSessionId(status.activeSession?.sessionId));
  setNodeText(
    elements.metricClientState,
    status.serviceState
      ? "base " +
          (status.serviceState.base ?? "-") +
          " / l3vpn " +
          (status.serviceState.l3vpn ?? "-") +
          " / tcp " +
          (status.serviceState.tcp ?? "-")
      : environmentInfo?.appExecutableExists
        ? "客户端已发现"
        : "客户端未发现",
  );
  setNodeText(elements.metricOfficialUi, formatOfficialUiMetric(status.officialUi));
  setNodeText(elements.metricPreferredGateway, fallbackGateway);
  setNodeText(elements.metricAllowedGateways, formatAllowedGateways(config).replaceAll("\n", " / "));
  setNodeText(elements.vpnStatus, safeStringify(sanitizeVpnStatusForDisplay(status)));

  scheduleMaintainerRefresh(maintainerStatus, maintainerView);
}

function renderRecoveryPlan(plan) {
  setNodeText(elements.recoveryPlan, formatRecoveryPlan(plan));
}

function renderRecoveryProbe(results) {
  setNodeText(elements.recoveryProbe, formatGatewayProbeResults(results));
}

function renderDiagnosticResult(result) {
  setNodeText(elements.diagnosticResult, safeStringify(sanitizeDiagnosticValueForDisplay(result)));
}

function scheduleMaintainerRefresh(maintainerStatus, maintainerView = deriveMaintainerView({ maintainerStatus })) {
  if (maintainerRefreshTimer) {
    window.clearTimeout(maintainerRefreshTimer);
    maintainerRefreshTimer = null;
  }

  if (!maintainerStatus?.running && maintainerView.state !== "quiet") {
    return;
  }

  const delay = maintainerView.state === "quiet" ? QUIET_REFRESH_INTERVAL_MS : MAINTAINER_REFRESH_INTERVAL_MS;
  maintainerRefreshTimer = window.setTimeout(async () => {
    if (maintainerRefreshInFlight) {
      scheduleMaintainerRefresh(maintainerStatus, maintainerView);
      return;
    }

    maintainerRefreshInFlight = true;
    try {
      await refreshStatus({ silent: true });
    } catch {
      scheduleMaintainerRefresh(maintainerStatus, maintainerView);
    } finally {
      maintainerRefreshInFlight = false;
    }
  }, delay);
}

async function withAction(title, action) {
  showActionNotice(title + "中", "正在执行本地操作。", "progress");
  try {
    const result = await action();
    appendActivity(title, "操作已完成。", "success");
    showActionNotice(title + "完成", "操作已完成。", "success");
    return result;
  } catch (error) {
    const detail = error?.message ?? String(error);
    appendActivity(title + "失败", detail, "error");
    showActionNotice(title + "失败", detail, "error");
    throw error;
  }
}

async function refreshStatus(options = {}) {
  return runLatestRefresh(
    async () => {
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
      const [storedConfig, maintainerStatus] = await Promise.all([
        withTimeout(window.workbench.getConfig(), 5000, "getConfig"),
        withTimeout(window.workbench.getMaintainerStatus(), 5000, "getMaintainerStatus"),
      ]);
      const renderConfig = mergeConfigForRender(currentConfig, storedConfig);
      const displayEnvironmentInfo = sanitizeEnvironmentInfoForDisplay(environmentInfo, renderConfig);
      const recoveryPlan = await withTimeout(
        window.workbench.getRecoveryPlan({
          config: renderConfig,
          gatewayCandidates: displayEnvironmentInfo?.gatewayCandidates ?? [],
        }),
        10000,
        "getRecoveryPlan",
      );

      return {
        config: renderConfig,
        status,
        environmentInfo: displayEnvironmentInfo,
        maintainerStatus,
        recoveryPlan,
      };
    },
    (result) => {
      renderStatus(result.status, result.environmentInfo, result.config, result.maintainerStatus);
      renderRecoveryPlan(result.recoveryPlan);
      if (!options.silent) {
        appendActivity("连接状态已更新", "本地运行态与守护状态已同步。", "neutral");
      }
    },
  );
}

async function saveConfig() {
  showSettingsFeedback("正在保存设置", "正在更新本地连接与守护配置。", "progress");
  try {
    const { saved, refreshError } = await persistSettingsAndRefresh({
      save: () => window.workbench.saveConfig(collectConfig()),
      afterSave: (nextConfig) => applyConfig(nextConfig),
      refresh: () => refreshStatus({ silent: true }),
    });
    appendActivity("保存设置", "新的连接与守护设置已经生效。", "success");
    if (refreshError) {
      const detail = refreshError?.message ?? String(refreshError);
      appendActivity("设置已保存，但状态刷新失败", detail, "warning");
      showSettingsFeedback(
        "设置已保存",
        `设置已生效，但状态刷新失败：${detail}`,
        "warning",
        { focus: true },
      );
      return saved;
    }
    showSettingsFeedback("设置已保存", "新的连接与守护设置已经生效。", "success", { focus: true });
    return saved;
  } catch (error) {
    const detail = error?.message ?? String(error);
    appendActivity("保存设置失败", detail, "error");
    showSettingsFeedback("设置保存失败", detail, "error", { focus: true });
    throw error;
  }
}

async function launchClient() {
  const result = await withAction("打开官方客户端", () =>
    window.workbench.launchOfficialClient({
      config: collectConfig(),
      remoteDebugPort: Number.parseInt(elements.vpnDebugPort.value, 10) || null,
    }),
  );
  renderDiagnosticResult(result);
  showActionNotice("官方客户端已打开", "需要连接时可返回概览执行“立即连接”。", "success");
  return result;
}

async function recoverAndLogin() {
  if (!elements.vpnUsername.value.trim() || !elements.vpnPassword.value) {
    const detail = "请先在设置中填写 VPN 用户名和密码。";
    appendActivity("缺少登录凭据", detail, "warning");
    showActionNotice("无法开始连接", detail, "warning");
    openSettings();
    return null;
  }

  const result = await withAction("恢复 VPN 连接", () =>
    window.workbench.recoverAndLogin({
      config: collectConfig(),
      username: elements.vpnUsername.value.trim(),
      password: elements.vpnPassword.value,
      remoteDebugPort: Number.parseInt(elements.vpnDebugPort.value, 10) || 9222,
      gatewayCandidates: lastEnvironmentInfo?.gatewayCandidates ?? [],
    }),
  );
  const recoveredStatus = extractStatusFromRecoverResult(result);
  const summary = describeMaintainerEvent({ ok: true, result });
  const config = await window.workbench.getConfig();
  const environmentInfo = sanitizeEnvironmentInfoForDisplay(
    await window.workbench.getEnvironmentInfo(),
    config,
  );
  const maintainerStatus = await window.workbench.getMaintainerStatus();
  renderStatus(recoveredStatus, environmentInfo, config, maintainerStatus);
  appendActivity(summary.title, summary.detail, summary.variant);
  showActionNotice(summary.title, summary.detail, summary.variant);
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
  renderDiagnosticResult(result);
  await refreshStatus({ silent: true });

  const messages = {
    "skip-offline": ["VPN 未在线", "官方界面修复不会触发登录，请先恢复 VPN。", "warning"],
    "already-consistent": ["官方界面正常", "官方窗口与底层隧道状态一致。", "success"],
    "skip-hidden-service-target": ["官方界面待处理", "当前没有安全的前台窗口可恢复。", "warning"],
    "restore-hidden-service-target": ["官方服务页已恢复", "隐藏的服务页已经恢复。", "success"],
    "restore-missing-service-target": ["官方服务页已恢复", "缺失的服务页已经恢复。", "success"],
  };
  const [title, detail, tone] = messages[result.action] ?? [
    "官方界面已修复",
    "官方窗口已回到可用状态。",
    "success",
  ];
  appendActivity(title, detail, tone);
  showActionNotice(title, detail, tone);
  return result;
}

async function debugTargets() {
  const result = await withAction("读取调试目标", () =>
    window.workbench.getDebugTargets({
      config: collectConfig(),
      remoteDebugPort: Number.parseInt(elements.vpnDebugPort.value, 10) || 9222,
    }),
  );
  renderDiagnosticResult(result);
  renderView("activity");
  showActionNotice("调试目标已更新", "结果已写入高级诊断。", "success");
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
  renderDiagnosticResult(result);
  showActionNotice("恢复链路探测完成", "候选网关和验证码要求已经更新。", "success");
  return result;
}

async function startMaintainer() {
  const savedConfig = await window.workbench.saveConfig(collectConfig());
  applyConfig(savedConfig);
  showActionNotice("启动自动守护中", "正在检查静默时段与本地守护状态。", "progress");
  try {
    const result = await window.workbench.startMaintainer({
      gatewayCandidates: lastEnvironmentInfo?.gatewayCandidates ?? [],
    });
    let refreshError = null;
    try {
      await refreshStatus({ silent: true });
    } catch (error) {
      refreshError = error;
    }
    const summary = describeMaintainerStartResult(result, { refreshError });
    appendActivity(summary.title, summary.detail, summary.tone);
    showActionNotice(summary.title, summary.detail, summary.tone);
    return result;
  } catch (error) {
    const detail = error?.message ?? String(error);
    appendActivity("启动自动守护失败", detail, "error");
    showActionNotice("启动自动守护失败", detail, "error");
    throw error;
  }
}

async function stopMaintainer() {
  const result = await withAction("停止自动守护", () => window.workbench.stopMaintainer());
  await refreshStatus({ silent: true });
  showActionNotice("自动守护已停止", "后台检查已停止，可随时重新启动。", "success");
  return result;
}

async function handleConnectionPrimaryAction() {
  if (currentConnectionAction === null) {
    return;
  }
  if (currentConnectionAction === "open-settings") {
    openSettings();
    return;
  }
  if (currentConnectionAction === "recover") {
    await recoverAndLogin();
    return;
  }
  if (currentConnectionAction === "launch-client") {
    await launchClient();
    return;
  }
  await withAction("检查连接", () =>
    refreshStatus({
      audit: true,
      auditTrigger: "connection-primary-action",
    }),
  );
}

async function handleMaintainerAction() {
  if (currentMaintainerAction === "start") {
    await startMaintainer();
  } else if (currentMaintainerAction === "stop") {
    await stopMaintainer();
  }
}

function bindStaticInteractions() {
  for (const button of elements.viewButtons) {
    button.addEventListener("click", () => renderView(button.dataset.view));
  }
  $("show-all-activity")?.addEventListener("click", () => renderView("activity"));
  $("clear-activity")?.addEventListener("click", () => {
    activityEntries = [];
    renderActivities();
    showActionNotice("活动已清空", "本次窗口内的活动记录已清空。", "neutral");
  });
  $("open-settings")?.addEventListener("click", openSettings);
  $("close-settings")?.addEventListener("click", closeSettings);
  elements.settingsBackdrop?.addEventListener("click", closeSettings);
  $("dismiss-action-notice")?.addEventListener("click", hideActionNotice);
  $("toggle-password")?.addEventListener("click", togglePasswordVisibility);
  document.addEventListener("keydown", (event) => {
    trapSettingsFocus(event);
    if (event.key === "Escape" && elements.settingsDrawer?.classList.contains("is-open")) {
      closeSettings();
    }
  });

  elements.settingsForm?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const button = $("save-config");
    setActionBusy(button, true);
    try {
      await saveConfig();
    } catch {
      // withAction records the failure.
    } finally {
      setActionBusy(button, false);
    }
  });

  bindClick(elements.connectionPrimaryAction, "connection-primary-action", handleConnectionPrimaryAction);
  bindClick(elements.maintainerAction, "maintainer-action", handleMaintainerAction);
  bindClick($("launch-client"), "launch-client", launchClient);
  bindClick($("repair-official-ui"), "repair-official-ui", repairOfficialUi);
  bindClick($("debug-targets"), "debug-targets", debugTargets);
  bindClick($("probe-recovery"), "probe-recovery", probeRecoveryPlan);
  bindClick($("open-logs"), "open-logs", () =>
    withAction("打开日志目录", () => window.workbench.openLogsDir()),
  );
  bindClick($("open-config-dir"), "open-config-dir", () =>
    withAction("打开配置目录", () => window.workbench.openConfigDir()),
  );
}

async function init() {
  if (!window.workbench) {
    throw new Error("window.workbench is unavailable");
  }

  renderActivities();
  renderView(currentView);
  bindStaticInteractions();
  refreshIcons();

  try {
    const config = await withTimeout(window.workbench.getConfig(), 5000, "getConfig");
    applyConfig(config);
  } catch (error) {
    const detail = error?.message ?? String(error);
    appendActivity("读取设置失败", detail, "error");
    showActionNotice("读取设置失败", detail, "error");
  }

  try {
    await refreshStatus();
    renderRecoveryProbe([]);
    appendActivity("Workbench 已就绪", "连接状态中心已经完成同步。", "success");
  } catch (error) {
    const detail = error?.message ?? String(error);
    appendActivity("初始状态刷新失败", detail, "warning");
    showActionNotice("初始状态刷新失败", detail, "warning");
  }
}

window.addEventListener("error", (event) => {
  appendActivity("前端异常", event.message, "error");
  showActionNotice("前端异常", event.message, "error");
});

window.addEventListener("unhandledrejection", (event) => {
  const detail = event.reason?.message ?? String(event.reason);
  appendActivity("未处理的异步异常", detail, "error");
  showActionNotice("未处理的异步异常", detail, "error");
});

window.addEventListener("beforeunload", () => {
  if (maintainerRefreshTimer) {
    window.clearTimeout(maintainerRefreshTimer);
    maintainerRefreshTimer = null;
  }
});

init().catch((error) => {
  const detail = error?.message ?? String(error);
  appendActivity("初始化失败", detail, "error");
  showActionNotice("初始化失败", detail, "error");
});
