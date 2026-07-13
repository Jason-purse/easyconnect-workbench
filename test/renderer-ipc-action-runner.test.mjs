import test from "node:test";
import assert from "node:assert/strict";

import { IPC_TIMEOUT_MS, runIpcAction } from "../src/renderer/ipc-action-runner.js";

function createDeferred() {
  let resolve;
  const promise = new Promise((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}

test("IPC action runner preserves a successful result and clears its timer", async () => {
  let timerCallback;
  let clearCount = 0;
  const result = await runIpcAction(
    "读取设置",
    () => Promise.resolve({ ok: true }),
    {
      timeoutMs: IPC_TIMEOUT_MS.quick,
      setTimeoutFn: (callback) => {
        timerCallback = callback;
        return "timer-token";
      },
      clearTimeoutFn: (token) => {
        assert.equal(token, "timer-token");
        clearCount += 1;
      },
    },
  );

  assert.deepEqual(result, { ok: true });
  assert.equal(typeof timerCallback, "function");
  assert.equal(clearCount, 1);
});

test("IPC action runner preserves the original operation error", async () => {
  const operationError = new Error("gateway unavailable");
  await assert.rejects(
    runIpcAction("探测恢复链路", () => Promise.reject(operationError), {
      timeoutMs: IPC_TIMEOUT_MS.quick,
    }),
    (error) => error === operationError,
  );
});

test("IPC action runner rejects a timeout with a typed operation label", async () => {
  const deferred = createDeferred();
  let timerCallback;
  let clearCount = 0;
  const pending = runIpcAction("恢复 VPN 连接", () => deferred.promise, {
    timeoutMs: IPC_TIMEOUT_MS.recovery,
    setTimeoutFn: (callback) => {
      timerCallback = callback;
      return "timeout-token";
    },
    clearTimeoutFn: (token) => {
      assert.equal(token, "timeout-token");
      clearCount += 1;
    },
  });

  timerCallback();
  await assert.rejects(pending, (error) => {
    assert.equal(error.code, "WORKBENCH_IPC_TIMEOUT");
    assert.match(error.message, /恢复 VPN 连接/);
    return true;
  });
  assert.equal(clearCount, 1);
});
