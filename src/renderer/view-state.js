import { describeMaintainerEvent } from "../services/vpn-status-labels.js";
import { sanitizeDiagnosticTextForDisplay } from "../services/vpn-display.js";

function getLastAction(maintainerStatus = {}) {
  return (
    maintainerStatus?.lastEvent?.result?.action ??
    maintainerStatus?.lastEvent?.action ??
    maintainerStatus?.lastResult?.action ??
    null
  );
}

function isQuietHours(maintainerStatus) {
  if (typeof maintainerStatus?.quietHours?.active === "boolean") {
    return maintainerStatus.quietHours.active;
  }

  return getLastAction(maintainerStatus) === "keepalive-paused-quiet-hours";
}

function hasFailureCode(event = {}, code) {
  return (
    event?.code === code ||
    (Array.isArray(event?.gatewayAttempts) && event.gatewayAttempts.some((attempt) => attempt?.code === code))
  );
}

function isCaptchaFailure(event = {}) {
  const messages = [event?.error, ...(event?.gatewayAttempts ?? []).map((attempt) => attempt?.error)];
  return messages.some((message) => /captcha|验证码|校验/i.test(`${message ?? ""}`));
}

function isReadinessFailure(event = {}) {
  return ["EASYCONNECT_LOCAL_SERVICE_NOT_READY", "EASYCONNECT_AGENT_PROXY_NOT_READY"].some((code) =>
    hasFailureCode(event, code),
  );
}

export function deriveConnectionView({ status = {}, environmentInfo = {}, maintainerStatus = {} } = {}) {
  if (!environmentInfo.appExecutableExists) {
    return {
      tone: "error",
      label: "客户端未就绪",
      title: "找不到 EasyConnect",
      primaryAction: "open-settings",
      primaryLabel: "检查设置",
    };
  }

  if (status.loginStatus?.status === "1") {
    return {
      tone: "online",
      label: "已连接",
      title: "连接受到保护",
      primaryAction: "refresh",
      primaryLabel: "立即检查",
    };
  }

  if (isQuietHours(maintainerStatus)) {
    return {
      tone: "quiet",
      label: "静默时段",
      title: "自动恢复已暂停",
      primaryAction: "refresh",
      primaryLabel: "立即检查",
    };
  }

  if (maintainerStatus?.currentPhase) {
    return {
      tone: "progress",
      label: "恢复中",
      title: "正在恢复连接",
      detail: `Workbench 正在执行 ${maintainerStatus.currentPhase}，请等待本轮恢复完成。`,
      primaryAction: null,
      primaryLabel: "正在连接",
    };
  }

  const lastEvent = maintainerStatus?.lastEvent;
  if (lastEvent?.ok === false && hasFailureCode(lastEvent, "EASYCONNECT_PRIVATE_KICK")) {
    return {
      tone: "warning",
      label: "需要人工处理",
      title: "账号在其他终端登录",
      detail: "自动恢复已退避，避免多个终端反复抢占同一账号。请打开官方客户端确认当前登录。",
      primaryAction: "launch-client",
      primaryLabel: "打开官方客户端",
    };
  }

  if (lastEvent?.ok === false && isCaptchaFailure(lastEvent)) {
    return {
      tone: "warning",
      label: "需要人工校验",
      title: "网关要求验证码",
      detail: "自动恢复已暂停。请在官方 EasyConnect 客户端完成验证码或额外校验。",
      primaryAction: "launch-client",
      primaryLabel: "打开官方客户端",
    };
  }

  if (lastEvent?.ok === false && isReadinessFailure(lastEvent)) {
    return {
      tone: "warning",
      label: "客户端准备中",
      title: "EasyConnect 服务尚未就绪",
      detail: "守护已降低重试频率，避免重复拉起客户端。稍后重新检查即可。",
      primaryAction: "refresh",
      primaryLabel: "重新检查",
    };
  }

  return {
    tone: "offline",
    label: "未连接",
    title: "连接需要恢复",
    primaryAction: "recover",
    primaryLabel: "立即连接",
  };
}

export function deriveMaintainerView({ config = {}, maintainerStatus = {} } = {}) {
  if (isQuietHours(maintainerStatus)) {
    return {
      state: "quiet",
      label: "静默时段",
      action: null,
      actionLabel: "静默时段后恢复",
      intervalSeconds: Number(config?.vpn?.maintainerIntervalSeconds ?? 300),
    };
  }

  if (maintainerStatus.running) {
    return {
      state: "running",
      label: "运行中",
      action: "stop",
      actionLabel: "停止守护",
      intervalSeconds: Number(config?.vpn?.maintainerIntervalSeconds ?? 300),
    };
  }

  return {
    state: "stopped",
    label: "已停止",
    action: "start",
    actionLabel: "启动守护",
    intervalSeconds: Number(config?.vpn?.maintainerIntervalSeconds ?? 300),
  };
}

export function deriveMaintainerActivity({ maintainerStatus = {}, previousEventAt = null } = {}) {
  const eventAt = maintainerStatus?.lastEventAt ?? null;
  if (!eventAt || !maintainerStatus?.lastEvent || eventAt === previousEventAt) {
    return null;
  }

  const summary = describeMaintainerEvent(maintainerStatus.lastEvent);
  return {
    eventAt,
    timestamp: eventAt,
    title: summary.title,
    detail: sanitizeDiagnosticTextForDisplay(summary.detail),
    tone: summary.variant,
  };
}

export function describeMaintainerStartResult(result = {}, { refreshError = null } = {}) {
  if (result.startSuppressed || result.quietHours?.active) {
    const start = result.quietHours?.start ?? "18:30";
    const end = result.quietHours?.end ?? "09:00";
    return {
      title: "静默时段",
      detail: `${start} - ${end} 内不会启动自动恢复。静默时段结束后可再次启动。`,
      tone: "warning",
    };
  }

  if (refreshError) {
    return {
      title: "自动守护已启动",
      detail: sanitizeDiagnosticTextForDisplay(
        `守护已经启动，但状态刷新失败：${refreshError?.message ?? String(refreshError)}`,
      ),
      tone: "warning",
    };
  }

  return {
    title: "自动守护已启动",
    detail: "Workbench 会在后台周期检查 VPN 状态。",
    tone: "success",
  };
}
