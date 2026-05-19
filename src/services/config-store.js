import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const DEFAULT_CONFIG = {
  app: {
    launchAtLogin: false,
  },
  vpn: {
    username: "",
    password: "",
    remoteDebugPort: 9222,
    maintainerAutoStart: false,
    maintainerIntervalSeconds: 300,
    maintainerCycleTimeoutMs: 180000,
    lastKnownGateway: null,
    appExecutable: "/Applications/EasyConnect.app/Contents/MacOS/EasyConnect",
    gateways: [],
  },
  portals: {
    build: {
      url: "",
      username: "",
      password: "",
    },
    release: {
      url: "",
      username: "",
      password: "",
    },
  },
};

function normalizeGateways(gateways) {
  if (!Array.isArray(gateways)) {
    return [];
  }

  return gateways
    .map((item) => ({
      host: `${item?.host ?? ""}`.trim(),
      port: Number.parseInt(`${item?.port ?? ""}`, 10) || "",
    }))
    .filter((item) => item.host || item.port);
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

function mergeConfig(base, incoming) {
  const incomingGateways = normalizeGateways(incoming?.vpn?.gateways);
  const baseGateways = normalizeGateways(base.vpn.gateways);
  const shouldPreserveLearnedGateways =
    Array.isArray(incoming?.vpn?.gateways) && incomingGateways.length === 0 && baseGateways.length > 0;

  return {
    app: {
      ...base.app,
      ...(incoming?.app ?? {}),
      launchAtLogin: Boolean(incoming?.app?.launchAtLogin ?? base.app.launchAtLogin),
    },
    vpn: {
      ...base.vpn,
      ...(incoming?.vpn ?? {}),
      maintainerAutoStart: Boolean(incoming?.vpn?.maintainerAutoStart ?? base.vpn.maintainerAutoStart),
      maintainerIntervalSeconds:
        Number.parseInt(`${incoming?.vpn?.maintainerIntervalSeconds ?? base.vpn.maintainerIntervalSeconds ?? 300}`, 10) ||
        300,
      maintainerCycleTimeoutMs:
        Number.parseInt(`${incoming?.vpn?.maintainerCycleTimeoutMs ?? base.vpn.maintainerCycleTimeoutMs ?? 180000}`, 10) ||
        180000,
      lastKnownGateway: normalizeGateway(
        shouldPreserveLearnedGateways
          ? base.vpn.lastKnownGateway
          : incoming?.vpn?.lastKnownGateway ?? base.vpn.lastKnownGateway,
      ),
      appExecutable: `${incoming?.vpn?.appExecutable ?? base.vpn.appExecutable ?? ""}`.trim(),
      gateways: shouldPreserveLearnedGateways ? baseGateways : normalizeGateways(incoming?.vpn?.gateways ?? base.vpn.gateways),
    },
    portals: {
      build: {
        ...base.portals.build,
        ...(incoming?.portals?.build ?? {}),
      },
      release: {
        ...base.portals.release,
        ...(incoming?.portals?.release ?? {}),
      },
    },
  };
}

function cloneConfig(value) {
  return JSON.parse(JSON.stringify(value));
}

export class ConfigStore {
  constructor(userDataPath) {
    this.filePath = path.join(userDataPath, "config.json");
  }

  async load() {
    try {
      const raw = await readFile(this.filePath, "utf8");
      return mergeConfig(DEFAULT_CONFIG, JSON.parse(raw));
    } catch {
      return cloneConfig(DEFAULT_CONFIG);
    }
  }

  async save(nextConfig) {
    const current = await this.load();
    const merged = mergeConfig(current, nextConfig);
    await mkdir(path.dirname(this.filePath), { recursive: true });
    await writeFile(this.filePath, JSON.stringify(merged, null, 2), "utf8");
    return merged;
  }
}

export { DEFAULT_CONFIG };
