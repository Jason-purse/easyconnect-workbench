function summarizeGatewayAttempts(attempts) {
  if (!Array.isArray(attempts) || attempts.length === 0) {
    return "";
  }

  const parts = attempts.map((item) => {
    if (item.ok) {
      return `${item.gateway} 成功`;
    }

    return `${item.gateway} 失败`;
  });

  return `本轮尝试：${parts.join("，")}。`;
}

export function describeMaintainerEvent(event) {
  if (!event) {
    return {
      title: "等待守护结果",
      detail: "后台守护尚未产出新的周期结果。",
      variant: "idle",
    };
  }

  if (event.ok) {
    if (event.result?.mode === "fallback-page-bridge") {
      return {
        title: "桥接恢复成功",
        detail: `主链路失败后已回退到官方页面桥接恢复。${summarizeGatewayAttempts(event.result?.gatewayAttempts)}`.trim(),
        variant: "warn",
      };
    }

    if (event.result?.mode === "fallback-portal-debug") {
      return {
        title: "兜底恢复成功",
        detail: `主链路失败后已回退到 portal 调试登录。${summarizeGatewayAttempts(event.result?.gatewayAttempts)}`.trim(),
        variant: "warn",
      };
    }

    if (event.result?.action === "keepalive-paused-quiet-hours") {
      return {
        title: "自动守护已进入静默时段",
        detail: `18:30-09:00 不自动 keepalive；下一次自动检查时间：${event.result?.quietHours?.resumeAt ?? "09:00"}。`,
        variant: "idle",
      };
    }

    if (event.result?.action === "relogin-page-bridge") {
      return {
        title: "主链路恢复成功",
        detail: `已通过服务端登录、cookie 注入和官方页面桥接恢复 VPN。${summarizeGatewayAttempts(event.result?.gatewayAttempts)}`.trim(),
        variant: "ok",
      };
    }

    if (event.result?.action === "already-online") {
      const officialUiRepair = event.result?.officialUiRepair;
      if (officialUiRepair?.action === "repair-official-ui") {
        return {
          title: "保持在线，官方界面已修复",
          detail: "VPN 已在线，本轮探活已在后台修复官方服务页状态，不会主动抢前台。",
          variant: "ok",
        };
      }

      if (officialUiRepair?.action === "restore-unreachable-official-ui") {
        return {
          title: "保持在线，官方服务页已恢复",
          detail: "VPN 已在线，本轮已恢复官方 UI 调试链路并回到服务页，后续周期会按冷却跳过重复修复。",
          variant: "ok",
        };
      }

      if (
        officialUiRepair?.action === "restore-hidden-service-target" ||
        officialUiRepair?.action === "restore-missing-service-target"
      ) {
        return {
          title: "保持在线，官方服务页已恢复",
          detail: "VPN 已在线，本轮已把官方窗口从探测页或辅助页恢复到服务页，后续周期会按冷却跳过重复修复。",
          variant: "ok",
        };
      }

      if (`${officialUiRepair?.action ?? ""}`.endsWith("-incomplete")) {
        return {
          title: "保持在线，官方界面待修复",
          detail: `VPN 已在线，但官方窗口仍未回到服务页：${officialUiRepair.reason ?? "未知原因"}`,
          variant: "warn",
        };
      }

      if (officialUiRepair?.action === "repair-error") {
        return {
          title: "保持在线，官方界面待修复",
          detail: `VPN 已在线，但官方窗口自愈失败：${officialUiRepair.error ?? "未知错误"}`,
          variant: "warn",
        };
      }

      return {
        title: "保持在线",
        detail: "VPN 已在线，本轮仅完成探活。",
        variant: "ok",
      };
    }

    return {
      title: "守护成功",
      detail: "后台守护完成了一轮成功检查。",
      variant: "ok",
    };
  }

  const error = `${event.error ?? ""}`;
  const isAgentProxyNotReady =
    event.code === "EASYCONNECT_AGENT_PROXY_NOT_READY" ||
    (Array.isArray(event.gatewayAttempts) && event.gatewayAttempts.some((item) => (
      item.code === "EASYCONNECT_AGENT_PROXY_NOT_READY"
    )));
  const isPrivateKick =
    event.code === "EASYCONNECT_PRIVATE_KICK" ||
    (Array.isArray(event.gatewayAttempts) && event.gatewayAttempts.some((item) => (
      item.code === "EASYCONNECT_PRIVATE_KICK"
    )));
  const isLocalServiceNotReady =
    event.code === "EASYCONNECT_LOCAL_SERVICE_NOT_READY" ||
    event.diagnostics?.classification === "local-service-not-ready" ||
    (Array.isArray(event.gatewayAttempts) && event.gatewayAttempts.some((item) => (
      item.code === "EASYCONNECT_LOCAL_SERVICE_NOT_READY" ||
      item.diagnostics?.classification === "local-service-not-ready"
    )));

  if (isAgentProxyNotReady) {
    return {
      title: "EasyConnect 代理未就绪",
      detail: `ECAgentProxy 还没有 ready，守护已暂停本轮恢复并降低重试频率，避免继续拉起官方客户端进入严重错误。${summarizeGatewayAttempts(event.gatewayAttempts)}`.trim(),
      variant: "warn",
    };
  }

  if (isPrivateKick) {
    return {
      title: "账号被其他端踢下线",
      detail: `EasyConnect 报告同用户名登录，守护已降低重试频率，避免当前机器和其他终端互相抢登录。${summarizeGatewayAttempts(event.gatewayAttempts)}`.trim(),
      variant: "warn",
    };
  }

  if (isLocalServiceNotReady) {
    return {
      title: "EasyConnect 本地服务未就绪",
      detail: `账号和网关登录链路已触发，但本机 EasyConnect 核心服务没有 ready；守护已降低重试频率，避免反复把官方界面拉回登录循环。${summarizeGatewayAttempts(event.gatewayAttempts)}`.trim(),
      variant: "warn",
    };
  }

  if (/captcha|验证码|校验/i.test(error)) {
    return {
      title: "需要人工校验",
      detail: `当前网关要求验证码或额外校验，自动恢复已暂停。${summarizeGatewayAttempts(event.gatewayAttempts)}`.trim(),
      variant: "warn",
    };
  }

  if (Array.isArray(event.gatewayAttempts) && event.gatewayAttempts.length > 0 && event.gatewayAttempts.every((item) => !item.ok)) {
    return {
      title: "VPN 离线 / 网关不可达",
      detail: `两个已配置网关都恢复失败，请检查网络、网关地址或 EasyConnect 服务端状态。${summarizeGatewayAttempts(event.gatewayAttempts)}`.trim(),
      variant: "error",
    };
  }

  if (/gateway/i.test(error)) {
    return {
      title: "缺少可用网关",
      detail: `当前没有可恢复的 VPN 网关，请先刷新状态或补充网关列表。${summarizeGatewayAttempts(event.gatewayAttempts)}`.trim(),
      variant: "error",
    };
  }

  return {
    title: "守护失败",
    detail: `${error || "后台守护本轮执行失败。"}${summarizeGatewayAttempts(event.gatewayAttempts)}`.trim(),
    variant: "error",
  };
}

export function extractStatusFromRecoverResult(result) {
  if (result?.online) {
    return {
      mode: result.mode,
      gateway: result.gateway,
      error: result.error,
      gatewayAttempts: result.gatewayAttempts,
      ...result.online,
    };
  }

  return result;
}
