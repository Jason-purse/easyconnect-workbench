export async function maybeStartMaintainerAutoStart({
  configStore,
  vpnMaintainer,
  gatewayCandidates = [],
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
