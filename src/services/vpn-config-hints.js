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

function includesGateway(gateways, gateway) {
  return gateways.some((item) => sameGateway(item, gateway));
}

function getAllowedHintGateways(config = {}, gateways = []) {
  const configuredGateways = getConfiguredGateways(config);
  if (configuredGateways.length === 0) {
    return gateways;
  }

  return gateways.filter((gateway) => includesGateway(configuredGateways, gateway));
}

function getAllowedGateway(config = {}, gateway) {
  const normalized = normalizeGateway(gateway);
  return getAllowedHintGateways(config, normalized ? [normalized] : [])[0] ?? null;
}

function mergeGateways(currentGateways = [], discoveredGateways = []) {
  const merged = [];

  for (const gateway of [...currentGateways, ...discoveredGateways]) {
    const normalized = normalizeGateway(gateway);
    if (!normalized) {
      continue;
    }

    if (!merged.some((item) => sameGateway(item, normalized))) {
      merged.push(normalized);
    }
  }

  return merged;
}

export function applySnapshotHints(config = {}, snapshot = {}) {
  const activeSession = snapshot?.status?.activeSession;
  const gatewayCandidates = getAllowedHintGateways(
    config,
    (snapshot?.environmentInfo?.gatewayCandidates ?? []).map(normalizeGateway).filter(Boolean),
  );

  if (gatewayCandidates.length === 0) {
    return config;
  }

  const discoveredGateway = normalizeGateway(gatewayCandidates[0]);
  if (!discoveredGateway) {
    return config;
  }

  const mergedGateways = mergeGateways(config?.vpn?.gateways ?? [], gatewayCandidates);
  const currentGateway = getAllowedGateway(config, config?.vpn?.lastKnownGateway);
  if (!activeSession) {
    const nextGateway = currentGateway ?? discoveredGateway;
    const gatewaysChanged = JSON.stringify(mergedGateways) !== JSON.stringify(config?.vpn?.gateways ?? []);

    if (sameGateway(currentGateway, nextGateway) && !gatewaysChanged) {
      return config;
    }

    return {
      ...config,
      vpn: {
        ...(config?.vpn ?? {}),
        gateways: mergedGateways,
        lastKnownGateway: nextGateway,
      },
    };
  }

  if (sameGateway(currentGateway, discoveredGateway)) {
    if (JSON.stringify(mergedGateways) === JSON.stringify(config?.vpn?.gateways ?? [])) {
      return config;
    }

    return {
      ...config,
      vpn: {
        ...(config?.vpn ?? {}),
        gateways: mergedGateways,
      },
    };
  }

  return {
    ...config,
    vpn: {
      ...(config?.vpn ?? {}),
      gateways: mergeGateways(config?.vpn?.gateways ?? [], gatewayCandidates),
      lastKnownGateway: discoveredGateway,
    },
  };
}

export function applyGatewaySelectionHint(config = {}, gateway) {
  const selectedGateway = normalizeGateway(gateway);
  if (!selectedGateway) {
    return config;
  }
  if (getAllowedHintGateways(config, [selectedGateway]).length === 0) {
    return config;
  }

  const currentGateway = getAllowedGateway(config, config?.vpn?.lastKnownGateway);
  const mergedGateways = mergeGateways(config?.vpn?.gateways ?? [], [selectedGateway]);
  const gatewaysChanged = JSON.stringify(mergedGateways) !== JSON.stringify(config?.vpn?.gateways ?? []);

  if (sameGateway(currentGateway, selectedGateway) && !gatewaysChanged) {
    return config;
  }

  return {
    ...config,
    vpn: {
      ...(config?.vpn ?? {}),
      gateways: mergedGateways,
      lastKnownGateway: selectedGateway,
    },
  };
}

export function applyProbeHints(config = {}, probeResults = []) {
  const allowedProbeResults = getAllowedHintGateways(
    config,
    probeResults.map(normalizeGateway).filter(Boolean),
  );
  const reachableGateways = probeResults
    .filter((item) => item.reachable)
    .filter((item) => includesGateway(allowedProbeResults, item))
    .map((item) => ({
      host: item.host,
      port: item.port,
    }));

  const mergedGateways = mergeGateways(config?.vpn?.gateways ?? [], reachableGateways);
  const currentGateway = getAllowedGateway(config, config?.vpn?.lastKnownGateway);
  const recommendedGateway = probeResults
    .filter((item) => includesGateway(allowedProbeResults, item))
    .find((item) => item.recommended);
  const currentGatewayResult =
    currentGateway &&
    probeResults.find((item) => item.host === currentGateway.host && item.port === currentGateway.port);

  const nextGateway =
    !currentGateway
      ? normalizeGateway(recommendedGateway)
      : currentGatewayResult?.reachable === false && recommendedGateway
        ? normalizeGateway(recommendedGateway)
        : currentGateway;

  if (
    JSON.stringify(mergedGateways) === JSON.stringify(config?.vpn?.gateways ?? []) &&
    JSON.stringify(nextGateway) === JSON.stringify(currentGateway)
  ) {
    return config;
  }

  return {
    ...config,
    vpn: {
      ...(config?.vpn ?? {}),
      gateways: mergedGateways,
      lastKnownGateway: nextGateway,
    },
  };
}
