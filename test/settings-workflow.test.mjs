import test from "node:test";
import assert from "node:assert/strict";

import { persistSettingsAndRefresh } from "../src/renderer/settings-workflow.js";

test("persistSettingsAndRefresh keeps a successful save successful when refresh fails", async () => {
  const calls = [];
  const refreshError = new Error("status refresh timed out");

  const result = await persistSettingsAndRefresh({
    save: async () => {
      calls.push("save");
      return { vpn: { username: "demo" } };
    },
    afterSave: async () => {
      calls.push("afterSave");
    },
    refresh: async () => {
      calls.push("refresh");
      throw refreshError;
    },
  });

  assert.deepEqual(calls, ["save", "afterSave", "refresh"]);
  assert.deepEqual(result.saved, { vpn: { username: "demo" } });
  assert.equal(result.refreshError, refreshError);
});

test("persistSettingsAndRefresh rejects real save failures and skips refresh", async () => {
  const calls = [];
  const saveError = new Error("disk write failed");

  await assert.rejects(
    persistSettingsAndRefresh({
      save: async () => {
        calls.push("save");
        throw saveError;
      },
      afterSave: async () => {
        calls.push("afterSave");
      },
      refresh: async () => {
        calls.push("refresh");
      },
    }),
    saveError,
  );
  assert.deepEqual(calls, ["save"]);
});
