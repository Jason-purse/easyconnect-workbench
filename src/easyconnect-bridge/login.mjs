import https from "node:https";
import { createPublicKey, publicEncrypt, constants } from "node:crypto";
import { promises as fs } from "node:fs";

function extract(xml, tag) {
  return ((xml.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`)) || [])[1] || "").trim();
}

function xmlAuthSummary(xml) {
  return {
    errorCode: extract(xml, "ErrorCode"),
    message: extract(xml, "Message"),
    note: extract(xml, "Note"),
    twfId: extract(xml, "TwfID"),
    csrfRandCode: extract(xml, "CSRF_RAND_CODE"),
    useRandCode: extract(xml, "USE_RAND_CODE"),
    midAtkCheck: extract(xml, "MID_ATK_CHECK"),
    authInfo: extract(xml, "AuthInfo"),
    nextService: extract(xml, "NextService"),
  };
}

function extractCookieTwfId(setCookieHeader) {
  const values = Array.isArray(setCookieHeader)
    ? setCookieHeader
    : setCookieHeader
      ? [setCookieHeader]
      : [];

  for (const value of values) {
    const match = value.match(/(?:^|;\s*)TWFID=([^;]+)/);
    if (match) {
      return match[1];
    }
  }

  return "";
}

function buildGatewayPublicKey(modulusHex, exponentDec = "65537") {
  const expHexRaw = BigInt(Number.parseInt(exponentDec, 10)).toString(16);
  const expHex = expHexRaw.length % 2 === 1 ? `0${expHexRaw}` : expHexRaw;

  return createPublicKey({
    key: {
      kty: "RSA",
      n: Buffer.from(modulusHex, "hex").toString("base64url"),
      e: Buffer.from(expHex, "hex").toString("base64url"),
    },
    format: "jwk",
  });
}

function encryptGatewayPassword(password, csrfRandCode, rsaKeyHex, rsaExponentDec) {
  const publicKey = buildGatewayPublicKey(rsaKeyHex, rsaExponentDec);
  const plaintext = `${password}_${csrfRandCode}`;
  return publicEncrypt(
    {
      key: publicKey,
      padding: constants.RSA_PKCS1_PADDING,
    },
    Buffer.from(plaintext, "utf8"),
  ).toString("hex");
}

export class EasyConnectGatewayLogin {
  constructor(options = {}) {
    this.host = options.host;
    this.port = options.port;
    this.userAgent = options.userAgent ?? "easyconnect_mac";
    this.referer = options.referer ?? `https://${this.host}:${this.port}/portal`;
    this.timeoutMs = options.timeoutMs ?? 10000;
    this.requestFactory = options.requestFactory ?? https.request.bind(https);
  }

  request({ method = "GET", path, headers = {}, body = "", binary = false, timeoutMs = this.timeoutMs }) {
    return new Promise((resolve, reject) => {
      const req = this.requestFactory(
        {
          hostname: this.host,
          port: this.port,
          path,
          method,
          headers,
          rejectUnauthorized: false,
        },
        (res) => {
          const chunks = [];
          res.on("data", (chunk) => chunks.push(chunk));
          res.on("end", () => {
            const buffer = Buffer.concat(chunks);
            resolve({
              statusCode: res.statusCode,
              headers: res.headers,
              body: binary ? buffer : buffer.toString("utf8"),
            });
          });
        },
      );

      if (typeof req.setTimeout === "function") {
        req.setTimeout(timeoutMs, () => {
          req.destroy(new Error(`Request timed out: ${method} ${path}`));
        });
      }

      req.on("error", reject);
      if (body) {
        req.write(body);
      }
      req.end();
    });
  }

  async loginAuth() {
    const response = await this.request({
      path: "/por/login_auth.csp",
      headers: {
        "User-Agent": this.userAgent,
      },
    });

    const xml = response.body;
    const twfId = extract(xml, "TwfID");

    return {
      response,
      xml,
      cookie: `TWFID=${twfId}`,
      summary: xmlAuthSummary(xml),
      twfId,
    };
  }

  async passwordConfig(cookie) {
    const response = await this.request({
      path: "/public/psw_config",
      headers: {
        "User-Agent": this.userAgent,
        Cookie: cookie,
      },
    });

    const xml = response.body;
    return {
      response,
      xml,
      summary: {
        ...xmlAuthSummary(xml),
        rsaEncryptKey: extract(xml, "RSA_ENCRYPT_KEY"),
        rsaEncryptExp: extract(xml, "RSA_ENCRYPT_EXP"),
        passwordAction: extract(xml, "U_PSWACTION"),
      },
    };
  }

  async fetchCaptcha(cookie, outputPath) {
    const response = await this.request({
      path: `/por/rand_code.csp?rnd=${Math.random()}`,
      headers: {
        "User-Agent": this.userAgent,
        Cookie: cookie,
      },
      binary: true,
    });

    if (outputPath) {
      await fs.writeFile(outputPath, response.body);
    }

    return response;
  }

  async loginWithPassword({
    username,
    password,
    cookie,
    csrfRandCode,
    rsaEncryptKey,
    rsaEncryptExp,
    randCode = "",
  }) {
    const encryptedPassword = encryptGatewayPassword(
      password,
      csrfRandCode,
      rsaEncryptKey,
      rsaEncryptExp,
    );

    const form = new URLSearchParams({
      mitm_result: "",
      svpn_req_randcode: csrfRandCode,
      svpn_name: username,
      svpn_password: encryptedPassword,
      svpn_rand_code: randCode,
    }).toString();

    const response = await this.request({
      method: "POST",
      path: "/por/login_psw.csp?anti_replay=1&encrypt=1",
      headers: {
        "User-Agent": this.userAgent,
        Referer: this.referer,
        "Content-Type": "application/x-www-form-urlencoded",
        "Content-Length": Buffer.byteLength(form),
        Cookie: cookie,
      },
      body: form,
    });

    const cookieTwfId = extractCookieTwfId(response.headers["set-cookie"]);
    const bodyTwfId = extract(response.body, "TwfID");
    const effectiveTwfId = cookieTwfId || bodyTwfId;

    return {
      response,
      xml: response.body,
      summary: {
        ...xmlAuthSummary(response.body),
        cookieTwfId,
        bodyTwfId,
        effectiveTwfId,
      },
    };
  }

  async loginPasswordSession({ username, password, randCode = "" }) {
    const auth = await this.loginAuth();
    const config = await this.passwordConfig(auth.cookie);
    const login = await this.loginWithPassword({
      username,
      password,
      cookie: auth.cookie,
      csrfRandCode: config.summary.csrfRandCode,
      rsaEncryptKey: config.summary.rsaEncryptKey,
      rsaEncryptExp: config.summary.rsaEncryptExp,
      randCode,
    });

    return {
      auth,
      config,
      login,
      effectiveTwfId: login.summary.effectiveTwfId,
    };
  }
}

export { encryptGatewayPassword, xmlAuthSummary };
