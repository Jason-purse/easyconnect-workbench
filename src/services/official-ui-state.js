const KIND_LABELS = {
  "probe-failed": "探测失败",
  connect: "网关探测",
  login: "登录页",
  service: "服务页",
  "service-failed": "服务页异常",
  "user-setting": "个人设置",
  "vpn-status-manager": "状态管理",
  shortcut: "快捷页",
  other: "其他",
};

function includesAny(text, patterns) {
  return patterns.some((pattern) => pattern.test(text));
}

function detectBodySignals(bodyText = "", target = {}) {
  const text = `${bodyText ?? ""}`;
  const url = `${target.url ?? ""}`;
  const isLoginRoute = url.includes("/portal/#!/login");
  const hasCredentialPair = /用户名/i.test(text) && /密码/i.test(text);
  const hasLoginSubmit = /登录/i.test(text) && (hasCredentialPair || /账号/i.test(text));

  return {
    probeFailed: includesAny(text, [/无法连接/i, /连接失败/i, /加载失败/i, /网络异常/i, /刷新后重试/i]),
    loginForm: isLoginRoute || hasCredentialPair || hasLoginSubmit,
    servicePage: includesAny(text, [/资源搜索/i, /默认资源组/i]),
    serviceFailed: includesAny(text, [/加载失败/i, /刷新后重试/i, /获取资源配置文件失败/i, /network request error/i]),
  };
}

function classifyTarget(target = {}, signals = {}) {
  const url = `${target.url ?? ""}`;

  if (url.includes("/local/connect/connect.html")) {
    return signals.probeFailed ? "probe-failed" : "connect";
  }

  if (url.includes("/local/connect_notfound/connect_notfound.html")) {
    return "probe-failed";
  }

  if (url.includes("/portal/#!/login")) {
    return "login";
  }

  if (url.includes("/portal/#!/service") || url.includes("/portal/#!/vpn_openresource")) {
    if (signals.serviceFailed && !signals.servicePage) {
      return "service-failed";
    }

    return "service";
  }

  if (url.includes("/portal/#!/user_setting_box")) {
    return "user-setting";
  }

  if (url.includes("/local/vpn_status_manager/")) {
    return "vpn-status-manager";
  }

  if (url.includes("/portal/shortcut.html")) {
    return "shortcut";
  }

  if (signals.servicePage) {
    return "service";
  }

  if (signals.loginForm) {
    return "login";
  }

  return "other";
}

function normalizeNativeWindowState(nativeWindowState = null) {
  if (!nativeWindowState || typeof nativeWindowState !== "object") {
    return null;
  }

  const alerts = Array.isArray(nativeWindowState.alerts)
    ? nativeWindowState.alerts
        .map((alert) => ({
          text: `${alert?.text ?? ""}`.trim(),
          buttons: Array.isArray(alert?.buttons) ? alert.buttons.map((button) => `${button}`) : [],
        }))
        .filter((alert) => alert.text)
    : [];

  return {
    ok: nativeWindowState.ok !== false,
    supported: nativeWindowState.supported ?? true,
    visible: nativeWindowState.visible ?? null,
    windowCount: Number.isFinite(nativeWindowState.windowCount) ? nativeWindowState.windowCount : null,
    windowNames: Array.isArray(nativeWindowState.windowNames) ? nativeWindowState.windowNames : [],
    alerts,
    error: nativeWindowState.error ?? null,
  };
}

function isBlockingNativeAlert(alert = {}) {
  const text = `${alert.text ?? ""}`;
  return includesAny(text, [
    /ecResize/i,
    /onResizeWindow failed/i,
    /winID is not exist/i,
    /EasyConnect遇到严重错误/i,
    /严重错误/i,
  ]);
}

function isVisible(target = {}) {
  return target.hidden === false || target.visibilityState === "visible";
}

function rankPrimaryTarget(target = {}, context = {}) {
  const visible = isVisible(target);
  const visibleBlockingRanks = {
    "probe-failed": 0,
    connect: 1,
    login: 2,
    "service-failed": 3,
  };

  if (visible && Object.hasOwn(visibleBlockingRanks, target.kind)) {
    return visibleBlockingRanks[target.kind];
  }

  if (visible && target.kind === "service") {
    return 4;
  }

  if (!context.hasBlockingVisibleTarget && target.kind === "service") {
    return 5;
  }

  if (!visible) {
    return 100;
  }

  const ranks = {
    "user-setting": 6,
    shortcut: 7,
    "vpn-status-manager": 8,
    other: 9,
  };

  return ranks[target.kind] ?? 9;
}

function isBlockingVisibleTarget(target = {}, context = {}) {
  if (!isVisible(target)) {
    return false;
  }

  if (target.kind === "connect") {
    return !context.hasVisibleServiceTarget;
  }

  return ["probe-failed", "login", "service-failed"].includes(target.kind);
}

export function buildOfficialUiState({
  reachable = true,
  remoteDebugPort = 9222,
  targets = [],
  error = null,
  nativeWindowState = null,
} = {}) {
  const normalizedNativeWindowState = normalizeNativeWindowState(nativeWindowState);

  if (!reachable) {
    return {
      reachable: false,
      remoteDebugPort,
      error,
      nativeWindowState: normalizedNativeWindowState,
      targets: [],
      primaryTarget: null,
      hasServiceTarget: false,
      hasVisibleServiceTarget: false,
      hasBlockingVisibleTarget: false,
      hasBlockingNativeAlert: false,
      blockingNativeAlerts: [],
      needsNativeWindowRestore: false,
      hasDuplicateNativeWindows: false,
      needsNativeWindowConsolidation: false,
    };
  }

  const normalizedTargets = targets.map((target) => {
    const signals = detectBodySignals(target.bodyText, target);
    const kind = classifyTarget(target, signals);

    return {
      id: target.id,
      type: target.type,
      title: target.title ?? "",
      url: target.url ?? "",
      kind,
      kindLabel: KIND_LABELS[kind] ?? KIND_LABELS.other,
      visibilityState: target.visibilityState ?? null,
      hidden: target.hidden ?? null,
      visible: isVisible(target),
      signals,
      evaluationError: target.evaluationError ?? null,
    };
  });

  const hasServiceTarget = normalizedTargets.some((target) => target.kind === "service");
  const hasVisibleServiceTarget = normalizedTargets.some((target) => target.kind === "service" && isVisible(target));
  const hasBlockingVisibleTarget = normalizedTargets.some((target) => isBlockingVisibleTarget(target, { hasVisibleServiceTarget }));
  const blockingNativeAlerts = (normalizedNativeWindowState?.alerts ?? []).filter(isBlockingNativeAlert);
  const hasBlockingNativeAlert = blockingNativeAlerts.length > 0;
  const needsNativeWindowRestore = Boolean(
    hasServiceTarget &&
      normalizedNativeWindowState?.ok &&
      normalizedNativeWindowState.windowCount === 0,
  );
  const hasDuplicateNativeWindows = Boolean(
    hasServiceTarget &&
      normalizedNativeWindowState?.ok &&
      Number.isFinite(normalizedNativeWindowState.windowCount) &&
      normalizedNativeWindowState.windowCount > 1,
  );
  const needsNativeWindowConsolidation = hasDuplicateNativeWindows;
  const primaryTarget =
    [...normalizedTargets].sort(
      (left, right) =>
        rankPrimaryTarget(left, { hasBlockingVisibleTarget }) -
        rankPrimaryTarget(right, { hasBlockingVisibleTarget }),
    )[0] ?? null;

  return {
    reachable: true,
    remoteDebugPort,
    error: null,
    nativeWindowState: normalizedNativeWindowState,
    targets: normalizedTargets,
    primaryTarget,
    hasServiceTarget,
    hasVisibleServiceTarget,
    hasBlockingVisibleTarget,
    hasBlockingNativeAlert,
    blockingNativeAlerts,
    needsNativeWindowRestore,
    hasDuplicateNativeWindows,
    needsNativeWindowConsolidation,
  };
}

export function formatOfficialUiMetric(state = null) {
  if (!state) {
    return "-";
  }

  if (!state.reachable) {
    return "不可读";
  }

  if (state.hasBlockingNativeAlert) {
    return "原生弹窗异常";
  }

  if (state.hasDuplicateNativeWindows) {
    return "多个官方窗口";
  }

  return state.primaryTarget?.kindLabel ?? "无页面";
}

export function describeOfficialUiConsistency(status = {}) {
  const officialUi = status?.officialUi;
  if (!officialUi) {
    return null;
  }

  const tunnelOnline = status?.loginStatus?.status === "1";
  const primaryKind = officialUi.primaryTarget?.kind;

  if (!officialUi.reachable && tunnelOnline) {
    return {
      title: "隧道在线，官方窗口不可读",
      detail: "底层 VPN 已在线，但 Workbench 无法读取 EasyConnect 调试页面；当前只能确认隧道状态。",
      variant: "warn",
    };
  }

  if (tunnelOnline && officialUi.hasBlockingNativeAlert) {
    return {
      title: "隧道在线，官方原生弹窗异常",
      detail: "底层 VPN 已在线，但 EasyConnect 前台被原生错误弹窗阻塞；需要关闭该弹窗后再判定服务页是否稳定。",
      variant: "warn",
    };
  }

  if (tunnelOnline && officialUi.hasDuplicateNativeWindows) {
    return {
      title: "隧道在线，官方窗口重复",
      detail: "底层 VPN 已在线，官方服务页也存在，但 macOS 当前有多个 EasyConnect 原生窗口；需要收敛为一个窗口，不能判定为稳定。",
      variant: "warn",
    };
  }

  if (tunnelOnline && officialUi.hasBlockingVisibleTarget) {
    const detailByKind = {
      "probe-failed": "底层 VPN 已在线，但 EasyConnect 前台仍停在探测失败页；刷新状态不能再等同于官方 UI 正常。",
      connect: "底层 VPN 已在线，但 EasyConnect 前台仍停在网关探测页；刷新状态不能再等同于官方 UI 正常。",
      login: "底层 VPN 已在线，但 EasyConnect 前台仍停在登录页；刷新状态不能再等同于官方 UI 正常。",
      "service-failed": "底层 VPN 可能已在线，但 EasyConnect 服务页资源配置加载失败；需要重新同步并刷新服务页。",
    };

    return {
      title: primaryKind === "service-failed" ? "隧道在线，官方服务页加载失败" : "隧道在线，官方窗口异常",
      detail: detailByKind[primaryKind] ?? "底层 VPN 已在线，但 EasyConnect 前台页面没有进入服务态。",
      variant: "warn",
    };
  }

  if (tunnelOnline && officialUi.needsNativeWindowRestore) {
    return {
      title: "隧道在线，官方窗口已隐藏",
      detail: "底层 VPN 已在线，官方服务页也存在，但 macOS 当前没有 EasyConnect 原生窗口；需要显式恢复窗口而不是误判为正常。",
      variant: "warn",
    };
  }

  if (tunnelOnline && officialUi.reachable && !officialUi.hasServiceTarget) {
    return {
      title: "隧道在线，服务页缺失",
      detail: "底层 VPN 已在线，但 DevTools target 中没有官方服务页；资源页可能没有完成恢复。",
      variant: "warn",
    };
  }

  if (!tunnelOnline && primaryKind === "probe-failed") {
    return {
      title: "官方网关探测失败",
      detail: "EasyConnect 前台停在无法连接页，底层登录状态也不是 online；需要走恢复链路而不是只刷新状态。",
      variant: "error",
    };
  }

  return null;
}
