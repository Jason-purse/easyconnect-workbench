function sanitizeSession(session) {
  if (!session) {
    return null;
  }

  return {
    ...session,
    token: undefined,
  };
}

function summarizeOfficialUiRepair(result = {}) {
  const repair = result?.officialUiRepair;
  if (!repair) {
    return null;
  }

  return {
    action: repair.action ?? null,
    reason: repair.reason ?? null,
    error: repair.error ?? null,
    gateway: repair.gateway ?? null,
  };
}

function getResultOnline(result = {}) {
  const online = result.online ?? result;
  if (!result.officialUiRepair || online.officialUiRepair) {
    return online;
  }

  return {
    ...online,
    officialUiRepair: result.officialUiRepair,
  };
}

function normalizeGateway(gateway) {
  const host = `${gateway?.host ?? ""}`.trim();
  const port = Number.parseInt(`${gateway?.port ?? ""}`, 10) || "";

  return host && port ? `${host}:${port}` : null;
}

function getGatewayConfigSignature(config = {}) {
  return {
    lastKnownGateway: normalizeGateway(config?.vpn?.lastKnownGateway),
    gateways: (Array.isArray(config?.vpn?.gateways) ? config.vpn.gateways : [])
      .map(normalizeGateway)
      .filter(Boolean),
  };
}

export function summarizeMaintainerStatus(status) {
  const result = status?.lastEvent?.result ?? {};
  const online = getResultOnline(result);

  return {
    running: Boolean(status?.running),
    gateway: status?.gateway ?? null,
    intervalSeconds: status?.intervalSeconds ?? null,
    cycleCount: status?.cycleCount ?? 0,
    currentPhase: status?.currentPhase ?? null,
    lastEventAt: status?.lastEventAt ?? null,
    lastEvent: status?.lastEvent
      ? {
          ok: Boolean(status.lastEvent.ok),
          action: result.action ?? null,
          gatewayAttempts: result.gatewayAttempts ?? status.lastEvent.gatewayAttempts ?? [],
          error: status.lastEvent.error ?? null,
          activeSession: sanitizeSession(online.activeSession),
          loginStatus: online.loginStatus ?? null,
          serviceState: online.serviceState ?? null,
          officialUiRepair: summarizeOfficialUiRepair(result),
        }
      : null,
    lastError: status?.lastError ?? null,
  };
}

export function summarizeAutostartResult(result) {
  return {
    ok: Boolean(result?.ok),
    started: Boolean(result?.started),
    reason: result?.reason ?? null,
    error: result?.error ?? null,
    status: result?.status ? summarizeMaintainerStatus(result.status) : null,
  };
}

export function getMaintainerOnline(status) {
  const result = status?.lastEvent?.result ?? {};
  return getResultOnline(result);
}

export function assertMaintainerOnline(status, label) {
  if (!status?.lastEvent?.ok) {
    const error = new Error(`${label} maintainer cycle failed: ${status?.lastError ?? "unknown"}`);
    error.status = status;
    throw error;
  }

  const online = getMaintainerOnline(status);
  if (online?.loginStatus?.status !== "1") {
    const error = new Error(`${label} maintainer cycle did not report online login status`);
    error.status = status;
    throw error;
  }

  const repairAction = online?.officialUiRepair?.action;
  if (![
    "already-consistent",
    "repair-official-ui",
    "restore-unreachable-official-ui",
    "restore-hidden-service-target",
    "restore-missing-service-target",
    "repair-error",
  ].includes(repairAction)) {
    const error = new Error(`${label} maintainer cycle did not exercise official UI repair`);
    error.status = status;
    throw error;
  }

  return status;
}

export function assertMaintainerRecoveredFromOffline(status, label) {
  assertMaintainerOnline(status, label);

  const result = status?.lastEvent?.result ?? {};
  if (!result.action || result.action === "already-online") {
    const error = new Error(`${label} maintainer cycle did not report a real recovery action`);
    error.status = status;
    throw error;
  }

  const online = getMaintainerOnline(status);
  const serviceState = online?.serviceState ?? {};
  if (serviceState.base !== "18" || serviceState.l3vpn !== "18" || serviceState.tcp !== "43") {
    const error = new Error(`${label} maintainer cycle did not report healthy VPN services`);
    error.status = status;
    throw error;
  }

  if (online?.officialUiRepair?.action === "repair-error") {
    const error = new Error(`${label} maintainer cycle left official UI repair in error state`);
    error.status = status;
    throw error;
  }

  return status;
}

export function assertMaintainerFailure(status, label) {
  if (status?.lastEvent?.ok) {
    const error = new Error(`${label} maintainer cycle unexpectedly succeeded`);
    error.status = status;
    throw error;
  }

  if (!Array.isArray(status?.lastEvent?.gatewayAttempts) || status.lastEvent.gatewayAttempts.length === 0) {
    const error = new Error(`${label} maintainer cycle did not report gateway attempts`);
    error.status = status;
    throw error;
  }

  return status;
}

export function assertNoPersistedGateways(config, invalidGateways = [], label) {
  const invalid = new Set(invalidGateways.map(normalizeGateway).filter(Boolean));
  const signature = getGatewayConfigSignature(config);
  const persisted = [signature.lastKnownGateway, ...signature.gateways].filter((gateway) => invalid.has(gateway));

  if (persisted.length > 0) {
    const error = new Error(`${label} persisted invalid gateway: ${persisted[0]}`);
    error.config = config;
    throw error;
  }

  return config;
}

export function assertGatewayConfigUnchanged(beforeConfig, afterConfig, label) {
  const before = getGatewayConfigSignature(beforeConfig);
  const after = getGatewayConfigSignature(afterConfig);

  if (JSON.stringify(before) !== JSON.stringify(after)) {
    const error = new Error(`${label} gateway config changed unexpectedly`);
    error.before = before;
    error.after = after;
    throw error;
  }

  return afterConfig;
}
