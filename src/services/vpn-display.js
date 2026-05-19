export function formatGateway(gateway) {
  if (!gateway?.host || !gateway?.port) {
    return "-";
  }

  return `${gateway.host}:${gateway.port}`;
}

function normalizeGateway(gateway) {
  const host = `${gateway?.host ?? ""}`.trim();
  const port = Number.parseInt(`${gateway?.port ?? ""}`, 10) || "";

  if (!host || !port) {
    return null;
  }

  return {
    host,
    port,
  };
}

function sameGateway(left, right) {
  return left?.host === right?.host && left?.port === right?.port;
}

function getConfiguredGateways(config = {}) {
  return (config?.vpn?.gateways ?? []).map(normalizeGateway).filter(Boolean);
}

function uniqueGateways(gateways = []) {
  const normalized = gateways.map(normalizeGateway).filter(Boolean);
  return normalized.filter((gateway, index) => {
    return normalized.findIndex((item) => sameGateway(item, gateway)) === index;
  });
}

export function filterGatewaysByConfigAllowlist(gateways = [], config = {}) {
  const normalized = uniqueGateways(gateways);
  const allowlist = getConfiguredGateways(config);
  if (allowlist.length === 0) {
    return normalized;
  }

  return normalized.filter((gateway) => allowlist.some((allowed) => sameGateway(allowed, gateway)));
}

export function sanitizeEnvironmentInfoForDisplay(environmentInfo = {}, config = {}) {
  return {
    ...environmentInfo,
    gatewayCandidates: filterGatewaysByConfigAllowlist(environmentInfo?.gatewayCandidates ?? [], config),
  };
}

export function formatAllowedGateways(config = {}) {
  const gateways = getConfiguredGateways(config);
  if (gateways.length === 0) {
    return "-";
  }

  return gateways.map(formatGateway).join("\n");
}

export function formatMaintainerAction(status = {}) {
  const event = status?.lastEvent;
  if (!event) {
    return "-";
  }

  if (!event.ok) {
    return "failed";
  }

  return event.result?.action ?? event.result?.mode ?? "ok";
}

export function formatMaintainerGateway(status = {}) {
  return formatGateway(status?.lastEvent?.result?.gateway ?? status?.gateway);
}

export function formatMaintainerLastError(status = {}) {
  return status?.lastError ?? status?.lastEvent?.error ?? "-";
}

function formatGatewaySource(source) {
  if (source === "configured") {
    return "手工配置";
  }
  if (source === "lastKnown") {
    return "最近成功";
  }
  if (source === "snapshot") {
    return "当前快照";
  }
  if (source === "discovered") {
    return "运行时发现";
  }
  return "未知来源";
}

export function formatRecoveryPlan(plan) {
  const gateways = plan?.gateways ?? [];
  if (gateways.length === 0) {
    return "暂无恢复计划。";
  }

  const lines = gateways.map((gateway, index) => {
    return `${index + 1}. 主链路 -> ${formatGateway(gateway)} (${formatGatewaySource(gateway.source)})`;
  });

  if (plan?.fallback === "portal-debug") {
    lines.push(`${lines.length + 1}. 兜底 -> portal 调试登录`);
  }

  return lines.join("\n");
}

export function formatGatewayProbeResults(results = []) {
  if (!Array.isArray(results) || results.length === 0) {
    return "暂无预检结果。";
  }

  return results
    .map((item, index) => {
      const parts = [
        `${index + 1}. ${formatGateway(item)}`,
        formatGatewaySource(item.source),
      ];

      if (item.reachable) {
        parts.push("可达");
        parts.push(item.captchaRequired ? "需要验证码" : "无验证码");
        if (item.recommended) {
          parts.push("推荐");
        }
      } else {
        parts.push("不可达");
        if (item.error) {
          parts.push(item.error);
        }
      }

      return parts.join(" | ");
    })
    .join("\n");
}
