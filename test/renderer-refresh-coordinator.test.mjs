import test from "node:test";
import assert from "node:assert/strict";

function createDeferred() {
  let resolve;
  const promise = new Promise((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}

test("renderer refresh coordinator commits and returns a completed request", async () => {
  let coordinatorModule = null;
  try {
    coordinatorModule = await import("../src/renderer/refresh-coordinator.js");
  } catch {
    // The first TDD cycle proves the project does not own this renderer boundary yet.
  }

  assert.equal(typeof coordinatorModule?.createLatestRequestCoordinator, "function");

  const commits = [];
  const runLatest = coordinatorModule.createLatestRequestCoordinator();
  const result = await runLatest(
    async () => "request-a",
    (value) => commits.push(value),
  );

  assert.equal(result, "request-a");
  assert.deepEqual(commits, ["request-a"]);
});

test("renderer refresh coordinator lets only the newest request commit", async () => {
  const { createLatestRequestCoordinator } = await import(
    "../src/renderer/refresh-coordinator.js"
  );
  const runLatest = createLatestRequestCoordinator();
  const requestA = createDeferred();
  const requestB = createDeferred();
  const commits = [];

  const resultA = runLatest(() => requestA.promise, (value) => commits.push(value));
  const resultB = runLatest(() => requestB.promise, (value) => commits.push(value));

  requestB.resolve("request-b");
  assert.equal(await resultB, "request-b");
  requestA.resolve("request-a");
  assert.equal(await resultA, "request-a");
  assert.deepEqual(commits, ["request-b"]);
});
