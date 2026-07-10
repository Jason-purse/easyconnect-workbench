function getLastAction(maintainerStatus = {}) {
  return (
    maintainerStatus?.lastEvent?.result?.action ??
    maintainerStatus?.lastEvent?.action ??
    maintainerStatus?.lastResult?.action ??
    null
  );
}

function isQuietHours(maintainerStatus) {
  return getLastAction(maintainerStatus) === "keepalive-paused-quiet-hours";
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

  return {
    tone: "offline",
    label: "未连接",
    title: "连接需要恢复",
    primaryAction: "recover",
    primaryLabel: "立即连接",
  };
}

export function deriveMaintainerView({ config = {}, maintainerStatus = {} } = {}) {
  if (maintainerStatus.running) {
    return {
      state: "running",
      label: "运行中",
      action: "stop",
      actionLabel: "停止守护",
      intervalSeconds: Number(config?.vpn?.maintainerIntervalSeconds ?? 300),
    };
  }

  if (isQuietHours(maintainerStatus)) {
    return {
      state: "quiet",
      label: "静默时段",
      action: null,
      actionLabel: "静默时段后恢复",
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
