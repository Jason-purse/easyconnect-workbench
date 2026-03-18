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
    description: "先沉淀地址和账号配置，后续再接真实动作编排。",
    actions: ["save-config"],
  },
  "release-portal": {
    kicker: "Adapter",
    title: "发版站",
    description: "保留发版入口配置，后续接发布动作、回执和失败回滚。",
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
  vpnUsername: $("vpn-username"),
  vpnPassword: $("vpn-password"),
  vpnDebugPort: $("vpn-debug-port"),
  vpnAppExecutable: $("vpn-app-executable"),
  vpnGateways: $("vpn-gateways"),
  buildUrl: $("build-url"),
  buildUsername: $("build-username"),
  buildPassword: $("build-password"),
  releaseUrl: $("release-url"),
  releaseUsername: $("release-username"),
  releasePassword: $("release-password"),
  statusBanner: $("status-banner"),
  vpnStatus: $("vpn-status"),
  actionLog: $("action-log"),
  metricLoginStatus: $("metric-login-status"),
  metricSessionId: $("metric-session-id"),
  metricClientState: $("metric-client-state"),
  metricGatewayCount: $("metric-gateway-count"),
  runtimeClientPath: $("runtime-client-path"),
  runtimeBundleDir: $("runtime-bundle-dir"),
  runtimeLogsDir: $("runtime-logs-dir"),
  toast: $("toast"),
  toastTitle: $("toast-title"),
  toastText: $("toast-text"),
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

function safeStringify(value) {
  return JSON.stringify(value, null, 2);
}

function setNodeText(node, value) {
  if (node) {
    node.textContent = value;
  }
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

  if (toastTimer) {
    clearTimeout(toastTimer);
  }

  toastTimer = setTimeout(() => {
    elements.toast.classList.add("hidden");
  }, 2600);
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
    try {
      await handler();
    } catch {
      // Action-specific logging is handled in withAction/init.
    }
  });
}

function collectConfig() {
  return {
    vpn: {
      username: elements.vpnUsername.value.trim(),
      password: elements.vpnPassword.value,
      remoteDebugPort: Number.parseInt(elements.vpnDebugPort.value, 10) || 9222,
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
  elements.vpnUsername.value = config.vpn.username ?? "";
  elements.vpnPassword.value = config.vpn.password ?? "";
  elements.vpnDebugPort.value = String(config.vpn.remoteDebugPort ?? 9222);
  elements.vpnAppExecutable.value = config.vpn.appExecutable ?? "";
  elements.vpnGateways.value = (config.vpn.gateways ?? []).map((item) => `${item.host}:${item.port}`).join("\n");

  elements.buildUrl.value = config.portals.build.url ?? "";
  elements.buildUsername.value = config.portals.build.username ?? "";
  elements.buildPassword.value = config.portals.build.password ?? "";

  elements.releaseUrl.value = config.portals.release.url ?? "";
  elements.releaseUsername.value = config.portals.release.username ?? "";
  elements.releasePassword.value = config.portals.release.password ?? "";
}

function renderStatus(status, environmentInfo, config) {
  setNodeText(elements.vpnStatus, safeStringify(status));
  setNodeText(elements.metricLoginStatus, status.loginStatus?.status ?? status.latestCachedToken?.loginStatus?.status ?? "-");
  setNodeText(elements.metricSessionId, status.activeSession?.sessionId ?? "-");
  setNodeText(elements.metricClientState, environmentInfo?.appExecutableExists ? "已发现" : "未发现");
  setNodeText(elements.metricGatewayCount, String(config?.vpn?.gateways?.length ?? 0));

  setNodeText(elements.runtimeClientPath, environmentInfo?.appExecutable ?? "-");
  setNodeText(elements.runtimeBundleDir, environmentInfo?.bundleConfDir ?? "-");
  setNodeText(elements.runtimeLogsDir, environmentInfo?.logsDir ?? "-");

  if (!environmentInfo?.appExecutableExists) {
    setBannerState("客户端未就绪", "EasyConnect 路径无效或本机未安装客户端。", "error");
  } else if (status.loginStatus?.status === "1") {
    setBannerState("VPN 在线", "本地运行态已进入 online。", "ok");
  } else if (status.latestCachedToken?.loginStatus?.status === "3") {
    setBannerState("检测到旧注销态", "可以直接走官方 recover/login 链路恢复。", "warn");
  } else {
    setBannerState("VPN 当前未在线", "客户端可拉起，等待后续恢复或登录。");
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
      button.classList.remove("hidden");
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

async function refreshStatus() {
  const config = await withTimeout(window.workbench.getConfig(), 5000, "getConfig");
  const [status, environmentInfo] = await Promise.all([
    withTimeout(window.workbench.getVpnStatus(), 12000, "getVpnStatus"),
    withTimeout(window.workbench.getEnvironmentInfo(), 12000, "getEnvironmentInfo"),
  ]);

  renderStatus(status, environmentInfo, config);
  appendLog("刷新状态", { status, environmentInfo });
  return { config, status, environmentInfo };
}

async function saveConfig() {
  const saved = await withAction("保存配置", () => window.workbench.saveConfig(collectConfig()));
  applyConfig(saved);
  showToast("配置已保存", "本地工作台配置已经更新。", "ok");
}

async function launchClient() {
  const result = await withAction("拉起官方客户端", () =>
    window.workbench.launchOfficialClient({
      remoteDebugPort: Number.parseInt(elements.vpnDebugPort.value, 10) || null,
    }),
  );
  showToast("客户端已拉起", "如果需要自动恢复登录，请继续点击恢复并登录。", "ok");
  return result;
}

async function recoverUserDebug() {
  const result = await withAction("只恢复客户端", () =>
    window.workbench.recoverOfficialClient({
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
      username: elements.vpnUsername.value.trim(),
      password: elements.vpnPassword.value,
      remoteDebugPort: Number.parseInt(elements.vpnDebugPort.value, 10) || 9222,
    }),
  );
  await refreshStatus();
  showToast("登录请求已发出", "已调用官方登录页的 password vm.login()", "ok");
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
      username: elements.vpnUsername.value.trim(),
      password: elements.vpnPassword.value,
      remoteDebugPort: Number.parseInt(elements.vpnDebugPort.value, 10) || 9222,
    }),
  );
  const config = await window.workbench.getConfig();
  const environmentInfo = await window.workbench.getEnvironmentInfo();
  renderStatus(result.online, environmentInfo, config);
  elements.vpnStatus.textContent = safeStringify(result.online);
  showToast("VPN 已恢复在线", "本地运行态已经切回 online。", "ok");
  return result;
}

async function debugTargets() {
  const result = await withAction("查看调试目标", () =>
    window.workbench.getDebugTargets({
      remoteDebugPort: Number.parseInt(elements.vpnDebugPort.value, 10) || 9222,
    }),
  );
  showToast("调试目标已更新", "结果已经写入最近结果面板。", "ok");
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
  bindClick($("refresh-status"), "refresh-status", refreshStatus);
  bindClick($("recover-login"), "recover-login", recoverAndLogin);
  bindClick($("launch-client"), "launch-client", launchClient);
  bindClick($("recover-user-debug"), "recover-user-debug", recoverUserDebug);
  bindClick($("debug-targets"), "debug-targets", debugTargets);
  bindClick($("portal-login"), "portal-login", portalLogin);
  bindClick($("open-logs"), "open-logs", () => window.workbench.openLogsDir());
  bindClick($("open-config-dir"), "open-config-dir", () => window.workbench.openConfigDir());

  try {
    const config = await withTimeout(window.workbench.getConfig(), 5000, "getConfig");
    applyConfig(config);
  } catch (error) {
    appendLog("读取配置失败", { error: error?.message ?? String(error) });
    showToast("读取配置失败", error?.message ?? String(error), "warn");
  }

  try {
    await refreshStatus();
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

init().catch((error) => {
  appendLog("初始化失败", { error: error?.message ?? String(error) });
  showToast("初始化失败", error?.message ?? String(error), "error");
});
