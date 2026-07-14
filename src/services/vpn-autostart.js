import { getQuietHoursState } from "./vpn-maintainer.js";

const QUIET_HOURS_RESUME_RETRY_MS = 30 * 1000;

export function getMaintainerStatusWithQuietHours({ config = {}, status = {}, nowMs = Date.now() } = {}) {
  return {
    ...status,
    quietHours: getQuietHoursState(config, nowMs),
  };
}

export function createVpnSmokeConfig(config = {}, vpnOverrides = {}, { ignoreQuietHours = false } = {}) {
  return {
    ...config,
    vpn: {
      ...(config.vpn ?? {}),
      ...vpnOverrides,
      ...(ignoreQuietHours ? { maintainerQuietHoursEnabled: false } : {}),
    },
  };
}

export async function startMaintainerWithQuietHoursGuard({
  config = {},
  vpnMaintainer,
  gatewayCandidates = [],
  nowMs = Date.now(),
} = {}) {
  if (!vpnMaintainer) {
    throw new Error("startMaintainerWithQuietHoursGuard requires vpnMaintainer");
  }

  const currentStatus = getMaintainerStatusWithQuietHours({
    config,
    status: vpnMaintainer.getStatus?.() ?? {},
    nowMs,
  });
  if (currentStatus.quietHours.active) {
    return {
      ...currentStatus,
      startSuppressed: true,
    };
  }

  const status = await vpnMaintainer.start(config, { gatewayCandidates });
  return getMaintainerStatusWithQuietHours({ config, status, nowMs });
}

function scheduleQuietHoursResume(callback, delayMs) {
  const timer = setTimeout(() => {
    void callback();
  }, delayMs);
  timer.unref?.();
  return timer;
}

export async function maybeStartMaintainerAutoStart({
  configStore,
  vpnMaintainer,
  gatewayCandidates = [],
  ignoreQuietHours = false,
  nowFn = () => Date.now(),
  scheduleFn = scheduleQuietHoursResume,
  logger = console,
} = {}) {
  if (!configStore) {
    throw new Error("maybeStartMaintainerAutoStart requires configStore");
  }

  if (!vpnMaintainer) {
    throw new Error("maybeStartMaintainerAutoStart requires vpnMaintainer");
  }

  const config = await configStore.load();
  if (!config?.vpn?.maintainerAutoStart) {
    return {
      ok: true,
      started: false,
      reason: "disabled",
    };
  }

  const quietHours = getQuietHoursState(config, nowFn());
  if (quietHours.active && !ignoreQuietHours) {
    const resume = async () => {
      try {
        const result = await maybeStartMaintainerAutoStart({
          configStore,
          vpnMaintainer,
          gatewayCandidates,
          nowFn,
          scheduleFn,
          logger,
        });
        if (
          result?.code === "EASYCONNECT_VPN_ACTION_IN_PROGRESS" &&
          typeof scheduleFn === "function"
        ) {
          scheduleFn(resume, QUIET_HOURS_RESUME_RETRY_MS);
        }
        return result;
      } catch (error) {
        logger?.warn?.("maintainer quiet-hours resume failed", error);
        return null;
      }
    };
    const scheduledResume = typeof scheduleFn === "function";
    if (scheduledResume) {
      scheduleFn(resume, quietHours.nextIntervalMs);
    }

    return {
      ok: true,
      started: false,
      reason: "quiet-hours",
      scheduledResume,
      nextStartMs: quietHours.nextIntervalMs,
      quietHours: {
        start: quietHours.start,
        end: quietHours.end,
        nowLocal: quietHours.nowLocal,
        resumeAt: quietHours.resumeAt,
      },
    };
  }

  const currentStatus = vpnMaintainer.getStatus?.();
  if (currentStatus?.running) {
    return {
      ok: true,
      started: false,
      reason: "already-running",
      status: currentStatus,
    };
  }

  const startConfig = ignoreQuietHours
    ? createVpnSmokeConfig(config, {}, { ignoreQuietHours: true })
    : config;

  try {
    const status = await vpnMaintainer.start(startConfig, { gatewayCandidates });

    return {
      ok: true,
      started: true,
      status,
    };
  } catch (error) {
    logger?.warn?.("maintainer auto-start failed", error);
    return {
      ok: false,
      started: false,
      error: error?.message ?? String(error),
      ...(error?.code ? { code: error.code } : {}),
      ...(error?.activeKey ? { activeKey: error.activeKey } : {}),
    };
  }
}
