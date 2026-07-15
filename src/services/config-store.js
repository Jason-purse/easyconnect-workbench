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
    maintainerQuietHoursEnabled: true,
    maintainerQuietStart: "18:30",
    maintainerQuietEnd: "09:00",
    dataPlaneProbeTarget: "",
    dataPlaneProbeTimeoutMs: 5000,
    lastKnownGateway: null,
    appExecutable: "/Applications/EasyConnect.app/Contents/MacOS/EasyConnect",
    gateways: [],
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
      maintainerQuietHoursEnabled: Boolean(
        incoming?.vpn?.maintainerQuietHoursEnabled ?? base.vpn.maintainerQuietHoursEnabled,
      ),
      maintainerQuietStart: `${incoming?.vpn?.maintainerQuietStart ?? base.vpn.maintainerQuietStart ?? "18:30"}`.trim() || "18:30",
      maintainerQuietEnd: `${incoming?.vpn?.maintainerQuietEnd ?? base.vpn.maintainerQuietEnd ?? "09:00"}`.trim() || "09:00",
      dataPlaneProbeTarget: `${incoming?.vpn?.dataPlaneProbeTarget ?? base.vpn.dataPlaneProbeTarget ?? ""}`.trim(),
      dataPlaneProbeTimeoutMs:
        Number.parseInt(`${incoming?.vpn?.dataPlaneProbeTimeoutMs ?? base.vpn.dataPlaneProbeTimeoutMs ?? 5000}`, 10) ||
        5000,
      lastKnownGateway: normalizeGateway(
        shouldPreserveLearnedGateways
          ? base.vpn.lastKnownGateway
          : incoming?.vpn?.lastKnownGateway ?? base.vpn.lastKnownGateway,
      ),
      appExecutable: `${incoming?.vpn?.appExecutable ?? base.vpn.appExecutable ?? ""}`.trim(),
      gateways: shouldPreserveLearnedGateways ? baseGateways : normalizeGateways(incoming?.vpn?.gateways ?? base.vpn.gateways),
    },
  };
}

function cloneConfig(value) {
  return JSON.parse(JSON.stringify(value));
}

export class ConfigStore {
  constructor(userDataPath) {
    this.filePath = path.join(userDataPath, "config.json");
    this.writeQueue = Promise.resolve();
  }

  async loadFromDisk() {
    try {
      const raw = await readFile(this.filePath, "utf8");
      return mergeConfig(DEFAULT_CONFIG, JSON.parse(raw));
    } catch {
      return cloneConfig(DEFAULT_CONFIG);
    }
  }

  async persist(config) {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    await writeFile(this.filePath, JSON.stringify(config, null, 2), "utf8");
  }

  enqueueWrite(operation) {
    const pending = this.writeQueue.then(operation, operation);
    this.writeQueue = pending.then(
      () => undefined,
      () => undefined,
    );
    return pending;
  }

  async load() {
    await this.writeQueue;
    return this.loadFromDisk();
  }

  save(nextConfig) {
    return this.enqueueWrite(async () => {
      const current = await this.loadFromDisk();
      const merged = mergeConfig(current, nextConfig);
      await this.persist(merged);
      return merged;
    });
  }

  update(updater) {
    if (typeof updater !== "function") {
      throw new TypeError("ConfigStore.update requires an updater function");
    }

    return this.enqueueWrite(async () => {
      const current = await this.loadFromDisk();
      const nextConfig = await updater(current);
      if (nextConfig === current) {
        return current;
      }

      const merged = mergeConfig(current, nextConfig);
      await this.persist(merged);
      return merged;
    });
  }
}

export { DEFAULT_CONFIG };
