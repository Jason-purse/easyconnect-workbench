export function formatGateway(gateway) {
  if (!gateway?.host || !gateway?.port) {
    return "-";
  }

  return `${gateway.host}:${gateway.port}`;
}

export function formatSessionId(sessionId) {
  const value = `${sessionId ?? ""}`.trim();
  if (!value) {
    return "-";
  }

  if (value.length <= 8) {
    return `${value.slice(0, 2)}…${value.slice(-2)}`;
  }

  return `${value.slice(0, 4)}…${value.slice(-4)}`;
}

export function sanitizeDiagnosticTextForDisplay(value = "") {
  return `${value}`
    .replace(
      /("(?:twfid|token|session(?:id)?|cookie|password|secret|websocketdebuggerurl)"\s*:\s*")[^"]*(")/gi,
      "$1<redacted>$2",
    )
    .replace(/((?:twfid|token|session(?:id)?|cookie)=)[^&\s]+/gi, "$1<redacted>")
    .replace(/\b[a-fA-F0-9]{16,64}\b/g, "<hex>");
}

function sanitizeDiagnosticText(value) {
  return value === null || value === undefined ? null : sanitizeDiagnosticTextForDisplay(value);
}

function isSensitiveDiagnosticKey(key = "") {
  const normalized = `${key}`.replace(/[^a-z0-9]/gi, "").toLowerCase();
  return /token|twfid|sessionid|cookie|password|secret|websocketdebuggerurl/.test(normalized);
}

export function sanitizeDiagnosticValueForDisplay(value, key = "") {
  if (isSensitiveDiagnosticKey(key)) {
    return "<redacted>";
  }

  if (Array.isArray(value)) {
    return value.map((item) => sanitizeDiagnosticValueForDisplay(item));
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([childKey, childValue]) => [
        childKey,
        sanitizeDiagnosticValueForDisplay(childValue, childKey),
      ]),
    );
  }

  return typeof value === "string" ? sanitizeDiagnosticTextForDisplay(value) : value;
}

export function sanitizeVpnStatusForDisplay(status = {}) {
  const officialUi = status?.officialUi;
  return {
    loginStatus: status?.loginStatus ? { status: status.loginStatus.status ?? null } : null,
    activeSession: status?.activeSession?.sessionId
      ? { sessionId: formatSessionId(status.activeSession.sessionId) }
      : null,
    serviceState: status?.serviceState
      ? {
          base: status.serviceState.base ?? null,
          l3vpn: status.serviceState.l3vpn ?? null,
          tcp: status.serviceState.tcp ?? null,
        }
      : null,
    officialUi: officialUi
      ? {
          reachable: officialUi.reachable ?? null,
          primaryKind: officialUi.primaryTarget?.kind ?? officialUi.primaryKind ?? null,
          hasServiceTarget: Boolean(officialUi.hasServiceTarget),
          hasVisibleServiceTarget: Boolean(officialUi.hasVisibleServiceTarget),
          hasBlockingVisibleTarget: Boolean(officialUi.hasBlockingVisibleTarget),
          hasBlockingNativeAlert: Boolean(officialUi.hasBlockingNativeAlert),
          needsNativeWindowRestore: Boolean(officialUi.needsNativeWindowRestore),
          hasDuplicateNativeWindows: Boolean(officialUi.hasDuplicateNativeWindows),
        }
      : null,
    error: sanitizeDiagnosticText(status?.error),
  };
}

export function sanitizeMaintainerStatusForDisplay(status = {}) {
  const event = status?.lastEvent;
  const result = event?.result;
  return {
    running: Boolean(status?.running),
    gateway: normalizeGateway(status?.gateway),
    intervalSeconds: status?.intervalSeconds ?? null,
    cycleTimeoutMs: status?.cycleTimeoutMs ?? null,
    startedAt: status?.startedAt ?? null,
    stoppedAt: status?.stoppedAt ?? null,
    cycleCount: status?.cycleCount ?? 0,
    currentPhase: status?.currentPhase ?? null,
    phaseUpdatedAt: status?.phaseUpdatedAt ?? null,
    lastEventAt: status?.lastEventAt ?? null,
    lastError: sanitizeDiagnosticText(status?.lastError),
    quietHours: status?.quietHours
      ? {
          active: Boolean(status.quietHours.active),
          start: status.quietHours.start ?? null,
          end: status.quietHours.end ?? null,
          resumeAt: status.quietHours.resumeAt ?? null,
        }
      : null,
    lastEvent: event
      ? {
          ok: event.ok !== false,
          error: sanitizeDiagnosticText(event.error),
          code: event.code ?? null,
          lastPhase: event.lastPhase ?? null,
          result: result
            ? {
                action: result.action ?? null,
                mode: result.mode ?? null,
                gateway: normalizeGateway(result.gateway),
                gatewayAttempts: Array.isArray(result.gatewayAttempts)
                  ? result.gatewayAttempts.map((attempt) => ({
                      gateway: attempt.gateway ?? null,
                      ok: attempt.ok !== false,
                      error: sanitizeDiagnosticText(attempt.error),
                      code: attempt.code ?? null,
                    }))
                  : [],
                officialUiRepair: result.officialUiRepair
                  ? {
                      action: result.officialUiRepair.action ?? null,
                      reason: sanitizeDiagnosticText(result.officialUiRepair.reason),
                      error: sanitizeDiagnosticText(result.officialUiRepair.error),
                    }
                  : null,
              }
            : null,
        }
      : null,
  };
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
  return sanitizeDiagnosticText(status?.lastError ?? status?.lastEvent?.error) ?? "-";
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
          parts.push(sanitizeDiagnosticTextForDisplay(item.error));
        }
      }

      return parts.join(" | ");
    })
    .join("\n");
}
