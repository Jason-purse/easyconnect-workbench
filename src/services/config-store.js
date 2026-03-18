import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const DEFAULT_CONFIG = {
  vpn: {
    username: "",
    password: "",
    remoteDebugPort: 9222,
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

function mergeConfig(base, incoming) {
  return {
    vpn: {
      ...base.vpn,
      ...(incoming?.vpn ?? {}),
      appExecutable: `${incoming?.vpn?.appExecutable ?? base.vpn.appExecutable ?? ""}`.trim(),
      gateways: normalizeGateways(incoming?.vpn?.gateways ?? base.vpn.gateways),
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

export class ConfigStore {
  constructor(userDataPath) {
    this.filePath = path.join(userDataPath, "config.json");
  }

  async load() {
    try {
      const raw = await readFile(this.filePath, "utf8");
      return mergeConfig(DEFAULT_CONFIG, JSON.parse(raw));
    } catch {
      return structuredClone(DEFAULT_CONFIG);
    }
  }

  async save(nextConfig) {
    const merged = mergeConfig(DEFAULT_CONFIG, nextConfig);
    await mkdir(path.dirname(this.filePath), { recursive: true });
    await writeFile(this.filePath, JSON.stringify(merged, null, 2), "utf8");
    return merged;
  }
}

export { DEFAULT_CONFIG };
