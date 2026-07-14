import test from "node:test";
import assert from "node:assert/strict";

function createDeferred() {
  let resolve;
  let reject;
  const promise = new Promise((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
}

test("before-quit shutdown waits for maintainer and VPN action drainage", async () => {
  const shutdownModule = await import("../src/services/app-shutdown.js").catch(() => ({}));
  assert.equal(typeof shutdownModule.createBeforeQuitHandler, "function");

  const stopDeferred = createDeferred();
  const drainDeferred = createDeferred();
  const calls = [];
  const handler = shutdownModule.createBeforeQuitHandler({
    onPrepare() {
      calls.push("prepare");
    },
    stopMaintainer() {
      calls.push("stop-maintainer");
      return stopDeferred.promise;
    },
    drainActions() {
      calls.push("drain-actions");
      return drainDeferred.promise;
    },
    quit() {
      calls.push("quit");
    },
  });
  const createEvent = (label) => ({
    preventDefault() {
      calls.push(`prevent-${label}`);
    },
  });

  const first = handler(createEvent("first"));
  const duplicate = handler(createEvent("duplicate"));

  assert.strictEqual(duplicate, first);
  assert.deepEqual(calls, [
    "prevent-first",
    "prepare",
    "stop-maintainer",
    "drain-actions",
    "prevent-duplicate",
  ]);

  stopDeferred.resolve();
  await Promise.resolve();
  assert.equal(calls.includes("quit"), false);

  drainDeferred.resolve();
  await first;
  assert.equal(calls.at(-1), "quit");

  const completed = handler(createEvent("completed"));
  assert.equal(completed, undefined);
  assert.equal(calls.includes("prevent-completed"), false);
  assert.equal(calls.filter((item) => item === "quit").length, 1);
});

test("before-quit defers the final quit request beyond the cancelled event turn", async () => {
  const shutdownModule = await import("../src/services/app-shutdown.js");
  const scheduled = [];
  const calls = [];
  const handler = shutdownModule.createBeforeQuitHandler({
    stopMaintainer() {
      calls.push("stop-maintainer");
    },
    drainActions() {
      calls.push("drain-actions");
    },
    scheduleQuit(callback) {
      scheduled.push(callback);
    },
    quit() {
      calls.push("quit");
    },
  });

  const shutdown = handler({
    preventDefault() {
      calls.push("prevent");
    },
  });

  await Promise.resolve();
  await Promise.resolve();

  assert.deepEqual(calls, ["prevent", "stop-maintainer", "drain-actions"]);
  assert.equal(scheduled.length, 1);

  scheduled[0]();
  await shutdown;
  assert.equal(calls.at(-1), "quit");
});
