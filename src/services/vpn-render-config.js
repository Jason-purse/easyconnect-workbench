export function mergeConfigForRender(currentConfig = {}, storedConfig = {}) {
  const currentVpn = currentConfig?.vpn ?? {};
  const storedVpn = storedConfig?.vpn ?? {};

  return {
    ...storedConfig,
    ...currentConfig,
    vpn: {
      ...storedVpn,
      ...currentVpn,
      gateways:
        Array.isArray(currentVpn.gateways) && currentVpn.gateways.length > 0
          ? currentVpn.gateways
          : storedVpn.gateways ?? [],
      lastKnownGateway: storedVpn.lastKnownGateway ?? currentVpn.lastKnownGateway ?? null,
    },
    portals: {
      ...(storedConfig?.portals ?? {}),
      ...(currentConfig?.portals ?? {}),
    },
  };
}
