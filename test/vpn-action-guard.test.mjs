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

test("main process routes every mutating IPC and tray entry point through the VPN guard", async () => {
  const source = await readFile("src/main.js", "utf8");
  for (const key of [
    "launch-official-client",
    "recover-official-client",
    "portal-login",
    "recover-login",
    "repair-official-ui",
    "maintainer-start",
    "maintainer-stop",
  ]) {
    assert.match(source, new RegExp(`runVpnAction\\([\\s\\S]{0,180}\\"${key}\\"`), key);
  }

  const readonlySource = source.slice(source.indexOf('ipcMain.handle("vpn:snapshot"'), source.indexOf('ipcMain.handle("vpn:probe-recovery"'));
  assert.doesNotMatch(readonlySource, /runVpnAction/);
});
