import { createHash, createPublicKey, publicEncrypt, createCipheriv, constants, randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import https from "node:https";
import { execFile, execSync, spawn } from "node:child_process";

const DEFAULT_PORT = 54530;
const DEFAULT_HOST = "127.0.0.1";
const TOKEN_SALT = "__md5_salt_for_ecagent_session__";
const DEFAULT_EXPONENT_HEX = "10001";
const APP_EXECUTABLE = "/Applications/EasyConnect.app/Contents/MacOS/EasyConnect";

const HOME = os.homedir();
const APP_SUPPORT_DIR = path.join(HOME, "Library", "Application Support", "EasyConnect");
const CACHE_DIR = path.join(APP_SUPPORT_DIR, "Cache", "Cache_Data");
const LOGS_DIR = path.join(HOME, "Library", "Logs", "EasyConnect");
const LOCAL_SERVICE_SOCKET_NAMES = ["ECDomainFile", "ECRSESSIONSOCKFILE"];
const AGENT_PROXY_LABEL = "com.sangfor.ECAgentProxy";
const AGENT_PROXY_PLIST = "/Library/LaunchAgents/com.sangfor.ECAgentProxy.plist";
const CACHE_SCAN_ENTRY_LIMIT = 2000;
const OFFICIAL_CRASH_DIAGNOSTIC_FRESH_MS = 10 * 60 * 1000;

function getBundleConfDir(appExecutable) {
  return path.join(path.dirname(path.dirname(appExecutable)), "Resources", "conf");
}

function getBundleResourcesDir(appExecutable) {
  return path.join(path.dirname(path.dirname(appExecutable)), "Resources");
}

function toBase64Url(buffer) {
  return buffer
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function redactToken(token) {
  if (!token) {
    return "";
  }

  if (token.length <= 8) {
    return token;
  }

  return `${token.slice(0, 6)}...${token.slice(-4)}`;
}

async function exists(filePath, fsOps = fs) {
  try {
    await fsOps.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function readJson(filePath) {
  const raw = await fs.readFile(filePath, "utf8");
  return JSON.parse(raw);
}

async function writeJsonAtomic(filePath, value) {
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmpPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await fs.rename(tmpPath, filePath);
}

async function listFilesByMtime(dirPath, limit = 40, fsOps = fs) {
  const dir = await fsOps.opendir(dirPath);
  const files = [];
  let inspected = 0;

  try {
    for await (const entry of dir) {
      if (!entry.isFile()) {
        continue;
      }

      inspected += 1;
      const filePath = path.join(dirPath, entry.name);
      let stat;
      try {
        stat = await fsOps.stat(filePath);
      } catch (error) {
        if (error?.code === "ENOENT") {
          continue;
        }
        throw error;
      }

      files.push({ filePath, mtimeMs: stat.mtimeMs });
      files.sort((a, b) => b.mtimeMs - a.mtimeMs);
      if (files.length > limit) {
        files.length = limit;
      }

      if (inspected >= CACHE_SCAN_ENTRY_LIMIT) {
        break;
      }
    }
  } finally {
    await dir.close().catch(() => {});
  }

  return files;
}

async function extractTokensFromCacheFromDir(dirPath, limit = 40, fsOps = fs) {
  if (!(await exists(dirPath, fsOps))) {
    return [];
  }

  const newestFiles = await listFilesByMtime(dirPath, limit, fsOps);
  const tokenSet = new Set();

  for (const { filePath } of newestFiles) {
    let buffer;
    try {
      buffer = await fsOps.readFile(filePath);
    } catch (error) {
      if (error?.code === "ENOENT") {
        continue;
      }
      throw error;
    }
    const content = buffer.toString("latin1");
    const matches = content.matchAll(/token=([a-f0-9]{32})/g);
    for (const match of matches) {
      tokenSet.add(match[1]);
    }
  }

  return [...tokenSet];
}

async function extractTokensFromCache(limit = 40) {
  return extractTokensFromCacheFromDir(CACHE_DIR, limit, fs);
}

function parseGatewayList(value) {
  if (!value) {
    return [];
  }

  return value
    .split(";")
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => {
      const [host, port] = item.split(":");
      if (!host || !port) {
        return null;
      }

      return {
        host,
        port: Number.parseInt(port, 10),
      };
    })
    .filter(Boolean);
}

function buildPublicKey(modulusHex, exponentHex = DEFAULT_EXPONENT_HEX) {
  const key = {
    kty: "RSA",
    n: toBase64Url(Buffer.from(modulusHex, "hex")),
    e: toBase64Url(Buffer.from(exponentHex, "hex")),
  };

  return createPublicKey({ key, format: "jwk" });
}

function encryptRsaPkcs1Hex(plaintext, modulusHex, exponentHex = DEFAULT_EXPONENT_HEX) {
  const publicKey = buildPublicKey(modulusHex, exponentHex);
  const encrypted = publicEncrypt(
    {
      key: publicKey,
      padding: constants.RSA_PKCS1_PADDING,
    },
    Buffer.from(plaintext, "utf8"),
  );

  return encrypted.toString("hex");
}

function decodeLogoutReason(logoutReason) {
  if (!logoutReason) {
    return null;
  }

  try {
    const decoded = Buffer.from(logoutReason, "base64").toString("utf8");
    try {
      return JSON.parse(decoded);
    } catch {
      return decoded;
    }
  } catch {
    return null;
  }
}

function isAgentTokenCheckError(response) {
  return response?.result === "-100";
}

function createAbortError() {
  const error = new Error("Operation aborted");
  error.name = "AbortError";
  return error;
}

function throwIfAborted(signal) {
  if (signal?.aborted) {
    throw createAbortError();
  }
}

function sleep(ms, signal) {
  throwIfAborted(signal);

  return new Promise((resolve, reject) => {
    const timer = setTimeout(finish, ms);

    function cleanup() {
      clearTimeout(timer);
      signal?.removeEventListener?.("abort", abort);
    }

    function finish() {
      cleanup();
      resolve();
    }

    function abort() {
      cleanup();
      reject(createAbortError());
    }

    signal?.addEventListener?.("abort", abort, { once: true });
  });
}

function getNetworkModule(protocol) {
  return protocol === "https:" || protocol === "wss:" ? https : http;
}

function buildWebSocketFrame(payload, opcode = 0x1) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload, "utf8");
  const mask = randomBytes(4);
  let header = null;

  if (body.length < 126) {
    header = Buffer.alloc(2);
    header[1] = 0x80 | body.length;
  } else if (body.length < 65536) {
    header = Buffer.alloc(4);
    header[1] = 0x80 | 126;
    header.writeUInt16BE(body.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 0x80 | 127;
    header.writeBigUInt64BE(BigInt(body.length), 2);
  }

  header[0] = 0x80 | opcode;

  const maskedBody = Buffer.alloc(body.length);
  for (let index = 0; index < body.length; index += 1) {
    maskedBody[index] = body[index] ^ mask[index % 4];
  }

  return Buffer.concat([header, mask, maskedBody]);
}

function extractWebSocketFrames(buffer) {
  const messages = [];
  let offset = 0;

  while (offset + 2 <= buffer.length) {
    const firstByte = buffer[offset];
    const secondByte = buffer[offset + 1];
    const opcode = firstByte & 0x0f;
    const masked = (secondByte & 0x80) !== 0;
    let payloadLength = secondByte & 0x7f;
    let headerLength = 2;

    if (payloadLength === 126) {
      if (offset + 4 > buffer.length) {
        break;
      }
      payloadLength = buffer.readUInt16BE(offset + 2);
      headerLength = 4;
    } else if (payloadLength === 127) {
      if (offset + 10 > buffer.length) {
        break;
      }
      payloadLength = Number(buffer.readBigUInt64BE(offset + 2));
      headerLength = 10;
    }

    const maskLength = masked ? 4 : 0;
    const frameLength = headerLength + maskLength + payloadLength;
    if (offset + frameLength > buffer.length) {
      break;
    }

    let payloadOffset = offset + headerLength;
    let payload = buffer.subarray(payloadOffset + maskLength, payloadOffset + maskLength + payloadLength);

    if (masked) {
      const mask = buffer.subarray(payloadOffset, payloadOffset + maskLength);
      const decoded = Buffer.alloc(payloadLength);
      for (let index = 0; index < payloadLength; index += 1) {
        decoded[index] = payload[index] ^ mask[index % 4];
      }
      payload = decoded;
    }

    if (opcode === 0x1) {
      messages.push(payload.toString("utf8"));
    } else if (opcode === 0x8) {
      messages.push(null);
    }

    offset += frameLength;
  }

  return {
    messages,
    remaining: buffer.subarray(offset),
  };
}

class SimpleWebSocketClient {
  constructor(socket) {
    this.socket = socket;
    this.buffer = Buffer.alloc(0);
    this.queue = [];
    this.waiters = [];
    this.closed = false;

    socket.on("data", (chunk) => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      const { messages, remaining } = extractWebSocketFrames(this.buffer);
      this.buffer = remaining;
      for (const message of messages) {
        this.push(message);
      }
    });

    socket.on("error", (error) => {
      this.fail(error);
    });

    socket.on("close", () => {
      this.fail(new Error("WebSocket closed"));
    });
  }

  push(message) {
    if (this.waiters.length > 0) {
      const waiter = this.waiters.shift();
      clearTimeout(waiter.timer);
      waiter.resolve(message);
      return;
    }

    this.queue.push(message);
  }

  fail(error) {
    if (this.closed) {
      return;
    }

    this.closed = true;
    while (this.waiters.length > 0) {
      const waiter = this.waiters.shift();
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
  }

  async send(payload) {
    if (this.closed) {
      throw new Error("WebSocket is closed");
    }

    const frame = buildWebSocketFrame(payload);
    await new Promise((resolve, reject) => {
      this.socket.write(frame, (error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  }

  nextMessage(timeoutMs = 5000) {
    if (this.queue.length > 0) {
      return Promise.resolve(this.queue.shift());
    }

    if (this.closed) {
      return Promise.reject(new Error("WebSocket is closed"));
    }

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((waiter) => waiter.resolve !== resolve);
        reject(new Error("Timed out waiting for WebSocket message"));
      }, timeoutMs);

      this.waiters.push({ resolve, reject, timer });
    });
  }

  close() {
    if (this.closed) {
      return;
    }

    try {
      this.socket.end(buildWebSocketFrame(Buffer.alloc(0), 0x8));
    } catch {
      this.socket.destroy();
    }
    this.fail(new Error("WebSocket closed"));
  }
}

async function requestJson(url, timeoutMs = 5000, options = {}) {
  const target = new URL(url);
  const networkModule = getNetworkModule(target.protocol);
  const method = options.method ?? "GET";

  return new Promise((resolve, reject) => {
    const requestOptions = {
      hostname: target.hostname,
      port: target.port || (target.protocol === "https:" ? 443 : 80),
      path: `${target.pathname}${target.search}`,
      method,
      timeout: timeoutMs,
    };

    if (networkModule === https) {
      requestOptions.rejectUnauthorized = false;
    }

    const req = networkModule.request(requestOptions, (res) => {
      let data = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        data += chunk;
      });
      res.on("end", () => {
        if ((res.statusCode ?? 500) < 200 || (res.statusCode ?? 500) >= 300) {
          reject(new Error(`HTTP ${res.statusCode} for ${url}`));
          return;
        }

        try {
          resolve(JSON.parse(data));
        } catch (error) {
          reject(new Error(`Failed to parse JSON from ${url}: ${error.message}`));
        }
      });
    });

    req.on("timeout", () => {
      req.destroy(new Error(`Request timed out: ${method} ${url}`));
    });
    req.on("error", reject);
    req.end();
  });
}

async function openWebSocket(url, timeoutMs = 5000) {
  const target = new URL(url);
  const networkModule = getNetworkModule(target.protocol);
  const headers = {
    Connection: "Upgrade",
    Upgrade: "websocket",
    "Sec-WebSocket-Version": "13",
    "Sec-WebSocket-Key": randomBytes(16).toString("base64"),
  };

  return new Promise((resolve, reject) => {
    const requestOptions = {
      hostname: target.hostname,
      port: target.port || (target.protocol === "wss:" ? 443 : 80),
      path: `${target.pathname}${target.search}`,
      method: "GET",
      headers,
      timeout: timeoutMs,
    };

    if (networkModule === https) {
      requestOptions.rejectUnauthorized = false;
    }

    const req = networkModule.request(requestOptions);

    req.on("upgrade", (_response, socket) => {
      resolve(new SimpleWebSocketClient(socket));
    });

    req.on("response", (response) => {
      response.resume();
      reject(new Error(`WebSocket upgrade failed: ${response.statusCode}`));
    });

    req.on("timeout", () => {
      req.destroy(new Error(`WebSocket timed out: ${url}`));
    });
    req.on("error", reject);
    req.end();
  });
}

async function sendRemoteDebugCommand(target, method, params = {}, options = {}) {
  const ws = await openWebSocket(target.webSocketDebuggerUrl, options?.timeoutMs ?? 5000);

  let msgId = 0;
  const pending = new Map();

  const consumeMessages = async () => {
    while (true) {
      const message = await ws.nextMessage(options?.timeoutMs ?? 5000);
      if (message === null) {
        return;
      }

      const payload = JSON.parse(message);
      const item = pending.get(payload.id);
      if (!item) {
        continue;
      }

      pending.delete(payload.id);
      if (payload.error) {
        item.reject(new Error(JSON.stringify(payload.error)));
      } else {
        item.resolve(payload.result);
      }
    }
  };

  const consumer = consumeMessages().catch((error) => {
    for (const item of pending.values()) {
      item.reject(error);
    }
    pending.clear();
  });

  const id = ++msgId;
  const result = await new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params })).catch((error) => {
      pending.delete(id);
      reject(error);
    });
  });

  ws.close();
  await consumer.catch(() => {});

  return {
    target,
    result,
  };
}

function encodeLaunchTwfId(sessionId) {
  const key = Buffer.from("_salt_for_twfid_", "utf8");
  const input = Buffer.from(sessionId, "utf8");
  const blockSize = 16;
  const remainder = input.length % blockSize;
  const paddingLength = remainder === 0 ? 0 : blockSize - remainder;
  const padded = Buffer.concat([input, Buffer.alloc(paddingLength, 0)]);
  const cipher = createCipheriv("aes-128-ecb", key, null);
  cipher.setAutoPadding(false);
  return cipher.update(padded).toString("base64") + cipher.final("base64");
}

function buildPortalPasswordLoginExpression(username, password) {
  return `(() => {
      const vm = window.avalon && window.avalon.vmodels && window.avalon.vmodels.password;
      if (!vm) return { ok: false, reason: "password vm missing" };
      vm.username = ${JSON.stringify(username)};
      vm.password = ${JSON.stringify(password)};
      setTimeout(() => vm.login(), 0);
      return {
        ok: true,
        username: vm.username,
        passwordLength: vm.password.length,
        scheduled: true
      };
    })()`;
}

function buildPortalPasswordVmStateExpression() {
  return `(() => {
      const vmodels = window.avalon && window.avalon.vmodels;
      const vm = vmodels && vmodels.password;
      return {
        hasAvalon: !!window.avalon,
        hasPasswordVm: !!vm,
        username: vm ? vm.username : null,
        loading: vm ? !!vm.loading : false,
        href: location.href
      };
    })()`;
}

function buildPortalOfficialAuthStateExpression() {
  return `(() => {
      const readGlobal = (key) => {
        try {
          return window.SF && SF.setting && typeof SF.setting.getGlobal === "function"
            ? SF.setting.getGlobal(key, "")
            : "";
        } catch {
          return "";
        }
      };
      const readTwfID = () => {
        try {
          const session = window.SF && SF.session && SF.session.createInstance
            ? SF.session.createInstance()
            : null;
          return session && typeof session.getTWFID === "function"
            ? String(session.getTWFID() || "").length
            : 0;
        } catch {
          return 0;
        }
      };
      const vmodels = window.avalon && window.avalon.vmodels;
      const vm = vmodels && vmodels.password;
      return {
        href: location.href,
        title: document.title,
        readyState: document.readyState,
        hasSF: !!window.SF,
        hasAuth: !!(window.SF && SF.auth && typeof SF.auth.getLoginConfig === "function" && typeof SF.auth.authPsw === "function"),
        hasSFAPI: !!(window.SFAPI && typeof SFAPI.getPswConfig === "function" && typeof SFAPI.loginPsw === "function"),
        hasSetting: !!(window.SF && SF.setting && typeof SF.setting.getGlobal === "function"),
        hasSession: !!(window.SF && SF.session && typeof SF.session.createInstance === "function"),
        hasVpnInfo: !!(window.SF && SF.vpnInfo && typeof SF.vpnInfo.createInstance === "function"),
        hasAvalon: !!window.avalon,
        hasPasswordVm: !!vm,
        loading: vm ? !!vm.loading : false,
        csrfLength: String(readGlobal(KEY_GLOBAL_CSRF_RAND_CODE) || "").length,
        encryptKeyLength: String(readGlobal(KEY_GLOBAL_ENCRYPT_KEY) || "").length,
        twfIDLength: readTwfID()
      };
    })()`;
}

function isPortalLoginAuthBridgeReady(probe = {}, targetUrlPart = "/portal/#!/login") {
  const href = `${probe?.href ?? ""}`;
  const title = `${probe?.title ?? ""}`;

  return (
    href.includes(targetUrlPart) &&
    !/^Loading\.\.\.$/i.test(title.trim()) &&
    probe?.hasAuth === true &&
    probe?.hasSFAPI === true &&
    probe?.hasSetting === true &&
    probe?.hasSession === true
  );
}

function isBrokenRemoteDebugPageTarget(target = {}) {
  const url = `${target?.url ?? ""}`;
  const title = `${target?.title ?? ""}`.trim();

  return (
    /^Loading\.\.\.$/i.test(title) ||
    url.includes("/local/connect_notfound/connect_notfound.html") ||
    url.includes("/local/vpn_logout_passive/") ||
    url.includes("/local/local_exception/") ||
    url.includes("/local/error/")
  );
}

function isReusableRemoteDebugPageTargetCandidate(target = {}) {
  const url = `${target?.url ?? ""}`;

  return (
    url.includes("/portal/#!/service") ||
    url.includes("/portal/#!/login") ||
    url.includes("/portal/#!/user_setting_box")
  );
}

function buildPortalOfficialPasswordLoginExpression(username, password, captcha = "") {
  return `(() => {
      const username = ${JSON.stringify(username)};
      const password = ${JSON.stringify(password)};
      const randCode = ${JSON.stringify(captcha)};
      const timeout = (stage, ms) => new Promise((resolve) => {
        setTimeout(() => resolve({ ok: false, reason: stage + " timeout" }), ms);
      });
      const withTimeout = (stage, promise, ms) => Promise.race([promise, timeout(stage, ms)]);
      const readGlobalLength = (key) => {
        try {
          return String(SF.setting.getGlobal(key, "") || "").length;
        } catch {
          return 0;
        }
      };
      const readSessionTWFIDLength = () => {
        try {
          const session = SF.session.createInstance();
          return String(session.getTWFID && session.getTWFID() || "").length;
        } catch {
          return 0;
        }
      };
      const simplifyError = (error) => {
        if (!error) return {};
        return {
          code: error.code ?? error.result ?? null,
          msg: error.msg ?? error.message ?? error.ErrorMsg ?? "",
          type: error.type ?? ""
        };
      };

      return (async () => {
        try {
          if (!window.SF || !SF.auth || typeof SF.auth.getLoginConfig !== "function" || typeof SF.auth.authPsw !== "function") {
            return { ok: false, reason: "official auth bridge missing", href: location.href };
          }
          if (!window.SFAPI || typeof SFAPI.getPswConfig !== "function" || typeof SFAPI.loginPsw !== "function") {
            return { ok: false, reason: "official password api missing", href: location.href };
          }
          if (!SF.setting || typeof SF.setting.getGlobal !== "function" || !SF.session || typeof SF.session.createInstance !== "function") {
            return { ok: false, reason: "official session/settings bridge missing", href: location.href };
          }

          const before = {
            href: location.href,
            csrfLength: readGlobalLength(KEY_GLOBAL_CSRF_RAND_CODE),
            encryptKeyLength: readGlobalLength(KEY_GLOBAL_ENCRYPT_KEY),
            sessionTWFIDLength: readSessionTWFIDLength()
          };

          try {
            if (SF.vpnInfo && typeof SF.vpnInfo.createInstance === "function") {
              const vpnInfo = SF.vpnInfo.createInstance();
              if (vpnInfo && typeof vpnInfo.saveTempLoginInfo === "function") {
                vpnInfo.saveTempLoginInfo({
                  userName: username,
                  savePwd: false,
                  autoLogin: false,
                  showRc: true
                });
              }
            }
          } catch (error) {
            // Temp login info helps official follow-up pages, but password auth can still proceed without it.
          }

          const passwordConfig = await withTimeout("auth.getLoginConfig", new Promise((resolve) => {
            let settled = false;
            const finish = (value) => {
              if (!settled) {
                settled = true;
                resolve(value);
              }
            };
            SF.auth.getLoginConfig({
              preventOnError: true,
              onGetPswConfig: (data) => finish({
                ok: true,
                enableRandCode: data && data.enableRandCode,
                enableMidAtkCheck: data && data.enableMidAtkCheck,
                csrfRandCodeLength: String(data && data.csrfRandCode || "").length,
                encryptKeyLength: String(data && data.encryptKey || "").length
              }),
              success: (value) => finish({ ok: true, value: !!value }),
              error: (error) => finish({
                ok: false,
                reason: "auth.getLoginConfig failed",
                error: simplifyError(error)
              })
            });
          }), 20000);

          if (!passwordConfig || !passwordConfig.ok) {
            return {
              ok: false,
              reason: passwordConfig && passwordConfig.reason || "auth.getLoginConfig failed",
              passwordConfig,
              before,
              href: location.href
            };
          }

          const auth = await withTimeout("auth.authPsw", new Promise((resolve) => {
            let settled = false;
            const finish = (value) => {
              if (!settled) {
                settled = true;
                resolve(value);
              }
            };
            SF.auth.authPsw({
              preventOnError: true,
              notCheck: true,
              userName: username,
              password,
              randCode,
              success: (result) => {
                const data = result && result.data || {};
                finish({
                  ok: true,
                  code: result && result.code,
                  nextService: data.nextService || "",
                  twfIDLength: String(data.twfID || "").length,
                  sessionTWFIDLength: readSessionTWFIDLength(),
                  href: location.href
                });
              },
              error: (error) => finish({
                ok: false,
                reason: "auth.authPsw failed",
                error: simplifyError(error),
                sessionTWFIDLength: readSessionTWFIDLength(),
                href: location.href
              })
            });
          }), 70000);

          if (!auth || !auth.ok) {
            return {
              ok: false,
              reason: auth && auth.reason || "auth.authPsw failed",
              before,
              passwordConfig,
              auth,
              href: location.href
            };
          }

          return {
            ok: true,
            before,
            passwordConfig,
            auth,
            href: location.href
          };
        } catch (error) {
          return {
            ok: false,
            reason: "official renderer password login failed",
            error: String(error && error.message || error),
            href: location.href
          };
        }
      })();
    })()`;
}

function buildPortalOfficialServiceStartExpression(username = "") {
  return `(() => {
      const username = ${JSON.stringify(username)};
      const timeout = (stage, ms) => new Promise((resolve) => {
        setTimeout(() => resolve({ ok: false, reason: stage + " timeout" }), ms);
      });
      const withTimeout = (stage, promise, ms) => Promise.race([promise, timeout(stage, ms)]);
      const pickServiceData = (data) => {
        if (!data || typeof data !== "object") return {};
        return {
          base: data.base ?? null,
          allService: data.allService ?? null,
          tcp: data.tcp ?? null,
          l3vpn: data.l3vpn ?? null,
          validTime: data.validTime ?? null
        };
      };
      const simplifyError = (error) => {
        if (!error) return {};
        return {
          code: error.code ?? error.result ?? null,
          msg: error.msg ?? error.message ?? error.ErrorMsg ?? "",
          type: error.type ?? "",
          data: pickServiceData(error.data)
        };
      };
      const readTwfID = () => {
        try {
          const session = SF.session.createInstance();
          return String(session.getTWFID && session.getTWFID() || "");
        } catch {
          return "";
        }
      };
      const parseGateway = () => {
        const parsed = new URL(location.href);
        return {
          vpnURL: parsed.protocol + "//" + parsed.host,
          host: parsed.hostname,
          port: parsed.port || (parsed.protocol === "https:" ? "443" : "80"),
          protocol: parsed.protocol
        };
      };
      const callCallbackApi = (stage, invoke, ms = 10000) => withTimeout(stage, new Promise((resolve) => {
        let settled = false;
        const finish = (value) => {
          if (!settled) {
            settled = true;
            resolve(value);
          }
        };
        try {
          invoke(finish);
        } catch (error) {
          finish({
            ok: false,
            reason: stage + " threw",
            error: String(error && error.message || error)
          });
        }
      }), ms);

      return (async () => {
        try {
          if (!window.SF || !SF.session || typeof SF.session.createInstance !== "function") {
            return { ok: false, reason: "official session bridge missing", href: location.href };
          }
          if (!window.SFAPI || typeof SFAPI.setTWFID !== "function" || typeof SFAPI.startService !== "function" ||
              typeof SFAPI.doConfigEC !== "function") {
            return { ok: false, reason: "official service bridge missing", href: location.href };
          }
          if (!SF.setting || typeof SF.setting.setGlobal !== "function" || typeof SF.setting.setShm !== "function") {
            return { ok: false, reason: "official setting bridge missing", href: location.href };
          }

          const loginInfo = {
            ok: false,
            username: username || "",
            persisted: false,
            tempPersisted: false,
            synced: false
          };
          const gateway = parseGateway();
          const session = SF.session.createInstance();
          const port = SF.setting.getGlobal(KEY_GLOBAL_EC_PORT, 0) || 0;
          const baseInfo = {
            loginClientType: SFConfig.container || 3,
            port,
            vpnURL: gateway.vpnURL,
            fromURL: gateway.vpnURL,
            browserType: "default",
            loginName: username || "",
            trayType: 1,
            lang: SF.setting.getGlobal(KEY_GLOBAL_LANG, "zh_CN") || "zh_CN",
            securityCheck: false,
            strategies: []
          };

          SF.setting.setGlobal([
            { key: KEY_GLOBAL_LOGIN_CLIENT_TYPE, value: SFConfig.container || 3 },
            { key: KEY_GLOBAL_VPN_URL, value: gateway.vpnURL },
            { key: KEY_GLOBAL_FROM_URL, value: gateway.vpnURL },
            { key: KEY_GLOBAL_VPN_IP, value: gateway.host },
            { key: KEY_GLOBAL_VPN_PORT, value: gateway.port },
            { key: KEY_GLOBAL_VPN_PROTOCOL, value: gateway.protocol },
            { key: KEY_GLOBAL_LOGIN_NAME, value: username || "" },
            { key: KEY_GLOBAL_TRAY_TYPE, value: 1 },
            { key: KEY_GLOBAL_SECURITY_CHECK, value: false },
            { key: KEY_GLOBAL_SECURITY_STRATEGIES, value: [] }
          ], 0);
          if (username && window.SF && SF.vpnInfo && typeof SF.vpnInfo.createInstance === "function") {
            try {
              const vpnInfo = SF.vpnInfo.createInstance();
              const nextLoginInfo = {
                userName: username,
                savePwd: false,
                autoLogin: false,
                showRc: true
              };
              if (vpnInfo && typeof vpnInfo.saveTempLoginInfo === "function") {
                vpnInfo.saveTempLoginInfo(nextLoginInfo);
                loginInfo.tempPersisted = true;
              }
              if (vpnInfo && typeof vpnInfo.saveLoginInfo === "function") {
                vpnInfo.saveLoginInfo(nextLoginInfo);
                loginInfo.persisted = true;
              }
              if (vpnInfo && typeof vpnInfo.syncLoginInfo === "function") {
                vpnInfo.syncLoginInfo();
                loginInfo.synced = true;
              }
              if (vpnInfo && typeof vpnInfo.setLastVPNURL === "function") {
                vpnInfo.setLastVPNURL(gateway.vpnURL);
              }
              loginInfo.ok = loginInfo.persisted || loginInfo.tempPersisted || loginInfo.synced;
            } catch (error) {
              loginInfo.error = String(error && error.message || error);
            }
          }

          const twfID = readTwfID();
          const before = {
            href: location.href,
            twfIDLength: twfID.length,
            loginInfo
          };

          if (!twfID) {
            return {
              ok: false,
              reason: "official session twfid missing",
              before,
              href: location.href
            };
          }

          const setTwf = await withTimeout("SFAPI.setTWFID", new Promise((resolve) => {
            let settled = false;
            const finish = (value) => {
              if (!settled) {
                settled = true;
                resolve(value);
              }
            };

            SFAPI.setTWFID({
              twfID,
              isForce: true,
              success: (result) => finish({
                ok: true,
                code: result && result.code,
                twfIDLength: twfID.length
              }),
              error: (error) => finish({
                ok: false,
                reason: "SFAPI.setTWFID failed",
                error: simplifyError(error),
                twfIDLength: twfID.length
              })
            });
          }), 20000);

          if (!setTwf || !setTwf.ok) {
            return {
              ok: false,
              reason: setTwf && setTwf.reason || "SFAPI.setTWFID failed",
              before,
              setTwf,
              href: location.href
            };
          }

          const preparation = [];
          const syncSession = await callCallbackApi("session.syncSession", (finish) => {
            if (session && typeof session.syncSession === "function") {
              session.syncSession(() => finish({ ok: true }));
            } else {
              finish({ ok: false, reason: "session.syncSession missing" });
            }
          }, 10000);
          preparation.push({ stage: "session.syncSession", result: syncSession });
          if (!syncSession || !syncSession.ok) {
            return {
              ok: false,
              reason: syncSession && syncSession.reason || "session.syncSession failed",
              before,
              setTwf,
              preparation,
              href: location.href
            };
          }

          const setBaseInfo = await callCallbackApi("SF.setting.setShm(KEY_VPN_BASE_INFO)", (finish) => {
            SF.setting.setShm({ key: KEY_VPN_BASE_INFO, value: baseInfo }, (ok) => {
              finish({ ok: !!ok });
            });
          }, 10000);
          preparation.push({
            stage: "SF.setting.setShm(KEY_VPN_BASE_INFO)",
            result: setBaseInfo,
            loginName: baseInfo.loginName,
            vpnURL: baseInfo.vpnURL,
            port: baseInfo.port
          });
          if (!setBaseInfo || !setBaseInfo.ok) {
            return {
              ok: false,
              reason: "SF.setting.setShm(KEY_VPN_BASE_INFO) failed",
              before,
              setTwf,
              preparation,
              href: location.href
            };
          }

          const configureClient = async (key, params) => {
            const result = await callCallbackApi("SFAPI.doConfigEC(" + key + ")", (finish) => {
              SFAPI.doConfigEC({
                key,
                params,
                success: (value) => finish({ ok: true, code: value && value.code }),
                error: (error) => finish({
                  ok: false,
                  reason: "SFAPI.doConfigEC(" + key + ") failed",
                  error: simplifyError(error)
                })
              });
            }, 10000);
            preparation.push({ stage: "SFAPI.doConfigEC(" + key + ")", result });
            return result;
          };
          const serverAddr = gateway.host + " " + gateway.port;
          const setServerAddr = await configureClient("S_SERVADDR", { address: serverAddr });
          if (!setServerAddr || !setServerAddr.ok) {
            return {
              ok: false,
              reason: setServerAddr && setServerAddr.reason || "SFAPI.doConfigEC(S_SERVADDR) failed",
              before,
              setTwf,
              preparation,
              href: location.href
            };
          }
          const setLoginAddr = await configureClient("S_LOGINADDR", { vpnLine: gateway.vpnURL });
          if (!setLoginAddr || !setLoginAddr.ok) {
            return {
              ok: false,
              reason: setLoginAddr && setLoginAddr.reason || "SFAPI.doConfigEC(S_LOGINADDR) failed",
              before,
              setTwf,
              preparation,
              href: location.href
            };
          }

          const states = [];
          const startService = await withTimeout("SFAPI.startService", new Promise((resolve) => {
            let settled = false;
            const finish = (value) => {
              if (!settled) {
                settled = true;
                resolve(value);
              }
            };
            const pushEvent = (event, data = {}) => {
              states.push({
                event,
                at: Date.now(),
                ...data
              });
            };

            SFAPI.startService({
              onBeforeQuery: () => Promise.resolve(),
              onTcpFinished: () => pushEvent("tcpFinished"),
              onL3vpnFinished: () => pushEvent("l3vpnFinished"),
              onStateChanged: (state) => pushEvent("state", { state: pickServiceData(state) }),
              success: (result) => finish({
                ok: true,
                code: result && result.code,
                data: pickServiceData(result && result.data),
                states
              }),
              error: (error) => finish({
                ok: false,
                reason: "SFAPI.startService failed",
                error: simplifyError(error),
                data: pickServiceData(error && error.data),
                states
              })
            });
          }), 90000);

          if (!startService || !startService.ok) {
            return {
              ok: false,
              reason: startService && startService.reason || "SFAPI.startService failed",
              before,
              setTwf,
              preparation,
              startService,
              states: startService && startService.states || states,
              href: location.href
            };
          }

          return {
            ok: true,
            before,
            setTwf,
            preparation,
            startService,
            states: startService.states || states,
            href: location.href
          };
        } catch (error) {
          return {
            ok: false,
            reason: "official portal service start failed",
            error: String(error && error.message || error),
            href: location.href
          };
        }
      })();
    })()`;
}

function buildContainerConfigReadExpression(key) {
  return `(() => new Promise((resolve) => {
      if (typeof window.ecReadConfig !== "function") {
        resolve({ ok: false, reason: "ecReadConfig missing", key: ${JSON.stringify(key)} });
        return;
      }
      window.ecReadConfig(${JSON.stringify(key)}, (value) => {
        let parsed = value;
        try {
          parsed = JSON.parse(value);
        } catch {}
        resolve({ ok: true, key: ${JSON.stringify(key)}, value: parsed });
      });
    }))()`;
}

function normalizeContainerWriteValue(value, fallback = "") {
  return value === undefined ? fallback : value;
}

function normalizeContainerRuntimeWriteSpec(writeSpec) {
  const [keyPath, value, persist = 0] = writeSpec;
  return [keyPath, normalizeContainerWriteValue(value), persist];
}

function buildContainerConfigWriteExpression(key, value, options = {}) {
  const normalizedValue = normalizeContainerWriteValue(value);
  const serializedValue = typeof normalizedValue === "string"
    ? normalizedValue
    : JSON.stringify(normalizedValue);
  const awaitCallback = options.awaitCallback ?? true;

  if (!awaitCallback) {
    return `(() => {
      if (typeof window.ecWriteConfig !== "function") {
        return { ok: false, reason: "ecWriteConfig missing", key: ${JSON.stringify(key)} };
      }
      try {
        window.ecWriteConfig(${JSON.stringify(key)}, ${JSON.stringify(serializedValue)}, () => {});
        return { ok: true, key: ${JSON.stringify(key)}, scheduled: true };
      } catch (error) {
        return { ok: false, key: ${JSON.stringify(key)}, error: String(error) };
      }
    })()`;
  }

  return `(() => new Promise((resolve) => {
      if (typeof window.ecWriteConfig !== "function") {
        resolve({ ok: false, reason: "ecWriteConfig missing", key: ${JSON.stringify(key)} });
        return;
      }
      window.ecWriteConfig(${JSON.stringify(key)}, ${JSON.stringify(serializedValue)}, (result) => {
        let parsed = result;
        try {
          parsed = JSON.parse(result);
        } catch {}
        resolve({ ok: true, key: ${JSON.stringify(key)}, result: parsed });
      });
    }))()`;
}

function buildContainerRuntimeReadExpression(keyPath) {
  return `(() => {
      if (typeof window.ecGet !== "function") {
        return { ok: false, reason: "ecGet missing", keyPath: ${JSON.stringify(keyPath)} };
      }
      let value = null;
      try {
        value = window.ecGet(${JSON.stringify(keyPath)});
      } catch (error) {
        return { ok: false, keyPath: ${JSON.stringify(keyPath)}, error: String(error) };
      }
      return { ok: true, keyPath: ${JSON.stringify(keyPath)}, value };
    })()`;
}

function buildContainerRuntimeWriteExpression(keyPath, value, persist = 0) {
  const normalizedValue = normalizeContainerWriteValue(value);
  return `(() => {
      if (typeof window.ecSet !== "function") {
        return { ok: false, reason: "ecSet missing", keyPath: ${JSON.stringify(keyPath)} };
      }
      let result = null;
      try {
        result = window.ecSet(${JSON.stringify(keyPath)}, ${JSON.stringify(normalizedValue)}, ${persist});
      } catch (error) {
        return { ok: false, keyPath: ${JSON.stringify(keyPath)}, error: String(error) };
      }
      return { ok: true, keyPath: ${JSON.stringify(keyPath)}, result };
    })()`;
}

function buildContainerRuntimeBatchWriteExpression(writeSpecs) {
  const normalizedWriteSpecs = writeSpecs.map((entry) => ({
    keyPath: entry.keyPath,
    value: normalizeContainerWriteValue(entry.value),
    persist: entry.persist ?? 0,
  }));
  return `(() => {
      if (typeof window.ecSet !== "function") {
        return { ok: false, reason: "ecSet missing", writes: [] };
      }
      const writes = ${JSON.stringify(normalizedWriteSpecs)};
      const results = [];
      for (const entry of writes) {
        try {
          results.push({
            ok: true,
            keyPath: entry.keyPath,
            persist: entry.persist,
            result: window.ecSet(entry.keyPath, entry.value, entry.persist),
          });
        } catch (error) {
          results.push({
            ok: false,
            keyPath: entry.keyPath,
            persist: entry.persist,
            error: String(error),
          });
          return { ok: false, writes: results };
        }
      }
      return { ok: true, writes: results };
    })()`;
}

function buildPageBridgeBootstrapExpression(context) {
  const {
    sessionId,
    gatewayHost,
    gatewayPort,
    username = "",
    browserType = "default",
    lang = "zh_CN",
    loginClientType = 3,
    trayType = 1,
    securityCheck = false,
    strategies = [],
  } = context ?? {};

  return `(async () => {
      const fail = (reason, extra = {}) => ({ ok: false, reason, ...extra });
      const withTimeout = (stage, promise, ms = 10000) => Promise.race([
        promise,
        new Promise((_, reject) => setTimeout(() => reject(new Error(stage + " timeout")), ms)),
      ]);
      if (typeof window.SF === "undefined" || !SF.setting || !SF.session || !SFAPI || !SF.res || !SF.vpnInfo) {
        return fail("SF bridge missing");
      }

      const session = SF.session.createInstance();
      const vpnInfo = SF.vpnInfo.createInstance();
      if (!session || typeof session.setTWFID !== "function") {
        return fail("session api missing");
      }
      if (!vpnInfo || typeof vpnInfo.saveTempLoginInfo !== "function") {
        return fail("vpnInfo api missing");
      }

      const vpnURL = ${JSON.stringify(`https://${gatewayHost}:${gatewayPort}`)};
      const baseInfo = {
        loginClientType: ${JSON.stringify(loginClientType)},
        port: SF.setting.getGlobal(KEY_GLOBAL_EC_PORT, 54530),
        vpnURL,
        fromURL: vpnURL,
        browserType: ${JSON.stringify(browserType)},
        loginName: ${JSON.stringify(username)},
        trayType: ${JSON.stringify(trayType)},
        lang: ${JSON.stringify(lang)},
        securityCheck: ${JSON.stringify(securityCheck)},
        strategies: ${JSON.stringify(strategies)}
      };

      SF.setting.setGlobal([
        { key: KEY_GLOBAL_LOGIN_CLIENT_TYPE, value: ${JSON.stringify(loginClientType)} },
        { key: KEY_GLOBAL_VPN_URL, value: vpnURL },
        { key: KEY_GLOBAL_FROM_URL, value: vpnURL },
        { key: KEY_GLOBAL_VPN_IP, value: ${JSON.stringify(gatewayHost)} },
        { key: KEY_GLOBAL_VPN_PORT, value: ${JSON.stringify(gatewayPort)} },
        { key: KEY_GLOBAL_VPN_PROTOCOL, value: "https:" },
        { key: KEY_GLOBAL_LOGIN_NAME, value: ${JSON.stringify(username)} },
        { key: KEY_GLOBAL_TRAY_TYPE, value: ${JSON.stringify(trayType)} },
        { key: KEY_GLOBAL_SECURITY_CHECK, value: ${JSON.stringify(securityCheck)} },
        { key: KEY_GLOBAL_SECURITY_STRATEGIES, value: ${JSON.stringify(strategies)} }
      ], 0);
      SF.setting.setGlobal({ key: KEY_GLOBAL_LANG, value: ${JSON.stringify(lang)} }, 1);

      session.setTWFID(${JSON.stringify(sessionId)});
      vpnInfo.saveTempLoginInfo({
        userName: ${JSON.stringify(username)},
        savePwd: false,
        autoLogin: false,
        showRc: true
      });
      vpnInfo.setLastVPNURL(vpnURL);

      await withTimeout("setShm", new Promise((resolve, reject) => {
        SF.setting.setShm({ key: KEY_VPN_BASE_INFO, value: baseInfo }, (ok) => {
          if (ok) resolve(ok);
          else reject(new Error("setShm failed"));
        });
      }));

      await withTimeout("syncSession", new Promise((resolve) => {
        session.syncSession(() => resolve(true));
      }));

      const initResult = await withTimeout("res.init", new Promise((resolve, reject) => {
        SF.res.init({
          success: () => resolve({ ok: true }),
          error: (error) => reject(new Error(JSON.stringify({ stage: "res.init", error: error || {} }))),
          onOtherLogin: () => reject(new Error(JSON.stringify({ stage: "res.init", error: "other login" }))),
          onCheckSecurityDeny: (strategies, denyResult) =>
            reject(new Error(JSON.stringify({ stage: "res.init", error: "security deny", strategies, denyResult }))),
          onMustInstallClient: (reason) =>
            reject(new Error(JSON.stringify({ stage: "res.init", error: "must install client", reason }))),
        });
      }));

      const startResult = await withTimeout("res.startService", new Promise((resolve, reject) => {
        SF.res.startService({
          onBeforeQuery: () => Promise.resolve(true),
          onTcpFinished: () => {},
          onL3vpnFinished: () => {},
          onStateChanged: () => {},
          success: (value) => resolve(value),
          error: (error) => reject(new Error(JSON.stringify({ stage: "res.startService", error: error || {} }))),
          onLogout: () => reject(new Error(JSON.stringify({ stage: "res.startService", error: "logout" }))),
        });
      }));

      return {
        ok: true,
        sessionId: session.getTWFID(),
        token: session.getToken(),
        vpnURL: SF.setting.getGlobal(KEY_GLOBAL_VPN_URL, ""),
        loginName: SF.setting.getGlobal(KEY_GLOBAL_LOGIN_NAME, ""),
        initResult,
        startResult
      };
    })()`;
}

function buildPortalRouteRedirectExpression(targetUrl) {
  return `(() => {
      location.href = ${JSON.stringify(targetUrl)};
      return {
        ok: true,
        href: location.href
      };
    })()`;
}

function buildPortalReloadExpression() {
  return `(() => {
      const beforeHref = location.href;
      setTimeout(() => location.reload(), 0);
      return {
        ok: true,
        beforeHref,
        href: location.href
      };
    })()`;
}

function buildPortalCookieWriteExpression(name, value, options = {}) {
  const path = options.path ?? "/";
  const extras = options.extras ?? [];
  const cookieParts = [`${name}=${value}`, `path=${path}`, ...extras];
  return `(() => {
      document.cookie = ${JSON.stringify(cookieParts.join("; "))};
      return {
        ok: true,
        cookie: document.cookie
      };
    })()`;
}

function toPortalFlag(value, defaultValue = 0) {
  if (value === undefined || value === null || value === "") {
    return defaultValue;
  }

  if (value === true || value === 1 || value === "1" || value === "true") {
    return 1;
  }

  if (value === false || value === 0 || value === "0" || value === "false") {
    return 0;
  }

  return value ? 1 : 0;
}

function buildPortalInitConfigData(configSummary = {}) {
  return {
    enableSavePwd: toPortalFlag(configSummary.enableSavePwd, 0),
    enableAutoLogin: toPortalFlag(configSummary.enableAutoLogin, 0),
    unforceInstallClient: toPortalFlag(configSummary.unforceInstallClient, 1),
    enableSecurityCheck: !!configSummary.enableSecurityCheck,
    enableMidAtkCheck: toPortalFlag(configSummary.enableMidAtkCheck ?? configSummary.midAtkCheck, 0),
    startAuth: configSummary.startAuth || configSummary.nextService || "auth/psw",
    domainSSOEnable: !!configSummary.domainSSOEnable,
  };
}

function buildPortalGlobalWriteSpecs(context, options = {}) {
  const {
    profile = "service",
  } = options;
  const {
    sessionId,
    gatewayHost,
    gatewayPort,
    username = "",
    browserType = "default",
    lang = "zh_CN",
    loginClientType = 3,
    trayType = 1,
    twfIDTmp = "",
    ecGuid = "",
    reloginStatus = 1,
    isFromEC = 1,
    hasTcpResource = false,
    hasRemoteApp = false,
    lastVPNURL = null,
    vpnURLList = null,
    initGetInitConfigData = null,
    passwordConfigSummary = null,
  } = context ?? {};

  if (!sessionId || !gatewayHost || !gatewayPort) {
    throw new Error("buildPortalGlobalWriteSpecs requires sessionId, gatewayHost, and gatewayPort");
  }

  const token = EasyConnectRuntime.deriveToken(sessionId);
  const vpnURL = `https://${gatewayHost}:${gatewayPort}`;
  const loginInitConfig = initGetInitConfigData ?? buildPortalInitConfigData(passwordConfigSummary ?? {});
  const allSpecs = [
    ["/global/sid", sessionId, 0],
    ["/global/ecToken", token, 0],
    ["/global/vpnURL", vpnURL, 0],
    ["/global/fromURL", vpnURL, 0],
    ["/global/vpnIP", gatewayHost, 0],
    ["/global/vpnPort", gatewayPort, 0],
    ["/global/VPNProtocol", "https:", 0],
    ["/global/loginName", username, 0],
    ["/global/browserType", browserType, 0],
    ["/global/lang", lang, 1],
    ["/global/loginClientType", loginClientType, 0],
    ["/global/trayType", trayType, 0],
    ["/global/twfIDTmp", twfIDTmp, 0],
    ["/global/ecGuid", ecGuid, 0],
    ["/global/reloginStatus", reloginStatus, 0],
    ["/global/isFromEC", isFromEC, 0],
    ["/global/hasTcpResource", hasTcpResource, 0],
    ["/global/hasRemoteApp", hasRemoteApp, 0],
    ["/global/lastVPNURL", lastVPNURL ?? vpnURL, 1],
    ["/global/vpnURLList", vpnURLList ?? [vpnURL], 1],
    ["/global/initGetInitConfigData", loginInitConfig, 0],
  ];
  const allowedKeysByProfile = {
    login: new Set([
      "/global/sid",
      "/global/ecToken",
      "/global/loginName",
      "/global/browserType",
      "/global/lang",
      "/global/loginClientType",
      "/global/trayType",
      "/global/twfIDTmp",
      "/global/ecGuid",
      "/global/reloginStatus",
      "/global/isFromEC",
    ]),
    service: null,
  };

  if (!(profile in allowedKeysByProfile)) {
    throw new Error(`Unsupported portal state profile: ${profile}`);
  }

  const allowedKeys = allowedKeysByProfile[profile];
  return {
    token,
    vpnURL,
    runtimeWriteSpecs: allowedKeys
      ? allSpecs.filter(([keyPath]) => allowedKeys.has(keyPath)).map(normalizeContainerRuntimeWriteSpec)
      : allSpecs.map(normalizeContainerRuntimeWriteSpec),
  };
}

function launchDetached(command, args) {
  const child = spawn(command, args, {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
  return child.pid ?? null;
}

function execFileAsync(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(command, args, options, (error, stdout, stderr) => {
      if (error) {
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
        return;
      }

      resolve({ stdout, stderr });
    });
  });
}

function sanitizeCommandOutput(text = "") {
  return `${text}`.trim().slice(0, 1200);
}

function sanitizeLogLine(line = "") {
  return `${line}`
    .replace(/(token|password|twfID|twfid|auth|session)[=:][^&"'\s]+/gi, "$1=<redacted>")
    .replace(/password:\s*'[^']+'/gi, "password: '<redacted>'")
    .replace(/token=[a-f0-9]{32}/gi, "token=<redacted>")
    .replace(/twfid=[^,\s]+/gi, "twfid=<redacted>");
}

async function readRecentLogLines(filePath, options = {}) {
  const limit = options.limit ?? 80;
  const maxBytes = options.maxBytes ?? 256 * 1024;

  try {
    const stat = await fs.stat(filePath);
    const start = Math.max(0, stat.size - maxBytes);
    const handle = await fs.open(filePath, "r");
    try {
      const buffer = Buffer.alloc(stat.size - start);
      await handle.read(buffer, 0, buffer.length, start);
      return buffer
        .toString("utf8")
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .slice(-limit)
        .map(sanitizeLogLine);
    } finally {
      await handle.close();
    }
  } catch {
    return [];
  }
}

function classifyRecoveryDiagnostics(diagnostics = {}) {
  const lines = [
    ...(diagnostics.officialLogs?.csclient ?? []),
    ...(diagnostics.officialLogs?.easyconnect ?? []),
    ...(diagnostics.officialLogs?.localServiceManager ?? []),
  ].join("\n");

  if (
    /crash_service run exception/i.test(lines) ||
    /uncaughtException/i.test(lines) ||
    /ERR_ASSERTION/i.test(lines) ||
    /Assert\(typeof value!?=?"undefined"\)/i.test(lines) ||
    /EasyConnect遇到严重错误/i.test(lines) ||
    /onResizeWindow failed, winID is not exist/i.test(lines)
  ) {
    return "official-ui-crashed";
  }

  if (
    /local service (CheckReady error|setup timeout)/i.test(lines) ||
    /LocalServiceConfManager/i.test(lines) ||
    /Register\(EC_EVENT_NAME_HEARTBEAT\)/i.test(lines)
  ) {
    return "local-service-not-ready";
  }

  return "unknown";
}

function isOfficialUiCrashDiagnostics(diagnostics) {
  if (diagnostics?.classification !== "official-ui-crashed") {
    return false;
  }

  if (typeof diagnostics?.collectedAt !== "number") {
    return true;
  }

  return Date.now() - diagnostics.collectedAt <= OFFICIAL_CRASH_DIAGNOSTIC_FRESH_MS;
}

function isLocalServiceNotReadyError(error) {
  return error?.code === "EASYCONNECT_LOCAL_SERVICE_NOT_READY" ||
    error?.diagnostics?.classification === "local-service-not-ready";
}

function getLogoutReasonCode(loginStatus) {
  return loginStatus?.logoutReasonDecoded?.data?.reason ??
    loginStatus?.logoutReasonDecoded?.reason ??
    null;
}

function createPrivateKickError(loginStatus, serviceState) {
  const reason = loginStatus?.logoutReasonDecoded?.data ?? loginStatus?.logoutReasonDecoded ?? {};
  const message = reason.msg ?? reason.message ?? "private same username login";
  const error = new Error(`EasyConnect logout detected: ${message}`);
  error.code = "EASYCONNECT_PRIVATE_KICK";
  error.loginStatus = loginStatus;
  error.serviceState = serviceState;
  return error;
}

function parseProcessList(stdout = "") {
  return `${stdout}`
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const match = line.match(/^(\d+)\s+(\d+)\s+(.+)$/);
      if (!match) {
        return null;
      }

      return {
        pid: Number.parseInt(match[1], 10),
        ppid: Number.parseInt(match[2], 10),
        command: match[3],
      };
    })
    .filter(Boolean);
}

function filterProcessesByExecutable(processes = [], executablePath = "") {
  return processes.filter((process) => {
    const command = process?.command ?? "";
    return command === executablePath || command.startsWith(`${executablePath} `);
  });
}

function parseLaunchctlPrintState(stdout = "") {
  const text = `${stdout}`;
  const state = text.match(/^\s*state\s*=\s*([^\n]+)$/m)?.[1]?.trim() ?? null;
  const pidText = text.match(/^\s*pid\s*=\s*(\d+)$/m)?.[1] ?? null;
  const runsText = text.match(/^\s*runs\s*=\s*(\d+)$/m)?.[1] ?? null;

  return {
    state,
    running: state === "running",
    pid: pidText ? Number.parseInt(pidText, 10) : null,
    runs: runsText ? Number.parseInt(runsText, 10) : null,
  };
}

function buildLaunchctlActionEntry({ action, ok, stdout = "", stderr = "", error = null, outputMode = "command" } = {}) {
  const entry = {
    action,
    ok,
  };

  if (outputMode === "launchctl-print") {
    entry.launchService = parseLaunchctlPrintState(stdout);
  } else {
    entry.stdout = sanitizeCommandOutput(stdout);
    entry.stderr = sanitizeCommandOutput(stderr);
  }

  if (error) {
    entry.error = error;
  }

  return entry;
}

function buildAgentProxyResetFinalState({ actions = [], launchService = null, processes = null } = {}) {
  const proxyProcesses = processes?.ecAgentProxy ?? [];
  const launchRunning = launchService?.running === true || launchService?.state === "running";
  const processRunning = proxyProcesses.length > 0;
  const running = launchRunning || processRunning;
  const failedActionNames = actions
    .filter((action) => !action.ok)
    .map((action) => action.action);

  return {
    ok: running,
    running,
    source: launchRunning ? "launchctl" : processRunning ? "process" : "none",
    state: launchService?.state ?? null,
    pid: launchService?.pid ?? proxyProcesses[0]?.pid ?? null,
    nonFatalActionFailures: running ? failedActionNames : [],
    fatalActionFailures: running ? [] : failedActionNames,
  };
}

function createAgentProxyNotReadyError(finalState = null) {
  const error = new Error("ECAgentProxy did not become ready before continuing EasyConnect recovery");
  error.code = "EASYCONNECT_AGENT_PROXY_NOT_READY";
  error.finalState = finalState;
  return error;
}

function createMainAppStillRunningError(processes = [], appExecutable = "") {
  const error = new Error("EasyConnect main app did not exit before relaunch");
  error.code = "EASYCONNECT_MAIN_APP_STILL_RUNNING";
  error.appExecutable = appExecutable;
  error.processes = processes;
  return error;
}

function createMainAppAlreadyRunningWithoutDebugError(processes = [], remoteDebugPort = null, appExecutable = "") {
  const error = new Error("EasyConnect is already running without a reusable remote-debug target");
  error.code = "EASYCONNECT_MAIN_APP_ALREADY_RUNNING_WITHOUT_DEBUG";
  error.appExecutable = appExecutable;
  error.remoteDebugPort = remoteDebugPort;
  error.processes = processes;
  return error;
}

function parseLsofHolders(stdout = "") {
  return `${stdout}`
    .split(/\r?\n/)
    .slice(1)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const columns = line.split(/\s+/);
      return {
        command: columns[0] ?? "",
        pid: Number.parseInt(columns[1] ?? "", 10) || null,
        user: columns[2] ?? "",
      };
    });
}

export class EasyConnectRuntime {
  constructor(options = {}) {
    this.host = options.host ?? DEFAULT_HOST;
    this.port = options.port ?? null;
    this.appExecutable = options.appExecutable ?? APP_EXECUTABLE;
  }

  static deriveToken(sessionId) {
    return createHash("md5").update(`${sessionId}${TOKEN_SALT}`, "utf8").digest("hex");
  }

  static redactToken(token) {
    return redactToken(token);
  }

  static encodeLaunchTwfId(sessionId) {
    return encodeLaunchTwfId(sessionId);
  }

  async getBundleSettingPath() {
    const bundleConfDir = getBundleConfDir(this.appExecutable);
    const userPath = path.join(bundleConfDir, `setting_${os.userInfo().username}.json`);
    if (await exists(userPath)) {
      return userPath;
    }

    const names = await fs.readdir(bundleConfDir);
    const fallback = names.find((name) => /^setting_.+\.json$/.test(name));
    return fallback ? path.join(bundleConfDir, fallback) : null;
  }

  async getBundleSetting() {
    const filePath = await this.getBundleSettingPath();
    if (!filePath) {
      return null;
    }

    return readJson(filePath);
  }

  async disableOfficialAutoConnectBeforeLaunch(options = {}) {
    const remoteDebugPort = options.remoteDebugPort ?? 9222;
    const remoteDebugTimeoutMs = options.remoteDebugTimeoutMs ?? 1200;
    const filePath = await this.getBundleSettingPath();
    let fileWrite = null;
    if (!filePath) {
      fileWrite = {
        ok: false,
        action: "skip",
        reason: "bundle setting file not found",
      };
    } else {
      const setting = await readJson(filePath);
      const previousValue = setting?.global?.notAutoConnect ?? null;
      setting.global = setting.global && typeof setting.global === "object" ? setting.global : {};
      let nextValue = null;
      if (Object.hasOwn(setting.global, "notAutoConnect")) {
        delete setting.global.notAutoConnect;
        await writeJsonAtomic(filePath, setting);
      }

      fileWrite = {
        ok: true,
        action: previousValue == null ? "already-enabled" : "enabled",
        filePath,
        key: "global.notAutoConnect",
        previousValue,
        value: nextValue,
      };
    }

    let liveWrite = null;
    try {
      const targets = await this.getRemoteDebugTargets(remoteDebugPort, { timeoutMs: remoteDebugTimeoutMs });
      const pageTargets = targets.filter((target) => target.type === "page" && target.webSocketDebuggerUrl);
      liveWrite = {
        ok: false,
        action: pageTargets.length ? "skipped-running-container-write" : "no-page-targets",
        reason: "Avoid writing global.notAutoConnect into a running container; EasyConnect asserts when the key exists in both persistent and temporary modes.",
        remoteDebugPort,
        targetCount: pageTargets.length,
      };
    } catch (error) {
      liveWrite = {
        ok: false,
        action: "unreachable",
        remoteDebugPort,
        error: error?.message ?? String(error),
      };
    }

    return {
      ...fileWrite,
      ok: Boolean(fileWrite?.ok || liveWrite?.ok),
      fileWrite,
      liveWrite,
    };
  }

  async getPort() {
    if (this.port) {
      return this.port;
    }

    const setting = await this.getBundleSetting();
    const rawPort = setting?.global?.ecPort;
    const port = Number.parseInt(rawPort ?? `${DEFAULT_PORT}`, 10);
    this.port = Number.isNaN(port) ? DEFAULT_PORT : port;
    return this.port;
  }

  async request(op, args = [], options = {}) {
    const token = options.token ?? "";
    const type = options.type ?? "WEB";
    const timeoutMs = options.timeoutMs ?? 3000;
    const port = options.port ?? (await this.getPort());

    const search = new URLSearchParams();
    search.set("op", op);
    args.forEach((arg, index) => {
      search.set(`arg${index + 1}`, String(arg));
    });
    search.set("type", type);
    search.set("token", token);

    const requestPath = `/ECAgent/?${search.toString()}`;

    const payload = await new Promise((resolve, reject) => {
      const req = https.request(
        {
          hostname: this.host,
          port,
          path: requestPath,
          method: "GET",
          rejectUnauthorized: false,
          timeout: timeoutMs,
        },
        (res) => {
          let data = "";
          res.setEncoding("utf8");
          res.on("data", (chunk) => {
            data += chunk;
          });
          res.on("end", () => resolve(data));
        },
      );

      req.on("timeout", () => {
        req.destroy(new Error(`Request timed out: ${requestPath}`));
      });
      req.on("error", reject);
      req.end();
    });

    try {
      return JSON.parse(payload);
    } catch (error) {
      throw new Error(`Failed to parse ECAgent response for ${op}: ${error.message}`);
    }
  }

  async validateToken(token) {
    if (!token) {
      return false;
    }

    const response = await this.request("DoQueryService", ["QUERY LOGINSTATUS"], {
      token,
      type: "WEB",
    });

    if (response?.result !== "1" || typeof response?.data?.status === "undefined") {
      return false;
    }

    return response.data.status === "1" || response.data.status === "2";
  }

  async discoverActiveToken() {
    const tokens = await extractTokensFromCache();

    for (const token of tokens) {
      try {
        if (await this.validateToken(token)) {
          return token;
        }
      } catch {
        // Ignore invalid historical tokens and continue scanning.
      }
    }

    return null;
  }

  async getSessionId(token) {
    const response = await this.request("DoQueryService", ["QUERY QSESSIONID"], {
      token,
      type: "WEB",
    });

    if (response?.result !== "1") {
      throw new Error(`Failed to get session id: ${JSON.stringify(response)}`);
    }

    return response.data.sessionID;
  }

  async getLoginStatus(token) {
    const response = await this.request("DoQueryService", ["QUERY LOGINSTATUS"], {
      token,
      type: "WEB",
    });

    if (response?.result !== "1") {
      throw new Error(`Failed to get login status: ${JSON.stringify(response)}`);
    }

    return {
      ...response.data,
      logoutReasonDecoded: decodeLogoutReason(response.data.logoutReason),
    };
  }

  async getServiceState(token) {
    const response = await this.request("DoQueryService", ["QUERY QSTATE ALLSERVICES"], {
      token,
      type: "WEB",
    });

    if (response?.result !== "1") {
      throw new Error(`Failed to get service state: ${JSON.stringify(response)}`);
    }

    return response.data;
  }

  async getLocalRuntimeInfo(token) {
    const response = await this.request("Getter", ["sfjssdklocal"], {
      token,
      type: "WEB",
    });

    if (response?.result !== "1") {
      throw new Error(`Failed to get local runtime info: ${JSON.stringify(response)}`);
    }

    return response.data;
  }

  async getGatewayConfig(token, type = "EC") {
    const response = await this.request("GetConfig", ["1"], {
      token,
      type,
      timeoutMs: 5000,
    });

    if (response?.result !== "1") {
      throw new Error(`Failed to get gateway config: ${JSON.stringify(response)}`);
    }

    return response.data;
  }

  async getResources(token, type = "EC") {
    const response = await this.request("GetConfig", ["2"], {
      token,
      type,
      timeoutMs: 5000,
    });

    if (response?.result !== "1") {
      throw new Error(`Failed to get resources: ${JSON.stringify(response)}`);
    }

    return response.data;
  }

  async getEncryptKey(token = "") {
    const response = await this.request("GetEncryptKey", [], {
      token,
      type: "EC",
    });

    if (!response?.result || typeof response.result !== "string") {
      throw new Error(`Failed to get encrypt key: ${JSON.stringify(response)}`);
    }

    return response.result;
  }

  async initAgent({ gatewayHost, gatewayPort, token }) {
    const response = await this.request("InitEcAgent", [`${gatewayHost} ${gatewayPort}`], {
      token: token ?? "",
      type: "EC",
      timeoutMs: 5000,
    });

    if (response?.result !== "1") {
      throw new Error(`InitEcAgent failed: ${JSON.stringify(response)}`);
    }

    return response;
  }

  async doXmlConfigure(step, token) {
    const response = await this.request("DoXmlConfigure", [String(step)], {
      token,
      type: "EC",
      timeoutMs: 5000,
    });

    if (response?.result !== "1") {
      throw new Error(`DoXmlConfigure(${step}) failed: ${JSON.stringify(response)}`);
    }

    return response;
  }

  async setTwfId(sessionId) {
    const token = EasyConnectRuntime.deriveToken(sessionId);
    const encryptKey = await this.getEncryptKey(token);
    const encryptedSession = encryptRsaPkcs1Hex(sessionId, encryptKey, DEFAULT_EXPONENT_HEX);
    const command = `SET TWFID ${encryptedSession}`;

    const response = await this.request("DoConfigure", [command], {
      token,
      type: "EC",
      timeoutMs: 5000,
    });

    if (response?.result !== "1") {
      throw new Error(`SET TWFID failed: ${JSON.stringify(response)}`);
    }

    return {
      token,
      command,
      response,
    };
  }

  async startService(token) {
    const response = await this.request("StartService", [], {
      token,
      type: "EC",
      timeoutMs: 5000,
    });

    if (response?.result !== "1") {
      throw new Error(`StartService failed: ${JSON.stringify(response)}`);
    }

    return response;
  }

  async getGatewayCandidates() {
    const candidates = [];
    const seen = new Set();

    const recentFromLog = await this.getRecentGatewayFromLogs();
    if (recentFromLog) {
      const key = `${recentFromLog.host}:${recentFromLog.port}`;
      seen.add(key);
      candidates.push(recentFromLog);
    }

    const activeToken = await this.discoverActiveToken();
    if (activeToken) {
      try {
        const gatewayConfig = await this.getGatewayConfig(activeToken);
        const mline = gatewayConfig?.Conf?.Mline?.list ?? "";
        for (const candidate of parseGatewayList(mline)) {
          const key = `${candidate.host}:${candidate.port}`;
          if (!seen.has(key)) {
            seen.add(key);
            candidates.push(candidate);
          }
        }
      } catch {
        // Keep best-effort discovery only.
      }
    }

    const bundleSetting = await this.getBundleSetting();
    const lastVpnUrl = bundleSetting?.global?.lastVPNURL;
    if (lastVpnUrl) {
      try {
        const normalized = JSON.parse(lastVpnUrl);
        const url = new URL(normalized);
        const candidate = {
          host: url.hostname,
          port: Number.parseInt(url.port, 10) || 443,
        };
        const key = `${candidate.host}:${candidate.port}`;
        if (!seen.has(key)) {
          seen.add(key);
          candidates.push(candidate);
        }
      } catch {
        // Ignore malformed persisted URLs.
      }
    }

    return candidates;
  }

  async getRecentGatewayFromLogs() {
    const logPath = path.join(LOGS_DIR, "CSClient.log");
    if (!(await exists(logPath))) {
      return null;
    }

    const content = await fs.readFile(logPath, "utf8");
    const matches = [...content.matchAll(/connect to server\(([^:]+):(\d+)\)/g)];
    if (matches.length === 0) {
      return null;
    }

    const last = matches.at(-1);
    return {
      host: last[1],
      port: Number.parseInt(last[2], 10),
    };
  }

  async describeActiveSession() {
    const token = await this.discoverActiveToken();
    if (!token) {
      return {
        token: null,
        sessionId: null,
      };
    }

    const sessionId = await this.getSessionId(token);
    return {
      token,
      tokenRedacted: redactToken(token),
      sessionId,
      derivedTokenMatches: EasyConnectRuntime.deriveToken(sessionId) === token,
    };
  }

  async describeLatestCachedToken() {
    const [token] = await extractTokensFromCache(10);
    if (!token) {
      return {
        token: null,
        loginStatus: null,
      };
    }

    let loginStatus = null;
    try {
      loginStatus = await this.getLoginStatus(token);
    } catch {
      loginStatus = null;
    }

    return {
      token,
      tokenRedacted: redactToken(token),
      loginStatus,
    };
  }

  async bootstrap({ sessionId, gatewayHost, gatewayPort, syncXml = true, containerTargetUrlPart = null, remoteDebugPort = 9222 }) {
    const token = EasyConnectRuntime.deriveToken(sessionId);
    const steps = [];

    steps.push({
      step: "InitEcAgent",
      response: await this.initAgent({ gatewayHost, gatewayPort, token: "" }),
    });

    steps.push({
      step: "SET BROWSER",
      response: await this.request("DoConfigure", ["SET BROWSER default"], {
        token,
        type: "EC",
      }),
    });

    steps.push({
      step: "SET SERVADDR",
      response: await this.request("DoConfigure", [`SET SERVADDR ${gatewayHost} ${gatewayPort}`], {
        token,
        type: "EC",
      }),
    });

    steps.push({
      step: "SET LOGINADDR",
      response: await this.request("DoConfigure", [`SET LOGINADDR https://${gatewayHost}:${gatewayPort}`], {
        token,
        type: "EC",
      }),
    });

    const setTwfIdResult = await this.setTwfId(sessionId);
    steps.push({
      step: "SET TWFID",
      response: setTwfIdResult.response,
    });

    if (containerTargetUrlPart) {
      steps.push({
        step: "syncLaunchContextToContainerRuntimeState",
        response: await this.syncLaunchContextToContainerRuntimeState(
          containerTargetUrlPart,
          {
            sessionId,
            gatewayHost,
            gatewayPort,
            remoteDebugPort,
            browserType: "default",
            lang: "zh_CN",
          },
          {
            remoteDebugPort,
            timeoutMs: 10000,
            pollMs: 500,
          },
        ),
      });

      steps.push({
        step: "syncPortalGlobalState",
        response: await this.syncPortalGlobalState(
          containerTargetUrlPart,
          {
            sessionId,
            gatewayHost,
            gatewayPort,
            username: "",
            browserType: "default",
            lang: "zh_CN",
            loginClientType: 3,
            trayType: 1,
          },
          {
            remoteDebugPort,
            timeoutMs: 10000,
            pollMs: 500,
          },
        ),
      });

      steps.push({
        step: "syncSessionToContainerConfig",
        response: await this.syncSessionToContainerConfig(
          containerTargetUrlPart,
          sessionId,
          {
            remoteDebugPort,
            timeoutMs: 10000,
            pollMs: 500,
          },
        ),
      });
    }

    // Prime ECAgent with the new session before attempting cache setters.
    try {
      steps.push({
        step: "GetConfig 1 (prime)",
        response: await this.request("GetConfig", ["1"], {
          token,
          type: "EC",
          timeoutMs: 5000,
        }),
      });
    } catch (error) {
      steps.push({
        step: "GetConfig 1 (prime)",
        error: error.message,
      });
    }

    try {
      steps.push({
        step: "GetConfig 2 (prime)",
        response: await this.request("GetConfig", ["2"], {
          token,
          type: "EC",
          timeoutMs: 5000,
        }),
      });
    } catch (error) {
      steps.push({
        step: "GetConfig 2 (prime)",
        error: error.message,
      });
    }

    if (syncXml) {
      steps.push({
        step: "DoXmlConfigure 1",
        response: await this.doXmlConfigure(1, token),
      });

      steps.push({
        step: "DoXmlConfigure 2",
        response: await this.doXmlConfigure(2, token),
      });
    }

    const startResponse = await this.startService(token);
    const afterStart = await this.getServiceState(token).catch((error) => ({
      error: error.message,
    }));
    const loginStatus = await this.getLoginStatus(token).catch((error) => ({
      error: error.message,
    }));
    const serviceState = await this.getServiceState(token).catch((error) => ({
      error: error.message,
    }));
    const localRuntimeInfo = await this.getLocalRuntimeInfo(token).catch((error) => ({
      error: error.message,
    }));

    return {
      token,
      tokenRedacted: redactToken(token),
      beforeStart: null,
      startResponse,
      afterStart,
      loginStatus,
      serviceState,
      localRuntimeInfo,
      steps,
    };
  }

  async setAgentSdkContext(token, payload) {
    const response = await this.request("Setter", ["sfjssdk", JSON.stringify(payload), 0], {
      token,
      type: "EC",
      timeoutMs: 5000,
    });

    if (response?.result !== "1") {
      throw new Error(`Setter sfjssdk failed: ${JSON.stringify(response)}`);
    }

    return response;
  }

  async getAgentSdkContext(token) {
    const response = await this.request("Getter", ["sfjssdk"], {
      token,
      type: "EC",
      timeoutMs: 5000,
    });

    if (response?.result !== "1") {
      throw new Error(`Getter sfjssdk failed: ${JSON.stringify(response)}`);
    }

    return response.data;
  }

  async setAgentLocalContext(token, payload) {
    const response = await this.request("Setter", ["sfjssdklocal", JSON.stringify(payload), 0], {
      token,
      type: "EC",
      timeoutMs: 5000,
    });

    if (response?.result !== "1") {
      throw new Error(`Setter sfjssdklocal failed: ${JSON.stringify(response)}`);
    }

    return response;
  }

  async getAgentLocalContext(token) {
    const response = await this.request("Getter", ["sfjssdklocal"], {
      token,
      type: "EC",
      timeoutMs: 5000,
    });

    if (response?.result !== "1") {
      throw new Error(`Getter sfjssdklocal failed: ${JSON.stringify(response)}`);
    }

    return response.data;
  }

  async launchMainAppFromEcAgent(sessionId, options = {}) {
    const token = EasyConnectRuntime.deriveToken(sessionId);
    const encodedTwfId = EasyConnectRuntime.encodeLaunchTwfId(sessionId);
    const args = [];

    if (options.remoteDebugPort) {
      args.push(`--remote-debugging-port=${options.remoteDebugPort}`);
    }

    args.push(
      "--from",
      "ecagent",
      "--agentport",
      String(await this.getPort()),
      "--token",
      token,
      "--twfid",
      encodedTwfId,
    );

    const killed = await this.killMainAppProcesses();
    const mainAppStopped = await this.waitForMainAppProcessesStopped({
      timeoutMs: options.mainAppStopTimeoutMs ?? 10000,
      pollMs: options.mainAppStopPollMs ?? 500,
      signal: options.signal,
    });
    const pid = this.spawnMainApp(args);

    return {
      pid,
      token,
      tokenRedacted: redactToken(token),
      encodedTwfId,
      remoteDebugPort: options.remoteDebugPort ?? null,
      killed,
      mainAppStopped,
    };
  }

  async listMainAppProcesses() {
    const { stdout } = await execFileAsync("/bin/ps", ["-axo", "pid=,ppid=,command="], {
      timeout: 5000,
      maxBuffer: 1024 * 1024,
    });
    const processes = parseProcessList(stdout);
    return filterProcessesByExecutable(processes, this.appExecutable);
  }

  async waitForMainAppProcessesStopped(options = {}) {
    const timeoutMs = options.timeoutMs ?? 10000;
    const pollMs = options.pollMs ?? 500;
    const signal = options.signal;
    const startedAt = Date.now();
    let lastProcesses = [];

    while (Date.now() - startedAt < timeoutMs) {
      throwIfAborted(signal);
      lastProcesses = await this.listMainAppProcesses();

      if (lastProcesses.length === 0) {
        return {
          ok: true,
          processes: [],
        };
      }

      await sleep(pollMs, signal);
    }

    throw createMainAppStillRunningError(lastProcesses, this.appExecutable);
  }

  async killMainAppProcesses({ force = true } = {}) {
    try {
      execSync(`pkill -TERM -f "${this.appExecutable}" || true`);
    } catch {
      // Best-effort only.
    }

    await sleep(1500);

    if (force) {
      try {
        execSync(`pkill -KILL -f "${this.appExecutable}" || true`);
      } catch {
        // Best-effort only.
      }
    }

    return {
      command: this.appExecutable,
      forced: force,
    };
  }

  async killCoreServiceProcesses({ force = true } = {}) {
    const resourcesDir = getBundleResourcesDir(this.appExecutable);
    const commands = [
      path.join(resourcesDir, "bin", "CSClient.app", "Contents", "MacOS", "CSClient"),
      path.join(resourcesDir, "bin", "svpnservice"),
    ];

    for (const command of commands) {
      try {
        execSync(`pkill -TERM -f "${command}" || true`);
      } catch {
        // Best-effort only.
      }
    }

    await sleep(1500);

    if (force) {
      for (const command of commands) {
        try {
          execSync(`pkill -KILL -f "${command}" || true`);
        } catch {
          // Best-effort only.
        }
      }
    }

    return {
      commands: ["CSClient", "svpnservice"],
      forced: force,
      remaining: await this.listCoreServiceProcesses(),
    };
  }

  async resetAgentProxy({ force = true } = {}) {
    const uid = os.userInfo().uid;
    const launchDomain = `gui/${uid}`;
    const launchServiceName = `${launchDomain}/${AGENT_PROXY_LABEL}`;
    const actions = [];

    const runLaunchctl = async (args, action, allowFailure = true, outputMode = "command") => {
      try {
        const result = await execFileAsync("/bin/launchctl", args, {
          timeout: 5000,
          maxBuffer: 128 * 1024,
        });
        actions.push(buildLaunchctlActionEntry({
          action,
          ok: true,
          stdout: result.stdout,
          stderr: result.stderr,
          outputMode,
        }));
        return result;
      } catch (error) {
        const entry = buildLaunchctlActionEntry({
          action,
          ok: false,
          error: error?.message ?? String(error),
          stdout: error?.stdout ?? "",
          stderr: error?.stderr ?? "",
          outputMode,
        });
        actions.push(entry);
        if (!allowFailure) {
          throw error;
        }
        return null;
      }
    };

    await runLaunchctl(["bootout", launchDomain, AGENT_PROXY_PLIST], "bootout", true);

    try {
      execSync(`pkill -TERM -f "${path.join(getBundleResourcesDir(this.appExecutable), "bin", "ECAgentProxy")}" || true`);
      actions.push({ action: "pkill-term", ok: true });
    } catch (error) {
      actions.push({ action: "pkill-term", ok: false, error: error?.message ?? String(error) });
    }

    await sleep(1000);

    if (force) {
      try {
        execSync(`pkill -KILL -f "${path.join(getBundleResourcesDir(this.appExecutable), "bin", "ECAgentProxy")}" || true`);
        actions.push({ action: "pkill-kill", ok: true });
      } catch (error) {
        actions.push({ action: "pkill-kill", ok: false, error: error?.message ?? String(error) });
      }
    }

    await runLaunchctl(["bootstrap", launchDomain, AGENT_PROXY_PLIST], "bootstrap", true);
    await runLaunchctl(["kickstart", "-k", launchServiceName], "kickstart", true);

    const launchServiceRaw = await runLaunchctl(["print", launchServiceName], "print", true, "launchctl-print");
    const launchService = launchServiceRaw ? parseLaunchctlPrintState(launchServiceRaw.stdout) : null;
    const processes = await this.listAgentProcesses();

    return {
      label: AGENT_PROXY_LABEL,
      plist: AGENT_PROXY_PLIST,
      forced: force,
      actions,
      launchService,
      processes,
      finalState: buildAgentProxyResetFinalState({ actions, launchService, processes }),
    };
  }

  async waitForAgentProxyReady(options = {}) {
    const timeoutMs = options.timeoutMs ?? 15000;
    const pollMs = options.pollMs ?? 500;
    const signal = options.signal;
    const uid = os.userInfo().uid;
    const launchServiceName = `gui/${uid}/${AGENT_PROXY_LABEL}`;
    const startedAt = Date.now();
    let lastLaunchService = null;
    let lastProcesses = null;
    let lastFinalState = null;

    while (Date.now() - startedAt < timeoutMs) {
      throwIfAborted(signal);
      let launchService = null;

      try {
        const result = await execFileAsync("/bin/launchctl", ["print", launchServiceName], {
          timeout: 5000,
          maxBuffer: 128 * 1024,
        });
        launchService = parseLaunchctlPrintState(result.stdout);
      } catch {
        launchService = null;
      }

      const processes = await this.listAgentProcesses().catch(() => null);
      const finalState = buildAgentProxyResetFinalState({
        actions: [],
        launchService,
        processes,
      });
      lastLaunchService = launchService;
      lastProcesses = processes;
      lastFinalState = finalState;

      if (finalState.ok) {
        return finalState;
      }

      await sleep(pollMs, signal);
    }

    const error = createAgentProxyNotReadyError(lastFinalState);
    error.launchService = lastLaunchService;
    error.processes = lastProcesses;
    throw error;
  }

  spawnMainApp(args = []) {
    return launchDetached(this.appExecutable, args);
  }

  async launchMainAppUserMode(options = {}) {
    const remoteDebugPort = options.remoteDebugPort ?? null;
    const forceKill = options.forceKill ?? true;
    const args = [];

    if (remoteDebugPort) {
      args.push(`--remote-debugging-port=${remoteDebugPort}`);
    }

    if (options.reuseExisting !== false) {
      const reusedExistingMainApp = await this.findReusableRemoteDebugPageTarget({
        remoteDebugPort,
        timeoutMs: options.existingRemoteDebugTimeoutMs ?? 1200,
        responsiveTimeoutMs: options.existingRemoteDebugResponsiveTimeoutMs ?? 1200,
        signal: options.signal,
      });

      if (reusedExistingMainApp) {
        return {
          action: "reused-existing",
          pid: null,
          appExecutable: this.appExecutable,
          remoteDebugPort,
          args: [],
          reusedExistingMainApp,
        };
      }
    }

    const existingProcesses = await this.listMainAppProcesses().catch(() => []);
    if (existingProcesses.length > 0) {
      if (options.failIfAlreadyRunning) {
        throw createMainAppAlreadyRunningWithoutDebugError(
          existingProcesses,
          remoteDebugPort,
          this.appExecutable,
        );
      }

      if (options.restartExisting === false) {
        return {
          action: "already-running-without-debug",
          pid: null,
          appExecutable: this.appExecutable,
          remoteDebugPort,
          args: [],
          existingProcesses,
        };
      }

      const killed = await this.killMainAppProcesses({ force: forceKill });
      const mainAppStopped = await this.waitForMainAppProcessesStopped({
        timeoutMs: options.mainAppStopTimeoutMs ?? 10000,
        pollMs: options.mainAppStopPollMs ?? 500,
        signal: options.signal,
      });
      const pid = this.spawnMainApp(args);

      return {
        action: "restarted-existing-without-debug",
        pid,
        appExecutable: this.appExecutable,
        remoteDebugPort,
        args,
        existingProcesses,
        killed,
        mainAppStopped,
      };
    }

    const pid = this.spawnMainApp(args);
    return {
      action: "launched",
      pid,
      appExecutable: this.appExecutable,
      remoteDebugPort,
      args,
    };
  }

  async recoverViaUserMode(options = {}) {
    const remoteDebugPort = options.remoteDebugPort ?? null;
    const forceKill = options.forceKill ?? true;
    const agentProxyReadyTimeoutMs = options.agentProxyReadyTimeoutMs ?? 15000;
    const recoveryDiagnostics = options.skipPreRecoveryDiagnostics === true
      ? null
      : await this.collectRecoveryDiagnostics().catch(() => null);
    const bypassReuseBecauseOfficialCrashed = isOfficialUiCrashDiagnostics(recoveryDiagnostics);

    if (options.reuseExisting !== false && !bypassReuseBecauseOfficialCrashed) {
      const reusedExistingMainApp = await this.findReusableRemoteDebugPageTarget({
        remoteDebugPort,
        timeoutMs: options.existingRemoteDebugTimeoutMs ?? 1200,
        responsiveTimeoutMs: options.existingRemoteDebugResponsiveTimeoutMs ?? 1200,
        signal: options.signal,
      });

      if (reusedExistingMainApp) {
        const disabledOfficialAutoConnect = await this.disableOfficialAutoConnectBeforeLaunch({ remoteDebugPort });

        return {
          mode: "reuse-existing-main-app",
          reusedExistingMainApp,
          killed: {
            action: "skipped-existing-debug-target",
            reason: "EasyConnect already has a responsive remote-debug page target; do not restart or duplicate the official app.",
          },
          killedCoreServices: null,
          resetAgentProxy: null,
          agentProxyReady: null,
          disabledOfficialAutoConnect,
          launched: null,
          recoveryDiagnostics,
        };
      }
    }

    const existingMainAppProcesses = await this.listMainAppProcesses().catch(() => []);
    const killed = await this.killMainAppProcesses({ force: forceKill });
    const mainAppStopped = await this.waitForMainAppProcessesStopped({
      timeoutMs: options.mainAppStopTimeoutMs ?? 10000,
      pollMs: options.mainAppStopPollMs ?? 500,
      signal: options.signal,
    });
    const killedCoreServices = await this.killCoreServiceProcesses({ force: forceKill });
    const resetAgentProxy = await this.resetAgentProxy({ force: forceKill });
    const agentProxyReady = await this.waitForAgentProxyReady({
      timeoutMs: agentProxyReadyTimeoutMs,
      signal: options.signal,
    });
    const disabledOfficialAutoConnect = await this.disableOfficialAutoConnectBeforeLaunch({ remoteDebugPort });
    const launched = await this.launchMainAppUserMode({
      remoteDebugPort,
      reuseExisting: false,
      failIfAlreadyRunning: true,
    });

    return {
      mode: "relaunch-main-app",
      existingMainAppProcesses,
      killed,
      mainAppStopped,
      killedCoreServices,
      resetAgentProxy,
      agentProxyReady,
      disabledOfficialAutoConnect,
      launched,
      recoveryDiagnostics,
      reuseBypassed: bypassReuseBecauseOfficialCrashed
        ? {
          reason: "recent official EasyConnect crash diagnostics; do not reuse a responsive but poisoned renderer target",
          classification: recoveryDiagnostics?.classification ?? null,
        }
        : null,
    };
  }

  async getRemoteDebugTargets(remoteDebugPort = 9222, options = {}) {
    const timeoutMs = typeof options === "number" ? options : options.timeoutMs ?? 5000;
    return requestJson(`http://127.0.0.1:${remoteDebugPort}/json/list`, timeoutMs);
  }

  async findReusableRemoteDebugPageTarget(options = {}) {
    const remoteDebugPort = options.remoteDebugPort ?? 9222;
    const timeoutMs = options.timeoutMs ?? 1200;
    const responsiveTimeoutMs = options.responsiveTimeoutMs ?? timeoutMs;

    if (!remoteDebugPort || timeoutMs <= 0) {
      return null;
    }

    let targets = [];
    try {
      targets = await this.getRemoteDebugTargets(remoteDebugPort, { timeoutMs });
    } catch {
      return null;
    }

    const pageTargets = targets.filter((target) => target.type === "page" && target.webSocketDebuggerUrl);
    const errors = [];

    for (const target of pageTargets) {
      throwIfAborted(options.signal);
      if (isBrokenRemoteDebugPageTarget(target) || !isReusableRemoteDebugPageTargetCandidate(target)) {
        errors.push({
          id: target.id ?? null,
          url: target.url ?? null,
          title: target.title ?? null,
          error: "target is not a reusable EasyConnect portal state",
        });
        continue;
      }

      try {
        const responsive = await this.ensureRemoteDebugPageTargetResponsive(target, {
          ...options,
          timeoutMs: responsiveTimeoutMs,
        });

        if (responsive) {
          return {
            remoteDebugPort,
            target,
            targetCount: pageTargets.length,
          };
        }
      } catch (error) {
        errors.push({
          id: target.id ?? null,
          url: target.url ?? null,
          error: error?.message ?? String(error),
        });
      }
    }

    return null;
  }

  async waitForPortalLoginAuthBridgeReady(targetUrlPart = "/portal/#!/login", options = {}) {
    const remoteDebugPort = options.remoteDebugPort ?? 9222;
    const timeoutMs = options.timeoutMs ?? 30000;
    const pollMs = options.pollMs ?? 1000;
    const signal = options.signal;
    const startedAt = Date.now();
    let lastProbe = null;
    let lastTarget = null;

    while (Date.now() - startedAt < timeoutMs) {
      throwIfAborted(signal);
      try {
        const target = await this.waitForRemoteDebugTarget(targetUrlPart, {
          remoteDebugPort,
          timeoutMs: Math.min(pollMs, Math.max(250, timeoutMs - (Date.now() - startedAt))),
          pollMs: Math.min(pollMs, 250),
          signal,
        });
        lastTarget = {
          id: target.id,
          url: target.url,
          title: target.title,
        };

        const probe = await this.evaluateOnRemoteDebugPageTarget(
          target,
          buildPortalOfficialAuthStateExpression(),
          {
            ...options,
            timeoutMs: Math.min(options.probeTimeoutMs ?? 5000, timeoutMs),
          },
        );
        lastProbe = probe.evaluation?.result?.value ?? null;

        if (isPortalLoginAuthBridgeReady(lastProbe, targetUrlPart)) {
          return {
            ...target,
            authBridgeProbe: lastProbe,
          };
        }
      } catch (error) {
        lastProbe = {
          error: error?.message ?? String(error),
        };
      }

      await sleep(pollMs, signal);
    }

    const error = new Error(`Timed out waiting for official login auth bridge: ${JSON.stringify(lastProbe)}`);
    error.code = "EASYCONNECT_OFFICIAL_LOGIN_TARGET_NOT_READY";
    error.lastProbe = lastProbe;
    error.lastTarget = lastTarget;
    throw error;
  }

  async createRemoteDebugTarget(targetUrl, options = {}) {
    const remoteDebugPort = options.remoteDebugPort ?? 9222;
    const timeoutMs = options.timeoutMs ?? 5000;
    const endpoint = `http://127.0.0.1:${remoteDebugPort}/json/new?${encodeURIComponent(targetUrl)}`;

    try {
      return await requestJson(endpoint, timeoutMs, { method: "PUT" });
    } catch (error) {
      if (!/HTTP (404|405|501)/.test(error?.message ?? "")) {
        throw error;
      }

      return requestJson(endpoint, timeoutMs);
    }
  }

  async waitForRemoteDebugTarget(targetUrlPart, options = {}) {
    const remoteDebugPort = options.remoteDebugPort ?? 9222;
    const timeoutMs = options.timeoutMs ?? 30000;
    const pollMs = options.pollMs ?? 1000;
    const signal = options.signal;
    const startedAt = Date.now();

    while (Date.now() - startedAt < timeoutMs) {
      throwIfAborted(signal);
      try {
        const targets = await this.getRemoteDebugTargets(remoteDebugPort);
        const target = targets.find((item) => item.url.includes(targetUrlPart));
        if (target) {
          return target;
        }
      } catch {
        // Retry while the browser endpoint is still starting.
      }

      await sleep(pollMs, signal);
    }

    throw new Error(`Timed out waiting for devtools target: ${targetUrlPart}`);
  }

  async waitForAnyRemoteDebugPageTarget(options = {}) {
    const remoteDebugPort = options.remoteDebugPort ?? 9222;
    const timeoutMs = options.timeoutMs ?? 30000;
    const pollMs = options.pollMs ?? 1000;
    const signal = options.signal;
    const startedAt = Date.now();

    while (Date.now() - startedAt < timeoutMs) {
      throwIfAborted(signal);
      try {
        const targets = await this.getRemoteDebugTargets(remoteDebugPort);
        const target = targets.find((item) => item.type === "page" && item.webSocketDebuggerUrl);
        if (target) {
          return target;
        }
      } catch {
        // Retry while the browser endpoint is still starting.
      }

      await sleep(pollMs, signal);
    }

    throw new Error("Timed out waiting for any devtools page target");
  }

  async evaluateOnRemoteDebugPageTarget(target, expression, options = {}) {
    const ws = await openWebSocket(target.webSocketDebuggerUrl, options?.timeoutMs ?? 5000);

    let msgId = 0;
    const pending = new Map();

    const consumeMessages = async () => {
      while (true) {
        const message = await ws.nextMessage(options?.timeoutMs ?? 5000);
        if (message === null) {
          return;
        }

        const payload = JSON.parse(message);
        const item = pending.get(payload.id);
        if (!item) {
          continue;
        }

        pending.delete(payload.id);
        if (payload.error) {
          item.reject(new Error(JSON.stringify(payload.error)));
        } else {
          item.resolve(payload.result);
        }
      }
    };

    const consumer = consumeMessages().catch((error) => {
      for (const item of pending.values()) {
        item.reject(error);
      }
      pending.clear();
    });

    const send = async (method, params = {}) => {
      const id = ++msgId;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        ws.send(JSON.stringify({ id, method, params })).catch((error) => {
          pending.delete(id);
          reject(error);
        });
      });
    };

    await send("Runtime.enable");
    const result = await send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });

    ws.close();
    await consumer.catch(() => {});

    return {
      target,
      evaluation: result,
    };
  }

  async evaluateOnRemoteDebugTarget(targetUrlPart, expression, options = {}) {
    const remoteDebugPort = options?.remoteDebugPort ?? 9222;
    const target = await this.waitForRemoteDebugTarget(targetUrlPart, {
      ...options,
      remoteDebugPort,
    });

    return this.evaluateOnRemoteDebugPageTarget(target, expression, options);
  }

  async ensureRemoteDebugPageTargetResponsive(target, options = {}) {
    const result = await this.evaluateOnRemoteDebugPageTarget(target, "1", {
      ...options,
      timeoutMs: options.responsiveTimeoutMs ?? Math.min(options.timeoutMs ?? 5000, 5000),
    });
    return result.evaluation?.result?.value === 1;
  }

  async navigateRemoteDebugPageTarget(target, targetUrl, options = {}) {
    const response = await sendRemoteDebugCommand(target, "Page.navigate", { url: targetUrl }, options);
    const result = response.result ?? {};

    return {
      ok: !result.errorText,
      requestedUrl: targetUrl,
      frameId: result.frameId ?? null,
      loaderId: result.loaderId ?? null,
      errorText: result.errorText ?? null,
      target: {
        id: target.id,
        url: target.url,
        title: target.title,
      },
    };
  }

  async navigateRemoteDebugTarget(targetUrlPart, targetUrl, options = {}) {
    const remoteDebugPort = options?.remoteDebugPort ?? 9222;
    const target = await this.waitForRemoteDebugTarget(targetUrlPart, {
      ...options,
      remoteDebugPort,
    });

    return this.navigateRemoteDebugPageTarget(target, targetUrl, options);
  }

  async bringRemoteDebugPageTargetToFront(target, options = {}) {
    const response = await sendRemoteDebugCommand(target, "Page.bringToFront", {}, options);

    return {
      ok: true,
      result: response.result ?? {},
      target: {
        id: target.id,
        url: target.url,
        title: target.title,
      },
    };
  }

  async bringRemoteDebugTargetToFront(targetUrlPart, options = {}) {
    const remoteDebugPort = options?.remoteDebugPort ?? 9222;
    const target = await this.waitForRemoteDebugTarget(targetUrlPart, {
      ...options,
      remoteDebugPort,
    });

    return this.bringRemoteDebugPageTargetToFront(target, options);
  }

  async closeOfficialWindowPageTarget(target, options = {}) {
    const expression = `(() => {
      const containerId = window.SFConfig && SFConfig.CONTAINER_WINDOW_ID
        ? SFConfig.CONTAINER_WINDOW_ID.CURRENT_WINDOW
        : "";
      const closeByWindowMgr = window.SF && SF.windowMgr && typeof SF.windowMgr.close === "function";
      if (closeByWindowMgr) {
        setTimeout(() => SF.windowMgr.close(containerId), 0);
        return { ok: true, method: "SF.windowMgr.close", containerId: String(containerId) };
      }

      if (typeof window.ecClose === "function") {
        setTimeout(() => window.ecClose(containerId), 0);
        return { ok: true, method: "ecClose", containerId: String(containerId) };
      }

      if (typeof window.close === "function") {
        setTimeout(() => window.close(), 0);
        return { ok: true, method: "window.close", containerId: String(containerId) };
      }

      return { ok: false, reason: "No official close API is available", containerId: String(containerId) };
    })()`;

    const result = await this.evaluateOnRemoteDebugPageTarget(target, expression, options);
    return {
      ok: result.evaluation?.result?.value?.ok === true,
      value: result.evaluation?.result?.value ?? null,
      target: {
        id: target.id,
        url: target.url,
        title: target.title,
      },
    };
  }

  async closeOfficialWindowTarget(targetUrlPart, options = {}) {
    const remoteDebugPort = options?.remoteDebugPort ?? 9222;
    const target = await this.waitForRemoteDebugTarget(targetUrlPart, {
      ...options,
      remoteDebugPort,
    });

    return this.closeOfficialWindowPageTarget(target, options);
  }

  async triggerPortalPasswordLogin(options) {
    const username = options?.username;
    const password = options?.password;
    const remoteDebugPort = options?.remoteDebugPort ?? 9222;
    const timeoutMs = options?.timeoutMs ?? 30000;
    const pollMs = options?.pollMs ?? 1000;

    if (!username || !password) {
      throw new Error("triggerPortalPasswordLogin requires username and password");
    }

    const target = await this.waitForRemoteDebugTarget("/portal/#!/login", {
      remoteDebugPort,
      timeoutMs,
      pollMs,
    });

    const deadline = Date.now() + timeoutMs;
    let lastProbe = null;

    while (Date.now() < deadline) {
      const probe = await this.evaluateOnRemoteDebugPageTarget(
        target,
        buildPortalPasswordVmStateExpression(),
        {
          timeoutMs,
          pollMs,
        },
      );
      lastProbe = probe.evaluation?.result?.value ?? null;

      if (lastProbe?.hasPasswordVm) {
        return this.evaluateOnRemoteDebugPageTarget(
          target,
          buildPortalPasswordLoginExpression(username, password),
          {
            timeoutMs,
            pollMs,
          },
        );
      }

      await sleep(pollMs);
    }

    throw new Error(`Timed out waiting for password vm: ${JSON.stringify(lastProbe)}`);
  }

  async triggerPortalOfficialPasswordLogin(options) {
    const username = options?.username;
    const password = options?.password;
    const captcha = options?.captcha ?? "";
    const remoteDebugPort = options?.remoteDebugPort ?? 9222;
    const timeoutMs = options?.timeoutMs ?? 60000;
    const pollMs = options?.pollMs ?? 1000;
    const signal = options?.signal;
    const targetUrlPart = options?.targetUrlPart ?? "/portal/#!/login";
    const evaluateTimeoutMs = options?.evaluateTimeoutMs ?? Math.max(timeoutMs, 90000);

    if (!username || !password) {
      throw new Error("triggerPortalOfficialPasswordLogin requires username and password");
    }

    const target = await this.waitForPortalLoginAuthBridgeReady(targetUrlPart, {
      remoteDebugPort,
      timeoutMs,
      pollMs,
      signal,
    });

    const deadline = Date.now() + timeoutMs;
    let lastProbe = null;
    let lastLoginResult = null;

    while (Date.now() < deadline) {
      throwIfAborted(signal);
      const probe = await this.evaluateOnRemoteDebugPageTarget(
        target,
        buildPortalOfficialAuthStateExpression(),
        {
          timeoutMs,
          pollMs,
          signal,
        },
      );
      lastProbe = probe.evaluation?.result?.value ?? null;

      if (isPortalLoginAuthBridgeReady(lastProbe, targetUrlPart)) {
        const result = await this.evaluateOnRemoteDebugPageTarget(
          target,
          buildPortalOfficialPasswordLoginExpression(username, password, captcha),
          {
            timeoutMs: evaluateTimeoutMs,
            pollMs,
            signal,
          },
        );
        lastLoginResult = result.evaluation?.result?.value ?? null;

        if (lastLoginResult?.ok) {
          return lastLoginResult;
        }

        const error = new Error(
          `Official renderer password login failed: ${JSON.stringify(lastLoginResult)}`,
        );
        error.code = "EASYCONNECT_OFFICIAL_RENDERER_LOGIN_FAILED";
        error.loginResult = lastLoginResult;
        error.lastProbe = lastProbe;
        throw error;
      }

      await sleep(pollMs, signal);
    }

    const error = new Error(`Timed out waiting for official auth bridge: ${JSON.stringify(lastProbe)}`);
    error.code = "EASYCONNECT_OFFICIAL_RENDERER_AUTH_BRIDGE_NOT_READY";
    error.lastProbe = lastProbe;
    throw error;
  }

  async startOfficialPortalService(targetUrlPart = "/portal/#!/service", options = {}) {
    const remoteDebugPort = options?.remoteDebugPort ?? 9222;
    const timeoutMs = options?.timeoutMs ?? 90000;
    const pollMs = options?.pollMs ?? 1000;
    const signal = options?.signal;
    const username = `${options?.username ?? ""}`.trim();
    const evaluateTimeoutMs = options?.evaluateTimeoutMs ?? Math.max(timeoutMs, 90000);
    const target = await this.waitForRemoteDebugTarget(targetUrlPart, {
      remoteDebugPort,
      timeoutMs,
      pollMs,
      signal,
    });

    const result = await this.evaluateOnRemoteDebugPageTarget(
      target,
      buildPortalOfficialServiceStartExpression(username),
      {
        timeoutMs: evaluateTimeoutMs,
        pollMs,
        signal,
      },
    );
    const value = result.evaluation?.result?.value ?? null;

    if (value?.ok) {
      return value;
    }

    const error = new Error(`Official portal service start failed: ${JSON.stringify(value)}`);
    error.code = "EASYCONNECT_OFFICIAL_PORTAL_SERVICE_START_FAILED";
    error.serviceStart = value;
    throw error;
  }

  async readContainerConfig(targetUrlPart, key, options = {}) {
    const result = await this.evaluateOnRemoteDebugTarget(
      targetUrlPart,
      buildContainerConfigReadExpression(key),
      options,
    );

    return result.evaluation?.result?.value ?? null;
  }

  async readContainerConfigOnPageTarget(target, key, options = {}) {
    const result = await this.evaluateOnRemoteDebugPageTarget(
      target,
      buildContainerConfigReadExpression(key),
      options,
    );

    return result.evaluation?.result?.value ?? null;
  }

  async writeContainerConfig(targetUrlPart, key, value, options = {}) {
    const result = await this.evaluateOnRemoteDebugTarget(
      targetUrlPart,
      buildContainerConfigWriteExpression(key, value, options),
      options,
    );

    return result.evaluation?.result?.value ?? null;
  }

  async writeContainerConfigOnPageTarget(target, key, value, options = {}) {
    const result = await this.evaluateOnRemoteDebugPageTarget(
      target,
      buildContainerConfigWriteExpression(key, value, options),
      options,
    );

    return result.evaluation?.result?.value ?? null;
  }

  async syncSessionToContainerConfig(targetUrlPart, sessionId, options = {}) {
    const token = EasyConnectRuntime.deriveToken(sessionId);
    const [twfIdResult, tokenResult] = await Promise.all([
      this.writeContainerConfig(targetUrlPart, "twfID", sessionId, options),
      this.writeContainerConfig(targetUrlPart, "token", token, options),
    ]);

    return {
      sessionId,
      token,
      twfIdResult,
      tokenResult,
    };
  }

  async readContainerRuntimeValue(targetUrlPart, keyPath, options = {}) {
    const result = await this.evaluateOnRemoteDebugTarget(
      targetUrlPart,
      buildContainerRuntimeReadExpression(keyPath),
      options,
    );

    return result.evaluation?.result?.value ?? null;
  }

  async readContainerRuntimeValueOnPageTarget(target, keyPath, options = {}) {
    const result = await this.evaluateOnRemoteDebugPageTarget(
      target,
      buildContainerRuntimeReadExpression(keyPath),
      options,
    );

    return result.evaluation?.result?.value ?? null;
  }

  async writeContainerRuntimeValue(targetUrlPart, keyPath, value, options = {}) {
    const persist = options.persist ?? 0;
    const result = await this.evaluateOnRemoteDebugTarget(
      targetUrlPart,
      buildContainerRuntimeWriteExpression(keyPath, value, persist),
      options,
    );

    return result.evaluation?.result?.value ?? null;
  }

  async writeContainerRuntimeValueOnPageTarget(target, keyPath, value, options = {}) {
    const persist = options.persist ?? 0;
    const result = await this.evaluateOnRemoteDebugPageTarget(
      target,
      buildContainerRuntimeWriteExpression(keyPath, value, persist),
      options,
    );

    return result.evaluation?.result?.value ?? null;
  }

  async writeContainerRuntimeValuesOnPageTarget(target, writeSpecs, options = {}) {
    const normalizedWrites = writeSpecs.map(([keyPath, value, persist = 0]) => ({
      keyPath,
      value,
      persist,
    }));
    const result = await this.evaluateOnRemoteDebugPageTarget(
      target,
      buildContainerRuntimeBatchWriteExpression(normalizedWrites),
      options,
    );

    return result.evaluation?.result?.value ?? null;
  }

  async syncSessionToContainerRuntimeState(targetUrlPart, sessionId, options = {}) {
    const token = EasyConnectRuntime.deriveToken(sessionId);
    const [twfIdResult, tokenResult] = await Promise.all([
      this.writeContainerRuntimeValue(
        targetUrlPart,
        "/global/twfID__sysconfig",
        sessionId,
        options,
      ),
      this.writeContainerRuntimeValue(
        targetUrlPart,
        "/global/token__sysconfig",
        token,
        options,
      ),
    ]);

    return {
      sessionId,
      token,
      twfIdResult,
      tokenResult,
    };
  }

  async syncLaunchContextToContainerRuntimeState(targetUrlPart, context, options = {}) {
    const {
      sessionId,
      gatewayHost,
      gatewayPort,
      browserType = "default",
      lang = "zh_CN",
    } = context ?? {};

    if (!sessionId || !gatewayHost || !gatewayPort) {
      throw new Error("syncLaunchContextToContainerRuntimeState requires sessionId, gatewayHost, and gatewayPort");
    }

    const token = EasyConnectRuntime.deriveToken(sessionId);
    const vpnURL = `https://${gatewayHost}:${gatewayPort}`;
    const ecPort = await this.getPort();

    const writes = await Promise.all([
      this.writeContainerRuntimeValue(
        targetUrlPart,
        "/global/twfID__sysconfig",
        sessionId,
        { ...options, persist: 0 },
      ),
      this.writeContainerRuntimeValue(
        targetUrlPart,
        "/global/token__sysconfig",
        token,
        { ...options, persist: 0 },
      ),
      this.writeContainerRuntimeValue(
        targetUrlPart,
        "/global/browserType__sysconfig",
        browserType,
        { ...options, persist: 0 },
      ),
      this.writeContainerRuntimeValue(
        targetUrlPart,
        "/global/lang__sysconfig",
        lang,
        { ...options, persist: 1 },
      ),
      this.writeContainerRuntimeValue(
        targetUrlPart,
        "/global/ecPort",
        ecPort,
        { ...options, persist: 1 },
      ),
      this.writeContainerRuntimeValue(
        targetUrlPart,
        "/global/vpnURL",
        vpnURL,
        { ...options, persist: 0 },
      ),
      this.writeContainerRuntimeValue(
        targetUrlPart,
        "/global/lastVPNURL__sysconfig",
        vpnURL,
        { ...options, persist: 1 },
      ),
    ]);

    return {
      sessionId,
      token,
      vpnURL,
      ecPort,
      writes,
    };
  }

  async syncPortalGlobalState(targetUrlPart, context, options = {}) {
    const profile = options.profile ?? "service";
    const includeConfigWrites = options.includeConfigWrites ?? true;
    const batchRuntimeWrites = options.batchRuntimeWrites ?? true;
    const refreshTargetPerWrite = options.refreshTargetPerWrite ?? (profile === "login");
    let target = await this.waitForRemoteDebugTarget(targetUrlPart, options);
    const onPhase = options.onPhase ?? (() => {});
    const {
      token,
      vpnURL,
      runtimeWriteSpecs,
    } = buildPortalGlobalWriteSpecs(context, { profile });

    const runtimeWrites = [];
    if (batchRuntimeWrites) {
      const currentTarget = refreshTargetPerWrite
        ? await this.waitForRemoteDebugTarget(targetUrlPart, options)
        : target;
      onPhase(`sync-portal-state:${profile}:batch`);
      const batchResult = await this.writeContainerRuntimeValuesOnPageTarget(
        currentTarget,
        runtimeWriteSpecs,
        options,
      );
      runtimeWrites.push(...(batchResult?.writes ?? []));
      target = currentTarget;
    } else {
      for (const [keyPath, value, persist] of runtimeWriteSpecs) {
        const currentTarget = refreshTargetPerWrite
          ? await this.waitForRemoteDebugTarget(targetUrlPart, options)
          : target;
        onPhase(`sync-portal-state:${profile}:${keyPath}`);
        runtimeWrites.push(
          await this.writeContainerRuntimeValueOnPageTarget(currentTarget, keyPath, value, {
            ...options,
            persist,
          }),
        );
        target = currentTarget;
      }
    }

    const configWrites = [];
    if (includeConfigWrites) {
      for (const [key, value] of [
        ["twfID", context.sessionId],
        ["token", token],
      ]) {
        const currentTarget = refreshTargetPerWrite
          ? await this.waitForRemoteDebugTarget(targetUrlPart, options)
          : target;
        onPhase(`sync-portal-config:${profile}:${key}`);
        configWrites.push(
          await this.writeContainerConfigOnPageTarget(currentTarget, key, value, {
            ...options,
            awaitCallback: false,
          }),
        );
        target = currentTarget;
      }
    }

    return {
      sessionId: context.sessionId,
      token,
      vpnURL,
      profile,
      runtimeWrites,
      configWrites,
    };
  }

  async probePortalRuntimeWrite(targetUrlPart, keyPath, value, options = {}) {
    const remoteDebugPort = options.remoteDebugPort ?? 9222;
    const settleMs = options.settleMs ?? 1000;
    const target = await this.waitForRemoteDebugTarget(targetUrlPart, options);
    const beforeTargets = await this.getRemoteDebugTargets(remoteDebugPort).catch(() => []);
    const write = await this.writeContainerRuntimeValueOnPageTarget(target, keyPath, value, options);

    await sleep(settleMs);

    const afterTargets = await this.getRemoteDebugTargets(remoteDebugPort).catch(() => []);
    const sameTarget = afterTargets.find((item) => item.id === target.id) ?? null;

    return {
      targetUrlPart,
      keyPath,
      value,
      persist: options.persist ?? 0,
      beforeTarget: {
        id: target.id,
        url: target.url,
        title: target.title,
      },
      write,
      afterTarget: sameTarget ? {
        id: sameTarget.id,
        url: sameTarget.url,
        title: sameTarget.title,
      } : null,
      targetChanged: sameTarget ? sameTarget.url !== target.url : true,
      loginTarget: afterTargets.find((item) => item.url.includes("/portal/#!/login")) ?? null,
      serviceTarget: afterTargets.find((item) => item.url.includes("/portal/#!/service")) ?? null,
      beforeTargetCount: beforeTargets.length,
      afterTargetCount: afterTargets.length,
    };
  }

  async bootstrapViaPageBridge(targetUrlPart, context, options = {}) {
    const result = await this.evaluateOnRemoteDebugTarget(
      targetUrlPart,
      buildPageBridgeBootstrapExpression(context),
      options,
    );

    return result.evaluation?.result?.value ?? null;
  }

  async navigatePortalRoute(targetUrlPart, targetUrl, options = {}) {
    const result = await this.evaluateOnRemoteDebugTarget(
      targetUrlPart,
      buildPortalRouteRedirectExpression(targetUrl),
      options,
    );

    return result.evaluation?.result?.value ?? null;
  }

  async reloadPortalTarget(targetUrlPart, options = {}) {
    const result = await this.evaluateOnRemoteDebugTarget(
      targetUrlPart,
      buildPortalReloadExpression(),
      options,
    );

    return result.evaluation?.result?.value ?? null;
  }

  async openPortalLoginTarget(gatewayHost, gatewayPort, targetUrlPart, options = {}) {
    const waitForResponsiveTarget = async () => {
      const target = await this.waitForRemoteDebugTarget(targetUrlPart, options);
      await this.ensureRemoteDebugPageTargetResponsive(target, options);
      return this.waitForPortalLoginAuthBridgeReady(targetUrlPart, options);
    };

    try {
      return await waitForResponsiveTarget();
    } catch (error) {
      const targetUrl = `https://${gatewayHost}:${gatewayPort}${targetUrlPart}`;
      try {
        const fallbackTarget = await this.waitForAnyRemoteDebugPageTarget(options);
        await this.navigateRemoteDebugPageTarget(fallbackTarget, targetUrl, options);
        return await waitForResponsiveTarget();
      } catch (redirectError) {
        const recovery = await this.recoverViaUserMode({
          remoteDebugPort: options.remoteDebugPort ?? 9222,
          signal: options.signal,
        });
        const relaunchedTarget = await this.waitForAnyRemoteDebugPageTarget(options);
        await this.navigateRemoteDebugPageTarget(relaunchedTarget, targetUrl, options);
        const target = await waitForResponsiveTarget();
        return {
          ...target,
          recovery,
          staleTargetError: redirectError?.message ?? String(redirectError),
        };
      }
    }
  }

  async writePortalCookie(targetUrlPart, name, value, options = {}) {
    const result = await this.evaluateOnRemoteDebugTarget(
      targetUrlPart,
      buildPortalCookieWriteExpression(name, value, options),
      options,
    );

    return result.evaluation?.result?.value ?? null;
  }

  async runOfficialShellScript(scriptName, args = [], options = {}) {
    const scriptPath = path.join(path.dirname(path.dirname(this.appExecutable)), "Resources", "shell", scriptName);
    const timeout = options.timeoutMs ?? 20000;
    const result = await execFileAsync("/bin/bash", [scriptPath, ...args], {
      timeout,
    });

    return {
      script: scriptName,
      stdout: sanitizeCommandOutput(result.stdout),
      stderr: sanitizeCommandOutput(result.stderr),
    };
  }

  async listPathHolders(filePath) {
    try {
      const { stdout } = await execFileAsync("/usr/sbin/lsof", ["-nP", filePath], {
        timeout: 2000,
        maxBuffer: 128 * 1024,
      });
      return parseLsofHolders(stdout);
    } catch (error) {
      if (error.code === 1) {
        return [];
      }

      throw error;
    }
  }

  async clearStaleLocalServiceSockets(options = {}) {
    const signal = options.signal;
    const confDir = getBundleConfDir(this.appExecutable);
    const entries = [];

    for (const name of LOCAL_SERVICE_SOCKET_NAMES) {
      throwIfAborted(signal);
      const socketPath = path.join(confDir, name);

      try {
        const stat = await fs.lstat(socketPath);
        if (!stat.isSocket()) {
          entries.push({ name, path: socketPath, action: "not-socket" });
          continue;
        }

        const holders = await this.listPathHolders(socketPath);
        if (holders.length > 0) {
          entries.push({ name, path: socketPath, action: "held", holders });
          continue;
        }

        await fs.unlink(socketPath);
        entries.push({ name, path: socketPath, action: "deleted" });
      } catch (error) {
        if (error.code === "ENOENT") {
          entries.push({ name, path: socketPath, action: "missing" });
          continue;
        }

        entries.push({
          name,
          path: socketPath,
          action: "error",
          error: error.message,
        });
      }
    }

    return {
      confDir,
      entries,
    };
  }

  async listCoreServiceProcesses() {
    const resourcesDir = getBundleResourcesDir(this.appExecutable);
    const csclientPath = path.join(resourcesDir, "bin", "CSClient.app", "Contents", "MacOS", "CSClient");
    const svpnservicePath = path.join(resourcesDir, "bin", "svpnservice");
    const { stdout } = await execFileAsync("/bin/ps", ["-axo", "pid=,ppid=,command="], {
      timeout: 5000,
      maxBuffer: 1024 * 1024,
    });
    const processes = parseProcessList(stdout);

    return {
      csclient: processes.filter((process) => process.command.includes(csclientPath)),
      svpnservice: processes.filter((process) => process.command.includes(svpnservicePath)),
    };
  }

  async listAgentProcesses() {
    const resourcesDir = getBundleResourcesDir(this.appExecutable);
    const agentPaths = {
      easyMonitor: path.join(resourcesDir, "bin", "EasyMonitor"),
      ecAgent: path.join(resourcesDir, "bin", "ECAgent"),
      ecAgentProxy: path.join(resourcesDir, "bin", "ECAgentProxy"),
    };
    const { stdout } = await execFileAsync("/bin/ps", ["-axo", "pid=,ppid=,command="], {
      timeout: 5000,
      maxBuffer: 1024 * 1024,
    });
    const processes = parseProcessList(stdout);

    return Object.fromEntries(
      Object.entries(agentPaths).map(([name, processPath]) => [
        name,
        filterProcessesByExecutable(processes, processPath),
      ]),
    );
  }

  async collectRecoveryDiagnostics() {
    const todayLogPath = path.join(LOGS_DIR, `EasyConnect_${os.userInfo().username}.${new Date().toISOString().slice(0, 10).replaceAll("-", "")}.log`);
    const diagnostics = {
      collectedAt: Date.now(),
      processes: await this.listCoreServiceProcesses().catch(() => null),
      agentProcesses: await this.listAgentProcesses().catch(() => null),
      officialLogs: {
        csclient: await readRecentLogLines(path.join(LOGS_DIR, "CSClient.log"), { limit: 24 }),
        startSvpn: await readRecentLogLines(path.join(LOGS_DIR, "StartSvpn.log"), { limit: 16 }),
        easyconnect: await readRecentLogLines(todayLogPath, { limit: 24 }),
        localServiceManager: await readRecentLogLines("/Library/Logs/Sangfor/EasyConnect/LocalServiceManager.log", { limit: 24 }),
      },
    };
    diagnostics.classification = classifyRecoveryDiagnostics(diagnostics);
    return diagnostics;
  }

  async waitForCoreServiceProcesses(options = {}) {
    const timeoutMs = options.timeoutMs ?? 15000;
    const pollMs = options.pollMs ?? 500;
    const signal = options.signal;
    const startedAt = Date.now();
    let lastProcesses = { csclient: [], svpnservice: [] };

    while (Date.now() - startedAt < timeoutMs) {
      throwIfAborted(signal);
      lastProcesses = await this.listCoreServiceProcesses();

      if (lastProcesses.csclient.length > 0 && lastProcesses.svpnservice.length > 0) {
        return lastProcesses;
      }

      await sleep(pollMs, signal);
    }

    const error = new Error("Core services did not become ready after official scripts returned");
    error.processes = lastProcesses;
    throw error;
  }

  async startCoreServices(options = {}) {
    const username = `${options.username ?? os.userInfo().username ?? ""}`.trim();
    const gatewayHost = `${options.gatewayHost ?? ""}`.trim();
    const gatewayPort = Number.parseInt(`${options.gatewayPort ?? ""}`, 10) || null;
    const timeoutMs = options.timeoutMs ?? 20000;
    const processCheckTimeoutMs = options.processCheckTimeoutMs ?? 15000;
    const processCheckPollMs = options.processCheckPollMs ?? 500;
    const signal = options.signal;

    if (!username || !gatewayHost || !gatewayPort) {
      throw new Error("startCoreServices requires username, gatewayHost, and gatewayPort");
    }

    const staleLocalServiceSockets = await this.clearStaleLocalServiceSockets({
      signal,
    });
    const svpnservice = await this.runOfficialShellScript("svpnservice.sh", ["-u", username], {
      timeoutMs,
    });
    const csclient = await this.runOfficialShellScript(
      "sslservice.sh",
      ["-u", username, "-h", gatewayHost, "-p", `${gatewayPort}`, "-s"],
      {
        timeoutMs,
      },
    );
    const processes = await this.waitForCoreServiceProcesses({
      timeoutMs: processCheckTimeoutMs,
      pollMs: processCheckPollMs,
      signal,
    });

    return {
      staleLocalServiceSockets,
      svpnservice,
      csclient,
      processes,
    };
  }

  async recoverLoginViaPageBridge(options) {
    const {
      gatewayLogin,
      gatewayHost,
      gatewayPort,
      username,
      password,
      captcha = "",
      remoteDebugPort = 9222,
      targetUrlPart = "/portal/#!/login",
      portalTimeoutMs = 45000,
      pollMs = 1000,
      onlineTimeoutMs = 90000,
      statusPollMs = 1500,
      officialAutoLoginTimeoutMs = 12000,
      officialRendererLoginTimeoutMs = null,
      officialRendererLoginOnlineTimeoutMs = null,
      serviceReloadSettleMs = 2000,
      signal,
      onPhase = () => {},
    } = options ?? {};

    if (!gatewayLogin) {
      throw new Error("recoverLoginViaPageBridge requires gatewayLogin");
    }

    if (!gatewayHost || !gatewayPort || !username || !password) {
      throw new Error("recoverLoginViaPageBridge requires gatewayHost, gatewayPort, username, and password");
    }

    const signalOption = signal ? { signal } : {};
    const serviceTargetUrlPart = "/portal/#!/service";
    const effectiveOfficialRendererLoginTimeoutMs =
      officialRendererLoginTimeoutMs ?? (officialAutoLoginTimeoutMs > 0 ? 60000 : 0);
    const effectiveOfficialRendererLoginOnlineTimeoutMs =
      officialRendererLoginOnlineTimeoutMs ?? onlineTimeoutMs;
    const currentSession = await this.describeActiveSession();
    if (currentSession.token) {
      try {
        const [loginStatus, serviceState] = await Promise.all([
          this.getLoginStatus(currentSession.token),
          this.getServiceState(currentSession.token),
        ]);

        if (loginStatus?.status === "1") {
          return {
            action: "already-online",
            online: {
              activeSession: currentSession,
              loginStatus,
              serviceState,
            },
          };
        }
      } catch {
        // Fall through to recovery when the cached session is stale.
      }
    }

    throwIfAborted(signal);
    onPhase("recover-user-mode");
    const recovery = await this.recoverViaUserMode({ remoteDebugPort });
    throwIfAborted(signal);
    onPhase("wait-login-target");
    await this.openPortalLoginTarget(gatewayHost, gatewayPort, targetUrlPart, {
      remoteDebugPort,
      timeoutMs: portalTimeoutMs,
      pollMs,
      ...signalOption,
    });

    let officialAutoLogin = null;
    if (officialAutoLoginTimeoutMs > 0) {
      throwIfAborted(signal);
      onPhase("wait-official-auto-login");
      try {
        officialAutoLogin = await this.waitForOnlineStatus({
          timeoutMs: officialAutoLoginTimeoutMs,
          pollMs: statusPollMs,
          ...signalOption,
        });
      } catch {
        officialAutoLogin = null;
      }
    }

    if (officialAutoLogin) {
      throwIfAborted(signal);
      onPhase("official-auto-login-online");
      return {
        mode: "official-auto-login",
        recovery,
        online: officialAutoLogin,
      };
    }

    let officialRendererLoginError = null;
    if (effectiveOfficialRendererLoginTimeoutMs > 0) {
      throwIfAborted(signal);
      onPhase("official-renderer-login");
      try {
        const officialRendererLogin = await this.triggerPortalOfficialPasswordLogin({
          username,
          password,
          captcha,
          gatewayHost,
          gatewayPort,
          remoteDebugPort,
          targetUrlPart,
          timeoutMs: effectiveOfficialRendererLoginTimeoutMs,
          pollMs,
          ...signalOption,
        });

        throwIfAborted(signal);
        onPhase("navigate-service-after-official-renderer-login");
        await this.navigatePortalRoute(
          targetUrlPart,
          `https://${gatewayHost}:${gatewayPort}${serviceTargetUrlPart}`,
          {
            remoteDebugPort,
            timeoutMs: portalTimeoutMs,
            pollMs,
            ...signalOption,
          },
        );

        await this.waitForRemoteDebugTarget(serviceTargetUrlPart, {
          remoteDebugPort,
          timeoutMs: portalTimeoutMs,
          pollMs,
          ...signalOption,
        });

        throwIfAborted(signal);
        onPhase("start-official-portal-service-after-official-renderer-login");
        let officialPortalService = null;
        let firstOfficialPortalServiceError = null;
        try {
          officialPortalService = await this.startOfficialPortalService(serviceTargetUrlPart, {
            remoteDebugPort,
            username,
            timeoutMs: Math.max(portalTimeoutMs, 90000),
            pollMs,
            signal,
          });
        } catch (error) {
          if (error?.code !== "EASYCONNECT_OFFICIAL_PORTAL_SERVICE_START_FAILED") {
            throw error;
          }

          firstOfficialPortalServiceError = error;
        }

        let online = null;
        let finalCoreServices = {
          mode: "official-portal-service",
          firstAttempt: officialPortalService,
        };
        let firstOnlineError = null;

        if (firstOfficialPortalServiceError) {
          throwIfAborted(signal);
          onPhase("recover-official-portal-service-after-official-renderer-login");
          const killedCoreServices = await this.killCoreServiceProcesses({ force: true });
          const resetAgentProxy = await this.resetAgentProxy({ force: true });
          const agentProxyReady = await this.waitForAgentProxyReady({
            timeoutMs: 15000,
            pollMs: 500,
            signal,
          });
          const retryOfficialPortalService = await this.startOfficialPortalService(serviceTargetUrlPart, {
            remoteDebugPort,
            username,
            timeoutMs: Math.max(portalTimeoutMs, 90000),
            pollMs,
            signal,
          });

          finalCoreServices = {
            mode: "official-portal-service",
            retryReason: "official-portal-service-start-failed",
            firstAttemptError: {
              code: firstOfficialPortalServiceError.code,
              message: firstOfficialPortalServiceError.message,
              serviceStart: firstOfficialPortalServiceError.serviceStart,
            },
            killedCoreServices,
            resetAgentProxy,
            agentProxyReady,
            retryAttempt: retryOfficialPortalService,
          };
        }

        throwIfAborted(signal);
        onPhase("wait-online-after-official-renderer-login");

        try {
          online = await this.waitForOnlineStatus({
            timeoutMs: effectiveOfficialRendererLoginOnlineTimeoutMs,
            pollMs: statusPollMs,
            ...signalOption,
          });
        } catch (error) {
          if (!isLocalServiceNotReadyError(error)) {
            throw error;
          }

          firstOnlineError = error;
        }

        if (firstOnlineError) {
          throwIfAborted(signal);
          onPhase("recover-local-service-not-ready-after-official-renderer-login");
          const killedCoreServices = await this.killCoreServiceProcesses({ force: true });
          const resetAgentProxy = await this.resetAgentProxy({ force: true });
          const agentProxyReady = await this.waitForAgentProxyReady({
            timeoutMs: 15000,
            pollMs: 500,
            signal,
          });
          const retryOfficialPortalService = await this.startOfficialPortalService(serviceTargetUrlPart, {
            remoteDebugPort,
            username,
            timeoutMs: Math.max(portalTimeoutMs, 90000),
            pollMs,
            signal,
          });

          finalCoreServices = {
            mode: "official-portal-service",
            retryReason: "local-service-not-ready",
            firstOnlineDiagnostics: firstOnlineError.diagnostics,
            killedCoreServices,
            resetAgentProxy,
            agentProxyReady,
            firstAttempt: finalCoreServices,
            retryAttempt: retryOfficialPortalService,
          };

          throwIfAborted(signal);
          onPhase("wait-online-after-official-renderer-local-service-retry");
          online = await this.waitForOnlineStatus({
            timeoutMs: effectiveOfficialRendererLoginOnlineTimeoutMs,
            pollMs: statusPollMs,
            ...signalOption,
          });
        }

        throwIfAborted(signal);
        onPhase("refresh-service-page");
        const serviceReload = await this.reloadPortalTarget(serviceTargetUrlPart, {
          remoteDebugPort,
          timeoutMs: portalTimeoutMs,
          pollMs,
          ...signalOption,
        });

        await this.waitForRemoteDebugTarget(serviceTargetUrlPart, {
          remoteDebugPort,
          timeoutMs: portalTimeoutMs,
          pollMs,
          ...signalOption,
        });
        await sleep(serviceReloadSettleMs, signal);

        return {
          mode: "official-renderer-login",
          recovery,
          officialRendererLogin,
          coreServices: finalCoreServices,
          serviceReload,
          online,
        };
      } catch (error) {
        officialRendererLoginError = {
          code: error?.code ?? null,
          message: error?.message ?? String(error),
          loginResult: error?.loginResult ?? null,
          lastProbe: error?.lastProbe ?? null,
        };
        onPhase("official-renderer-login-fallback-backend");
      }
    }

    throwIfAborted(signal);
    onPhase("backend-login-session");
    const session = await gatewayLogin.loginPasswordSession({
      username,
      password,
      randCode: captcha,
    });

    const context = {
      sessionId: session.effectiveTwfId,
      gatewayHost,
      gatewayPort,
      username,
      browserType: "default",
      lang: "zh_CN",
      loginClientType: 3,
      trayType: 1,
      passwordConfigSummary: session.config?.summary ?? {},
    };

    throwIfAborted(signal);
    onPhase("sync-portal-login-state");
    await this.syncPortalGlobalState(targetUrlPart, context, {
      remoteDebugPort,
      timeoutMs: portalTimeoutMs,
      pollMs,
      ...signalOption,
      profile: "login",
      includeConfigWrites: true,
      onPhase,
    });

    throwIfAborted(signal);
    onPhase("sync-portal-cookie");
    await this.writePortalCookie(targetUrlPart, "TWFID", context.sessionId, {
      remoteDebugPort,
      timeoutMs: portalTimeoutMs,
      pollMs,
      ...signalOption,
      path: "/",
    });

    throwIfAborted(signal);
    onPhase("navigate-service");
    await this.navigatePortalRoute(
      targetUrlPart,
      `https://${gatewayHost}:${gatewayPort}/portal/#!/service`,
      {
        remoteDebugPort,
        timeoutMs: portalTimeoutMs,
        pollMs,
        ...signalOption,
      },
    );

    throwIfAborted(signal);
    onPhase("wait-service-target");
    await this.waitForRemoteDebugTarget(serviceTargetUrlPart, {
      remoteDebugPort,
      timeoutMs: portalTimeoutMs,
      pollMs,
      ...signalOption,
    });

    throwIfAborted(signal);
    onPhase("sync-portal-service-state");
    await this.syncPortalGlobalState(serviceTargetUrlPart, context, {
      remoteDebugPort,
      timeoutMs: portalTimeoutMs,
      pollMs,
      ...signalOption,
      profile: "service",
      includeConfigWrites: false,
      onPhase,
    });

    throwIfAborted(signal);
    onPhase("page-bridge-bootstrap");
    const bridge = await this.bootstrapViaPageBridge(
      serviceTargetUrlPart,
      context,
      {
        remoteDebugPort,
        timeoutMs: portalTimeoutMs,
        pollMs,
        ...signalOption,
      },
    );

    throwIfAborted(signal);
    onPhase("start-core-services");
    const coreServices = await this.startCoreServices({
      username,
      gatewayHost,
      gatewayPort,
      timeoutMs: portalTimeoutMs,
    });

    throwIfAborted(signal);
    onPhase("wait-online");
    let online = null;
    let finalCoreServices = coreServices;
    let firstOnlineError = null;

    try {
      online = await this.waitForOnlineStatus({
        timeoutMs: onlineTimeoutMs,
        pollMs: statusPollMs,
        ...signalOption,
      });
    } catch (error) {
      if (!isLocalServiceNotReadyError(error)) {
        throw error;
      }

      firstOnlineError = error;
    }

    if (firstOnlineError) {
      throwIfAborted(signal);
      onPhase("recover-local-service-not-ready");
      const killedCoreServices = await this.killCoreServiceProcesses({ force: true });
      const resetAgentProxy = await this.resetAgentProxy({ force: true });
      const agentProxyReady = await this.waitForAgentProxyReady({
        timeoutMs: 15000,
        pollMs: 500,
        signal,
      });
      const retryCoreServices = await this.startCoreServices({
        username,
        gatewayHost,
        gatewayPort,
        timeoutMs: portalTimeoutMs,
        signal,
      });

      finalCoreServices = {
        ...retryCoreServices,
        retryReason: "local-service-not-ready",
        firstOnlineDiagnostics: firstOnlineError.diagnostics,
        killedCoreServices,
        resetAgentProxy,
        agentProxyReady,
        firstAttempt: coreServices,
      };

      throwIfAborted(signal);
      onPhase("wait-online-after-local-service-retry");
      online = await this.waitForOnlineStatus({
        timeoutMs: onlineTimeoutMs,
        pollMs: statusPollMs,
        ...signalOption,
      });
    }

    throwIfAborted(signal);
    onPhase("refresh-service-page");
    const serviceReload = await this.reloadPortalTarget(serviceTargetUrlPart, {
      remoteDebugPort,
      timeoutMs: portalTimeoutMs,
      pollMs,
      ...signalOption,
    });

    throwIfAborted(signal);
    onPhase("wait-service-target-after-refresh");
    await this.waitForRemoteDebugTarget(serviceTargetUrlPart, {
      remoteDebugPort,
      timeoutMs: portalTimeoutMs,
      pollMs,
      ...signalOption,
    });

    await sleep(serviceReloadSettleMs, signal);

    return {
      recovery,
      officialRendererLoginError,
      loginSummary: session.login.summary,
      bridge,
      coreServices: finalCoreServices,
      serviceReload,
      online,
    };
  }

  async waitForOnlineStatus(options = {}) {
    const timeoutMs = options.timeoutMs ?? 90000;
    const pollMs = options.pollMs ?? 1500;
    const signal = options.signal;
    const startedAt = Date.now();

    while (Date.now() - startedAt < timeoutMs) {
      throwIfAborted(signal);
      const session = await this.describeActiveSession();
      if (session.token) {
        const loginStatus = await this.getLoginStatus(session.token);
        const serviceState = await this.getServiceState(session.token);

        if (loginStatus.status === "1") {
          return {
            activeSession: session,
            loginStatus,
            serviceState,
          };
        }

        if (getLogoutReasonCode(loginStatus) === "LOGOUT_PRIVATEKICK") {
          throw createPrivateKickError(loginStatus, serviceState);
        }
      }

      await sleep(pollMs, signal);
    }

    const diagnostics = await this.collectRecoveryDiagnostics().catch((error) => ({
      classification: "unknown",
      collectionError: error?.message ?? String(error),
    }));
    const isLocalServiceNotReady = diagnostics.classification === "local-service-not-ready";
    const error = new Error(
      isLocalServiceNotReady
        ? "Local service did not become ready before online status timeout"
        : "Timed out waiting for online login status",
    );
    if (isLocalServiceNotReady) {
      error.code = "EASYCONNECT_LOCAL_SERVICE_NOT_READY";
    }
    error.diagnostics = diagnostics;
    throw error;
  }

  async recoverLoginViaUserDebug(options) {
    const username = options?.username;
    const password = options?.password;
    const remoteDebugPort = options?.remoteDebugPort ?? 9222;

    if (!username || !password) {
      throw new Error("recoverLoginViaUserDebug requires username and password");
    }

    const currentSession = await this.describeActiveSession();
    if (currentSession.token) {
      try {
        const [loginStatus, serviceState] = await Promise.all([
          this.getLoginStatus(currentSession.token),
          this.getServiceState(currentSession.token),
        ]);

        if (loginStatus?.status === "1") {
          return {
            action: "already-online",
            online: {
              activeSession: currentSession,
              loginStatus,
              serviceState,
            },
          };
        }
      } catch {
        // Fall through to a fresh browser-mode recovery when the cached session is stale.
      }
    }

    const recovery = await this.recoverViaUserMode({ remoteDebugPort });
    const portalTarget = await this.waitForRemoteDebugTarget("/portal/#!/login", {
      remoteDebugPort,
      timeoutMs: options?.portalTimeoutMs ?? 45000,
      pollMs: options?.pollMs ?? 1000,
    });
    const triggered = await this.triggerPortalOfficialPasswordLogin({
      username,
      password,
      captcha: options?.captcha ?? "",
      remoteDebugPort,
      timeoutMs: options?.portalTimeoutMs ?? 45000,
      pollMs: options?.pollMs ?? 1000,
    });
    await this.navigatePortalRoute(
      "/portal/#!/login",
      options?.serviceUrl ?? portalTarget.url.replace("/portal/#!/login", "/portal/#!/service"),
      {
        remoteDebugPort,
        timeoutMs: options?.portalTimeoutMs ?? 45000,
        pollMs: options?.pollMs ?? 1000,
      },
    ).catch(() => null);
    const online = await this.waitForOnlineStatus({
      timeoutMs: options?.onlineTimeoutMs ?? 90000,
      pollMs: options?.statusPollMs ?? 1500,
    });

    return {
      recovery,
      portalTarget: {
        id: portalTarget.id,
        url: portalTarget.url,
      },
      triggered,
      online,
    };
  }

  async getEnvironmentSummary() {
    const bundleSettingPath = await this.getBundleSettingPath();
    const activeSession = await this.describeActiveSession();
    const latestCachedToken = await this.describeLatestCachedToken();
    const appExecutableExists = await exists(this.appExecutable);

    return {
      appSupportDir: APP_SUPPORT_DIR,
      cacheDir: CACHE_DIR,
      logsDir: LOGS_DIR,
      appExecutable: this.appExecutable,
      appExecutableExists,
      bundleConfDir: getBundleConfDir(this.appExecutable),
      bundleSettingPath,
      port: await this.getPort(),
      activeSession,
      latestCachedToken,
      gatewayCandidates: await this.getGatewayCandidates(),
    };
  }
}

export {
  APP_SUPPORT_DIR,
  CACHE_DIR,
  LOGS_DIR,
  APP_EXECUTABLE,
  buildContainerConfigReadExpression,
  buildContainerConfigWriteExpression,
  buildPortalCookieWriteExpression,
  buildPortalReloadExpression,
  buildPortalRouteRedirectExpression,
  buildPortalInitConfigData,
  buildPortalGlobalWriteSpecs,
  buildPageBridgeBootstrapExpression,
  buildContainerRuntimeReadExpression,
  buildContainerRuntimeWriteExpression,
  buildContainerRuntimeBatchWriteExpression,
  buildPortalPasswordLoginExpression,
  buildPortalPasswordVmStateExpression,
  buildPortalOfficialAuthStateExpression,
  buildPortalOfficialPasswordLoginExpression,
  buildPortalOfficialServiceStartExpression,
  buildAgentProxyResetFinalState,
  buildLaunchctlActionEntry,
  filterProcessesByExecutable,
  listFilesByMtime,
  extractTokensFromCacheFromDir,
  getBundleConfDir,
  parseLaunchctlPrintState,
  DEFAULT_PORT,
  DEFAULT_HOST,
  TOKEN_SALT,
  redactToken,
  encodeLaunchTwfId,
};
