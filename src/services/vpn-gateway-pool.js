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

function getConfiguredGateways(config) {
  const gateways = config?.vpn?.gateways ?? [];
  return gateways.map(normalizeGateway).filter(Boolean);
}

function getLastKnownGateway(config) {
  return normalizeGateway(config?.vpn?.lastKnownGateway ?? null);
}

function includesGateway(gateways, gateway) {
  return gateways.some((item) => sameGateway(item, gateway));
}

export function collectRecoveryGateways(config, providedGateways = [], discoveredGateways = []) {
  const configuredGateways = getConfiguredGateways(config);
  const hasAllowlist = configuredGateways.length > 0;
  const isAllowed = (gateway) => !hasAllowlist || includesGateway(configuredGateways, gateway);
  const candidates = [
    isAllowed(getLastKnownGateway(config)) ? getLastKnownGateway(config) : null,
    ...configuredGateways,
    ...providedGateways.map(normalizeGateway),
    ...discoveredGateways.map(normalizeGateway),
  ].filter((gateway) => gateway && isAllowed(gateway));

  return candidates.filter((gateway, index) => {
    return candidates.findIndex((item) => sameGateway(item, gateway)) === index;
  });
}

export function buildRecoveryPlan(config, providedGateways = [], discoveredGateways = []) {
  const configuredGateways = getConfiguredGateways(config);
  const hasAllowlist = configuredGateways.length > 0;
  const isAllowed = (gateway) => !hasAllowlist || includesGateway(configuredGateways, gateway);
  const labeled = [
    { gateway: getLastKnownGateway(config), source: "lastKnown" },
    ...configuredGateways.map((gateway) => ({ gateway, source: "configured" })),
    ...providedGateways.map((gateway) => ({ gateway: normalizeGateway(gateway), source: "snapshot" })),
    ...discoveredGateways.map((gateway) => ({ gateway: normalizeGateway(gateway), source: "discovered" })),
  ].filter((item) => item.gateway && isAllowed(item.gateway));

  const gateways = labeled.filter((item, index) => {
    return labeled.findIndex((entry) => sameGateway(entry.gateway, item.gateway)) === index;
  });

  return {
    gateways: gateways.map((item) => ({
      ...item.gateway,
      source: item.source,
    })),
    fallback: "portal-debug",
  };
}
