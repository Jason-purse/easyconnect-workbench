import path from "node:path";
import { fileURLToPath } from "node:url";
import { app, BrowserWindow, ipcMain, shell } from "electron";
import { ConfigStore } from "./services/config-store.js";
import { VpnService } from "./services/vpn-service.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let mainWindow = null;
let configStore = null;
let vpnService = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 1080,
    minHeight: 760,
    title: "EasyConnect Workbench",
    backgroundColor: "#f4efe6",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, "renderer", "index.html"));
}

function registerIpc() {
  ipcMain.handle("config:get", async () => configStore.load());

  ipcMain.handle("config:save", async (_event, nextConfig) => configStore.save(nextConfig));

  ipcMain.handle("vpn:status", async () => vpnService.getStatus(await configStore.load()));
  ipcMain.handle("vpn:info", async () => vpnService.getEnvironmentInfo(await configStore.load()));

  ipcMain.handle("vpn:launch-user", async (_event, payload = {}) => {
    const nextPayload = typeof payload === "number" ? { remoteDebugPort: payload } : payload;
    return vpnService.launchOfficialClient(await configStore.load(), {
      remoteDebugPort: nextPayload.remoteDebugPort ?? null,
    });
  });

  ipcMain.handle("vpn:recover-user", async (_event, payload = {}) => {
    const nextPayload = typeof payload === "number" ? { remoteDebugPort: payload } : payload;
    return vpnService.recoverOfficialClient(await configStore.load(), {
      remoteDebugPort: nextPayload.remoteDebugPort ?? null,
    });
  });

  ipcMain.handle("vpn:debug-targets", async (_event, payload = {}) =>
    vpnService.getDebugTargets(await configStore.load(), payload.remoteDebugPort ?? 9222),
  );

  ipcMain.handle("vpn:portal-login", async (_event, payload = {}) =>
    vpnService.portalLogin(
      await configStore.load(),
      payload.username ?? "",
      payload.password ?? "",
      payload.remoteDebugPort ?? 9222,
    ),
  );

  ipcMain.handle("vpn:recover-login", async (_event, payload = {}) =>
    vpnService.recoverAndLogin(
      await configStore.load(),
      payload.username ?? "",
      payload.password ?? "",
      payload.remoteDebugPort ?? 9222,
    ),
  );

  ipcMain.handle("app:open-logs", async () => {
    const info = await vpnService.getEnvironmentInfo(await configStore.load());
    return shell.openPath(info.logsDir);
  });

  ipcMain.handle("app:open-config-dir", async () => shell.openPath(app.getPath("userData")));
}

app.whenReady().then(() => {
  configStore = new ConfigStore(app.getPath("userData"));
  vpnService = new VpnService();
  registerIpc();
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
