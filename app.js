(() => {
  "use strict";

  const SCAN_ENDPOINT = String(window.URL_BATTLER_CONFIG?.scanEndpoint || "").trim();
  const PUBLIC_APP_URL = String(window.URL_BATTLER_CONFIG?.publicAppUrl || location.origin).trim();
  const CACHE_TTL = 24 * 60 * 60 * 1000;
  const DAILY_ENERGY_MAX = 5;
  const MAX_CARDS = 5;
  const MAX_HISTORY = 100;

  const LS = {
    cards: "urlbattler.cards.v2",
    history: "urlbattler.history.v2",
    cache: "urlbattler.cache.v2",
    rush: "urlbattler.rush.v2",
    energy: "urlbattler.energy.v1"
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
      url, finalUrl: url, domain: name, siteName: name, path: "/",
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


  function localDateKey() {
    const d = new Date();
    const y = d.getFullYear();
    const m = String(d.getMonth()+1).padStart(2,"0");
    const day = String(d.getDate()).padStart(2,"0");
    return `${y}-${m}-${day}`;
  }

  function getEnergyState() {
    const today = localDateKey();
    let state = loadJson(LS.energy, null);
    if (!state || state.date !== today) {
      state = { date: today, remaining: DAILY_ENERGY_MAX, rewardUsed: false };
      saveJson(LS.energy, state);
    }
    state.remaining = clamp(Number(state.remaining ?? DAILY_ENERGY_MAX), 0, DAILY_ENERGY_MAX);
    return state;
  }

  function consumeEnergy(amount = 1) {
    const state = getEnergyState();
    if (state.remaining < amount) return false;
    state.remaining -= amount;
    saveJson(LS.energy, state);
    renderEnergy();
    return true;
  }

  function renderEnergy() {
    const state = getEnergyState();
    $("#headerEnergy").textContent = `${state.remaining} / ${DAILY_ENERGY_MAX}`;
    $("#energyRemaining").textContent = state.remaining;
    $("#energyResetText").textContent = `毎日0:00に全回復`;
    const orbs = $("#energyOrbs");
    if (orbs) {
      orbs.innerHTML = Array.from({length:DAILY_ENERGY_MAX}, (_,i) =>
        `<span class="energy-orb ${i < state.remaining ? "on" : ""}"></span>`
      ).join("");
    }
  }

  async function getPageSpeedCard(rawUrl, strategy = "desktop", force = false) {
    const url = normalizeUrl(rawUrl);
    const key = cacheKey(url, strategy);
    const cache = getCache();

    if (!force && cache[key] && now() - cache[key].cachedAt < CACHE_TTL) {
      setApiState("LOCAL HIT");
      return { ...cache[key].card, source: "local-cache", discoveryStatus: "LOCAL" };
    }

    if (!SCAN_ENDPOINT) {
      setApiState("OFFLINE");
      throw new AppError(
        "SCANNER_OFFLINE",
        "スキャナーURLが未設定です。config.js の scanEndpoint にCloudflare Workerの /scan URLを設定してください。"
      );
    }

    const energy = getEnergyState();
    if (force && energy.remaining <= 0) {
      throw new AppError("ENERGY_EMPTY", "再計測にはSCAN ENERGYが1必要です。発見済みURLの通常召喚はENERGY 0でも試せます。");
    }

    setApiState("SCANNING");
    showProgress(true, "サイト召喚中...", energy.remaining > 0
      ? "発見済みならENERGY 0、未発見なら成功時にENERGYを1消費します。"
      : "ENERGY 0のため、発見済み共有キャッシュだけを探します。");

    let response, payload;
    try {
      response = await fetch(SCAN_ENDPOINT, {
        method: "POST",
        mode: "cors",
        cache: "no-store",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          url,
          strategy,
          force: Boolean(force),
          allowFresh: force ? true : energy.remaining > 0
        })
      });
      const text = await response.text();
      try { payload = JSON.parse(text); } catch { payload = { message: text }; }
    } catch (err) {
      setApiState("NETWORK");
      throw new AppError("NETWORK", "URL BATTLERスキャナーへ接続できませんでした。保存済みカードやURL RUSHは遊べます。", err);
    } finally {
      showProgress(false);
    }

    if (!response.ok) {
      throw parseScannerError(response.status, payload);
    }
    if (!payload?.ok || !payload?.scan) {
      throw new AppError("SCAN_FAILED", "スキャナーから有効な計測結果を取得できませんでした。");
    }

    const cacheStatus = String(payload.cacheStatus || "MISS").toUpperCase();
    if (cacheStatus !== "HIT") {
      if (!consumeEnergy(1)) {
        throw new AppError("ENERGY_RACE", "SCAN ENERGYの状態が変わったためカード生成を中止しました。");
      }
    }

    const card = buildCard(url, strategy, payload);
    card.source = cacheStatus === "HIT" ? "shared-cache" : "new-scan";
    card.discoveryStatus = cacheStatus === "HIT" ? "DISCOVERED" : "NEW";
    cache[key] = { cachedAt: now(), card };
    setCache(cache);
    setApiState(cacheStatus === "HIT" ? "CACHE HIT" : "NEW SCAN");
    return card;
  }

  function parseScannerError(status, payload = {}) {
    const code = String(payload.code || "");
    const message = String(payload.message || "");

    if (status === 409 && code === "CACHE_MISS") {
      setApiState("ENERGY 0");
      return new AppError(
        "ENERGY_EMPTY",
        "このURLはまだ共有キャッシュにありません。今日のSCAN ENERGYを使い切っています。保存済みカード・URL RUSHはそのまま遊べます。"
      );
    }
    if (status === 429 || code === "SCANNER_LIMIT" || code === "UPSTREAM_LIMIT") {
      setApiState("CHARGING");
      return new AppError(
        "SCANNER_LIMIT",
        "スキャナーが混み合っているため、新しいURLの計測を現在受け付けられません。発見済みカード・保存カード・URL RUSHは遊べます。"
      );
    }
    if (status === 403) {
      setApiState("DENIED");
      return new AppError("DENIED", "このゲームからスキャナーを利用できません。公開設定を確認してください。");
    }
    if (status === 400 || status === 422) {
      setApiState("INVALID");
      return new AppError("SCAN_REJECTED", message || "このURLは計測できませんでした。");
    }
    if (status >= 500) {
      setApiState("BUSY");
      return new AppError("SERVICE", "スキャナーまたはPageSpeed側が一時的に利用できません。ローカル対戦は遊べます。");
    }
    setApiState("ERROR");
    return new AppError("API", message || `スキャナーエラー (${status})`);
  }

  function buildCard(requestedUrl, strategy, payload) {
    const metrics = { ...(payload.scan || {}) };
    const finalUrl = payload.finalUrl || metrics.finalUrl || requestedUrl;
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
      siteName: domain,
      capturedAt: payload.scannedAt || now(),
      strategy,
      className,
      stats,
      bp,
      skills,
      metrics,
      source: "new-scan"
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
      const oldName = cards[same].siteName;
      cards[same] = { ...card, siteName: oldName || card.siteName || card.domain, savedAt: now() };
      setCards(cards);
      showAlert("カードを更新しました。", "success");
      return true;
    }
    if (cards.length >= MAX_CARDS) {
      showAlert("保存枠は5枚までです。マイカードから1枚削除してから保存してください。", "error");
      return false;
    }
    cards.push({ ...card, siteName: card.siteName || card.domain, savedAt: now() });
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

  function displayName(card) {
    return String(card?.siteName || card?.domain || "UNKNOWN").trim() || "UNKNOWN";
  }

  let editingCardId = null;
  function openCardNameEditor(card) {
    editingCardId = card.id;
    $("#cardNameInput").value = displayName(card);
    $("#cardNameDialog").showModal();
    setTimeout(() => $("#cardNameInput").select(), 0);
  }

  function saveEditedCardName() {
    const name = $("#cardNameInput").value.trim().slice(0,60);
    if (!name || !editingCardId) return;
    const cards = getCards();
    const idx = cards.findIndex(c => c.id === editingCardId);
    if (idx >= 0) {
      cards[idx].siteName = name;
      saveJson(LS.cards, cards);
      renderAll();
      showAlert("カード名を変更しました。共有画像にも反映されます。", "success");
    }
    editingCardId = null;
    $("#cardNameDialog").close();
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
    const source =
      card.source === "local-cache" ? "LOCAL CACHE" :
      card.source === "shared-cache" ? "DISCOVERED" :
      card.source === "new-scan" ? "NEW DISCOVERY" :
      card.source === "npc" ? "NPC" : "SCAN";
    return `
      <article class="site-card" style="--cardA:${a};--cardB:${b}">
        <div class="card-top">
          <div>
            <div class="card-name">${esc(displayName(card))}</div>
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
    const discovery =
      card.discoveryStatus === "NEW"
        ? `<div class="discovery-banner new">🆕 NEW DISCOVERY — SCAN ENERGY -1</div>`
        : card.discoveryStatus === "DISCOVERED"
          ? `<div class="discovery-banner">♻ DISCOVERED CARD — 共有キャッシュから召喚 / ENERGY 0</div>`
          : `<div class="discovery-banner">💾 LOCAL CARD — ENERGY 0</div>`;
    area.innerHTML = `
      <div>
        ${cardHtml(card)}
        ${discovery}
        ${metricsHtml(card)}
        <div class="card-actions">
          <button class="primary" id="saveLatestCard">5枚枠に保存</button>
          <button class="secondary" id="shareLatestCard">SNS共有</button>
          <button class="secondary" id="downloadLatestCard">カード画像</button>
          <button class="secondary" id="battleLatestNpc">NPCと戦う</button>
          <button class="secondary" id="openLatestSite">サイトを見る</button>
        </div>
        <div class="share-note">SNS共有はカード画像＋短い投稿文をローカル生成します。対応端末では画像付きWeb Shareを使います。</div>
      </div>`;
    $("#saveLatestCard").onclick = () => saveCard(card);
    $("#shareLatestCard").onclick = () => shareCard(card);
    $("#downloadLatestCard").onclick = () => downloadCardImage(card);
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
            <button class="primary act-share">SNS共有</button>
            <button class="secondary act-image">画像</button>
            <button class="secondary act-name">名前</button>
            <button class="secondary act-battle">NPC戦</button>
            <button class="secondary act-open">サイト</button>
            <button class="secondary act-rescan">再計測 ⚡1</button>
            <button class="danger ghost act-delete">削除</button>
          </div>
        </div>`).join("");
      $$(".card-wrap").forEach(el => {
        const card = cards.find(c => c.id === el.dataset.cardId);
        $(".act-share", el).onclick = () => shareCard(card);
        $(".act-image", el).onclick = () => downloadCardImage(card);
        $(".act-name", el).onclick = () => openCardNameEditor(card);
        $(".act-battle", el).onclick = () => showBattle(card, randomNpc(), "NPC");
        $(".act-open", el).onclick = () => requestExternalOpen(card.url);
        $(".act-delete", el).onclick = () => removeCard(card.id);
        $(".act-rescan", el).onclick = async () => {
          try {
            const updated = await getPageSpeedCard(card.url, card.strategy, true);
            updated.siteName = card.siteName || card.domain;
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
      winnerDomain:displayName(r.winner), loserDomain:displayName(r.loser)
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
    return { id:c.id, domain:c.domain, siteName:c.siteName, url:c.url, className:c.className, stats:c.stats, bp:c.bp, skills:c.skills };
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
            <h3>${esc(displayName(r.winner))}</h3>
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

  function compactUrlForImage(url, max = 86) {
    const s = String(url || "");
    return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
  }

  function xWeightedEstimate(text) {
    const urls = String(text).match(/https?:\/\/\S+/g) || [];
    let rest = String(text).replace(/https?:\/\/\S+/g, "");
    let weight = urls.length * 23;
    for (const ch of [...rest.normalize("NFC")]) {
      weight += ch.codePointAt(0) <= 0x10FF ? 1 : 2;
    }
    return weight;
  }

  function makeCardShareText(card) {
    const statLine = `BP ${card.bp}｜HP ${card.stats.hp} ATK ${card.stats.atk} DEF ${card.stats.def} SPD ${card.stats.spd} TEC ${card.stats.tec}`;
    let name = displayName(card).slice(0, 42);
    let text = `強URL発見⚡ ${name}\n${statLine}\n${card.url}\n#URLBATTLER\n${PUBLIC_APP_URL}`;
    while (xWeightedEstimate(text) > 270 && name.length > 8) {
      name = `${name.slice(0,-2)}…`;
      text = `強URL発見⚡ ${name}\n${statLine}\n${card.url}\n#URLBATTLER\n${PUBLIC_APP_URL}`;
    }
    return text;
  }

  async function downloadCardImage(card) {
    const blob = await makeCardImage(card);
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `url-battler-card-${hashString(card.url)}.png`;
    a.click();
    setTimeout(()=>URL.revokeObjectURL(a.href), 1000);
  }

  async function shareCard(card) {
    const text = makeCardShareText(card);
    const blob = await makeCardImage(card);
    const file = new File([blob], `url-battler-card-${hashString(card.url)}.png`, {type:"image/png"});
    try {
      if (navigator.share && navigator.canShare?.({files:[file]})) {
        await navigator.share({ title:`URL BATTLER - ${displayName(card)}`, text, files:[file] });
        return;
      }
      if (navigator.share) {
        await navigator.share({ title:`URL BATTLER - ${displayName(card)}`, text });
        return;
      }
      await navigator.clipboard.writeText(text);
      await downloadCardImage(card);
      showAlert(`SNS投稿文をコピーし、カード画像を保存しました。X換算の推定文字数：約${xWeightedEstimate(text)} / 280`, "success");
    } catch(e) {
      if (e?.name !== "AbortError") {
        try {
          await navigator.clipboard.writeText(text);
          showAlert("共有を開始できなかったため、投稿文をクリップボードへコピーしました。", "error");
        } catch {
          showAlert("共有を開始できませんでした。カード画像を保存して手動で投稿してください。", "error");
        }
      }
    }
  }

  function makeCardImage(card) {
    return new Promise(resolve => {
      const c = document.createElement("canvas");
      c.width = 1200; c.height = 630;
      const x = c.getContext("2d");
      const [a,b] = cardColors(card);

      x.fillStyle = "#090b10"; x.fillRect(0,0,c.width,c.height);
      const grad = x.createRadialGradient(1060, 30, 20, 930, 80, 520);
      grad.addColorStop(0, b);
      grad.addColorStop(1, "#090b10");
      x.globalAlpha = .24; x.fillStyle = grad; x.fillRect(0,0,c.width,c.height); x.globalAlpha = 1;

      x.fillStyle = "#b9ff38"; x.fillRect(0,0,16,c.height);
      x.fillStyle = "#72e8ff"; x.font = "700 23px sans-serif"; x.fillText("URL BATTLER / FOUND CARD", 70, 68);

      x.fillStyle = "#ffffff"; x.font = "900 56px sans-serif";
      fitText(x, displayName(card), 70, 145, 1030);

      x.fillStyle = "#9aa5b5"; x.font = "600 22px sans-serif";
      x.fillText(compactUrlForImage(card.url), 70, 190);

      x.fillStyle = "#b9ff38"; x.font = "900 76px sans-serif";
      x.fillText(String(card.bp), 70, 302);
      x.fillStyle = "#9aa5b5"; x.font = "700 18px sans-serif"; x.fillText("BATTLE POWER", 74, 330);

      const labels = ["HP","ATK","DEF","SPD","TEC"];
      const vals = [card.stats.hp,card.stats.atk,card.stats.def,card.stats.spd,card.stats.tec];
      labels.forEach((lab,i)=>{
        const px = 335 + i*165;
        x.fillStyle = "#171c26"; roundRect(x,px,238,145,96,14); x.fill();
        x.fillStyle = "#9aa5b5"; x.font = "700 16px sans-serif"; x.fillText(lab,px+15,268);
        x.fillStyle = "#ffffff"; x.font = "900 39px sans-serif"; x.fillText(String(vals[i]),px+15,312);
      });

      x.fillStyle = "#ffffff"; x.font = "800 20px sans-serif";
      x.fillText(`CLASS  ${card.className}`, 70, 402);

      const skills = (card.skills || []).map(s=>s.name).slice(0,3);
      x.fillStyle = "#9aa5b5"; x.font = "600 20px sans-serif";
      x.fillText(`SKILLS  ${skills.length ? skills.join(" / ") : "ノーマル"}`, 70, 447);

      x.fillStyle = "#72e8ff"; x.font = "800 22px sans-serif";
      x.fillText("#URLBATTLER", 70, 538);
      x.fillStyle = "#9aa5b5"; x.font = "600 17px sans-serif";
      x.fillText(compactUrlForImage(PUBLIC_APP_URL, 90), 70, 575);

      x.fillStyle = "#ffffff"; x.font = "700 17px sans-serif";
      x.textAlign = "right";
      x.fillText(`${card.domain} / ${String(card.strategy || "desktop").toUpperCase()}`, 1130, 575);
      x.textAlign = "left";

      c.toBlob(blob => resolve(blob), "image/png");
    });
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
    const text = `URL BATTLER：${displayName(r.winner)} WIN！ ${r.turns}ターン決着 / BP ${r.winner.bp} #URLBATTLER ${PUBLIC_APP_URL}`;
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
    renderEnergy();
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
      if (card.discoveryStatus === "NEW") {
        showAlert("NEW DISCOVERY！ 未発見URLを計測しました。SCAN ENERGY -1。", "success");
      } else if (card.discoveryStatus === "DISCOVERED") {
        showAlert("DISCOVERED CARD！ 誰かが発見済みの共有キャッシュからENERGY 0で召喚しました。", "success");
      } else {
        showAlert("ローカル保存済みの計測結果からENERGY 0で召喚しました。", "success");
      }
    } catch(e) { handleAppError(e); }
    finally { $("#scanButton").disabled = false; showProgress(false); }
  }

  async function battleUrls() {
    const button = $("#battleUrlButton");
    try {
      button.disabled = true;
      showAlert("URL Aを召喚しています。発見済みならENERGY 0です。");
      const a = await getPageSpeedCard($("#battleUrlA").value, $("#battleStrategy").value, false);
      showAlert("URL Bを召喚しています。発見済みならENERGY 0です。");
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
    $("#cardNameCancel").onclick = () => {
      editingCardId = null;
      $("#cardNameDialog").close();
    };
    $("#cardNameSave").onclick = saveEditedCardName;
    $("#cardNameInput").addEventListener("keydown", e => {
      if (e.key === "Enter") saveEditedCardName();
    });
    renderAll();
    setInterval(renderEnergy, 60 * 1000);
  }

  init();
})();