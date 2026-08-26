(() => {
  "use strict";

  const API_ENDPOINT = "https://www.googleapis.com/pagespeedonline/v5/runPagespeed";
  const CACHE_TTL = 24 * 60 * 60 * 1000;
  const MAX_CARDS = 5;
  const MAX_HISTORY = 100;

  const LS = {
    cards: "urlbattler.cards.v1",
    history: "urlbattler.history.v1",
    cache: "urlbattler.cache.v1",
    rush: "urlbattler.rush.v1"
  };

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
  const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
  const now = () => Date.now();
  const fmt = (n) => new Intl.NumberFormat("ja-JP").format(Math.round(n || 0));
  const fmtBytes = (n) => {
    n = Number(n || 0);
    if (n < 1024) return `${Math.round(n)} B`;
    if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
    return `${(n / 1024 ** 2).toFixed(2)} MB`;
  };

  class AppError extends Error {
    constructor(code, message, details = null) {
      super(message);
      this.name = "AppError";
      this.code = code;
      this.details = details;
    }
  }

  const SKILL_DEFS = [
    { id:"speed-god", name:"神速", desc:"初手の行動順を強制的に最速化", priority: 100 },
    { id:"ancient-html", name:"古代HTML", desc:"SPD強化。軽量構成の奥義", priority: 95 },
    { id:"heavy-fort", name:"重装要塞", desc:"最大HP増加、SPD低下", priority: 80 },
    { id:"image-barrage", name:"画像弾幕", desc:"通常攻撃が時々2連撃", priority: 75 },
    { id:"magic-overload", name:"魔術過積載", desc:"TEC攻撃強化、SPD低下", priority: 78 },
    { id:"void", name:"無の境地", desc:"TEC攻撃への耐性", priority: 83 },
    { id:"triple-barrier", name:"三重結界", desc:"被ダメージ軽減", priority: 92 },
    { id:"third-party", name:"第三者召喚", desc:"開幕ランダム能力強化", priority: 70 },
    { id:"dom-maze", name:"DOM迷宮", desc:"DEF強化", priority: 65 },
    { id:"iron-wall", name:"鉄壁", desc:"DEF強化", priority: 68 },
    { id:"css-armor", name:"CSS甲冑", desc:"DEFを少し強化", priority: 55 },
    { id:"giant-life", name:"巨大生命", desc:"最大HPを大幅強化", priority: 74 },
    { id:"clean-page", name:"静寂のページ", desc:"少リクエストで回避率上昇", priority: 60 },
    { id:"unstable", name:"揺らぐ大地", desc:"CLS由来のハイリスク攻撃", priority: 40 }
  ];
  function skillByName(name) { return SKILL_DEFS.find(s => s.name === name); }

  const NPCS = [
    npc("THE EMPTY PAGE", "https://npc.invalid/empty", [180, 170, 310, 970, 120], ["神速", "無の境地"], "STATIC"),
    npc("MEGA PORTAL", "https://npc.invalid/portal", [930, 820, 690, 260, 860], ["重装要塞", "第三者召喚"], "PORTAL"),
    npc("IMAGE FORTRESS", "https://npc.invalid/gallery", [760, 910, 540, 330, 640], ["画像弾幕", "重装要塞"], "MEDIA"),
    npc("JAVASCRIPT TOWER", "https://npc.invalid/app", [690, 620, 620, 410, 980], ["魔術過積載", "第三者召喚"], "APP"),
    npc("TEXT ARCHIVE", "https://npc.invalid/archive", [810, 760, 720, 610, 260], ["DOM迷宮", "鉄壁"], "ARCHIVE"),
    npc("CSS KNIGHT", "https://npc.invalid/style", [620, 570, 900, 590, 740], ["CSS甲冑", "鉄壁"], "DESIGN"),
    npc("OLD WEB MASTER", "https://npc.invalid/oldweb", [310, 330, 610, 990, 150], ["古代HTML", "神速", "無の境地"], "LEGACY"),
    npc("AD SUMMONER", "https://npc.invalid/ads", [740, 660, 430, 280, 960], ["第三者召喚", "魔術過積載"], "SUMMONER"),
    npc("SECURE GATE", "https://npc.invalid/gate", [570, 470, 980, 660, 520], ["三重結界", "鉄壁"], "GUARD"),
    npc("MEDIA TITAN", "https://npc.invalid/media", [990, 920, 510, 180, 710], ["巨大生命", "画像弾幕"], "TITAN"),
    npc("BALANCED CLOUD", "https://npc.invalid/cloud", [710, 720, 730, 740, 750], ["鉄壁"], "CLOUD"),
    npc("DOM LABYRINTH", "https://npc.invalid/dom", [880, 780, 820, 290, 730], ["DOM迷宮", "重装要塞"], "MAZE")
  ];

  function npc(name, url, s, skills, className) {
    return {
      id: `npc-${name}`,
      url, finalUrl: url, domain: name, path: "/",
      capturedAt: 0, strategy: "desktop", className,
      stats: { hp: s[0], atk: s[1], def: s[2], spd: s[3], tec: s[4] },
      bp: Math.round(s.reduce((a,b)=>a+b,0)/5),
      skills: skills.map(skillByName).filter(Boolean),
      metrics: { isNpc: true },
      source: "npc"
    };
  }


  function loadJson(key, fallback) {
    try { return JSON.parse(localStorage.getItem(key)) ?? fallback; }
    catch { return fallback; }
  }
  function saveJson(key, value) {
    localStorage.setItem(key, JSON.stringify(value));
  }
  function getCards() { return loadJson(LS.cards, []); }
  function setCards(cards) { saveJson(LS.cards, cards.slice(0, MAX_CARDS)); renderAll(); }
  function getHistory() { return loadJson(LS.history, []); }
  function addHistory(record) {
    const h = getHistory();
    h.unshift(record);
    saveJson(LS.history, h.slice(0, MAX_HISTORY));
    renderHistory();
  }
  function getCache() { return loadJson(LS.cache, {}); }
  function setCache(cache) {
    const entries = Object.entries(cache).sort((a,b)=>(b[1]?.cachedAt||0)-(a[1]?.cachedAt||0)).slice(0,30);
    saveJson(LS.cache, Object.fromEntries(entries));
  }

  function normalizeUrl(raw) {
    let value = String(raw || "").trim();
    if (!value) throw new AppError("INVALID_URL", "URLを入力してください。");
    if (value.length > 2048) throw new AppError("INVALID_URL", "URLが長すぎます。");
    if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(value)) value = `https://${value}`;

    let u;
    try { u = new URL(value); }
    catch { throw new AppError("INVALID_URL", "URLの形式を確認してください。"); }

    if (!["http:", "https:"].includes(u.protocol)) {
      throw new AppError("INVALID_URL", "http:// または https:// の公開Webページのみ利用できます。");
    }
    if (u.username || u.password) {
      throw new AppError("BLOCKED_URL", "認証情報を含むURLはカード化できません。");
    }

    const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, "");
    if (isBlockedHost(host)) {
      throw new AppError("BLOCKED_URL", "localhost・プライベートIP・内部向けホストはカード化できません。");
    }

    u.hash = "";
    return u.toString();
  }

  function isBlockedHost(host) {
    if (!host) return true;
    if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) return true;
    if (host === "::1" || host === "::" || host.startsWith("fe80:") || host.startsWith("fc") || host.startsWith("fd")) return true;
    if (/^0*:0*:0*:0*:0*:ffff:/i.test(host)) {
      const tail = host.split(":").pop();
      if (tail && /^\d+\.\d+\.\d+\.\d+$/.test(tail)) return isPrivateIPv4(tail);
    }
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

  function cacheKey(url, strategy) { return `${strategy}|${url}`; }

  async function getPageSpeedCard(rawUrl, strategy = "desktop", force = false) {
    const url = normalizeUrl(rawUrl);
    const key = cacheKey(url, strategy);
    const cache = getCache();
    if (!force && cache[key] && now() - cache[key].cachedAt < CACHE_TTL) {
      setApiState("CACHE");
      return { ...cache[key].card, source: "cache" };
    }

    setApiState("CALLING");
    showProgress(true, "PageSpeed計測中...", "対象ページをLighthouseで解析しています。通常数秒〜数十秒かかります。");

    const params = new URLSearchParams();
    params.set("url", url);
    params.set("strategy", strategy);
    params.set("locale", "ja");
    params.append("category", "performance");
    params.append("category", "best-practices");
    const apiKey = sessionStorage.getItem("urlbattler.psi.key");
    if (apiKey) params.set("key", apiKey);

    let response, data;
    try {
      response = await fetch(`${API_ENDPOINT}?${params.toString()}`, { method: "GET", mode: "cors", cache: "no-store" });
      const text = await response.text();
      try { data = JSON.parse(text); } catch { data = { raw: text }; }
    } catch (err) {
      setApiState("NETWORK");
      throw new AppError("NETWORK", "PageSpeed APIへ接続できませんでした。ネットワーク接続やブラウザ設定を確認してください。", err);
    } finally {
      showProgress(false);
    }

    if (!response.ok) throw parseGoogleApiError(response.status, data);

    const runtimeError = data?.lighthouseResult?.runtimeError;
    if (runtimeError?.code || runtimeError?.message) {
      throw new AppError("SCAN_FAILED", `Lighthouseがこのページを測定できませんでした：${runtimeError.message || runtimeError.code}`);
    }
    if (!data?.lighthouseResult?.audits) {
      throw new AppError("SCAN_FAILED", "PageSpeedから有効なLighthouse結果を取得できませんでした。");
    }

    const card = buildCard(url, strategy, data);
    cache[key] = { cachedAt: now(), card };
    setCache(cache);
    setApiState("READY");
    return card;
  }

  function parseGoogleApiError(status, data) {
    const e = data?.error || {};
    const message = String(e.message || data?.message || "PageSpeed APIエラー");
    const reasons = (e.errors || []).map(x => `${x.reason || ""} ${x.message || ""}`).join(" ");
    const combined = `${message} ${reasons}`.toLowerCase();

    if (status === 429 || ((status === 403 || status === 400) && /(quota|rate|limit|resource_exhausted|daily)/.test(combined))) {
      setApiState("LIMIT");
      return new AppError(
        "QUOTA",
        "PageSpeed APIの利用制限に達した可能性があります。新しいカードの計測は一時停止します。保存済みカード・URL RUSH・戦歴はそのまま遊べます。",
        { status, message }
      );
    }
    if (status === 400) {
      setApiState("ERROR");
      return new AppError("BAD_REQUEST", `PageSpeedがURLを受け付けませんでした：${message}`);
    }
    if (status === 403) {
      setApiState("DENIED");
      return new AppError("DENIED", `PageSpeed APIがリクエストを拒否しました：${message}`);
    }
    if (status >= 500) {
      setApiState("BUSY");
      return new AppError("SERVICE", "PageSpeed API側が一時的に利用できません。保存済みカードやURL RUSHは引き続き遊べます。");
    }
    setApiState("ERROR");
    return new AppError("API", `PageSpeed APIエラー (${status})：${message}`);
  }

  function buildCard(requestedUrl, strategy, data) {
    const lhr = data.lighthouseResult;
    const audits = lhr.audits || {};
    const categories = lhr.categories || {};
    const finalUrl = lhr.finalDisplayedUrl || lhr.finalUrl || requestedUrl;

    const network = audits["network-requests"]?.details?.items || [];
    const net = summarizeNetwork(network, finalUrl);

    const perf = score100(categories.performance?.score);
    const best = score100(categories["best-practices"]?.score);

    const fcp = numAudit(audits, "first-contentful-paint");
    const lcp = numAudit(audits, "largest-contentful-paint");
    const tbt = numAudit(audits, "total-blocking-time");
    const si = numAudit(audits, "speed-index");
    const cls = numAudit(audits, "cumulative-layout-shift");
    const totalBytes = numAudit(audits, "total-byte-weight") || net.totalBytes;

    const domNodes = extractDomNodes(audits);
    const isHttps = finalUrl.startsWith("https://") ? 1 : 0;
    const httpsAudit = auditScore(audits, "is-on-https");
    const hsts = firstAuditScore(audits, ["has-hsts"]);
    const csp = firstAuditScore(audits, ["csp-xss", "csp"]);
    const noVuln = firstAuditScore(audits, ["no-vulnerable-libraries"]);
    const mixed = firstAuditScore(audits, ["is-on-https"]);

    const metrics = {
      perf, best, fcp, lcp, tbt, si, cls,
      totalBytes,
      requestCount: network.length,
      imageBytes: net.byType.Image?.bytes || 0,
      imageCount: net.byType.Image?.count || 0,
      scriptBytes: net.byType.Script?.bytes || 0,
      scriptCount: net.byType.Script?.count || 0,
      cssBytes: (net.byType.Stylesheet?.bytes || 0),
      cssCount: net.byType.Stylesheet?.count || 0,
      fontBytes: net.byType.Font?.bytes || 0,
      documentBytes: net.byType.Document?.bytes || 0,
      thirdPartyDomains: net.thirdPartyDomains,
      resourceTypes: net.resourceTypes,
      domNodes,
      isHttps,
      httpsAudit,
      hsts,
      csp,
      noVuln,
      mixed,
      lighthouseVersion: lhr.lighthouseVersion || "?",
      fetchTime: lhr.fetchTime || new Date().toISOString(),
      runWarnings: lhr.runWarnings || []
    };

    const stats = makeStats(metrics);
    const skills = chooseSkills(metrics, stats);
    const className = chooseClass(metrics, stats);
    const u = new URL(requestedUrl);
    const domain = u.hostname;
    const path = `${u.pathname}${u.search}` || "/";
    const bp = Math.round((stats.hp + stats.atk + stats.def + stats.spd + stats.tec) / 5);

    return {
      id: `card-${hashString(`${strategy}|${requestedUrl}`)}`,
      url: requestedUrl,
      finalUrl,
      domain,
      path,
      capturedAt: now(),
      strategy,
      className,
      stats,
      bp,
      skills,
      metrics,
      source: "api"
    };
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
      if (!byType[type]) byType[type] = { count: 0, bytes: 0 };
      byType[type].count++;
      byType[type].bytes += bytes;
      totalBytes += bytes;
      types.add(type);
      const h = safeHostname(item.url);
      if (h && host && h !== host) third.add(h);
    }
    return { byType, totalBytes, thirdPartyDomains: third.size, resourceTypes: types.size };
  }

  function safeHostname(url) {
    try { return new URL(url).hostname; } catch { return ""; }
  }
  function score100(score) {
    return Number.isFinite(score) ? Math.round(score * 100) : null;
  }
  function numAudit(audits, id) {
    const v = audits?.[id]?.numericValue;
    return Number.isFinite(v) ? v : null;
  }
  function auditScore(audits, id) {
    const v = audits?.[id]?.score;
    return Number.isFinite(v) ? v : null;
  }
  function firstAuditScore(audits, ids) {
    for (const id of ids) {
      const v = auditScore(audits, id);
      if (v !== null) return v;
    }
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
      const n = Number(v);
      if (Number.isFinite(n) && n >= 0) return n;
    }
    const text = JSON.stringify(audits?.["dom-size"]?.details || audits?.["dom-size-insight"]?.details || {});
    const m = text.match(/"value"\s*:\s*(\d{2,7})/);
    return m ? Number(m[1]) : 0;
  }

  function logNorm(x, scale) {
    return clamp(Math.log1p(Math.max(0, x)) / Math.log1p(scale), 0, 1);
  }
  function fastScore(ms, good, bad) {
    if (!Number.isFinite(ms)) return null;
    return clamp(1 - (ms - good) / (bad - good), 0, 1);
  }
  function weightedAvailable(items, fallback = .5) {
    let sum = 0, weight = 0;
    for (const [value, w] of items) {
      if (Number.isFinite(value)) { sum += value * w; weight += w; }
    }
    return weight ? sum / weight : fallback;
  }
  function stat(n) { return Math.round(100 + 899 * clamp(n,0,1)); }

  function makeStats(m) {
    const hpN = weightedAvailable([
      [logNorm(m.totalBytes, 12 * 1024 * 1024), .48],
      [logNorm(m.domNodes, 5000), .25],
      [logNorm(m.requestCount, 250), .27]
    ]);
    const atkN = weightedAvailable([
      [logNorm(m.imageBytes, 8 * 1024 * 1024), .36],
      [logNorm(m.imageCount, 80), .18],
      [logNorm(m.documentBytes, 600 * 1024), .14],
      [logNorm(m.requestCount, 220), .14],
      [logNorm(m.domNodes, 4500), .18]
    ]);

    const guardSignals = [
      [m.best !== null ? m.best / 100 : null, .40],
      [m.isHttps, .22],
      [m.httpsAudit, .10],
      [m.hsts, .12],
      [m.csp, .10],
      [m.noVuln, .06]
    ];
    const defN = weightedAvailable(guardSignals, .45);

    const spdN = weightedAvailable([
      [m.perf !== null ? m.perf / 100 : null, .42],
      [fastScore(m.fcp, 700, 4500), .16],
      [fastScore(m.lcp, 1200, 6500), .22],
      [fastScore(m.tbt, 80, 1600), .12],
      [fastScore(m.si, 1200, 7000), .08]
    ], .45);

    const tecN = weightedAvailable([
      [logNorm(m.scriptBytes, 3 * 1024 * 1024), .44],
      [logNorm(m.cssBytes, 800 * 1024), .18],
      [logNorm(m.thirdPartyDomains, 25), .20],
      [logNorm(m.resourceTypes, 9), .08],
      [logNorm(m.requestCount, 220), .10]
    ]);

    return { hp: stat(hpN), atk: stat(atkN), def: stat(defN), spd: stat(spdN), tec: stat(tecN) };
  }

  function chooseSkills(m, s) {
    const found = [];
    const add = (name, cond) => { if (cond) { const sk = skillByName(name); if (sk) found.push(sk); } };

    add("神速", s.spd >= 850 || (m.perf >= 92 && (m.lcp || 99999) < 1800));
    add("古代HTML", m.scriptBytes < 60*1024 && m.cssBytes < 120*1024 && m.totalBytes < 700*1024 && s.spd >= 720);
    add("重装要塞", m.totalBytes >= 4*1024*1024);
    add("画像弾幕", m.imageCount >= 30 || m.imageBytes >= 3*1024*1024);
    add("魔術過積載", m.scriptBytes >= 1500*1024);
    add("無の境地", m.scriptBytes <= 35*1024);
    add("三重結界", m.isHttps && m.hsts === 1 && m.csp === 1);
    add("第三者召喚", m.thirdPartyDomains >= 10);
    add("DOM迷宮", m.domNodes >= 1400);
    add("鉄壁", m.isHttps && (m.best ?? 0) >= 90);
    add("CSS甲冑", m.cssBytes >= 450*1024);
    add("巨大生命", m.totalBytes >= 8*1024*1024);
    add("静寂のページ", m.requestCount > 0 && m.requestCount <= 10);
    add("揺らぐ大地", (m.cls ?? 0) >= .25);

    return found.sort((a,b)=>b.priority-a.priority).slice(0,3);
  }

  function chooseClass(m, s) {
    if (s.spd >= 850 && m.scriptBytes < 100*1024) return "STATIC";
    if (s.def >= 820) return "GUARD";
    if (s.tec >= 820) return "APP";
    if (m.imageCount >= 30) return "MEDIA";
    if (s.hp >= 820) return "TANK";
    if (m.domNodes >= 1400) return "PORTAL";
    return "WEB";
  }

  function saveCard(card) {
    const cards = getCards();
    const same = cards.findIndex(c => c.id === card.id || (c.url === card.url && c.strategy === card.strategy));
    if (same >= 0) {
      cards[same] = { ...card, savedAt: now() };
      setCards(cards);
      showAlert("カードを更新しました。", "success");
      return true;
    }
    if (cards.length >= MAX_CARDS) {
      showAlert("保存枠は5枚までです。マイカードから1枚削除してから保存してください。", "error");
      return false;
    }
    cards.push({ ...card, savedAt: now() });
    setCards(cards);
    showAlert("カードをローカル保存しました。", "success");
    return true;
  }

  function removeCard(id) {
    if (!confirm("このカードをローカル保存から削除しますか？")) return;
    setCards(getCards().filter(c => c.id !== id));
  }

  function hashString(str) {
    let h = 2166136261;
    for (let i=0; i<str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return (h >>> 0).toString(36);
  }

  function cardColors(card) {
    const h = parseInt(hashString(card.domain).slice(-4), 36) || 120;
    const hue = h % 360;
    return [`hsla(${hue}, 90%, 58%, .23)`, `hsl(${(hue+70)%360}, 85%, 68%)`];
  }

  function cardHtml(card, opts = {}) {
    const [a,b] = cardColors(card);
    const path = card.path || (() => { try { const u = new URL(card.url); return u.pathname + u.search; } catch { return "/"; } })();
    const date = card.capturedAt ? new Date(card.capturedAt).toLocaleString("ja-JP", {month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit"}) : "NPC";
    const source = card.source === "cache" ? "LOCAL CACHE" : card.source === "npc" ? "NPC" : "PAGESPEED";
    return `
      <article class="site-card" style="--cardA:${a};--cardB:${b}">
        <div class="card-top">
          <div>
            <div class="card-domain">${esc(card.domain)}</div>
            <div class="card-path">${esc(path)}</div>
          </div>
          <div class="class-badge">${esc(card.className)}</div>
        </div>
        <div class="card-bp"><small>BATTLE POWER</small><strong>${fmt(card.bp)}</strong></div>
        <div class="stats">
          ${statBox("HP",card.stats.hp)}
          ${statBox("ATK",card.stats.atk)}
          ${statBox("DEF",card.stats.def)}
          ${statBox("SPD",card.stats.spd)}
          ${statBox("TEC",card.stats.tec)}
        </div>
        <div class="skills">
          ${(card.skills?.length ? card.skills : [{name:"ノーマル",desc:"固有スキルなし"}]).map(s=>`
            <div class="skill"><strong>${esc(s.name)}</strong><span>${esc(s.desc)}</span></div>
          `).join("")}
        </div>
        <div class="card-meta"><span>${esc(card.strategy || "desktop")}</span><span>${source} / ${date}</span></div>
      </article>`;
  }
  function statBox(name, value) { return `<div class="statbox"><small>${name}</small><strong>${fmt(value)}</strong></div>`; }
  function esc(v) {
    return String(v ?? "").replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  }

  function metricsHtml(card) {
    const m = card.metrics || {};
    if (m.isNpc) return "";
    return `
      <div class="safety-note">
        <strong>SCAN DATA</strong>
        <p>
          Performance ${m.perf ?? "—"} / Best Practices ${m.best ?? "—"} /
          転送 ${fmtBytes(m.totalBytes)} / ${fmt(m.requestCount)} requests /
          Image ${fmt(m.imageCount)} (${fmtBytes(m.imageBytes)}) /
          JS ${fmtBytes(m.scriptBytes)} / CSS ${fmtBytes(m.cssBytes)} /
          3rd-party hosts ${fmt(m.thirdPartyDomains)} /
          DOM ${m.domNodes ? fmt(m.domNodes) : "n/a"}<br>
          FCP ${m.fcp ? Math.round(m.fcp)+"ms" : "n/a"} /
          LCP ${m.lcp ? Math.round(m.lcp)+"ms" : "n/a"} /
          TBT ${m.tbt != null ? Math.round(m.tbt)+"ms" : "n/a"} /
          Lighthouse ${esc(m.lighthouseVersion || "?")}
        </p>
      </div>`;
  }

  function renderLatest(card) {
    const area = $("#latestCardArea");
    area.classList.remove("showcase");
    area.innerHTML = `
      <div>
        ${cardHtml(card)}
        ${metricsHtml(card)}
        <div class="card-actions">
          <button class="primary" id="saveLatestCard">5枚枠に保存</button>
          <button class="secondary" id="battleLatestNpc">NPCと戦う</button>
          <button class="secondary" id="openLatestSite">サイトを見る</button>
        </div>
      </div>`;
    $("#saveLatestCard").onclick = () => saveCard(card);
    $("#battleLatestNpc").onclick = () => showBattle(card, randomNpc(), "NPC");
    $("#openLatestSite").onclick = () => requestExternalOpen(card.url);
  }

  function renderCards() {
    const cards = getCards();
    $("#cardsCounter").textContent = `${cards.length} / ${MAX_CARDS}`;
    $("#headerCardCount").textContent = `${cards.length} / ${MAX_CARDS}`;
    const grid = $("#cardsGrid");
    if (!cards.length) {
      grid.innerHTML = `<p class="muted">保存カードはまだありません。「カード生成」から最大5枚まで保存できます。</p>`;
    } else {
      grid.innerHTML = cards.map(c => `
        <div class="card-wrap" data-card-id="${esc(c.id)}">
          ${cardHtml(c)}
          <div class="card-actions">
            <button class="secondary act-battle">NPC戦</button>
            <button class="secondary act-open">サイト</button>
            <button class="secondary act-rescan">再計測</button>
            <button class="danger ghost act-delete">削除</button>
          </div>
        </div>`).join("");
      $$(".card-wrap").forEach(el => {
        const card = cards.find(c => c.id === el.dataset.cardId);
        $(".act-battle", el).onclick = () => showBattle(card, randomNpc(), "NPC");
        $(".act-open", el).onclick = () => requestExternalOpen(card.url);
        $(".act-delete", el).onclick = () => removeCard(card.id);
        $(".act-rescan", el).onclick = async () => {
          try {
            const updated = await getPageSpeedCard(card.url, card.strategy, true);
            saveCard(updated);
            renderLatest(updated);
            switchView("create");
          } catch(e) { handleAppError(e); }
        };
      });
    }
    renderRushSelect();
  }

  function renderRushSelect() {
    const sel = $("#rushCardSelect");
    const cards = getCards();
    sel.innerHTML = cards.length
      ? cards.map(c => `<option value="${esc(c.id)}">${esc(c.domain)} — BP ${fmt(c.bp)}</option>`).join("")
      : `<option value="">保存カードがありません</option>`;
    $("#rushStartButton").disabled = !cards.length;
  }

  function randomNpc() {
    return structuredClone(NPCS[Math.floor(Math.random() * NPCS.length)]);
  }

  function seededRandom(seed) {
    let x = seed >>> 0 || 123456789;
    return () => {
      x ^= x << 13; x ^= x >>> 17; x ^= x << 5;
      return (x >>> 0) / 4294967296;
    };
  }

  function battle(cardA, cardB) {
    const seed = (Date.now() ^ Math.floor(Math.random()*0xffffffff)) >>> 0;
    const rnd = seededRandom(seed);
    const A = fighter(cardA, rnd);
    const B = fighter(cardB, rnd);
    const log = [];

    applyOpening(A, rnd, log);
    applyOpening(B, rnd, log);

    for (let turn = 1; turn <= 20; turn++) {
      const first = actionOrder(A, B, turn, rnd);
      const second = first === A ? B : A;
      log.push(`— TURN ${turn} —`);
      attack(first, second, rnd, log);
      if (second.hp <= 0) return result(cardA, cardB, first.card.id, turn, seed, log);
      attack(second, first, rnd, log);
      if (first.hp <= 0) return result(cardA, cardB, second.card.id, turn, seed, log);
    }

    const winner = A.hp / A.maxHp >= B.hp / B.maxHp ? A : B;
    log.push(`20ターン終了。残HP率判定で ${winner.card.domain} が勝利。`);
    return result(cardA, cardB, winner.card.id, 20, seed, log);
  }

  function fighter(card, rnd) {
    const f = {
      card, hp: card.stats.hp * 3, maxHp: card.stats.hp * 3,
      atk: card.stats.atk, def: card.stats.def, spd: card.stats.spd, tec: card.stats.tec,
      skills: new Set((card.skills || []).map(s=>s.name))
    };
    if (f.skills.has("重装要塞")) { f.maxHp *= 1.15; f.hp = f.maxHp; f.spd *= .92; }
    if (f.skills.has("巨大生命")) { f.maxHp *= 1.22; f.hp = f.maxHp; }
    if (f.skills.has("古代HTML")) f.spd *= 1.15;
    if (f.skills.has("魔術過積載")) f.spd *= .92;
    if (f.skills.has("DOM迷宮")) f.def *= 1.08;
    if (f.skills.has("鉄壁")) f.def *= 1.10;
    if (f.skills.has("CSS甲冑")) f.def *= 1.05;
    return f;
  }

  function applyOpening(f, rnd, log) {
    if (f.skills.has("第三者召喚")) {
      const keys = ["atk","def","spd","tec"];
      const k = keys[Math.floor(rnd()*keys.length)];
      f[k] *= 1.12;
      log.push(`${f.card.domain}「第三者召喚」→ ${k.toUpperCase()} +12%`);
    }
  }

  function actionOrder(A, B, turn, rnd) {
    if (turn === 1 && A.skills.has("神速") !== B.skills.has("神速")) return A.skills.has("神速") ? A : B;
    const a = A.spd * (.92 + rnd()*.16);
    const b = B.spd * (.92 + rnd()*.16);
    return a >= b ? A : B;
  }

  function attack(attacker, defender, rnd, log) {
    const techAttack = attacker.tec > attacker.atk * 1.08 && rnd() < .42;
    const offense = techAttack ? attacker.tec : attacker.atk;
    let defense = defender.def;
    let skillLabel = techAttack ? "TEC" : "ATK";

    if (techAttack && defender.skills.has("無の境地")) defense *= 1.28;
    let base = 42 * Math.sqrt(Math.max(.25, offense / Math.max(1, defense)));
    base *= .88 + rnd()*.24;

    if (techAttack && attacker.skills.has("魔術過積載")) { base *= 1.20; skillLabel = "魔術過積載"; }
    if (defender.skills.has("三重結界")) base *= .90;
    if (defender.skills.has("静寂のページ") && rnd() < .10) {
      log.push(`${defender.card.domain}「静寂のページ」→ 攻撃を回避！`);
      return;
    }
    if (attacker.skills.has("揺らぐ大地") && rnd() < .16) {
      base *= 1.65;
      skillLabel = "揺らぐ大地";
    }

    const hit = Math.max(8, Math.round(base));
    defender.hp -= hit;
    log.push(`${attacker.card.domain} [${skillLabel}] → ${defender.card.domain} に ${hit} damage (HP ${Math.max(0,Math.round(defender.hp))})`);

    if (!techAttack && attacker.skills.has("画像弾幕") && rnd() < .28 && defender.hp > 0) {
      const hit2 = Math.max(5, Math.round(hit * .55));
      defender.hp -= hit2;
      log.push(`${attacker.card.domain}「画像弾幕」→ 追加 ${hit2} damage！`);
    }
  }

  function result(cardA, cardB, winnerId, turns, seed, log) {
    return {
      id: `battle-${Date.now().toString(36)}-${Math.floor(Math.random()*9999)}`,
      playedAt: now(), seed, turns, log,
      cardA, cardB,
      winnerId,
      winner: winnerId === cardA.id ? cardA : cardB,
      loser: winnerId === cardA.id ? cardB : cardA
    };
  }

  function showBattle(a, b, mode = "LOCAL", target = "dialog") {
    const r = battle(a,b);
    addHistory({
      id:r.id, playedAt:r.playedAt, seed:r.seed, turns:r.turns, mode,
      cardA:snapshot(a), cardB:snapshot(b), winnerId:r.winnerId,
      winnerDomain:r.winner.domain, loserDomain:r.loser.domain
    });

    const html = battleResultHtml(r);
    if (target === "rush") {
      $("#rushArena").innerHTML = html;
      bindResultActions($("#rushArena"), r, true);
    } else if (target === "arena") {
      $("#battleArena").innerHTML = html;
      bindResultActions($("#battleArena"), r, false);
    } else {
      $("#battleDialogContent").innerHTML = html;
      bindResultActions($("#battleDialogContent"), r, false);
      $("#battleDialog").showModal();
    }
    return r;
  }

  function snapshot(c) {
    return { id:c.id, domain:c.domain, url:c.url, className:c.className, stats:c.stats, bp:c.bp, skills:c.skills };
  }

  function battleResultHtml(r) {
    return `
      <div class="arena">
        <div class="arena-cards">
          ${cardHtml(r.cardA)}
          <div class="arena-vs">VS</div>
          ${cardHtml(r.cardB)}
        </div>
        <div class="result-banner">
          <div>
            <p>WINNER / ${r.turns} TURN</p>
            <h3>${esc(r.winner.domain)}</h3>
          </div>
          <div class="result-actions">
            <button class="primary result-download">結果画像</button>
            <button class="secondary result-share">共有</button>
            <button class="secondary result-rematch">再戦</button>
            <button class="secondary result-next hidden">次のNPC</button>
          </div>
        </div>
        <div class="battle-log">
          ${r.log.map(x=>`<div class="log-line">${esc(x)}</div>`).join("")}
        </div>
      </div>`;
  }

  function bindResultActions(root, r, rush) {
    $(".result-download", root).onclick = () => downloadResultImage(r);
    $(".result-share", root).onclick = () => shareResult(r);
    $(".result-rematch", root).onclick = () => {
      if (rush) doRushBattle(r.cardA);
      else showBattle(r.cardA, r.cardB, "REMATCH", root === $("#battleArena") ? "arena" : "dialog");
    };
    const next = $(".result-next", root);
    if (rush) {
      next.classList.remove("hidden");
      next.onclick = () => doRushBattle(r.cardA);
    }
  }

  function doRushBattle(card) {
    const r = showBattle(card, randomNpc(), "RUSH", "rush");
    const state = loadJson(LS.rush, {streak:0});
    if (r.winnerId === card.id) state.streak = (state.streak || 0) + 1;
    else state.streak = 0;
    saveJson(LS.rush, state);
    $("#rushStreak").textContent = state.streak;
  }

  async function downloadResultImage(r) {
    const blob = await makeResultImage(r);
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `url-battler-${r.id}.png`;
    a.click();
    setTimeout(()=>URL.revokeObjectURL(a.href), 1000);
  }

  async function shareResult(r) {
    const text = `URL BATTLER：${r.winner.domain} WIN！ ${r.turns}ターン決着 / BP ${r.winner.bp}`;
    const blob = await makeResultImage(r);
    const file = new File([blob], `url-battler-${r.id}.png`, {type:"image/png"});
    try {
      if (navigator.share && navigator.canShare?.({files:[file]})) {
        await navigator.share({ title:"URL BATTLER", text, files:[file] });
      } else if (navigator.share) {
        await navigator.share({ title:"URL BATTLER", text });
      } else {
        await navigator.clipboard.writeText(text);
        showAlert("共有文をクリップボードにコピーしました。画像は「結果画像」から保存できます。", "success");
      }
    } catch(e) {
      if (e?.name !== "AbortError") showAlert("共有を開始できませんでした。結果画像を保存してSNSへ添付してください。", "error");
    }
  }

  function makeResultImage(r) {
    return new Promise(resolve => {
      const c = document.createElement("canvas");
      c.width = 1200; c.height = 630;
      const x = c.getContext("2d");
      x.fillStyle = "#090b10"; x.fillRect(0,0,c.width,c.height);
      x.fillStyle = "#b9ff38"; x.fillRect(0,0,16,c.height);
      x.fillStyle = "#72e8ff"; x.font = "700 24px sans-serif"; x.fillText("URL BATTLER / BATTLE RESULT", 70, 74);
      x.fillStyle = "#ffffff"; x.font = "900 68px sans-serif"; x.fillText("WINNER", 70, 160);
      x.fillStyle = "#b9ff38"; x.font = "900 54px sans-serif"; fitText(x, r.winner.domain, 70, 232, 1000);
      x.fillStyle = "#9aa5b5"; x.font = "600 24px sans-serif"; x.fillText(`${r.turns} TURN / BP ${r.winner.bp}`, 70, 282);

      const labels = ["HP","ATK","DEF","SPD","TEC"];
      const vals = [r.winner.stats.hp,r.winner.stats.atk,r.winner.stats.def,r.winner.stats.spd,r.winner.stats.tec];
      labels.forEach((lab,i)=>{
        const px = 70 + i*205;
        x.fillStyle = "#171c26"; roundRect(x,px,350,175,110,14); x.fill();
        x.fillStyle = "#9aa5b5"; x.font = "700 18px sans-serif"; x.fillText(lab,px+18,382);
        x.fillStyle = "#ffffff"; x.font = "900 44px sans-serif"; x.fillText(String(vals[i]),px+18,432);
      });

      x.fillStyle = "#9aa5b5"; x.font = "600 20px sans-serif";
      const skill = r.winner.skills?.[0]?.name || "ノーマル";
      x.fillText(`決め手：${skill}`, 70, 525);
      x.fillStyle = "#ffffff"; x.font = "600 18px sans-serif";
      x.fillText(`${r.cardA.domain}  VS  ${r.cardB.domain}`, 70, 578);

      c.toBlob(blob => resolve(blob), "image/png");
    });
  }

  function fitText(ctx, text, x, y, maxWidth) {
    let size = parseInt(ctx.font, 10) || 54;
    while (ctx.measureText(text).width > maxWidth && size > 26) {
      size -= 2;
      ctx.font = `900 ${size}px sans-serif`;
    }
    ctx.fillText(text, x, y);
  }

  function roundRect(ctx,x,y,w,h,r) {
    ctx.beginPath();
    ctx.roundRect(x,y,w,h,r);
  }

  function renderHistory() {
    const h = getHistory();
    const el = $("#historyList");
    if (!h.length) {
      el.innerHTML = `<p class="muted">まだ戦歴はありません。</p>`;
      return;
    }
    el.innerHTML = h.map(v => `
      <div class="history-item">
        <time>${new Date(v.playedAt).toLocaleString("ja-JP")}</time>
        <strong>${esc(v.cardA.domain)} VS ${esc(v.cardB.domain)}</strong>
        <span>${esc(v.winnerDomain)} WIN / ${v.turns}T</span>
      </div>`).join("");
  }

  function renderAll() {
    renderCards();
    renderHistory();
    $("#rushStreak").textContent = loadJson(LS.rush, {streak:0}).streak || 0;
  }

  function setApiState(state) {
    $("#headerApiState").textContent = state;
  }
  function showProgress(on, title, text) {
    $("#scanProgress").classList.toggle("hidden", !on);
    if (title) $("#scanProgressTitle").textContent = title;
    if (text) $("#scanProgressText").textContent = text;
  }
  function showAlert(message, type = "") {
    const el = $("#globalAlert");
    el.textContent = message;
    el.className = `alert ${type}`.trim();
    el.classList.remove("hidden");
    window.scrollTo({top:0,behavior:"smooth"});
    clearTimeout(showAlert.timer);
    showAlert.timer = setTimeout(()=>el.classList.add("hidden"), type === "error" ? 12000 : 5000);
  }
  function handleAppError(err) {
    console.error(err);
    if (err instanceof AppError) showAlert(err.message, "error");
    else showAlert(`予期しないエラーが発生しました：${err?.message || err}`, "error");
  }

  function switchView(name) {
    $$(".tab").forEach(b => b.classList.toggle("active", b.dataset.view === name));
    $$(".view").forEach(v => v.classList.toggle("active", v.id === `view-${name}`));
    window.scrollTo({top:0, behavior:"smooth"});
  }

  let pendingExternalUrl = null;
  function requestExternalOpen(url) {
    pendingExternalUrl = url;
    $("#externalUrlText").textContent = url;
    $("#externalDialog").showModal();
  }
  function actuallyOpenExternal() {
    if (!pendingExternalUrl) return;
    const a = document.createElement("a");
    a.href = pendingExternalUrl;
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    document.body.appendChild(a);
    a.click();
    a.remove();
    pendingExternalUrl = null;
    $("#externalDialog").close();
  }

  async function scanFromCreate() {
    try {
      $("#scanButton").disabled = true;
      const card = await getPageSpeedCard($("#createUrl").value, $("#strategySelect").value, $("#forceScan").checked);
      renderLatest(card);
      showAlert(card.source === "cache" ? "24時間以内のローカルキャッシュからカードを生成しました（API使用なし）。" : "カードを生成しました。", "success");
    } catch(e) { handleAppError(e); }
    finally { $("#scanButton").disabled = false; showProgress(false); }
  }

  async function battleUrls() {
    const button = $("#battleUrlButton");
    try {
      button.disabled = true;
      showAlert("URL Aを準備しています。未キャッシュならPageSpeed APIを使用します。");
      const a = await getPageSpeedCard($("#battleUrlA").value, $("#battleStrategy").value, false);
      showAlert("URL Bを準備しています。未キャッシュならPageSpeed APIを使用します。");
      const b = await getPageSpeedCard($("#battleUrlB").value, $("#battleStrategy").value, false);
      showBattle(a,b,"URL_VS_URL","arena");
    } catch(e) { handleAppError(e); }
    finally { button.disabled = false; showProgress(false); }
  }

  function init() {
    $$(".tab").forEach(b => b.addEventListener("click", () => switchView(b.dataset.view)));
    $("#scanButton").onclick = scanFromCreate;
    $("#createUrl").addEventListener("keydown", e => { if (e.key === "Enter") scanFromCreate(); });
    $("#battleUrlButton").onclick = battleUrls;
    $("#rushStartButton").onclick = () => {
      const card = getCards().find(c => c.id === $("#rushCardSelect").value);
      if (card) doRushBattle(card);
    };
    $("#clearHistoryButton").onclick = () => {
      if (confirm("ローカル戦歴をすべて削除しますか？")) { saveJson(LS.history, []); renderHistory(); }
    };
    $("#battleDialogClose").onclick = () => $("#battleDialog").close();
    $("#externalCancel").onclick = () => { pendingExternalUrl = null; $("#externalDialog").close(); };
    $("#externalOpen").onclick = actuallyOpenExternal;
    $("#saveApiKeyButton").onclick = () => {
      const key = $("#apiKeyInput").value.trim();
      if (key) sessionStorage.setItem("urlbattler.psi.key", key);
      else sessionStorage.removeItem("urlbattler.psi.key");
      showAlert(key ? "APIキーをこのタブのsessionStorageに保存しました。" : "APIキーを解除しました。", "success");
    };
    const storedKey = sessionStorage.getItem("urlbattler.psi.key");
    if (storedKey) $("#apiKeyInput").value = storedKey;
    renderAll();
  }

  init();
})();