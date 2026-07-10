import test from "node:test";
import assert from "node:assert/strict";

import {
  CookieJar,
  PlatformApiClient,
  PlatformMutationBlockedError,
  bootstrapReleaseConsoleSession,
  buildBuildImagesPayload,
  buildPlatformEnvelope,
  buildReleasePublishAppsPayload,
  buildStopBuildImagesPayload,
  extractRows,
  getBuildServices,
  getReleasePublishOverview,
  isMutationEndpoint,
  loginBuildPlatform,
  sha256Hex,
} from "../src/services/platform-api-client.js";

test("buildPlatformEnvelope matches the observed internal platform request shape", () => {
  const envelope = buildPlatformEnvelope({
    userId: "demo",
    pageSize: 15,
  });

  assert.deepEqual(envelope, {
    datatype: "json",
    i18n: "zh",
    params: JSON.stringify({
      userId: "demo",
      pageSize: 15,
    }),
    userInfo: {},
    userId: "demo",
    pageSize: 15,
  });
});

test("sha256Hex hashes platform passwords without storing plaintext", () => {
  assert.equal(
    sha256Hex("123456"),
    "8d969eef6ecad3c29a3a629280e686cf0c3f5d5a86aff3ca12020c923adc6c92",
  );
});

test("loginBuildPlatform posts hashed password and app id", async () => {
  const calls = [];
  const client = {
    async post(path, params) {
      calls.push({ path, params });
      return {
        ok: true,
        status: 201,
        body: {
          data: {
            token: "token-1",
          },
        },
        cookieCount: 1,
      };
    },
  };

  const result = await loginBuildPlatform(client, {
    username: "demo-user",
    password: "demo-password",
  });

  assert.equal(result.userId, "demo-user");
  assert.equal(result.token, "token-1");
  assert.deepEqual(calls, [
    {
      path: "/api/authority/login",
      params: {
        account: "demo-user",
        password: sha256Hex("demo-password"),
        appId: "OPS0001",
      },
    },
  ]);
});

test("PlatformApiClient blocks known mutation endpoints by default", async () => {
  const client = new PlatformApiClient({
    baseUrl: "https://example.test",
    fetchImpl: async () => {
      throw new Error("mutation endpoint should not reach fetch");
    },
  });

  await assert.rejects(
    () => client.post("/api/support/buildImages", {}),
    PlatformMutationBlockedError,
  );
  assert.equal(isMutationEndpoint("/api/support/buildImages"), true);
  assert.equal(isMutationEndpoint("/api/support/stopBuildImages"), true);
  assert.equal(isMutationEndpoint("/api/cloud/publishApps"), true);
  assert.equal(isMutationEndpoint("/api/cloud/delPublish"), true);
  assert.equal(isMutationEndpoint("/api/cloud/publishOverviewList"), false);
  assert.equal(isMutationEndpoint("/api/cloud/getPublishRecordsPage"), false);
});

test("buildBuildImagesPayload matches current build-platform bundle shape", () => {
  assert.deepEqual(
    buildBuildImagesPayload({
      customerNameEn: "bj-bj-gamyy",
      applicationCode: "hlwyy",
      applicationName: "hlwyy",
      userId: "gamyy",
      codeBranch: "develop",
      kubernetesVersion: "",
      service: {
        imageJenkinsName: "prescriweb-hlwyy-ewell-develop",
      },
    }),
    {
      customerNameEn: "bj-bj-gamyy",
      applicationCode: "hlwyy",
      applicationName: "hlwyy",
      buildPerId: "gamyy",
      codeBranch: "develop",
      buildImages: [
        {
          imageJenkinsName: "prescriweb-hlwyy-ewell-develop",
          applicationCode: "hlwyy",
        },
      ],
      kubernetesVersion: "",
    },
  );
});

test("buildStopBuildImagesPayload matches current stop-build bundle shape", () => {
  assert.deepEqual(
    buildStopBuildImagesPayload({
      customerNameEn: "bj-bj-gamyy",
      applicationName: "hlwyy",
      codeBranch: "develop",
      imageJenkinsName: "prescriweb-hlwyy-ewell-develop",
      buildNum: -1,
    }),
    {
      customerNameEn: "bj-bj-gamyy",
      applicationName: "hlwyy",
      codeBranch: "develop",
      imageJenkinsName: "prescriweb-hlwyy-ewell-develop",
      buildNum: -1,
    },
  );
});

test("buildReleasePublishAppsPayload matches current release-platform bundle shape", () => {
  assert.deepEqual(
    buildReleasePublishAppsPayload({
      userId: "gamyy",
      customerNameEn: "bj-bj-gamyy",
      showNameEn: "prodgamyy",
      environment: "company",
      environmentFlag: "a",
      applicationCode: "ops",
      applicationVersion: "1.1.65",
    }),
    {
      userId: "gamyy",
      customerNameEn: "bj-bj-gamyy",
      showNameEn: "prodgamyy",
      environment: "company",
      environmentFlag: "a",
      publishApps: [
        {
          applicationCode: "ops",
          applicationVersion: "1.1.65",
        },
      ],
    },
  );
});

test("PlatformApiClient reports a clear runtime error when fetch is unavailable", async () => {
  const originalFetch = globalThis.fetch;
  try {
    delete globalThis.fetch;
    const client = new PlatformApiClient({
      baseUrl: "https://example.test",
    });

    await assert.rejects(
      () => client.post("/api/support/myApplicationListPage", {}),
      /requires a fetch implementation/,
    );
  } finally {
    if (originalFetch) {
      globalThis.fetch = originalFetch;
    }
  }
});

test("PlatformApiClient sends the observed envelope through fetch", async () => {
  const calls = [];
  const client = new PlatformApiClient({
    baseUrl: "https://example.test",
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return {
        ok: true,
        status: 201,
        headers: {
          getSetCookie() {
            return ["SESSION=abc; Path=/; HttpOnly"];
          },
        },
        async text() {
          return JSON.stringify({
            data: {
              rows: [{ appName: "门诊" }],
            },
          });
        },
      };
    },
  });

  const result = await client.post("/api/support/myApplicationListPage", {
    userId: "demo",
  });

  assert.equal(result.ok, true);
  assert.equal(result.cookieCount, 1);
  assert.equal(calls[0].url, "https://example.test/api/support/myApplicationListPage");
  assert.deepEqual(JSON.parse(calls[0].options.body), buildPlatformEnvelope({ userId: "demo" }));
});

test("bootstrapReleaseConsoleSession opens cloud console with login token and captures cookies", async () => {
  const calls = [];
  const client = new PlatformApiClient({
    baseUrl: "https://cloudweb.think-go.com",
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return {
        ok: true,
        status: 200,
        headers: {
          getSetCookie() {
            return ["CLOUDSESSION=abc; Path=/; HttpOnly"];
          },
        },
        async text() {
          return "<html></html>";
        },
      };
    },
  });

  const result = await bootstrapReleaseConsoleSession(client, "token value");

  assert.equal(result.ok, true);
  assert.equal(result.cookieCount, 1);
  assert.equal(calls[0].url, "https://cloud.think-go.com/control/pubManage?loginToken=token%20value");
  assert.equal(calls[0].options.method, "GET");
});

test("read-only build service and release overview helpers send verified request fields", async () => {
  const calls = [];
  const client = {
    async post(path, params) {
      calls.push({ path, params });
      return { ok: true, status: 201, body: { object: [] }, cookieCount: 1 };
    },
  };

  await getBuildServices(client, {
    userId: "gamyy",
    customerNameEn: "bj-bj-gamyy",
    applicationCode: "hlwyy",
    codeBranch: "develop",
    pageNumber: 1,
    pageSize: 15,
  });
  await getReleasePublishOverview(client, {
    userId: "gamyy",
    customerNameEn: "bj-bj-gamyy",
  });

  assert.deepEqual(calls, [
    {
      path: "/api/support/selectPublishMicroServiceInfo",
      params: {
        userId: "gamyy",
        imageJenkinsName: "",
        customerNameEn: "bj-bj-gamyy",
        applicationCode: "hlwyy",
        codeBranch: "develop",
        pageNumber: 1,
        pageSize: 15,
      },
    },
    {
      path: "https://cloud.think-go.com/api/cloud/publishOverviewList",
      params: {
        userId: "gamyy",
        customerNameEn: "bj-bj-gamyy",
      },
    },
  ]);
});

test("CookieJar captures response cookies for follow-up API requests", () => {
  const jar = new CookieJar();
  const headers = {
    getSetCookie() {
      return [
        "SESSION=abc; Path=/; HttpOnly",
        "theme=light; Path=/",
      ];
    },
  };

  jar.capture(headers);

  assert.equal(jar.count(), 2);
  assert.match(jar.header(), /SESSION=abc/);
  assert.match(jar.header(), /theme=light/);
});

test("extractRows finds nested table records from platform-shaped responses", () => {
  const rows = extractRows({
    code: 0,
    data: {
      page: {
        rows: [
          {
            appName: "门诊",
            appCode: "mem",
          },
        ],
      },
    },
  });

  assert.deepEqual(rows, [
    {
      appName: "门诊",
      appCode: "mem",
    },
  ]);
});
