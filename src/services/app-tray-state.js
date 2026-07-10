import { describeMaintainerEvent } from "./vpn-status-labels.js";

function getEventResult(status = {}) {
  const result = status?.lastEvent?.result ?? {};
  return result.online ?? result;
}

function compactSessionId(sessionId) {
  const value = `${sessionId ?? ""}`.trim();
  if (!value) {
    return "-";
  }

  return value.length > 12 ? `${value.slice(0, 8)}...${value.slice(-4)}` : value;
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
  const eventResult = getEventResult(status);
  const onlineState = getOnlineState(status);
  const action = eventResult?.action ?? "-";
  const gateway = formatGateway(eventResult?.gateway ?? status.gateway);
  const session = compactSessionId(onlineState.sessionId);

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
      detail: eventDescription.detail || "VPN 已在线。",
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
      detail: eventDescription.detail,
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
      detail: eventDescription.detail || "后台守护已启动，等待下一轮探活或恢复结果。",
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
    detail: eventDescription.detail || "自动守护未运行。",
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
