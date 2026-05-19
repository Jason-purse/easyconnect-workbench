function isOnlineStatus(loginStatus) {
  return loginStatus?.status === "1";
}

function needsCaptcha(passwordConfig) {
  return passwordConfig?.summary?.useRandCode && passwordConfig.summary.useRandCode !== "0";
}

function createAbortError() {
  const error = new Error("Operation aborted");
  error.name = "AbortError";
  return error;
}

function createCycleTimeoutError(timeoutMs) {
  const error = new Error(`Maintainer cycle timed out after ${timeoutMs}ms`);
  error.name = "MaintainerCycleTimeoutError";
  error.code = "MAINTAINER_CYCLE_TIMEOUT";
  return error;
}

function throwIfAborted(signal) {
  if (signal?.aborted) {
    throw createAbortError();
  }
}

export async function ensureOnline(options) {
  const {
    runtime,
    gatewayLogin,
    gatewayHost,
    gatewayPort,
    username,
    password,
    captcha = "",
    signal,
    onPhase,
  } = options ?? {};

  if (!runtime) {
    throw new Error("ensureOnline requires runtime");
  }

  if (!gatewayLogin) {
    throw new Error("ensureOnline requires gatewayLogin");
  }

  if (!gatewayHost || !gatewayPort) {
    throw new Error("ensureOnline requires gatewayHost and gatewayPort");
  }

  if (!username || !password) {
    throw new Error("ensureOnline requires username and password");
  }

  throwIfAborted(signal);
  const activeSession = await runtime.describeActiveSession();
  if (activeSession?.token) {
    try {
      const [loginStatus, serviceState] = await Promise.all([
        runtime.getLoginStatus(activeSession.token),
        runtime.getServiceState(activeSession.token),
      ]);

      if (isOnlineStatus(loginStatus)) {
        return {
          action: "already-online",
          activeSession,
          loginStatus,
          serviceState,
        };
      }
    } catch {
      // Fall through to a fresh login when the active session is stale.
    }
  }

  throwIfAborted(signal);
  const auth = await gatewayLogin.loginAuth();
  throwIfAborted(signal);
  const passwordConfig = await gatewayLogin.passwordConfig(auth.cookie);

  if (needsCaptcha(passwordConfig) && !captcha) {
    throw new Error("Gateway requires captcha; automatic password login is blocked");
  }

  const relogin = await runtime.recoverLoginViaPageBridge({
    gatewayLogin,
    gatewayHost,
    gatewayPort,
    username,
    password,
    captcha,
    ...(onPhase ? { onPhase } : {}),
    ...(signal ? { signal } : {}),
  });

  return {
    action: "relogin-page-bridge",
    auth,
    passwordConfig,
    recovery: relogin.recovery,
    loginSummary: relogin.loginSummary,
    bridge: relogin.bridge,
    coreServices: relogin.coreServices,
    serviceReload: relogin.serviceReload,
    online: relogin.online,
  };
}

function delay(ms, signal) {
  if (signal?.aborted) {
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    const timer = setTimeout(finish, ms);

    function cleanup() {
      clearTimeout(timer);
      signal?.removeEventListener?.("abort", finish);
    }

    function finish() {
      cleanup();
      resolve();
    }

    signal?.addEventListener?.("abort", finish, { once: true });
  });
}

async function runCycleWithTimeout(operation, { signal, timeoutMs } = {}) {
  if (!timeoutMs || timeoutMs <= 0) {
    return operation(signal);
  }

  throwIfAborted(signal);

  const cycleController = new AbortController();
  let settleAbort = null;
  let timeout = null;
  const abortPromise = new Promise((_resolve, reject) => {
    settleAbort = reject;
  });
  const timeoutPromise = new Promise((_resolve, reject) => {
    timeout = setTimeout(() => {
      const timeoutError = createCycleTimeoutError(timeoutMs);
      cycleController.abort(timeoutError);
      reject(timeoutError);
    }, timeoutMs);
  });
  const operationPromise = Promise.resolve()
    .then(() => operation(cycleController.signal))
    .finally(() => clearTimeout(timeout));

  function abortCycle() {
    const abortError = createAbortError();
    cycleController.abort(abortError);
    settleAbort?.(abortError);
  }

  signal?.addEventListener?.("abort", abortCycle, { once: true });

  try {
    return await Promise.race([operationPromise, timeoutPromise, abortPromise]);
  } finally {
    clearTimeout(timeout);
    operationPromise.catch(() => {});
    signal?.removeEventListener?.("abort", abortCycle);
  }
}

export async function maintainOnline(options) {
  const {
    signal,
    intervalMs = 5 * 60 * 1000,
    cycleTimeoutMs = 0,
    ensureOnlineFn = ensureOnline,
    sleep = delay,
    onCycle = async () => {},
  } = options ?? {};

  while (!signal?.aborted) {
    let nextIntervalMs = intervalMs;

    try {
      const result = await runCycleWithTimeout(
        (cycleSignal) =>
          ensureOnlineFn({
            ...options,
            signal: cycleSignal,
          }),
        {
          signal,
          timeoutMs: cycleTimeoutMs,
        },
      );
      const cycleControl = await onCycle({
        ok: true,
        result,
      });
      if (Number.isFinite(cycleControl?.nextIntervalMs) && cycleControl.nextIntervalMs > 0) {
        nextIntervalMs = cycleControl.nextIntervalMs;
      }
    } catch (error) {
      if (signal?.aborted && error?.name === "AbortError") {
        return;
      }

      const cycleControl = await onCycle({
        ok: false,
        error,
      });
      if (Number.isFinite(cycleControl?.nextIntervalMs) && cycleControl.nextIntervalMs > 0) {
        nextIntervalMs = cycleControl.nextIntervalMs;
      }
    }

    if (signal?.aborted) {
      return;
    }

    await sleep(nextIntervalMs, signal);
  }
}
