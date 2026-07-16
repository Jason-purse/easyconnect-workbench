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

export async function drainShutdownTasks(tasks = []) {
  if (!Array.isArray(tasks) || tasks.some((task) => typeof task !== "function")) {
    throw new Error("drainShutdownTasks requires an array of functions");
  }

  const results = await Promise.allSettled(tasks.map(startShutdownTask));
  const errors = results
    .filter((result) => result.status === "rejected")
    .map((result) => result.reason);
  if (errors.length === 1) {
    throw errors[0];
  }
  if (errors.length > 1) {
    throw new AggregateError(errors, "Application shutdown drainage failed");
  }
}

export function createRelaunchOnce({ relaunch, args = [] } = {}) {
  if (typeof relaunch !== "function") {
    throw new Error("createRelaunchOnce requires relaunch");
  }

  let scheduled = false;
  return function scheduleRelaunch() {
    if (scheduled) {
      return false;
    }
    scheduled = true;
    try {
      relaunch({ args: [...args] });
      return true;
    } catch (error) {
      scheduled = false;
      throw error;
    }
  };
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
    ]).then(async (results) => {
      for (const result of results) {
        if (result.status === "rejected") {
          logger?.error?.("application shutdown task failed", result.reason);
        }
      }

      try {
        await startShutdownTask(stopMaintainer);
      } catch (error) {
        logger?.error?.("application final maintainer stop failed", error);
      }

      shutdownComplete = true;
      // Let the cancelled native quit event unwind before asking Electron to quit again.
      return scheduleShutdownTask(scheduleQuit, quit);
    });

    return shutdownPromise;
  };
}
