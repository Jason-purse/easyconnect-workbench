export function createVpnActionGuard() {
  let activeScope = null;
  let drainPromise = null;
  let draining = false;

  function getActiveKey(scopeState) {
    return Array.from(scopeState.operations.keys()).at(-1) ?? null;
  }

  function runInScope(scopeState, key, operation) {
    let resolveAction;
    let rejectAction;
    const promise = new Promise((resolve, reject) => {
      resolveAction = resolve;
      rejectAction = reject;
    });
    scopeState.operations.set(key, promise);

    try {
      resolveAction(operation());
    } catch (error) {
      rejectAction(error);
    }

    const clear = () => {
      if (activeScope !== scopeState || scopeState.operations.get(key) !== promise) {
        return;
      }

      scopeState.operations.delete(key);
      if (scopeState.operations.size === 0) {
        activeScope = null;
      }
    };
    promise.then(clear, clear);
    return promise;
  }

  return {
    run(key, operation, options = {}) {
      if (draining) {
        const error = new Error("VPN actions are draining for application shutdown");
        error.code = "EASYCONNECT_VPN_ACTION_DRAINING";
        error.requestedKey = key;
        return Promise.reject(error);
      }

      const scope = options.scope ?? key;
      if (activeScope) {
        const duplicate = activeScope.operations.get(key);
        if (duplicate) {
          return duplicate;
        }

        const allowedActiveKeys = new Set(options.allowWith ?? []);
        const canJoinScope =
          activeScope.name === scope &&
          Array.from(activeScope.operations.keys()).every((activeKey) => allowedActiveKeys.has(activeKey));
        if (!canJoinScope) {
          const activeKey = getActiveKey(activeScope);
          const error = new Error(`VPN action ${activeKey} is already in progress`);
          error.code = "EASYCONNECT_VPN_ACTION_IN_PROGRESS";
          error.activeKey = activeKey;
          error.requestedKey = key;
          return Promise.reject(error);
        }

        return runInScope(activeScope, key, operation);
      }

      const scopeState = {
        name: scope,
        operations: new Map(),
      };
      activeScope = scopeState;
      return runInScope(scopeState, key, operation);
    },
    drain() {
      if (drainPromise) {
        return drainPromise;
      }

      draining = true;
      const activePromises = activeScope ? Array.from(activeScope.operations.values()) : [];
      drainPromise = Promise.allSettled(activePromises).then(() => undefined);
      return drainPromise;
    },
  };
}
