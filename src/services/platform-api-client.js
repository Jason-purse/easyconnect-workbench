import { createHash } from "node:crypto";

const DEFAULT_TIMEOUT_MS = 20000;
const DEFAULT_I18N = "zh";
const DEFAULT_DATATYPE = "json";
const BUILD_APP_ID = "OPS0001";

const SECRET_KEY_PATTERN = /pass|pwd|token|cookie|authorization|secret|session|twfid|jwt|ticket|credential/i;
const MUTATION_ENDPOINT_PATTERNS = [
  /\/api\/support\/buildImages\b/i,
  /\/api\/support\/stopBuildImages\b/i,
  /\/api\/support\/applyProdStruct\b/i,
  /\/api\/support\/commonImagesInstall\b/i,
  /\/api\/support\/testComplete\b/i,
  /\/api\/support\/confirmPublish\b/i,
  /\/api\/cloud\/publishApps\b/i,
  /\/api\/cloud\/delPublish\b/i,
  /\/api\/cloud\/saveEnvironmentInfo\b/i,
  /\/api\/cloud\/configEnvironmentStatus\b/i,
  /\/api\/cloud\/configEnvironmentAddress\b/i,
  /\/api\/cloud\/thirdAppAutoPackages\b/i,
  /\/api\/cloud\/.*(?:confirm|deploy|rollback|stop|start|build).*$/i,
];

function normalizeUrl(value, fallback = "") {
  const raw = `${value ?? ""}`.trim() || fallback;
  const withProtocol = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  const url = new URL(withProtocol);
  return url.origin;
}

function createAbortSignal(timeoutMs) {
  if (typeof AbortController === "undefined") {
    return {
      signal: undefined,
      clear: () => {},
    };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, timeoutMs);
  timer.unref?.();

  return {
    signal: controller.signal,
    clear: () => clearTimeout(timer),
  };
}

function splitSetCookieHeader(value) {
  if (!value) {
    return [];
  }

  return `${value}`.split(/,(?=\s*[^;,\s]+=)/g).map((item) => item.trim()).filter(Boolean);
}

function isObject(value) {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function getHeaderSetCookies(headers) {
  if (!headers) {
    return [];
  }

  if (typeof headers.getSetCookie === "function") {
    return headers.getSetCookie();
  }

  return splitSetCookieHeader(headers.get?.("set-cookie"));
}

function extractCookieValue(setCookie) {
  const firstPart = `${setCookie ?? ""}`.split(";")[0] ?? "";
  const separatorIndex = firstPart.indexOf("=");
  if (separatorIndex <= 0) {
    return null;
  }

  return {
    name: firstPart.slice(0, separatorIndex).trim(),
    value: firstPart.slice(separatorIndex + 1).trim(),
  };
}

function scrubString(value) {
  if (value.length > 240) {
    return `${value.slice(0, 240)}...[truncated]`;
  }

  return value;
}

function findFirstValue(value, keys, depth = 0) {
  if (value == null || depth > 5) {
    return null;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findFirstValue(item, keys, depth + 1);
      if (found != null) {
        return found;
      }
    }
    return null;
  }

  if (!isObject(value)) {
    return null;
  }

  for (const [key, item] of Object.entries(value)) {
    if (keys.includes(key) && item != null && typeof item !== "object") {
      return item;
    }
  }

  for (const item of Object.values(value)) {
    const found = findFirstValue(item, keys, depth + 1);
    if (found != null) {
      return found;
    }
  }

  return null;
}

function collectArrays(value, arrays = [], depth = 0) {
  if (value == null || depth > 6) {
    return arrays;
  }

  if (Array.isArray(value)) {
    arrays.push(value);
    for (const item of value.slice(0, 20)) {
      collectArrays(item, arrays, depth + 1);
    }
    return arrays;
  }

  if (isObject(value)) {
    for (const item of Object.values(value)) {
      collectArrays(item, arrays, depth + 1);
    }
  }

  return arrays;
}

function looksLikeApplicationRow(row) {
  if (!isObject(row)) {
    return false;
  }

  const keys = Object.keys(row).map((key) => key.toLowerCase());
  return keys.some((key) => key.includes("app") || key.includes("customer") || key.includes("name"));
}

function normalizePath(pathOrUrl) {
  if (/^https?:\/\//i.test(`${pathOrUrl}`)) {
    return `${pathOrUrl}`;
  }

  return `${pathOrUrl}`.startsWith("/") ? `${pathOrUrl}` : `/${pathOrUrl}`;
}

export class PlatformMutationBlockedError extends Error {
  constructor(endpoint) {
    super(`Mutation endpoint is blocked by default: ${endpoint}`);
    this.name = "PlatformMutationBlockedError";
    this.endpoint = endpoint;
  }
}

export class CookieJar {
  constructor() {
    this.cookies = new Map();
  }

  capture(headers) {
    for (const setCookie of getHeaderSetCookies(headers)) {
      const cookie = extractCookieValue(setCookie);
      if (cookie?.name) {
        this.cookies.set(cookie.name, cookie.value);
      }
    }
  }

  header() {
    return Array.from(this.cookies.entries())
      .map(([name, value]) => `${name}=${value}`)
      .join("; ");
  }

  count() {
    return this.cookies.size;
  }
}

export function sha256Hex(value) {
  return createHash("sha256").update(`${value ?? ""}`).digest("hex");
}

export function buildPlatformEnvelope(params = {}, options = {}) {
  return {
    datatype: options.datatype ?? DEFAULT_DATATYPE,
    i18n: options.i18n ?? DEFAULT_I18N,
    params: JSON.stringify(params ?? {}),
    userInfo: options.userInfo ?? {},
    ...(params ?? {}),
  };
}

export function isMutationEndpoint(endpoint) {
  const pathname = (() => {
    try {
      return new URL(endpoint).pathname;
    } catch {
      return endpoint;
    }
  })();

  return MUTATION_ENDPOINT_PATTERNS.some((pattern) => pattern.test(pathname));
}

export function scrubPlatformValue(value, depth = 0) {
  if (depth > 6) {
    return "[depth-limit]";
  }

  if (value == null || typeof value === "number" || typeof value === "boolean") {
    return value;
  }

  if (typeof value === "string") {
    return scrubString(value);
  }

  if (Array.isArray(value)) {
    return value.slice(0, 30).map((item) => scrubPlatformValue(item, depth + 1));
  }

  if (isObject(value)) {
    const output = {};
    for (const [key, item] of Object.entries(value).slice(0, 160)) {
      output[key] = SECRET_KEY_PATTERN.test(key) ? "[redacted]" : scrubPlatformValue(item, depth + 1);
    }
    return output;
  }

  return String(value);
}

export function extractRows(value) {
  const arrays = collectArrays(value);
  const scored = arrays
    .map((items) => ({
      items,
      score: items.length + (items.some(looksLikeApplicationRow) ? 1000 : 0),
    }))
    .sort((left, right) => right.score - left.score);

  return scored[0]?.items ?? [];
}

export class PlatformApiClient {
  constructor(options = {}) {
    this.baseUrl = normalizeUrl(options.baseUrl, options.fallbackBaseUrl);
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.cookieJar = options.cookieJar ?? new CookieJar();
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  url(pathOrUrl) {
    const normalized = normalizePath(pathOrUrl);
    if (/^https?:\/\//i.test(normalized)) {
      return normalized;
    }

    return `${this.baseUrl}${normalized}`;
  }

  async post(pathOrUrl, params = {}, options = {}) {
    if (typeof this.fetchImpl !== "function") {
      throw new Error("Platform API client requires a fetch implementation in this runtime");
    }

    const url = this.url(pathOrUrl);
    if (!options.allowMutation && isMutationEndpoint(url)) {
      throw new PlatformMutationBlockedError(url);
    }

    const timeout = createAbortSignal(options.timeoutMs ?? this.timeoutMs);
    const cookieHeader = this.cookieJar.header();
    try {
      const response = await this.fetchImpl(url, {
        method: "POST",
        signal: timeout.signal,
        headers: {
          Accept: "application/json, text/plain, */*",
          "Content-Type": "application/json;charset=UTF-8",
          ...(cookieHeader ? { Cookie: cookieHeader } : {}),
          ...(options.headers ?? {}),
        },
        body: JSON.stringify(buildPlatformEnvelope(params, options.envelopeOptions)),
      });

      this.cookieJar.capture(response.headers);
      const text = await response.text();
      let body = text;
      try {
        body = text ? JSON.parse(text) : null;
      } catch {
        // Keep raw text for platform responses that are not JSON.
      }

      return {
        ok: response.ok,
        status: response.status,
        url,
        body,
        cookieCount: this.cookieJar.count(),
      };
    } finally {
      timeout.clear();
    }
  }

  async get(pathOrUrl, options = {}) {
    if (typeof this.fetchImpl !== "function") {
      throw new Error("Platform API client requires a fetch implementation in this runtime");
    }

    const url = this.url(pathOrUrl);
    if (!options.allowMutation && isMutationEndpoint(url)) {
      throw new PlatformMutationBlockedError(url);
    }

    const timeout = createAbortSignal(options.timeoutMs ?? this.timeoutMs);
    const cookieHeader = this.cookieJar.header();
    try {
      const response = await this.fetchImpl(url, {
        method: "GET",
        signal: timeout.signal,
        headers: {
          Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          ...(cookieHeader ? { Cookie: cookieHeader } : {}),
          ...(options.headers ?? {}),
        },
      });

      this.cookieJar.capture(response.headers);
      const text = await response.text();

      return {
        ok: response.ok,
        status: response.status,
        url,
        body: text,
        cookieCount: this.cookieJar.count(),
      };
    } finally {
      timeout.clear();
    }
  }
}

export function createBuildPlatformClient(portalConfig = {}, options = {}) {
  return new PlatformApiClient({
    ...options,
    baseUrl: portalConfig.url,
    fallbackBaseUrl: "http://supportweb-ecp-ewell-prodyhkj.192.168.150.42.nip.io",
  });
}

export function createReleasePlatformClient(portalConfig = {}, options = {}) {
  return new PlatformApiClient({
    ...options,
    baseUrl: portalConfig.url,
    fallbackBaseUrl: "https://cloudweb.think-go.com",
  });
}

export function createReleaseCloudClient(portalConfig = {}, options = {}) {
  return new PlatformApiClient({
    ...options,
    baseUrl: portalConfig.apiUrl,
    fallbackBaseUrl: "https://cloud.think-go.com",
  });
}

export async function loginBuildPlatform(client, portalConfig = {}) {
  const username = `${portalConfig.username ?? ""}`.trim();
  const password = `${portalConfig.password ?? ""}`;
  if (!username || !password) {
    throw new Error("Missing build platform username or password");
  }

  const result = await client.post("/api/authority/login", {
    account: username,
    password: sha256Hex(password),
    appId: BUILD_APP_ID,
  });
  const token = findFirstValue(result.body, ["token", "loginToken", "accessToken", "jwt"]);

  return {
    ...result,
    userId: username,
    token: token ? `${token}` : null,
  };
}

export async function verifyBuildLoginToken(client, token) {
  if (!token) {
    return null;
  }

  return client.post("/api/authority/loginTokenVerification", {
    loginToken: token,
    appId: BUILD_APP_ID,
  });
}

export async function getBuildMyApplications(client, options = {}) {
  const userId = `${options.userId ?? ""}`.trim();
  if (!userId) {
    throw new Error("Missing build platform userId");
  }

  return client.post("/api/support/myApplicationListPage", {
    userId,
    pageSize: Number.parseInt(`${options.pageSize ?? 15}`, 10) || 15,
    pageNumber: Number.parseInt(`${options.pageNumber ?? 1}`, 10) || 1,
    orderBy: options.orderBy ?? "create_time",
    sort: options.sort ?? "desc",
  });
}

export async function getBuildCustomers(client, options = {}) {
  const userId = `${options.userId ?? ""}`.trim();
  if (!userId) {
    throw new Error("Missing build platform userId");
  }

  return client.post("/api/support/findCustomerList", {
    userId,
    searchCustomerUserFlag: true,
  });
}

export async function getBuildCustomerApps(client, options = {}) {
  const userId = `${options.userId ?? ""}`.trim();
  if (!userId) {
    throw new Error("Missing build platform userId");
  }

  return client.post("/api/support/findCustomerAppList", {
    userId,
    customerNameEn: `${options.customerNameEn ?? ""}`.trim(),
    searchCustomerUserFlag: true,
  });
}

export async function getBuildApplicationDetail(client, options = {}) {
  const customerNameEn = `${options.customerNameEn ?? ""}`.trim();
  const applicationCode = `${options.applicationCode ?? ""}`.trim();
  if (!customerNameEn || !applicationCode) {
    throw new Error("Missing build platform customerNameEn or applicationCode");
  }

  return client.post("/api/support/findMyApplicationDetail", {
    customerNameEn,
    applicationCode,
  });
}

export async function getBuildNamespaces(client, options = {}) {
  const customerNameEn = `${options.customerNameEn ?? ""}`.trim();
  const applicationCode = `${options.applicationCode ?? ""}`.trim();
  if (!customerNameEn || !applicationCode) {
    throw new Error("Missing build platform customerNameEn or applicationCode");
  }

  return client.post("/api/support/selectCustomerAppNamespaces", {
    customerNameEn,
    applicationCode,
  });
}

export async function getBuildServices(client, options = {}) {
  const userId = `${options.userId ?? ""}`.trim();
  const customerNameEn = `${options.customerNameEn ?? ""}`.trim();
  const applicationCode = `${options.applicationCode ?? ""}`.trim();
  const codeBranch = `${options.codeBranch ?? ""}`.trim();
  if (!userId || !customerNameEn || !applicationCode || !codeBranch) {
    throw new Error("Missing build platform userId, customerNameEn, applicationCode, or codeBranch");
  }

  return client.post("/api/support/selectPublishMicroServiceInfo", {
    userId,
    imageJenkinsName: `${options.imageJenkinsName ?? ""}`.trim(),
    customerNameEn,
    applicationCode,
    codeBranch,
    pageNumber: Number.parseInt(`${options.pageNumber ?? 1}`, 10) || 1,
    pageSize: Number.parseInt(`${options.pageSize ?? 15}`, 10) || 15,
  });
}

export async function getBuildServiceDetail(client, options = {}) {
  const userId = `${options.userId ?? ""}`.trim();
  const customerNameEn = `${options.customerNameEn ?? ""}`.trim();
  const imageJenkinsName = `${options.imageJenkinsName ?? ""}`.trim();
  const codeBranch = `${options.codeBranch ?? ""}`.trim();
  const applicationName = `${options.applicationName ?? options.applicationCode ?? ""}`.trim();
  if (!userId || !customerNameEn || !imageJenkinsName || !codeBranch || !applicationName) {
    throw new Error("Missing build service detail fields");
  }

  return client.post("/api/support/getStructureImageDetail", {
    customerNameEn,
    imageJenkinsName,
    codeBranch,
    applicationName,
    userId,
  });
}

export async function getBuildHistory(client, options = {}) {
  const customerNameEn = `${options.customerNameEn ?? ""}`.trim();
  const codeBranch = `${options.codeBranch ?? ""}`.trim();
  const applicationName = `${options.applicationName ?? options.applicationCode ?? ""}`.trim();
  const imageJenkinsName = `${options.imageJenkinsName ?? ""}`.trim();
  const imageVersion = `${options.imageVersion ?? ""}`.trim();
  if (!customerNameEn || !codeBranch || !applicationName || !imageJenkinsName || !imageVersion) {
    throw new Error("Missing build history fields");
  }

  return client.post("/api/support/getStructureDetailList", {
    customerNameEn,
    codeBranch,
    applicationName,
    imageJenkinsName,
    imageVersion,
  });
}

export async function getBuildLog(client, options = {}) {
  const customerNameEn = `${options.customerNameEn ?? ""}`.trim();
  const codeBranch = `${options.codeBranch ?? ""}`.trim();
  const applicationName = `${options.applicationName ?? options.applicationCode ?? ""}`.trim();
  const imageJenkinsName = `${options.imageJenkinsName ?? ""}`.trim();
  const buildID = `${options.buildID ?? options.buildId ?? ""}`.trim();
  if (!customerNameEn || !codeBranch || !applicationName || !imageJenkinsName || !buildID) {
    throw new Error("Missing build log fields");
  }

  return client.post("/api/support/getStructureLog", {
    customerNameEn,
    codeBranch,
    applicationName,
    imageJenkinsName,
    buildID,
  });
}

export async function getBuildTaskType(client, options = {}) {
  const customerNameEn = `${options.customerNameEn ?? ""}`.trim();
  const applicationCode = `${options.applicationCode ?? ""}`.trim();
  const envType = `${options.envType ?? ""}`.trim();
  const codeBranch = `${options.codeBranch ?? ""}`.trim();
  const staffCode = `${options.staffCode ?? options.userId ?? ""}`.trim();
  const groupCode = `${options.groupCode ?? ""}`.trim();
  if (!customerNameEn || !applicationCode || !envType || !codeBranch || !staffCode || !groupCode) {
    throw new Error("Missing build task type fields");
  }

  return client.post("/api/support/getBuildTaskType", {
    customerNameEn,
    applicationCode,
    releaseStatus: `${options.releaseStatus ?? "0"}`,
    envType,
    codeBranch,
    staffCode,
    groupCode,
  });
}

export function buildBuildImagesPayload(options = {}) {
  const customerNameEn = `${options.customerNameEn ?? ""}`.trim();
  const applicationCode = `${options.applicationCode ?? ""}`.trim();
  const applicationName = `${options.applicationName ?? options.applicationCode ?? ""}`.trim();
  const buildPerId = `${options.buildPerId ?? options.userId ?? ""}`.trim();
  const codeBranch = `${options.codeBranch ?? ""}`.trim();
  const rawImages = Array.isArray(options.buildImages) ? options.buildImages : [options.buildImage ?? options.service].filter(Boolean);
  const buildImages = rawImages
    .map((item) => ({
      imageJenkinsName: `${item?.imageJenkinsName ?? ""}`.trim(),
      applicationCode: `${item?.applicationCode ?? applicationCode}`.trim(),
      ...(item?.imageVersion ? { imageVersion: `${item.imageVersion}`.trim() } : {}),
    }))
    .filter((item) => item.imageJenkinsName && item.applicationCode);

  if (!customerNameEn || !applicationCode || !applicationName || !buildPerId || !codeBranch || buildImages.length === 0) {
    throw new Error("Missing buildImages payload fields");
  }

  return {
    customerNameEn,
    applicationCode,
    applicationName,
    buildPerId,
    codeBranch,
    buildImages,
    kubernetesVersion: options.kubernetesVersion ?? "",
  };
}

export function buildStopBuildImagesPayload(options = {}) {
  const customerNameEn = `${options.customerNameEn ?? ""}`.trim();
  const applicationName = `${options.applicationName ?? options.applicationCode ?? ""}`.trim();
  const codeBranch = `${options.codeBranch ?? ""}`.trim();
  const imageJenkinsName = `${options.imageJenkinsName ?? ""}`.trim();
  const buildNum = Number.parseInt(`${options.buildNum ?? options.buildID ?? options.buildId ?? -1}`, 10);
  if (!customerNameEn || !applicationName || !codeBranch || !imageJenkinsName || !Number.isFinite(buildNum)) {
    throw new Error("Missing stopBuildImages payload fields");
  }

  return {
    customerNameEn,
    applicationName,
    codeBranch,
    imageJenkinsName,
    buildNum,
  };
}

export async function loginReleasePlatform(client, portalConfig = {}) {
  const username = `${portalConfig.username ?? ""}`.trim();
  const password = `${portalConfig.password ?? ""}`;
  if (!username || !password) {
    throw new Error("Missing release platform username or password");
  }

  const result = await client.post("/api/authority/login", {
    account: username,
    password: sha256Hex(password),
    deviceType: "pc",
    appId: "",
  });
  const token = findFirstValue(result.body, ["token", "loginToken", "accessToken", "jwt"]);

  return {
    ...result,
    userId: username,
    token: token ? `${token}` : null,
  };
}

export async function bootstrapReleaseConsoleSession(client, loginToken) {
  if (!loginToken) {
    return null;
  }

  return client.get(`https://cloud.think-go.com/control/pubManage?loginToken=${encodeURIComponent(loginToken)}`);
}

export async function getReleaseCustomerList(client, options = {}) {
  const customerNameCh = `${options.customerNameCh ?? ""}`.trim();
  return client.post("https://cloud.think-go.com/api/cloud/getCustomerListAuth", {
    ...(customerNameCh ? { customerNameCh } : {}),
  });
}

export async function getReleasePublishOverview(client, options = {}) {
  const userId = `${options.userId ?? ""}`.trim();
  const customerNameEn = `${options.customerNameEn ?? ""}`.trim();
  if (!userId || !customerNameEn) {
    throw new Error("Missing release platform userId or customerNameEn");
  }

  return client.post("https://cloud.think-go.com/api/cloud/publishOverviewList", {
    userId,
    customerNameEn,
  });
}

export async function getReleasePublishRecords(client, options = {}) {
  const customerNameEn = `${options.customerNameEn ?? ""}`.trim();
  const applicationCode = `${options.applicationCode ?? ""}`.trim();
  const showNameEn = `${options.showNameEn ?? ""}`.trim();
  const environmentFlag = `${options.environmentFlag ?? ""}`.trim();
  if (!customerNameEn || !applicationCode || !showNameEn || !environmentFlag) {
    throw new Error("Missing release records customerNameEn, applicationCode, showNameEn, or environmentFlag");
  }

  return client.post("https://cloud.think-go.com/api/cloud/getPublishRecordsPage", {
    applicationCode,
    customerNameEn,
    showNameEn,
    environmentFlag,
    imageName: `${options.imageName ?? ""}`,
    beginTime: `${options.beginTime ?? ""}`,
    endTime: `${options.endTime ?? ""}`,
    pageSize: Number.parseInt(`${options.pageSize ?? 10}`, 10) || 10,
    pageNumber: Number.parseInt(`${options.pageNumber ?? 1}`, 10) || 1,
  });
}

export async function getReleaseCurrentPublishDetail(client, options = {}) {
  const userId = `${options.userId ?? ""}`.trim();
  const customerNameEn = `${options.customerNameEn ?? ""}`.trim();
  const showNameEn = `${options.showNameEn ?? ""}`.trim();
  const environmentFlag = `${options.environmentFlag ?? ""}`.trim();
  const applicationCode = `${options.applicationCode ?? ""}`.trim();
  const applicationVersion = `${options.applicationVersion ?? ""}`.trim();
  if (!userId || !customerNameEn || !showNameEn || !environmentFlag || !applicationCode || !applicationVersion) {
    throw new Error("Missing release current publish detail fields");
  }

  return client.post("https://cloud.think-go.com/api/cloud/getCurrentAppPublishDetail", {
    userId,
    customerNameEn,
    showNameEn,
    environmentFlag,
    applicationCode,
    applicationVersion,
  });
}

export function buildReleasePublishAppsPayload(options = {}) {
  const userId = `${options.userId ?? ""}`.trim();
  const customerNameEn = `${options.customerNameEn ?? ""}`.trim();
  const showNameEn = `${options.showNameEn ?? ""}`.trim();
  const environment = `${options.environment ?? ""}`.trim();
  const environmentFlag = `${options.environmentFlag ?? ""}`.trim();
  const publishApps = (Array.isArray(options.publishApps)
    ? options.publishApps
    : [
        options.publishApp ??
          options.app ?? {
            applicationCode: options.applicationCode,
            applicationVersion: options.applicationVersion,
          },
      ].filter(Boolean))
    .map((item) => ({
      applicationCode: `${item?.applicationCode ?? options.applicationCode ?? ""}`.trim(),
      applicationVersion: `${item?.applicationVersion ?? options.applicationVersion ?? ""}`.trim(),
    }))
    .filter((item) => item.applicationCode && item.applicationVersion);

  if (!userId || !customerNameEn || !showNameEn || !environment || !environmentFlag || publishApps.length === 0) {
    throw new Error("Missing publishApps payload fields");
  }

  return {
    userId,
    customerNameEn,
    showNameEn,
    environment,
    environmentFlag,
    publishApps,
  };
}

export function buildReleasePublishRatePayload(options = {}) {
  const customerNameEn = `${options.customerNameEn ?? ""}`.trim();
  const showNameEn = `${options.showNameEn ?? ""}`.trim();
  const environment = `${options.environment ?? ""}`.trim();
  const environmentFlag = `${options.environmentFlag ?? ""}`.trim();
  const applicationCode = `${options.applicationCode ?? ""}`.trim();
  const applicationVersion = `${options.applicationVersion ?? ""}`.trim();
  if (!customerNameEn || !showNameEn || !environment || !environmentFlag || !applicationCode || !applicationVersion) {
    throw new Error("Missing publishAppRate payload fields");
  }

  return {
    customerNameEn,
    showNameEn,
    environment,
    environmentFlag,
    applicationCode,
    applicationVersion,
  };
}

export const buildReleaseDelPublishPayload = buildReleasePublishRatePayload;

export function summarizePlatformResult(result) {
  return scrubPlatformValue({
    ok: result?.ok ?? false,
    status: result?.status ?? null,
    url: result?.url ?? null,
    cookieCount: result?.cookieCount ?? 0,
    body: result?.body ?? null,
  });
}

export function summarizePlatformLogin(result) {
  return {
    ok: Boolean(result?.ok),
    status: result?.status ?? null,
    userId: result?.userId ?? null,
    tokenAvailable: Boolean(result?.token),
    cookieCount: result?.cookieCount ?? 0,
    body: scrubPlatformValue(result?.body ?? null),
  };
}

export function summarizeRowsResult(result) {
  const rows = extractRows(result?.body);
  return {
    ...summarizePlatformResult(result),
    rows: scrubPlatformValue(rows),
    rowCount: rows.length,
  };
}
