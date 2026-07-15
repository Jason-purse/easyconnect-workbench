import { describeMaintainerEvent } from "./vpn-status-labels.js";
import { formatSessionId, sanitizeDiagnosticTextForDisplay } from "./vpn-display.js";
import {
  getMaintainerDataPlaneEvidence,
  getMaintainerEventResult,
} from "./vpn-data-plane-evidence.js";

function formatGateway(gateway) {
  if (!gateway?.host || !gateway?.port) {
    return "-";
  }

  return `${gateway.host}:${gateway.port}`;
}

function getOnlineState(status = {}, options = {}) {
  const eventResult = getMaintainerEventResult(status);
  const evidence = getMaintainerDataPlaneEvidence(status, options);
  const activeSession = evidence.source ? evidence.activeSession : (eventResult?.activeSession ?? null);
  const loginStatus = evidence.source ? evidence.loginStatus : (eventResult?.loginStatus ?? null);
  const dataPlane = evidence.dataPlane;
  const controlPlaneOnline = Boolean(activeSession?.sessionId && loginStatus?.status === "1");
  const verified = Boolean(controlPlaneOnline && dataPlane?.configured === true && dataPlane?.ok === true);

  return {
    online: Boolean(verified && evidence.evidenceFresh && evidence.evidenceMatchesProbe),
    controlPlaneOnline,
    dataPlane,
    verified,
    evidenceFresh: evidence.evidenceFresh,
    evidenceMatchesProbe: evidence.evidenceMatchesProbe,
    evidenceSource: evidence.source,
    sessionId: activeSession?.sessionId ?? null,
  };
}

export function buildTrayStatusLabels(status = null, options = {}) {
  if (!status) {
    return {
      title: "EasyConnect: 未初始化",
      detail: "应用正在启动，尚未读取 VPN 守护状态。",
      variant: "idle",
      gateway: "-",
      session: "-",
      action: "-",
      canStart: false,
      canStop: false,
      running: false,
      online: false,
    };
  }

  const onlineState = getOnlineState(status, options);
  const selectedEvent = onlineState.evidenceSource === "observation" ? null : status.lastEvent;
  const eventDescription = describeMaintainerEvent(selectedEvent);
  const eventDetail = sanitizeDiagnosticTextForDisplay(eventDescription.detail);
  const eventResult = selectedEvent ? getMaintainerEventResult(status) : {};
  const action = eventResult?.action ?? "-";
  const gateway = formatGateway(eventResult?.gateway ?? status.gateway);
  const session = formatSessionId(onlineState.sessionId);

  if (status.quietHours?.active) {
    const start = status.quietHours.start ?? "18:30";
    const end = status.quietHours.end ?? "09:00";
    return {
      title: "EasyConnect: 静默时段",
      detail: `${start} - ${end} 内不会自动恢复 VPN。`,
      variant: "quiet",
      gateway,
      session,
      action,
      canStart: false,
      canStop: Boolean(status.running),
      running: Boolean(status.running),
      online: onlineState.online,
    };
  }

  if (status.currentPhase) {
    return {
      title: "EasyConnect: 恢复中",
      detail: `后台守护正在执行：${status.currentPhase}`,
      variant: "busy",
      gateway,
      session,
      action,
      canStart: false,
      canStop: true,
      running: true,
      online: onlineState.online,
    };
  }

  if (onlineState.verified && !status.running) {
    return {
      title: "EasyConnect: 守护已停止",
      detail: "自动守护未运行，最近一次在线结果不再作为当前状态。",
      variant: "idle",
      gateway,
      session,
      action,
      canStart: true,
      canStop: false,
      running: false,
      online: false,
    };
  }

  if (onlineState.dataPlane && !onlineState.evidenceMatchesProbe) {
    return {
      title: "EasyConnect: 连接待复核",
      detail: "探活目标已更新，等待下一轮检查。",
      variant: "warn",
      gateway,
      session,
      action,
      canStart: false,
      canStop: true,
      running: true,
      online: false,
    };
  }

  if (onlineState.verified && !onlineState.evidenceFresh) {
    return {
      title: "EasyConnect: 连接待复核",
      detail: "最近一次数据通道探测已过期，等待下一轮检查。",
      variant: "warn",
      gateway,
      session,
      action,
      canStart: false,
      canStop: true,
      running: true,
      online: false,
    };
  }

  if (onlineState.controlPlaneOnline && onlineState.dataPlane?.configured !== true) {
    return {
      title: "EasyConnect: 连接未验证",
      detail: eventDetail || "尚未配置内网探活目标，当前连接无法验证。",
      variant: "warn",
      gateway,
      session,
      action,
      canStart: !status.running,
      canStop: Boolean(status.running),
      running: Boolean(status.running),
      online: false,
    };
  }

  if (
    onlineState.controlPlaneOnline &&
    onlineState.evidenceMatchesProbe &&
    onlineState.dataPlane?.configured === true &&
    onlineState.dataPlane?.ok === false
  ) {
    return {
      title: "EasyConnect: 数据通道不可达",
      detail: sanitizeDiagnosticTextForDisplay(
        onlineState.dataPlane.error ?? "最新一次内网探活失败。",
      ),
      variant: "error",
      gateway,
      session,
      action,
      canStart: !status.running,
      canStop: Boolean(status.running),
      running: Boolean(status.running),
      online: false,
    };
  }

  if (
    onlineState.evidenceSource === "maintainer" &&
    onlineState.evidenceMatchesProbe &&
    `${status.lastEvent?.code ?? ""}`.startsWith("VPN_DATA_PLANE_")
  ) {
    return {
      title: "EasyConnect: 数据通道不可达",
      detail: eventDetail,
      variant: "error",
      gateway,
      session,
      action,
      canStart: !status.running,
      canStop: Boolean(status.running),
      running: Boolean(status.running),
      online: false,
    };
  }

  if (onlineState.online) {
    return {
      title: "EasyConnect: 在线",
      detail: eventDetail || "VPN 已在线。",
      variant: "ok",
      gateway,
      session,
      action,
      canStart: !status.running,
      canStop: Boolean(status.running),
      running: Boolean(status.running),
      online: true,
    };
  }

  if (eventDescription.variant === "error") {
    return {
      title: "EasyConnect: 离线 / 恢复失败",
      detail: eventDetail,
      variant: "error",
      gateway,
      session,
      action,
      canStart: !status.running,
      canStop: Boolean(status.running),
      running: Boolean(status.running),
      online: false,
    };
  }

  if (status.running) {
    return {
      title: "EasyConnect: 守护运行中",
      detail: eventDetail || "后台守护已启动，等待下一轮探活或恢复结果。",
      variant: eventDescription.variant,
      gateway,
      session,
      action,
      canStart: false,
      canStop: true,
      running: true,
      online: false,
    };
  }

  return {
    title: "EasyConnect: 守护已停止",
    detail: eventDetail || "自动守护未运行。",
    variant: "idle",
    gateway,
    session,
    action,
    canStart: true,
    canStop: false,
    running: false,
    online: false,
  };
}

export function buildTrayTooltip(status = null) {
  const labels = buildTrayStatusLabels(status);
  return [
    labels.title,
    `网关: ${labels.gateway}`,
    `会话: ${labels.session}`,
    labels.detail,
  ]
    .filter(Boolean)
    .join("\n");
}

export function buildTrayStatusSignature(status = null, options = {}) {
  const labels = buildTrayStatusLabels(status, options);
  return JSON.stringify({
    title: labels.title,
    detail: labels.detail,
    gateway: labels.gateway,
    session: labels.session,
    action: labels.action,
    canStart: labels.canStart,
    canStop: labels.canStop,
    running: labels.running,
    online: labels.online,
    variant: labels.variant,
  });
}
