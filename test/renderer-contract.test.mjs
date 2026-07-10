import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const requiredIds = [
  "view-overview",
  "view-activity",
  "settings-drawer",
  "open-settings",
  "close-settings",
  "connection-primary-action",
  "maintainer-action",
  "recent-activity-list",
  "activity-list",
  "action-notice",
  "vpn-quiet-hours-enabled",
  "vpn-quiet-start",
  "vpn-quiet-end",
];

test("renderer exposes the VPN-only status-center structure", async () => {
  const html = await readFile("src/renderer/index.html", "utf8");
  for (const id of requiredIds) {
    assert.match(html, new RegExp(`id=["']${id}["']`), `missing #${id}`);
  }
  assert.doesNotMatch(html, /app-sidebar|build-portal|release-portal|Adapters/);
});

test("renderer behavior has no toast overlay or renderer-owned autostart", async () => {
  const source = await readFile("src/renderer/app.js", "utf8");
  assert.doesNotMatch(source, /showToast|toastTimer/);
  assert.doesNotMatch(source, /自动守护自启动/);
  assert.match(source, /deriveConnectionView/);
  assert.match(source, /deriveMaintainerView/);
});
