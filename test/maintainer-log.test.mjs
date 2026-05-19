import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile, rm } from "node:fs/promises";

import {
  createMaintainerLogger,
  redactMaintainerEvent,
} from "../src/services/maintainer-log.js";

test("redactMaintainerEvent removes credentials, tokens, cookies, and raw exchange bodies", () => {
  const redacted = redactMaintainerEvent({
    event: "cycle",
    username: "demo-user",
    password: "secret-password",
    activeSession: {
      token: "secret-token",
      sessionId: "session-1",
    },
    response: {
      headers: {
        "set-cookie": "TWFID=secret",
        twfid: "secret",
      },
      body: "<xml>secret</xml>",
    },
    gatewayAttempts: [
      {
        gateway: "198.51.100.20:9898",
        ok: false,
        error: "Timed out waiting for online login status",
      },
    ],
  });

  assert.equal(redacted.username, "demo-user");
  assert.equal(redacted.password, undefined);
  assert.equal(redacted.activeSession.token, undefined);
  assert.equal(redacted.response.headers["set-cookie"], undefined);
  assert.equal(redacted.response.headers.twfid, undefined);
  assert.equal(redacted.response.body, undefined);
  assert.deepEqual(redacted.gatewayAttempts, [
    {
      gateway: "198.51.100.20:9898",
      ok: false,
      error: "Timed out waiting for online login status",
    },
  ]);
});

test("createMaintainerLogger writes redacted JSONL events", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "easyconnect-maintainer-log-"));

  try {
    const logger = createMaintainerLogger(tempDir, {
      clock: () => "2026-05-07T09:25:00.000Z",
    });

    await logger.write("cycle-failed", {
      password: "secret-password",
      token: "secret-token",
      gateway: {
        host: "198.51.100.20",
        port: 9898,
      },
    });

    const text = await readFile(logger.filePath, "utf8");
    const lines = text.trim().split("\n");
    assert.equal(lines.length, 1);

    const event = JSON.parse(lines[0]);
    assert.equal(event.timestamp, "2026-05-07T09:25:00.000Z");
    assert.equal(event.event, "cycle-failed");
    assert.equal(event.password, undefined);
    assert.equal(event.token, undefined);
    assert.deepEqual(event.gateway, {
      host: "198.51.100.20",
      port: 9898,
    });
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
