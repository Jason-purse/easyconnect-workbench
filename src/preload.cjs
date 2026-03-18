const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("workbench", {
  getConfig: () => ipcRenderer.invoke("config:get"),
  saveConfig: (config) => ipcRenderer.invoke("config:save", config),
  getVpnStatus: () => ipcRenderer.invoke("vpn:status"),
  getEnvironmentInfo: () => ipcRenderer.invoke("vpn:info"),
  launchOfficialClient: (payload) => ipcRenderer.invoke("vpn:launch-user", payload),
  recoverOfficialClient: (payload) => ipcRenderer.invoke("vpn:recover-user", payload),
  getDebugTargets: (payload) => ipcRenderer.invoke("vpn:debug-targets", payload),
  portalLogin: (payload) => ipcRenderer.invoke("vpn:portal-login", payload),
  recoverAndLogin: (payload) => ipcRenderer.invoke("vpn:recover-login", payload),
  openLogsDir: () => ipcRenderer.invoke("app:open-logs"),
  openConfigDir: () => ipcRenderer.invoke("app:open-config-dir"),
});
