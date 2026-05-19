import test from "node:test";
import assert from "node:assert/strict";

import { mergeConfigForRender } from "../src/services/vpn-render-config.js";

test("mergeConfigForRender prefers current form values but keeps learned gateway hints", () => {
  const merged = mergeConfigForRender(
    {
      vpn: {
        username: "demo-user",
        password: "secret",
        appExecutable: "/custom/EasyConnect",
        gateways: [],
      },
    },
    {
      vpn: {
        username: "old-user",
        password: "old-secret",
        appExecutable: "/old/EasyConnect",
        gateways: [{ host: "203.0.113.10", port: 9898 }],
        lastKnownGateway: { host: "203.0.113.10", port: 9898 },
      },
    },
  );

  assert.equal(merged.vpn.username, "demo-user");
  assert.equal(merged.vpn.password, "secret");
  assert.equal(merged.vpn.appExecutable, "/custom/EasyConnect");
  assert.deepEqual(merged.vpn.gateways, [{ host: "203.0.113.10", port: 9898 }]);
  assert.deepEqual(merged.vpn.lastKnownGateway, { host: "203.0.113.10", port: 9898 });
});

test("mergeConfigForRender keeps current gateway list when the user has typed one", () => {
  const merged = mergeConfigForRender(
    {
      vpn: {
        gateways: [{ host: "198.51.100.20", port: 9898 }],
      },
    },
    {
      vpn: {
        gateways: [{ host: "203.0.113.10", port: 9898 }],
        lastKnownGateway: { host: "203.0.113.10", port: 9898 },
      },
    },
  );

  assert.deepEqual(merged.vpn.gateways, [{ host: "198.51.100.20", port: 9898 }]);
  assert.deepEqual(merged.vpn.lastKnownGateway, { host: "203.0.113.10", port: 9898 });
});
