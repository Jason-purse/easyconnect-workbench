export function createVpnActionGuard() {
  let active = null;

  return {
    run(key, operation) {
      if (active) {
        if (active.key === key) {
          return active.promise;
        }

        const error = new Error(`VPN action ${active.key} is already in progress`);
        error.code = "EASYCONNECT_VPN_ACTION_IN_PROGRESS";
        error.activeKey = active.key;
        error.requestedKey = key;
        return Promise.reject(error);
      }

      let resolveAction;
      let rejectAction;
      const promise = new Promise((resolve, reject) => {
        resolveAction = resolve;
        rejectAction = reject;
      });
      active = { key, promise };

      try {
        resolveAction(operation());
      } catch (error) {
        rejectAction(error);
      }

      const clear = () => {
        if (active?.promise === promise) {
          active = null;
        }
      };
      promise.then(clear, clear);
      return promise;
    },
  };
}
