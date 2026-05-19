const DEFAULT_ONLINE_WAIT_MS = 10000;
const DEFAULT_ONLINE_POLL_MS = 500;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function cloneWithoutSecrets(value) {
  const next = JSON.parse(JSON.stringify(value ?? null));
  redactSecrets(next);
  return next;
}

function redactSecrets(value) {
  if (!value || typeof value !== "object") {
    return;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      redactSecrets(item);
    }
    return;
  }

  for (const key of Object.keys(value)) {
    if (key === "token") {
      delete value[key];
      continue;
    }
    redactSecrets(value[key]);
  }
}

function assertOnline(snapshot = {}) {
  const status = snapshot.status ?? {};
  if (status.loginStatus?.status === "1" && status.activeSession?.sessionId) {
    return status;
  }

  throw new Error("Official UI repair smoke requires VPN to be online; it will not trigger login.");
}

async function waitForOnlineSnapshot(vpnService, config, { onlineWaitMs, onlinePollMs }) {
  const startedAt = Date.now();
  let attempts = 0;
  let snapshot = null;

  while (true) {
    attempts += 1;
    snapshot = await vpnService.getSnapshot(config);
    const status = snapshot?.status ?? {};
    if (status.loginStatus?.status === "1" && status.activeSession?.sessionId) {
      return {
        snapshot,
        status,
        attempts,
      };
    }

    const elapsedMs = Date.now() - startedAt;
    if (elapsedMs >= onlineWaitMs) {
      break;
    }

    await sleep(Math.min(onlinePollMs, onlineWaitMs - elapsedMs));
  }

  assertOnline(snapshot);
}

function summarizeExistingBlockingTarget(status = {}) {
  const target = status.officialUi?.primaryTarget ?? null;
  if (!status.officialUi?.hasBlockingVisibleTarget || !target) {
    return null;
  }

  return {
    action: "use-existing-blocking-target",
    target: {
      kind: target.kind ?? null,
      title: target.title ?? "",
      url: target.url ?? "",
    },
  };
}

export async function runOfficialUiRepairSmoke({
  vpnService,
  config = {},
  remoteDebugPort = null,
  allowServiceTargetMutation = false,
  onlineWaitMs = DEFAULT_ONLINE_WAIT_MS,
  onlinePollMs = DEFAULT_ONLINE_POLL_MS,
} = {}) {
  if (!vpnService) {
    throw new Error("runOfficialUiRepairSmoke requires vpnService");
  }

  const effectiveRemoteDebugPort =
    remoteDebugPort ?? (Number.parseInt(`${config?.vpn?.remoteDebugPort ?? 9222}`, 10) || 9222);
  const online = await waitForOnlineSnapshot(vpnService, config, { onlineWaitMs, onlinePollMs });
  const status = online.status;
  let preparedTarget = await vpnService.prepareOfficialUiRepairSmokeTarget(config, {
    remoteDebugPort: effectiveRemoteDebugPort,
    allowServiceTargetMutation,
  });

  const repairPreparationActions = new Set(["prepared-test-target", "prepared-by-mutating-service-target"]);
  if (!repairPreparationActions.has(preparedTarget.action)) {
    const existingBlockingTarget = summarizeExistingBlockingTarget(status);
    if (!existingBlockingTarget) {
      return {
        action: "skip-no-test-target",
        reason: preparedTarget.reason ?? "No safe official UI test target could be created",
        preparedTarget,
        onlineProbeAttempts: online.attempts,
        loginStatus: status.loginStatus,
        serviceState: status.serviceState ?? null,
      };
    }

    preparedTarget = {
      ...existingBlockingTarget,
      prepareReason: preparedTarget.reason ?? null,
    };
  }

  const repair = cloneWithoutSecrets(
    await vpnService.repairOfficialUi(config, {
      remoteDebugPort: effectiveRemoteDebugPort,
    }),
  );

  if (repair?.action !== "repair-official-ui") {
    const error = new Error(`Official UI repair smoke expected repair-official-ui, got ${repair?.action ?? "unknown"}`);
    error.repair = repair;
    throw error;
  }

  return {
    action: "repair-official-ui-smoke",
    preparedTarget,
    repair,
    onlineProbeAttempts: online.attempts,
    loginStatus: status.loginStatus,
    serviceState: status.serviceState ?? null,
  };
}
