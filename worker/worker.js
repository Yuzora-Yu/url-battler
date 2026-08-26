import { DurableObject } from "cloudflare:workers";

const PAGESPEED_ENDPOINT = "https://pagespeedonline.googleapis.com/pagespeedonline/v5/runPagespeed";
const CACHE_TTL_SECONDS = 24 * 60 * 60;
const UPSTREAM_TIMEOUT_MS = 30_000;
const WORKER_VERSION = "0.8.0";

const GLOBAL_MINUTE_LIMIT = 150;
const GLOBAL_DAILY_LIMIT = 15_000;
const USER_DAILY_ENERGY = 5;
const MINUTE_WINDOW_MS = 60_000;
const JST_OFFSET_MS = 9 * 60 * 60 * 1000;
const SESSION_COOKIE = "urlb_session_v1";
const SESSION_MAX_AGE = 365 * 24 * 60 * 60;

/**
 * Global, strongly-consistent admission controller for fresh PageSpeed scans.
 *
 * One named instance ("global") coordinates:
 * - rolling 60-second limit: 150 fresh PageSpeed attempts
 * - JST calendar-day limit: 15,000 fresh PageSpeed attempts
 * - anonymous session energy: 5 successful fresh scans / JST day
 * - future rewarded-ad bonus: at most +1 / JST day
 *
 * This intentionally uses a SQLite-backed Durable Object instead of Workers
 * Rate Limiting or KV, because those are not suitable for strict global accounting.
 */
export class ScanGuard extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS global_state (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        day_key TEXT NOT NULL,
        daily_count INTEGER NOT NULL DEFAULT 0,
        recent_json TEXT NOT NULL DEFAULT '[]'
      );
      INSERT OR IGNORE INTO global_state (singleton, day_key, daily_count, recent_json)
      VALUES (1, '', 0, '[]');

      CREATE TABLE IF NOT EXISTS user_energy (
        user_id TEXT PRIMARY KEY,
        day_key TEXT NOT NULL,
        used INTEGER NOT NULL DEFAULT 0,
        reward_used INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL
      );
    `);
  }

  getEnergy(userId, nowMs = Date.now()) {
    const day = jstDayInfo(nowMs);
    const row = this.sql.exec(
      "SELECT day_key, used, reward_used FROM user_energy WHERE user_id = ?",
      userId
    ).toArray()[0];
    // Read-only status checks must not create a row for every casual visitor.
    if (!row || row.day_key !== day.dayKey) {
      return energyState({ day_key:day.dayKey, used:0, reward_used:0 }, day);
    }
    return energyState(row, day);
  }

  authorizeFresh(userId, nowMs = Date.now()) {
    return this.ctx.storage.transactionSync(() => {
      const day = jstDayInfo(nowMs);
      const user = this.ensureUserDay(userId, day.dayKey, nowMs);
      const currentEnergy = energyState(user, day);

      if (currentEnergy.remaining <= 0) {
        return {
          ok: false,
          code: "USER_DAILY_LIMIT",
          message: "Daily scan energy exhausted",
          energy: currentEnergy,
          retryAfter: secondsUntil(day.resetAt, nowMs),
          resetAt: day.resetAt
        };
      }

      const state = this.sql.exec(
        "SELECT day_key, daily_count, recent_json FROM global_state WHERE singleton = 1"
      ).one();
      let recent = parseRecentTimestamps(state?.recent_json);
      const cutoff = nowMs - MINUTE_WINDOW_MS;
      recent = recent.filter(ts => ts > cutoff && ts <= nowMs);
      const minuteCount = recent.length;

      if (minuteCount >= GLOBAL_MINUTE_LIMIT) {
        const oldest = recent[0] || nowMs;
        return {
          ok: false,
          code: "SCANNER_MINUTE_LIMIT",
          message: "Fresh scan minute limit reached",
          energy: currentEnergy,
          quota: quotaState(minuteCount, state?.day_key === day.dayKey ? Number(state?.daily_count || 0) : 0),
          retryAfter: Math.max(1, Math.ceil((oldest + MINUTE_WINDOW_MS - nowMs) / 1000))
        };
      }

      const dailyCount = state?.day_key === day.dayKey ? Number(state?.daily_count || 0) : 0;
      if (dailyCount >= GLOBAL_DAILY_LIMIT) {
        return {
          ok: false,
          code: "SCANNER_DAILY_LIMIT",
          message: "Fresh scan daily limit reached",
          energy: currentEnergy,
          quota: quotaState(minuteCount, dailyCount),
          retryAfter: secondsUntil(day.resetAt, nowMs),
          resetAt: day.resetAt
        };
      }

      recent.push(nowMs);
      this.sql.exec(`
        UPDATE global_state
        SET day_key = ?, daily_count = ?, recent_json = ?
        WHERE singleton = 1
      `, day.dayKey, dailyCount + 1, JSON.stringify(recent));
      this.sql.exec(`
        UPDATE user_energy
        SET used = used + 1, updated_at = ?
        WHERE user_id = ?
      `, nowMs, userId);

      const afterUser = this.sql.exec(
        "SELECT day_key, used, reward_used FROM user_energy WHERE user_id = ?",
        userId
      ).one();

      return {
        ok: true,
        dayKey: day.dayKey,
        energy: energyState(afterUser, day),
        quota: quotaState(minuteCount + 1, dailyCount + 1),
        resetAt: day.resetAt
      };
    });
  }

  refundEnergy(userId, dayKey, nowMs = Date.now()) {
    return this.ctx.storage.transactionSync(() => {
      const day = jstDayInfo(nowMs);
      const row = this.ensureUserDay(userId, day.dayKey, nowMs);
      if (row.day_key === dayKey && Number(row.used || 0) > 0) {
        this.sql.exec(
          "UPDATE user_energy SET used = used - 1, updated_at = ? WHERE user_id = ? AND day_key = ? AND used > 0",
          nowMs,
          userId,
          dayKey
        );
      }
      const after = this.sql.exec(
        "SELECT day_key, used, reward_used FROM user_energy WHERE user_id = ?",
        userId
      ).one();
      return energyState(after, day);
    });
  }

  /**
   * Future use only: call this after a rewarded-ad provider's server-side
   * verification succeeds. Do not expose a public "reward complete" route that
   * trusts a browser-only signal.
   */
  grantDailyReward(userId, nowMs = Date.now()) {
    return this.ctx.storage.transactionSync(() => {
      const day = jstDayInfo(nowMs);
      const row = this.ensureUserDay(userId, day.dayKey, nowMs);
      const before = energyState(row, day);

      if (Number(row.reward_used || 0) === 1) {
        return { ok:false, code:"REWARD_ALREADY_USED", energy:before };
      }
      if (before.remaining >= USER_DAILY_ENERGY) {
        return { ok:false, code:"ENERGY_FULL", energy:before };
      }

      // Reward restores exactly one spent energy. The gauge stays 0..5,
      // while reward_used ensures this can happen only once per JST day.
      this.sql.exec(`
        UPDATE user_energy
        SET used = MAX(0, used - 1), reward_used = 1, updated_at = ?
        WHERE user_id = ?
      `, nowMs, userId);
      const after = this.sql.exec(
        "SELECT day_key, used, reward_used FROM user_energy WHERE user_id = ?",
        userId
      ).one();
      return { ok:true, energy:energyState(after, day) };
    });
  }

  ensureUserDay(userId, dayKey, nowMs) {
    let row = this.sql.exec(
      "SELECT day_key, used, reward_used FROM user_energy WHERE user_id = ?",
      userId
    ).toArray()[0];

    if (!row) {
      this.sql.exec(`
        INSERT INTO user_energy (user_id, day_key, used, reward_used, updated_at)
        VALUES (?, ?, 0, 0, ?)
      `, userId, dayKey, nowMs);
      row = { day_key:dayKey, used:0, reward_used:0 };
    } else if (row.day_key !== dayKey) {
      this.sql.exec(`
        UPDATE user_energy
        SET day_key = ?, used = 0, reward_used = 0, updated_at = ?
        WHERE user_id = ?
      `, dayKey, nowMs, userId);
      row = { day_key:dayKey, used:0, reward_used:0 };
    }
    return row;
  }
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";
    const allowedOrigins = env.ALLOWED_ORIGINS || env.ALLOWED_ORIGIN || "";
    const cors = corsHeaders(origin, allowedOrigins);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors });
    }

    const url = new URL(request.url);
    const base = String(env.APP_BASE_PATH || "/games/url-battler").replace(/\/$/, "");
    const scanPaths = new Set(["/scan", `${base}/api/scan`]);
    const energyPaths = new Set(["/energy", `${base}/api/energy`]);

    if (!scanPaths.has(url.pathname) && !energyPaths.has(url.pathname)) {
      return json({ ok:false, code:"NOT_FOUND", message:"Not found" }, 404, cors);
    }

    if (energyPaths.has(url.pathname)) {
      if (request.method !== "GET" && request.method !== "HEAD") {
        return json(
          { ok:false, code:"METHOD_NOT_ALLOWED", message:"Use GET for energy status" },
          405,
          { ...cors, "Allow":"GET, HEAD, OPTIONS" }
        );
      }
      if (!env.SCAN_GUARD) {
        return json({ ok:false, code:"NO_SCAN_GUARD", message:"Scan guard is not configured" }, 503, cors);
      }
      const session = getOrCreateSession(request);
      try {
        const guard = env.SCAN_GUARD.getByName("global");
        const energy = await guard.getEnergy(session.id, Date.now());
        const headers = withSession({ ...cors, "Cache-Control":"no-store" }, session, request);
        return request.method === "HEAD"
          ? new Response(null, { status:200, headers })
          : json({ ok:true, energy }, 200, headers);
      } catch {
        return json({ ok:false, code:"SCAN_GUARD_UNAVAILABLE", message:"Scan guard unavailable" }, 503, cors);
      }
    }

    // ブラウザでAPI URLを直接開いた時に、ルーティング/Binding状態を安全に確認できる。
    if (request.method === "GET" || request.method === "HEAD") {
      const body = {
        ok: Boolean(env.PAGESPEED_API_KEY && env.SCAN_CACHE && env.SCAN_GUARD),
        service: "url-battler-scan",
        version: WORKER_VERSION,
        endpoint: url.pathname,
        accepts: ["POST"],
        limits: {
          freshPerMinute: GLOBAL_MINUTE_LIMIT,
          freshPerDay: GLOBAL_DAILY_LIMIT,
          userEnergyPerDay: USER_DAILY_ENERGY,
          resetTimeZone: "Asia/Tokyo"
        },
        configured: {
          pageSpeedApiKey: Boolean(env.PAGESPEED_API_KEY),
          scanCache: Boolean(env.SCAN_CACHE),
          scanGuard: Boolean(env.SCAN_GUARD)
        }
      };
      const headers = { ...cors, "Cache-Control":"no-store" };
      return request.method === "HEAD"
        ? new Response(null, { status:200, headers })
        : json(body, 200, headers);
    }

    if (request.method !== "POST") {
      return json(
        { ok:false, code:"METHOD_NOT_ALLOWED", message:"Use POST for scans" },
        405,
        { ...cors, "Allow":"GET, HEAD, POST, OPTIONS" }
      );
    }

    if (!originAllowed(origin, allowedOrigins)) {
      return json({ ok:false, code:"ORIGIN_DENIED", message:"Origin denied" }, 403, cors);
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return json({ ok:false, code:"BAD_JSON", message:"Invalid JSON" }, 400, cors);
    }

    let target;
    try {
      target = normalizeUrl(body.url);
    } catch (e) {
      return json({ ok:false, code:"INVALID_URL", message:e.message || "Invalid URL" }, 422, cors);
    }

    const session = getOrCreateSession(request);
    const headersWithSession = (headers = cors) => withSession(headers, session, request);
    const strategy = body.strategy === "mobile" ? "mobile" : "desktop";
    // allowFresh is only a client preference. It never bypasses server-side limits.
    const allowFresh = body.allowFresh !== false;
    const force = body.force === true;
    const cacheKey = await makeCacheKey(target, strategy);
    const cacheAvailable = Boolean(env.SCAN_CACHE);

    // PageSpeed Secretが一時的に欠けていても、既存KVカードは返せるように先にキャッシュを見る。
    if (!force && cacheAvailable) {
      try {
        const cached = await env.SCAN_CACHE.get(cacheKey, { type:"json", cacheTtl:60 });
        if (cached?.scan) {
          return json({ ...cached, ok:true, cacheStatus:"HIT" }, 200, headersWithSession({
            ...cors,
            "Cache-Control":"public, max-age=60",
            "X-URLB-Cache":"HIT"
          }));
        }
      } catch {
        // KV障害中にfreshへフォールバックすると同じURLをPageSpeedへ再送しやすいためfail-closed。
        return json({ ok:false, code:"CACHE_UNAVAILABLE", message:"Shared cache unavailable" }, 503, headersWithSession(cors));
      }
    }

    if (!allowFresh) {
      if (!cacheAvailable) {
        return json({ ok:false, code:"NO_CACHE", message:"KV binding SCAN_CACHE is missing" }, 503, headersWithSession(cors));
      }
      return json({
        ok:false,
        code:"CACHE_MISS",
        message:"Not discovered in shared cache"
      }, 409, headersWithSession({ ...cors, "X-URLB-Cache":"MISS" }));
    }

    // 共有キャッシュが無い状態でfreshを許すと同一URLの再測定が増えるためfail-closed。
    if (!cacheAvailable) {
      return json({ ok:false, code:"NO_CACHE", message:"KV binding SCAN_CACHE is missing" }, 503, headersWithSession(cors));
    }

    // Secrets/Bindingsは新規測定を実行する直前にだけ必須。保護Binding欠落時はfail-closed。
    if (!env.PAGESPEED_API_KEY) {
      return json({ ok:false, code:"NO_API_KEY", message:"Scanner is not configured" }, 503, headersWithSession(cors));
    }
    if (!env.SCAN_GUARD) {
      return json({ ok:false, code:"NO_SCAN_GUARD", message:"Scan guard is not configured" }, 503, headersWithSession(cors));
    }

    let admission;
    try {
      const guard = env.SCAN_GUARD.getByName("global");
      admission = await guard.authorizeFresh(session.id, Date.now());
    } catch {
      return json({ ok:false, code:"SCAN_GUARD_UNAVAILABLE", message:"Scan guard unavailable" }, 503, headersWithSession(cors));
    }

    if (!admission?.ok) {
      const retryAfter = Math.max(1, Number(admission?.retryAfter || 60));
      const message = admission?.code === "USER_DAILY_LIMIT"
        ? "今日の探索エナジーを使い切りました"
        : admission?.code === "SCANNER_DAILY_LIMIT"
          ? "本日の新規探索上限に達しました"
          : "新規探索が短時間に集中しています";
      return json({
        ok:false,
        code:admission?.code || "SCANNER_LIMIT",
        message,
        energy:admission?.energy || null,
        quota:admission?.quota || null,
        resetAt:admission?.resetAt || null,
        retryAfter
      }, 429, headersWithSession({ ...cors, "Retry-After":String(retryAfter) }));
    }

    const params = new URLSearchParams();
    params.set("url", target);
    params.set("strategy", strategy);
    params.set("locale", "ja");
    params.set("key", env.PAGESPEED_API_KEY);
    params.append("category", "performance");
    params.append("category", "best-practices");

    let upstream;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
    try {
      upstream = await fetch(`${PAGESPEED_ENDPOINT}?${params.toString()}`, {
        method:"GET",
        headers:{ "accept":"application/json" },
        signal:controller.signal,
        cf:{ cacheTtl:0, cacheEverything:false }
      });
    } catch (e) {
      const energy = await refundEnergySafe(env, session.id, admission.dayKey);
      const timedOut = e?.name === "AbortError";
      return json({
        ok:false,
        code:timedOut ? "UPSTREAM_TIMEOUT" : "UPSTREAM_NETWORK",
        message:timedOut ? "PageSpeed request timed out" : "PageSpeed network error",
        energy
      }, timedOut ? 504 : 502, headersWithSession(cors));
    } finally {
      clearTimeout(timeoutId);
    }

    let data;
    try { data = await upstream.json(); }
    catch { data = null; }

    if (!upstream.ok) {
      const energy = await refundEnergySafe(env, session.id, admission.dayKey);
      const msg = data?.error?.message || `PageSpeed error ${upstream.status}`;
      if (upstream.status === 429 || upstream.status === 403 && /quota|rate|limit/i.test(msg)) {
        return json({ ok:false, code:"UPSTREAM_LIMIT", message:"Scanner capacity reached", energy }, 429, headersWithSession({ ...cors, "Retry-After":"300" }));
      }
      if (upstream.status >= 500) {
        return json({ ok:false, code:"UPSTREAM_BUSY", message:"PageSpeed temporarily unavailable", energy }, 503, headersWithSession(cors));
      }
      return json({ ok:false, code:"UPSTREAM_REJECTED", message:msg, energy }, 422, headersWithSession(cors));
    }

    const lhr = data?.lighthouseResult;
    if (!lhr?.audits) {
      const energy = await refundEnergySafe(env, session.id, admission.dayKey);
      return json({ ok:false, code:"NO_LIGHTHOUSE", message:"No Lighthouse result", energy }, 422, headersWithSession(cors));
    }
    if (lhr.runtimeError?.message) {
      const energy = await refundEnergySafe(env, session.id, admission.dayKey);
      return json({ ok:false, code:"LIGHTHOUSE_ERROR", message:lhr.runtimeError.message, energy }, 422, headersWithSession(cors));
    }

    const result = compactScan(target, strategy, data);
    if (cacheAvailable) {
      try {
        await env.SCAN_CACHE.put(cacheKey, JSON.stringify(result), {
          expirationTtl: CACHE_TTL_SECONDS
        });
      } catch {
        // カードは返せるので、KV書き込み失敗だけでユーザーのスキャンを失敗させない。
      }
    }

    return json({
      ...result,
      ok:true,
      cacheStatus:"MISS",
      energy:admission.energy,
      quota:admission.quota
    }, 200, headersWithSession({
      ...cors,
      "Cache-Control":"no-store",
      "X-URLB-Cache":"MISS",
      "X-URLB-Minute-Remaining":String(admission.quota?.minuteRemaining ?? ""),
      "X-URLB-Daily-Remaining":String(admission.quota?.dailyRemaining ?? "")
    }));
  }
};

async function refundEnergySafe(env, userId, dayKey) {
  try {
    if (!env.SCAN_GUARD || !dayKey) return null;
    const guard = env.SCAN_GUARD.getByName("global");
    return await guard.refundEnergy(userId, dayKey, Date.now());
  } catch {
    return null;
  }
}

function compactScan(requestedUrl, strategy, data) {
  const lhr = data.lighthouseResult;
  const audits = lhr.audits || {};
  const categories = lhr.categories || {};
  const finalUrl = lhr.finalDisplayedUrl || lhr.finalUrl || requestedUrl;
  const network = audits["network-requests"]?.details?.items || [];
  const net = summarizeNetwork(network, finalUrl);

  const scan = {
    perf: score100(categories.performance?.score),
    best: score100(categories["best-practices"]?.score),
    fcp: numAudit(audits, "first-contentful-paint"),
    lcp: numAudit(audits, "largest-contentful-paint"),
    tbt: numAudit(audits, "total-blocking-time"),
    si: numAudit(audits, "speed-index"),
    cls: numAudit(audits, "cumulative-layout-shift"),
    totalBytes: numAudit(audits, "total-byte-weight") || net.totalBytes,
    requestCount: network.length,
    imageBytes: net.byType.Image?.bytes || 0,
    imageCount: net.byType.Image?.count || 0,
    scriptBytes: net.byType.Script?.bytes || 0,
    scriptCount: net.byType.Script?.count || 0,
    cssBytes: net.byType.Stylesheet?.bytes || 0,
    cssCount: net.byType.Stylesheet?.count || 0,
    fontBytes: net.byType.Font?.bytes || 0,
    documentBytes: net.byType.Document?.bytes || 0,
    thirdPartyDomains: net.thirdPartyDomains,
    resourceTypes: net.resourceTypes,
    domNodes: extractDomNodes(audits),
    isHttps: finalUrl.startsWith("https://") ? 1 : 0,
    httpsAudit: auditScore(audits, "is-on-https"),
    hsts: firstAuditScore(audits, ["has-hsts"]),
    csp: firstAuditScore(audits, ["csp-xss", "csp"]),
    noVuln: firstAuditScore(audits, ["no-vulnerable-libraries"]),
    mixed: firstAuditScore(audits, ["is-on-https"]),
    lighthouseVersion: lhr.lighthouseVersion || "?",
    fetchTime: lhr.fetchTime || new Date().toISOString()
  };

  return {
    requestedUrl,
    finalUrl,
    strategy,
    scannedAt: Date.now(),
    scan
  };
}

function normalizeUrl(raw) {
  let value = String(raw || "").trim();
  if (!value || value.length > 2048) throw new Error("URLを確認してください");
  if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(value)) value = `https://${value}`;
  const u = new URL(value);
  if (!["http:","https:"].includes(u.protocol)) throw new Error("http/httpsのみ利用できます");
  if (u.username || u.password) throw new Error("認証情報入りURLは利用できません");
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g,"");
  if (isBlockedHost(host)) throw new Error("内部向けURLは利用できません");
  u.hash = "";
  return u.toString();
}

function isBlockedHost(host) {
  if (!host) return true;
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) return true;
  if (host === "::1" || host === "::" || host.startsWith("fe80:") || host.startsWith("fc") || host.startsWith("fd")) return true;
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) return isPrivateIPv4(host);
  return false;
}

function isPrivateIPv4(ip) {
  const p = ip.split(".").map(Number);
  if (p.length !== 4 || p.some(n => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  const [a,b] = p;
  return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127) || a >= 224;
}

async function makeCacheKey(url, strategy) {
  const raw = new TextEncoder().encode(`${strategy}|${url}`);
  const digest = await crypto.subtle.digest("SHA-256", raw);
  return "scan:" + [...new Uint8Array(digest)].map(b=>b.toString(16).padStart(2,"0")).join("");
}

function summarizeNetwork(items, finalUrl) {
  const byType = {};
  let totalBytes = 0;
  const host = safeHostname(finalUrl);
  const third = new Set();
  const types = new Set();

  for (const item of items) {
    const type = String(item.resourceType || "Other");
    const bytes = Number(item.transferSize ?? item.resourceSize ?? 0) || 0;
    if (!byType[type]) byType[type] = { count:0, bytes:0 };
    byType[type].count++;
    byType[type].bytes += bytes;
    totalBytes += bytes;
    types.add(type);
    const h = safeHostname(item.url);
    if (h && host && h !== host) third.add(h);
  }
  return { byType, totalBytes, thirdPartyDomains:third.size, resourceTypes:types.size };
}

function safeHostname(url) { try { return new URL(url).hostname; } catch { return ""; } }
function score100(score) { return Number.isFinite(score) ? Math.round(score*100) : null; }
function numAudit(audits,id) { const v=audits?.[id]?.numericValue; return Number.isFinite(v)?v:null; }
function auditScore(audits,id) { const v=audits?.[id]?.score; return Number.isFinite(v)?v:null; }
function firstAuditScore(audits,ids) {
  for (const id of ids) { const v=auditScore(audits,id); if (v!==null) return v; }
  return null;
}
function extractDomNodes(audits) {
  const candidates = [
    audits?.["dom-size"]?.numericValue,
    audits?.["dom-size"]?.details?.items?.[0]?.value,
    audits?.["dom-size"]?.details?.items?.[0]?.statistic,
    audits?.["dom-size-insight"]?.numericValue
  ];
  for (const v of candidates) {
    const n=Number(v); if (Number.isFinite(n) && n>=0) return n;
  }
  return 0;
}

function getOrCreateSession(request) {
  const cookies = parseCookies(request.headers.get("Cookie") || "");
  const existing = String(cookies[SESSION_COOKIE] || "");
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(existing)) {
    return { id:existing, isNew:false };
  }
  return { id:crypto.randomUUID(), isNew:true };
}

function parseCookies(header) {
  const out = {};
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx < 0) continue;
    const key = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (key) out[key] = value;
  }
  return out;
}

function withSession(headers, session, request) {
  if (!session?.isNew) return headers;
  const requestUrl = new URL(request.url);
  const secure = requestUrl.protocol === "https:";
  const attrs = [
    `${SESSION_COOKIE}=${session.id}`,
    `Max-Age=${SESSION_MAX_AGE}`,
    "Path=/",
    "HttpOnly",
    secure ? "Secure" : "",
    secure ? "SameSite=None" : "SameSite=Lax"
  ].filter(Boolean);
  return { ...headers, "Set-Cookie":attrs.join("; ") };
}

function jstDayInfo(nowMs) {
  const shifted = new Date(nowMs + JST_OFFSET_MS);
  const y = shifted.getUTCFullYear();
  const m = shifted.getUTCMonth();
  const d = shifted.getUTCDate();
  const dayKey = `${y}-${String(m + 1).padStart(2,"0")}-${String(d).padStart(2,"0")}`;
  const resetAt = Date.UTC(y, m, d + 1) - JST_OFFSET_MS;
  return { dayKey, resetAt };
}

function energyState(row, day) {
  const used = Math.max(0, Number(row?.used || 0));
  return {
    date: day.dayKey,
    remaining: Math.max(0, USER_DAILY_ENERGY - used),
    limit: USER_DAILY_ENERGY,
    baseLimit: USER_DAILY_ENERGY,
    used,
    rewardUsed: Number(row?.reward_used || 0) === 1,
    resetsAt: day.resetAt,
    timeZone: "Asia/Tokyo"
  };
}

function parseRecentTimestamps(raw) {
  try {
    const parsed = JSON.parse(String(raw || "[]"));
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map(Number)
      .filter(Number.isFinite)
      .sort((a,b) => a - b)
      .slice(-GLOBAL_MINUTE_LIMIT);
  } catch {
    return [];
  }
}

function quotaState(minuteUsed, dailyUsed) {
  const minute = minuteUsed === null || minuteUsed === undefined ? null : Number(minuteUsed);
  const daily = dailyUsed === null || dailyUsed === undefined ? null : Number(dailyUsed);
  return {
    minuteLimit: GLOBAL_MINUTE_LIMIT,
    minuteUsed: minute,
    minuteRemaining: minute === null ? null : Math.max(0, GLOBAL_MINUTE_LIMIT - minute),
    dailyLimit: GLOBAL_DAILY_LIMIT,
    dailyUsed: daily,
    dailyRemaining: daily === null ? null : Math.max(0, GLOBAL_DAILY_LIMIT - daily)
  };
}

function secondsUntil(targetMs, nowMs) {
  return Math.max(1, Math.ceil((Number(targetMs) - Number(nowMs)) / 1000));
}

function originAllowed(origin, configured) {
  const list = configured.split(",").map(s=>s.trim()).filter(Boolean);
  if (!list.length || list.includes("*")) return true;
  return list.includes(origin);
}

function corsHeaders(origin, configured) {
  const list = configured.split(",").map(s=>s.trim()).filter(Boolean);
  const wildcard = !list.length || list.includes("*");
  const allowed = wildcard ? (origin || "*") : (list.includes(origin) ? origin : list[0]);
  return {
    "Access-Control-Allow-Origin": allowed,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "content-type",
    ...(allowed !== "*" ? { "Access-Control-Allow-Credentials":"true" } : {}),
    "Vary": "Origin",
    "Content-Type":"application/json; charset=utf-8"
  };
}

function json(body, status=200, headers={}) {
  return new Response(JSON.stringify(body), { status, headers });
}
