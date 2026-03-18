import { EasyConnectRuntime } from "../../../easyconnect-runtime-poc/src/runtime.mjs";

function sanitizeSession(session) {
  if (!session) {
    return null;
  }

  return {
    ...session,
    token: undefined,
  };
}

function sanitizeSummary(summary) {
  const next = { ...summary };
  if (next.activeSession?.token) {
    next.activeSession = sanitizeSession(next.activeSession);
  }
  if (next.latestCachedToken?.token) {
    next.latestCachedToken = {
      ...next.latestCachedToken,
      token: undefined,
    };
  }
  return next;
}

export class VpnService {
  createRuntime(config = {}) {
    return new EasyConnectRuntime({
      appExecutable: config?.vpn?.appExecutable,
    });
  }

  async getStatus(config = {}) {
    const runtime = this.createRuntime(config);
    const session = await runtime.describeActiveSession();
    if (!session.token) {
      const latestCachedToken = await runtime.describeLatestCachedToken();
      return {
        activeSession: null,
        latestCachedToken: latestCachedToken.token
          ? { ...latestCachedToken, token: undefined }
          : latestCachedToken,
        loginStatus: null,
        serviceState: null,
        localRuntimeInfo: null,
      };
    }

    const [loginStatus, serviceState, localRuntimeInfo] = await Promise.all([
      runtime.getLoginStatus(session.token),
      runtime.getServiceState(session.token),
      runtime.getLocalRuntimeInfo(session.token),
    ]);

    return {
      activeSession: sanitizeSession(session),
      loginStatus,
      serviceState,
      localRuntimeInfo,
    };
  }

  async getEnvironmentInfo(config = {}) {
    const runtime = this.createRuntime(config);
    const summary = await runtime.getEnvironmentSummary();
    return sanitizeSummary(summary);
  }

  async launchOfficialClient(config = {}, options = {}) {
    const runtime = this.createRuntime(config);
    return runtime.launchMainAppUserMode(options);
  }

  async recoverOfficialClient(config = {}, options = {}) {
    const runtime = this.createRuntime(config);
    return runtime.recoverViaUserMode(options);
  }

  async getDebugTargets(config = {}, remoteDebugPort) {
    const runtime = this.createRuntime(config);
    return runtime.getRemoteDebugTargets(remoteDebugPort);
  }

  async portalLogin(config = {}, username, password, remoteDebugPort) {
    const runtime = this.createRuntime(config);
    return runtime.triggerPortalPasswordLogin({
      username,
      password,
      remoteDebugPort,
    });
  }

  async recoverAndLogin(config = {}, username, password, remoteDebugPort) {
    const runtime = this.createRuntime(config);
    const result = await runtime.recoverLoginViaUserDebug({
      username,
      password,
      remoteDebugPort,
    });

    if (result.online?.activeSession?.token) {
      result.online.activeSession = sanitizeSession(result.online.activeSession);
    }

    return result;
  }
}
