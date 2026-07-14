import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { createVpnActionGuard } from "../src/services/vpn-action-guard.js";

function createDeferred() {
  let resolve;
  let reject;
  const promise = new Promise((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
}

test("VPN action guard returns the active promise for a duplicate key", async () => {
  const guard = createVpnActionGuard();
  const deferred = createDeferred();
  let calls = 0;
  const operation = () => {
    calls += 1;
    return deferred.promise;
  };

  const first = guard.run("recover-login", operation);
  const duplicate = guard.run("recover-login", operation);
  assert.strictEqual(duplicate, first);
  assert.equal(calls, 1);

  deferred.resolve({ ok: true });
  assert.deepEqual(await first, { ok: true });
});

test("VPN action guard rejects a different key with the active key", async () => {
  const guard = createVpnActionGuard();
  const deferred = createDeferred();
  const active = guard.run("recover-login", () => deferred.promise);

  await assert.rejects(
    guard.run("maintainer-stop", () => ({ ok: true })),
    (error) => {
      assert.equal(error.code, "EASYCONNECT_VPN_ACTION_IN_PROGRESS");
      assert.equal(error.activeKey, "recover-login");
      assert.match(error.message, /recover-login/);
      return true;
    },
  );

  deferred.resolve({ ok: true });
  await active;
});

test("VPN action guard clears after both resolved and rejected actions", async () => {
  const guard = createVpnActionGuard();
  assert.deepEqual(await guard.run("launch-client", () => ({ action: "launched" })), {
    action: "launched",
  });
  await assert.rejects(guard.run("portal-login", () => Promise.reject(new Error("login failed"))));
  assert.deepEqual(await guard.run("maintainer-start", () => ({ running: true })), { running: true });
});

test("VPN action guard keeps a shared scope locked until every scoped operation settles", async () => {
  const guard = createVpnActionGuard();
  const startDeferred = createDeferred();
  const cycleDeferred = createDeferred();
  let cycleCalls = 0;

  const start = guard.run("maintainer-start", () => startDeferred.promise, {
    scope: "maintainer",
  });
  const cycle = guard.run(
    "maintainer-cycle",
    () => {
      cycleCalls += 1;
      return cycleDeferred.promise;
    },
    {
      scope: "maintainer",
      allowWith: ["maintainer-start"],
    },
  );

  try {
    await Promise.resolve();
    assert.equal(cycleCalls, 1);
    await assert.rejects(
      guard.run("recover-login", () => ({ ok: true })),
      (error) => {
        assert.equal(error.code, "EASYCONNECT_VPN_ACTION_IN_PROGRESS");
        assert.equal(error.activeKey, "maintainer-cycle");
        return true;
      },
    );

    startDeferred.resolve({ running: true });
    await start;
    await assert.rejects(
      guard.run("repair-official-ui", () => ({ ok: true })),
      (error) => {
        assert.equal(error.activeKey, "maintainer-cycle");
        return true;
      },
    );

    cycleDeferred.resolve({ action: "already-online" });
    assert.deepEqual(await cycle, { action: "already-online" });
    assert.deepEqual(await guard.run("recover-login", () => ({ ok: true })), { ok: true });
  } finally {
    startDeferred.resolve({ running: true });
    cycleDeferred.resolve({ action: "already-online" });
    await Promise.allSettled([start, cycle]);
  }
});

test("VPN action guard rejects incompatible operations inside the same scope", async () => {
  const guard = createVpnActionGuard();
  const startDeferred = createDeferred();
  const start = guard.run("maintainer-start", () => startDeferred.promise, {
    scope: "maintainer",
  });
  let stopCalls = 0;

  try {
    await assert.rejects(
      guard.run(
        "maintainer-stop",
        () => {
          stopCalls += 1;
          return { running: false };
        },
        { scope: "maintainer" },
      ),
      (error) => {
        assert.equal(error.code, "EASYCONNECT_VPN_ACTION_IN_PROGRESS");
        assert.equal(error.activeKey, "maintainer-start");
        return true;
      },
    );
    assert.equal(stopCalls, 0);
  } finally {
    startDeferred.resolve({ running: true });
    await start;
  }
});

test("VPN action guard drain rejects new work and waits for active actions", async () => {
  const guard = createVpnActionGuard();
  const deferred = createDeferred();
  const active = guard.run("recover-login", () => deferred.promise);

  const drain = guard.drain();
  let drained = false;
  void drain.then(() => {
    drained = true;
  });
  await Promise.resolve();

  assert.equal(drained, false);
  await assert.rejects(
    guard.run("repair-official-ui", () => ({ ok: true })),
    (error) => {
      assert.equal(error.code, "EASYCONNECT_VPN_ACTION_DRAINING");
      return true;
    },
  );

  deferred.resolve({ ok: true });
  assert.deepEqual(await active, { ok: true });
  await drain;
  assert.equal(drained, true);
});

test("main process routes every mutating IPC and tray entry point through the VPN guard", async () => {
  const source = await readFile("src/main.js", "utf8");
  for (const key of [
    "launch-official-client",
    "recover-official-client",
    "portal-login",
    "recover-login",
    "repair-official-ui",
  ]) {
    assert.match(source, new RegExp(`runVpnAction\\([\\s\\S]{0,180}\\"${key}\\"`), key);
  }

  const readonlySource = source.slice(source.indexOf('ipcMain.handle("vpn:snapshot"'), source.indexOf('ipcMain.handle("vpn:probe-recovery"'));
  assert.doesNotMatch(readonlySource, /runVpnAction/);
  for (const key of ["maintainer-start", "maintainer-stop"]) {
    assert.match(source, new RegExp(`runMaintainerAction\\([\\s\\S]{0,180}\\"${key}\\"`), key);
  }
  assert.match(source, /scope:\s*"maintainer"/);
  assert.match(source, /allowWith/);
  assert.match(source, /"maintainer-initialize":\s*\["maintainer-start"\]/);
  assert.match(source, /actionRunner:\s*runMaintainerAction/);
});
