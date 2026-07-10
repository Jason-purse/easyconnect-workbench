import { access, mkdir, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDir, "..");
const require = createRequire(import.meta.url);

const PLATFORM_CONFIGS = {
  build: {
    name: "build-platform",
    baseUrl: "http://supportweb-ecp-ewell-prodyhkj.192.168.150.42.nip.io",
    loginPath: "/login",
    queryLogin: {
      accountParam: "account",
      passwordParam: "password",
    },
    accountEnv: "EASYCONNECT_BUILD_ACCOUNT",
    passwordEnv: "EASYCONNECT_BUILD_PASSWORD",
    usernamePlaceholder: "请输入用户名称",
    passwordPlaceholder: "请输入登录密码",
    submitRoleName: /登\s*录/,
    apiHostAllowList: [
      "supportweb-ecp-ewell-prodyhkj.192.168.150.42.nip.io",
    ],
  },
  release: {
    name: "release-platform",
    baseUrl: "https://cloudweb.think-go.com",
    loginPath: "/login",
    accountEnv: "EASYCONNECT_RELEASE_ACCOUNT",
    passwordEnv: "EASYCONNECT_RELEASE_PASSWORD",
    usernamePlaceholder: "请输入用户名称",
    passwordPlaceholder: "请输入登录密码",
    submitRoleName: /登\s*录/,
    apiHostAllowList: [
      "cloudweb.think-go.com",
      "cloud.think-go.com",
    ],
  },
};

const MUTATION_ENDPOINT_PATTERNS = [
  /\/api\/support\/buildImages\b/i,
  /\/api\/support\/stopBuildImages\b/i,
  /\/api\/support\/applyProdStruct\b/i,
  /\/api\/support\/commonImagesInstall\b/i,
  /\/api\/support\/testComplete\b/i,
  /\/api\/support\/confirmPublish\b/i,
  /\/api\/cloud\/.*(?:publish|confirm|deploy|release|rollback|stop|start|build).*$/i,
];

const SECRET_KEY_PATTERN = /pass|pwd|token|cookie|authorization|secret|session|twfid|jwt|ticket|credential/i;

function parseArgs(argv) {
  const args = {
    platform: "build",
    headed: false,
    outputDir: path.join(projectRoot, "output", "platform-api"),
    timeoutMs: 45000,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (item === "--headed") {
      args.headed = true;
      continue;
    }

    if (item === "--platform") {
      args.platform = argv[index + 1] ?? args.platform;
      index += 1;
      continue;
    }

    if (item === "--output-dir") {
      args.outputDir = path.resolve(argv[index + 1] ?? args.outputDir);
      index += 1;
      continue;
    }

    if (item === "--timeout-ms") {
      args.timeoutMs = Number.parseInt(argv[index + 1] ?? "", 10) || args.timeoutMs;
      index += 1;
    }
  }

  return args;
}

function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }

  return value;
}

async function pathExists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function findNpxPlaywrightRoots() {
  const npxRoot = path.join(process.env.HOME ?? "", ".npm", "_npx");
  if (!(await pathExists(npxRoot))) {
    return [];
  }

  const entries = await readdir(npxRoot, { withFileTypes: true });
  const roots = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }

    const nodeModules = path.join(npxRoot, entry.name, "node_modules");
    if (await pathExists(path.join(nodeModules, "playwright", "package.json"))) {
      roots.push(nodeModules);
    }
  }

  return roots;
}

async function loadPlaywright() {
  const explicitRoot = process.env.PLAYWRIGHT_NODE_MODULES;
  const candidateRoots = [
    explicitRoot,
    path.join(projectRoot, "node_modules"),
    ...(await findNpxPlaywrightRoots()),
  ].filter(Boolean);

  for (const root of candidateRoots) {
    try {
      const resolved = require.resolve("playwright", { paths: [root] });
      return require(resolved);
    } catch {
      // Try the next known package root.
    }
  }

  throw new Error(
    "Cannot resolve Playwright. Run the wrapper once or pass PLAYWRIGHT_NODE_MODULES=/path/to/node_modules; " +
      "for example: PLAYWRIGHT_NODE_MODULES=$HOME/.npm/_npx/<id>/node_modules node scripts/capture-platform-api.mjs ...",
  );
}

function redact(value) {
  if (value == null) {
    return value;
  }

  if (typeof value === "string") {
    return value.length > 120 ? `${value.slice(0, 120)}...[truncated]` : value;
  }

  return value;
}

function scrub(value, depth = 0) {
  if (depth > 5) {
    return "[depth-limit]";
  }

  if (value == null || typeof value === "number" || typeof value === "boolean") {
    return value;
  }

  if (typeof value === "string") {
    return redact(value);
  }

  if (Array.isArray(value)) {
    return value.slice(0, 20).map((item) => scrub(item, depth + 1));
  }

  if (typeof value === "object") {
    const out = {};
    for (const [key, item] of Object.entries(value).slice(0, 120)) {
      out[key] = SECRET_KEY_PATTERN.test(key) ? "[redacted]" : scrub(item, depth + 1);
    }
    return out;
  }

  return String(value);
}

function parseRequestBody(postData) {
  if (!postData) {
    return null;
  }

  try {
    return scrub(JSON.parse(postData));
  } catch {
    // Continue to form decoding.
  }

  try {
    return scrub(Object.fromEntries(new URLSearchParams(postData)));
  } catch {
    return redact(postData);
  }
}

function normalizeApiUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    return `${url.origin}${url.pathname}`;
  } catch {
    return rawUrl;
  }
}

function redactUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    for (const key of Array.from(url.searchParams.keys())) {
      if (SECRET_KEY_PATTERN.test(key) || ["account", "username", "user"].includes(key.toLowerCase())) {
        url.searchParams.set(key, "[redacted]");
      }
    }
    return url.href;
  } catch {
    return rawUrl;
  }
}

function isAllowedApiUrl(rawUrl, config) {
  try {
    const url = new URL(rawUrl);
    return url.pathname.includes("/api/") && config.apiHostAllowList.includes(url.host);
  } catch {
    return false;
  }
}

function isMutationEndpoint(rawUrl) {
  const normalized = normalizeApiUrl(rawUrl);
  return MUTATION_ENDPOINT_PATTERNS.some((pattern) => pattern.test(normalized));
}

async function waitForSettledPage(page, timeoutMs) {
  await page.waitForLoadState("domcontentloaded", { timeout: timeoutMs }).catch(() => {});
  await page.waitForLoadState("networkidle", { timeout: Math.min(timeoutMs, 15000) }).catch(() => {});
  await page.waitForTimeout(3000);
}

async function login(page, config, account, password, timeoutMs) {
  const loginUrl = new URL(config.loginPath, config.baseUrl);
  if (config.queryLogin) {
    loginUrl.searchParams.set(config.queryLogin.accountParam, account);
    loginUrl.searchParams.set(config.queryLogin.passwordParam, password);
    await page.goto(loginUrl.href, { waitUntil: "domcontentloaded", timeout: timeoutMs });
    await waitForSettledPage(page, timeoutMs);

    if (!new URL(page.url()).pathname.includes("/login")) {
      return { mode: "query" };
    }
  }

  loginUrl.search = "";
  await page.goto(loginUrl.href, { waitUntil: "domcontentloaded", timeout: timeoutMs });

  await page.getByPlaceholder(config.usernamePlaceholder).fill(account, { timeout: timeoutMs });
  await page.getByPlaceholder(config.passwordPlaceholder).fill(password, { timeout: timeoutMs });
  await page.getByRole("button", { name: config.submitRoleName }).click({ timeout: timeoutMs });
  await waitForSettledPage(page, timeoutMs);

  return { mode: "form" };
}

async function buildPageSummary(page) {
  return page.evaluate(() => {
    const visibleText = document.body?.innerText ?? "";
    const links = Array.from(document.querySelectorAll("a[href]"))
      .slice(0, 60)
      .map((item) => ({
        text: item.textContent?.trim() ?? "",
        href: item.href,
      }));
    const buttons = Array.from(document.querySelectorAll("button"))
      .slice(0, 80)
      .map((item) => item.textContent?.trim() ?? "");

    return {
      visibleTextSample: visibleText.slice(0, 2000),
      links,
      buttons,
    };
  });
}

function summarizeApiEvents(apiEvents) {
  const unique = new Map();

  for (const event of apiEvents) {
    const key = `${event.method} ${event.url}`;
    const current = unique.get(key) ?? {
      method: event.method,
      url: event.url,
      statuses: new Set(),
      count: 0,
      requestBodyKeys: null,
      responseKeys: null,
    };
    current.count += 1;
    current.statuses.add(event.status);
    if (!current.requestBodyKeys && event.postData && typeof event.postData === "object" && !Array.isArray(event.postData)) {
      current.requestBodyKeys = Object.keys(event.postData);
    }
    if (!current.responseKeys && event.bodyShape?.topLevelKeys) {
      current.responseKeys = event.bodyShape.topLevelKeys;
    }
    unique.set(key, current);
  }

  return Array.from(unique.values()).map((item) => ({
    ...item,
    statuses: Array.from(item.statuses).sort(),
  }));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const config = PLATFORM_CONFIGS[args.platform];
  if (!config) {
    throw new Error(`Unsupported platform "${args.platform}". Use one of: ${Object.keys(PLATFORM_CONFIGS).join(", ")}`);
  }

  const account = requireEnv(config.accountEnv);
  const password = requireEnv(config.passwordEnv);
  const apiEvents = [];
  const blockedMutations = [];
  const requestMeta = new Map();
  const { chromium } = await loadPlaywright();

  await mkdir(args.outputDir, { recursive: true });

  const browser = await chromium.launch({
    channel: "chrome",
    headless: !args.headed,
  });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 960 },
    ignoreHTTPSErrors: true,
  });
  const page = await context.newPage();

  await page.route("**/*", async (route) => {
    const request = route.request();
    if (isMutationEndpoint(request.url())) {
      blockedMutations.push({
        method: request.method(),
        url: normalizeApiUrl(request.url()),
      });
      await route.abort("blockedbyclient");
      return;
    }

    await route.continue();
  });

  page.on("request", (request) => {
    if (!isAllowedApiUrl(request.url(), config)) {
      return;
    }

    requestMeta.set(request, {
      timestamp: new Date().toISOString(),
      method: request.method(),
      url: normalizeApiUrl(request.url()),
      postData: parseRequestBody(request.postData()),
    });
  });

  page.on("response", async (response) => {
    const request = response.request();
    const meta = requestMeta.get(request);
    if (!meta) {
      return;
    }

    const headers = response.headers();
    const contentType = headers["content-type"] ?? "";
    let bodyShape = null;
    if (contentType.includes("application/json")) {
      try {
        const json = await response.json();
        bodyShape = {
          topLevelType: Array.isArray(json) ? "array" : typeof json,
          topLevelKeys: json && typeof json === "object" && !Array.isArray(json) ? Object.keys(json).slice(0, 40) : null,
          sample: scrub(json),
        };
      } catch (error) {
        bodyShape = { error: error?.message ?? String(error) };
      }
    }

    apiEvents.push({
      ...meta,
      status: response.status(),
      contentType,
      bodyShape,
    });
  });

  try {
    const loginResult = await login(page, config, account, password, args.timeoutMs);
    const pageSummary = await buildPageSummary(page);
    const report = {
      platform: args.platform,
      baseUrl: config.baseUrl,
      capturedAt: new Date().toISOString(),
      loginResult,
      pageUrl: redactUrl(page.url()),
      title: await page.title(),
      blockedMutations,
      apiSummary: summarizeApiEvents(apiEvents),
      apiEvents,
      pageSummary,
    };
    const reportPath = path.join(args.outputDir, `${config.name}-network.json`);
    await writeFile(reportPath, JSON.stringify(report, null, 2));

    console.log(JSON.stringify({
      ok: true,
      reportPath,
      pageUrl: report.pageUrl,
      title: report.title,
      apiCount: apiEvents.length,
      uniqueApiCount: report.apiSummary.length,
      blockedMutationCount: blockedMutations.length,
      apiSummary: report.apiSummary,
    }, null, 2));
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  const message = redactUrl(error?.message ?? String(error));
  const stack = redactUrl(error?.stack ?? "");
  console.error(JSON.stringify({
    ok: false,
    message,
    stack,
  }, null, 2));
  process.exitCode = 1;
});
