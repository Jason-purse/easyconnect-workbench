import { getQuietHoursState } from "./vpn-maintainer.js";

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
  if (quietHours.active) {
    const resume = async () => {
      try {
        await maybeStartMaintainerAutoStart({
          configStore,
          vpnMaintainer,
          gatewayCandidates,
          nowFn,
          scheduleFn,
          logger,
        });
      } catch (error) {
        logger?.warn?.("maintainer quiet-hours resume failed", error);
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

  try {
    const status = await vpnMaintainer.start(config, { gatewayCandidates });

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
    };
  }
}
