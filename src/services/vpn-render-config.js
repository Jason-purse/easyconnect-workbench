export function mergeConfigForRender(currentConfig = {}, storedConfig = {}) {
  const currentVpn = currentConfig?.vpn ?? {};
  const storedVpn = storedConfig?.vpn ?? {};

  return {
    app: {
      ...(storedConfig?.app ?? {}),
      ...(currentConfig?.app ?? {}),
    },
    vpn: {
      ...storedVpn,
      ...currentVpn,
      gateways:
        Array.isArray(currentVpn.gateways) && currentVpn.gateways.length > 0
          ? currentVpn.gateways
          : storedVpn.gateways ?? [],
      lastKnownGateway: storedVpn.lastKnownGateway ?? currentVpn.lastKnownGateway ?? null,
    },
  };
}
