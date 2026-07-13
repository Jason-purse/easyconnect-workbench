import { describeMaintainerEvent } from "./vpn-status-labels.js";
import { formatSessionId, sanitizeDiagnosticTextForDisplay } from "./vpn-display.js";

function getEventResult(status = {}) {
  const result = status?.lastEvent?.result ?? {};
  return result.online ?? result;
}

function formatGateway(gateway) {
  if (!gateway?.host || !gateway?.port) {
    return "-";
  }

  return `${gateway.host}:${gateway.port}`;
}

function getOnlineState(status = {}) {
  const eventResult = getEventResult(status);
  const activeSession = eventResult?.activeSession ?? null;
  const loginStatus = eventResult?.loginStatus ?? null;

  return {
    online: Boolean(activeSession?.sessionId && loginStatus?.status === "1"),
    sessionId: activeSession?.sessionId ?? null,
  };
}

export function buildTrayStatusLabels(status = null) {
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

  const eventDescription = describeMaintainerEvent(status.lastEvent);
  const eventDetail = sanitizeDiagnosticTextForDisplay(eventDescription.detail);
  const eventResult = getEventResult(status);
  const onlineState = getOnlineState(status);
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

export function buildTrayStatusSignature(status = null) {
  const labels = buildTrayStatusLabels(status);
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
