const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("workbench", {
  getConfig: () => ipcRenderer.invoke("config:get"),
  saveConfig: (config) => ipcRenderer.invoke("config:save", config),
  getVpnSnapshot: (payload) => ipcRenderer.invoke("vpn:snapshot", payload),
  getVpnStatus: () => ipcRenderer.invoke("vpn:status"),
  getEnvironmentInfo: () => ipcRenderer.invoke("vpn:info"),
  getRecoveryPlan: (payload) => ipcRenderer.invoke("vpn:recovery-plan", payload),
  probeRecoveryPlan: (payload) => ipcRenderer.invoke("vpn:probe-recovery", payload),
  launchOfficialClient: (payload) => ipcRenderer.invoke("vpn:launch-user", payload),
  recoverOfficialClient: (payload) => ipcRenderer.invoke("vpn:recover-user", payload),
  getDebugTargets: (payload) => ipcRenderer.invoke("vpn:debug-targets", payload),
  portalLogin: (payload) => ipcRenderer.invoke("vpn:portal-login", payload),
  recoverAndLogin: (payload) => ipcRenderer.invoke("vpn:recover-login", payload),
  repairOfficialUi: (payload) => ipcRenderer.invoke("vpn:repair-official-ui", payload),
  getMaintainerStatus: () => ipcRenderer.invoke("vpn:maintainer-status"),
  startMaintainer: (payload) => ipcRenderer.invoke("vpn:maintainer-start", payload),
  stopMaintainer: () => ipcRenderer.invoke("vpn:maintainer-stop"),
  getBuildPlatformOverview: (payload) => ipcRenderer.invoke("platform:build-overview", payload),
  getReleasePlatformOverview: (payload) => ipcRenderer.invoke("platform:release-overview", payload),
  openLogsDir: () => ipcRenderer.invoke("app:open-logs"),
  openConfigDir: () => ipcRenderer.invoke("app:open-config-dir"),
});
