function startShutdownTask(task) {
  try {
    return Promise.resolve(task?.());
  } catch (error) {
    return Promise.reject(error);
  }
}

function scheduleShutdownTask(schedule, task) {
  return new Promise((resolve, reject) => {
    schedule(() => {
      try {
        resolve(task());
      } catch (error) {
        reject(error);
      }
    });
  });
}

export function createBeforeQuitHandler({
  onPrepare = () => {},
  stopMaintainer = () => {},
  drainActions = () => {},
  scheduleQuit = setImmediate,
  quit,
  logger = console,
} = {}) {
  if (typeof quit !== "function") {
    throw new Error("createBeforeQuitHandler requires quit");
  }

  let shutdownComplete = false;
  let shutdownPromise = null;

  return function handleBeforeQuit(event) {
    if (shutdownComplete) {
      return undefined;
    }

    event?.preventDefault?.();
    if (shutdownPromise) {
      return shutdownPromise;
    }

    onPrepare();
    shutdownPromise = Promise.allSettled([
      startShutdownTask(stopMaintainer),
      startShutdownTask(drainActions),
    ]).then((results) => {
      for (const result of results) {
        if (result.status === "rejected") {
          logger?.error?.("application shutdown task failed", result.reason);
        }
      }

      shutdownComplete = true;
      // Let the cancelled native quit event unwind before asking Electron to quit again.
      return scheduleShutdownTask(scheduleQuit, quit);
    });

    return shutdownPromise;
  };
}
