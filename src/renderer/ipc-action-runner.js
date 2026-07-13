export const IPC_TIMEOUT_MS = Object.freeze({
  quick: 10000,
  normal: 30000,
  recovery: 180000,
});

function createTimeoutError(operationLabel, timeoutMs) {
  const error = new Error(`${operationLabel}超时（${timeoutMs}ms）`);
  error.code = "WORKBENCH_IPC_TIMEOUT";
  error.operationLabel = operationLabel;
  error.timeoutMs = timeoutMs;
  return error;
}

export function runIpcAction(operationLabel, operation, options = {}) {
  const timeoutMs = options.timeoutMs ?? IPC_TIMEOUT_MS.normal;
  const setTimeoutFn = options.setTimeoutFn ?? globalThis.setTimeout.bind(globalThis);
  const clearTimeoutFn = options.clearTimeoutFn ?? globalThis.clearTimeout.bind(globalThis);
  let timer = null;

  const operationPromise = Promise.resolve().then(operation);
  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeoutFn(() => reject(createTimeoutError(operationLabel, timeoutMs)), timeoutMs);
  });

  return Promise.race([operationPromise, timeoutPromise]).finally(() => {
    if (timer !== null) {
      clearTimeoutFn(timer);
    }
  });
}
