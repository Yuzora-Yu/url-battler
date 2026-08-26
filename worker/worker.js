const PAGESPEED_ENDPOINT = "https://pagespeedonline.googleapis.com/pagespeedonline/v5/runPagespeed";
const CACHE_TTL_SECONDS = 24 * 60 * 60;

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";
    const cors = corsHeaders(origin, env.ALLOWED_ORIGIN || "");

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors });
    }

    const url = new URL(request.url);
    if (request.method !== "POST" || url.pathname !== "/scan") {
      return json({ ok:false, code:"NOT_FOUND", message:"Not found" }, 404, cors);
    }

    if (!originAllowed(origin, env.ALLOWED_ORIGIN || "")) {
      return json({ ok:false, code:"ORIGIN_DENIED", message:"Origin denied" }, 403, cors);
    }

    if (!env.PAGESPEED_API_KEY) {
      return json({ ok:false, code:"NO_API_KEY", message:"Scanner is not configured" }, 503, cors);
    }
    if (!env.SCAN_CACHE) {
      return json({ ok:false, code:"NO_CACHE", message:"KV binding SCAN_CACHE is missing" }, 503, cors);
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

    const strategy = body.strategy === "mobile" ? "mobile" : "desktop";
    const allowFresh = body.allowFresh === true;
    const force = body.force === true;

    const cacheKey = await makeCacheKey(target, strategy);

    if (!force) {
      try {
        const cached = await env.SCAN_CACHE.get(cacheKey, { type:"json", cacheTtl:60 });
        if (cached?.scan) {
          return json({ ...cached, ok:true, cacheStatus:"HIT" }, 200, {
            ...cors,
            "Cache-Control":"public, max-age=60",
            "X-URLB-Cache":"HIT"
          });
        }
      } catch (e) {
        // KV障害時はfreshが許可されていれば続行。許可されていなければ安全側に停止。
        if (!allowFresh) {
          return json({ ok:false, code:"CACHE_UNAVAILABLE", message:"Shared cache unavailable" }, 503, cors);
        }
      }
    }

    if (!allowFresh) {
      return json({
        ok:false,
        code:"CACHE_MISS",
        message:"Not discovered in shared cache"
      }, 409, { ...cors, "X-URLB-Cache":"MISS" });
    }

    const params = new URLSearchParams();
    params.set("url", target);
    params.set("strategy", strategy);
    params.set("locale", "ja");
    params.set("key", env.PAGESPEED_API_KEY);
    params.append("category", "performance");
    params.append("category", "best-practices");

    let upstream;
    try {
      upstream = await fetch(`${PAGESPEED_ENDPOINT}?${params.toString()}`, {
        method:"GET",
        headers:{ "accept":"application/json" },
        cf:{ cacheTtl:0, cacheEverything:false }
      });
    } catch {
      return json({ ok:false, code:"UPSTREAM_NETWORK", message:"PageSpeed network error" }, 502, cors);
    }

    let data;
    try { data = await upstream.json(); }
    catch { data = null; }

    if (!upstream.ok) {
      const msg = data?.error?.message || `PageSpeed error ${upstream.status}`;
      if (upstream.status === 429 || upstream.status === 403 && /quota|rate|limit/i.test(msg)) {
        return json({ ok:false, code:"UPSTREAM_LIMIT", message:"Scanner capacity reached" }, 429, cors);
      }
      if (upstream.status >= 500) {
        return json({ ok:false, code:"UPSTREAM_BUSY", message:"PageSpeed temporarily unavailable" }, 503, cors);
      }
      return json({ ok:false, code:"UPSTREAM_REJECTED", message:msg }, 422, cors);
    }

    const lhr = data?.lighthouseResult;
    if (!lhr?.audits) {
      return json({ ok:false, code:"NO_LIGHTHOUSE", message:"No Lighthouse result" }, 422, cors);
    }
    if (lhr.runtimeError?.message) {
      return json({ ok:false, code:"LIGHTHOUSE_ERROR", message:lhr.runtimeError.message }, 422, cors);
    }

    const result = compactScan(target, strategy, data);
    try {
      await env.SCAN_CACHE.put(cacheKey, JSON.stringify(result), {
        expirationTtl: CACHE_TTL_SECONDS
      });
    } catch {
      // カードは返せるので、KV書き込み失敗だけでユーザーのスキャンを失敗させない。
    }

    return json({
      ...result,
      ok:true,
      cacheStatus:"MISS"
    }, 200, {
      ...cors,
      "Cache-Control":"no-store",
      "X-URLB-Cache":"MISS"
    });
  }
};

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

function originAllowed(origin, configured) {
  const list = configured.split(",").map(s=>s.trim()).filter(Boolean);
  if (!list.length || list.includes("*")) return true;
  return list.includes(origin);
}

function corsHeaders(origin, configured) {
  const list = configured.split(",").map(s=>s.trim()).filter(Boolean);
  const allowed = !list.length || list.includes("*") ? "*" : (list.includes(origin) ? origin : list[0]);
  return {
    "Access-Control-Allow-Origin": allowed,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "content-type",
    "Vary": "Origin",
    "Content-Type":"application/json; charset=utf-8"
  };
}

function json(body, status=200, headers={}) {
  return new Response(JSON.stringify(body), { status, headers });
}
