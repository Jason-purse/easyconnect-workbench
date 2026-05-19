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

  if (url.includes("/portal/#!/login")) {
    return "login";
  }

  if (url.includes("/portal/#!/service")) {
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

function isVisible(target = {}) {
  return target.hidden === false || target.visibilityState === "visible";
}

function rankPrimaryTarget(target = {}) {
  if (!isVisible(target)) {
    return 100;
  }

  const ranks = {
    "probe-failed": 0,
    connect: 1,
    login: 2,
    "service-failed": 3,
    service: 4,
    "user-setting": 5,
    shortcut: 6,
    "vpn-status-manager": 7,
    other: 8,
  };

  return ranks[target.kind] ?? 8;
}

function isBlockingVisibleTarget(target = {}) {
  return isVisible(target) && ["probe-failed", "connect", "login", "service-failed"].includes(target.kind);
}

export function buildOfficialUiState({ reachable = true, remoteDebugPort = 9222, targets = [], error = null } = {}) {
  if (!reachable) {
    return {
      reachable: false,
      remoteDebugPort,
      error,
      targets: [],
      primaryTarget: null,
      hasServiceTarget: false,
      hasBlockingVisibleTarget: false,
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

  const primaryTarget =
    [...normalizedTargets].sort((left, right) => rankPrimaryTarget(left) - rankPrimaryTarget(right))[0] ?? null;

  return {
    reachable: true,
    remoteDebugPort,
    error: null,
    targets: normalizedTargets,
    primaryTarget,
    hasServiceTarget: normalizedTargets.some((target) => target.kind === "service"),
    hasBlockingVisibleTarget: normalizedTargets.some(isBlockingVisibleTarget),
  };
}

export function formatOfficialUiMetric(state = null) {
  if (!state) {
    return "-";
  }

  if (!state.reachable) {
    return "不可读";
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
