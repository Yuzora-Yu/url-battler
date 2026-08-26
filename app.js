(() => {
  "use strict";

  const SCAN_ENDPOINT = String(window.URL_BATTLER_CONFIG?.scanEndpoint || "").trim();
  const PUBLIC_APP_URL = String(window.URL_BATTLER_CONFIG?.publicAppUrl || location.origin).trim();
  const CACHE_TTL = 24 * 60 * 60 * 1000;
  const DAILY_ENERGY_MAX = 5;
  const MAX_CARDS = 5;
  const MAX_HISTORY = 100;
  const BALANCE_VERSION = 4;
  let battlePlaybackId = 0;

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
    { id:"speed-god", name:"神速", desc:"初手を奪い、最初の一撃も強化", priority:100 },
    { id:"ancient-html", name:"古代HTML", desc:"軽量構成で速さアップ", priority:95 },
    { id:"heavy-fort", name:"重装要塞", desc:"耐久アップ・速さダウン", priority:80 },
    { id:"image-barrage", name:"画像弾幕", desc:"画像の物量で追加攻撃", priority:75 },
    { id:"magic-overload", name:"魔術過積載", desc:"技術攻撃アップ・速さダウン", priority:78 },
    { id:"void", name:"無の境地", desc:"技術攻撃のダメージを軽減", priority:83 },
    { id:"triple-barrier", name:"三重結界", desc:"受けるダメージを軽減", priority:92 },
    { id:"third-party", name:"第三者召喚", desc:"開幕に能力ひとつを強化", priority:70 },
    { id:"dom-maze", name:"DOM迷宮", desc:"複雑な構造で守備アップ", priority:65 },
    { id:"iron-wall", name:"鉄壁", desc:"公開設定の堅さで守備アップ", priority:68 },
    { id:"css-armor", name:"CSS甲冑", desc:"CSSの厚みで守備アップ", priority:55 },
    { id:"giant-life", name:"巨大生命", desc:"超重量ページで最大HPアップ", priority:74 },
    { id:"clean-page", name:"静寂のページ", desc:"少リクエストで攻撃を回避", priority:60 },
    { id:"unstable", name:"揺らぐ大地", desc:"不安定さを高威力へ変換", priority:40 }
  ];
  function skillByName(name) { return SKILL_DEFS.find(s => s.name === name); }

  const NPCS = [
    npc("からっぽページ", "https://npc.invalid/empty", [210,180,300,930,150], ["神速","無の境地"], "STATIC"),
    npc("メガポータル", "https://npc.invalid/portal", [865,790,690,300,835], ["重装要塞","第三者召喚"], "PORTAL"),
    npc("画像の城", "https://npc.invalid/gallery", [720,875,510,360,610], ["画像弾幕","重装要塞"], "MEDIA"),
    npc("JSタワー", "https://npc.invalid/app", [650,590,600,430,925], ["魔術過積載","第三者召喚"], "APP"),
    npc("文章アーカイブ", "https://npc.invalid/archive", [780,735,700,620,280], ["DOM迷宮","鉄壁"], "ARCHIVE"),
    npc("CSSナイト", "https://npc.invalid/style", [600,540,850,580,710], ["CSS甲冑","鉄壁"], "DESIGN"),
    npc("古代ウェブマスター", "https://npc.invalid/oldweb", [300,310,590,965,145], ["古代HTML","神速","無の境地"], "LEGACY"),
    npc("広告サモナー", "https://npc.invalid/ads", [710,630,420,310,900], ["第三者召喚","魔術過積載"], "SUMMONER"),
    npc("セキュアゲート", "https://npc.invalid/gate", [560,460,920,650,500], ["三重結界","鉄壁"], "GUARD"),
    npc("メディアタイタン", "https://npc.invalid/media", [935,880,500,220,680], ["巨大生命","画像弾幕"], "TITAN"),
    npc("バランスクラウド", "https://npc.invalid/cloud", [690,700,710,720,730], ["鉄壁"], "CLOUD"),
    npc("DOMラビリンス", "https://npc.invalid/dom", [835,750,790,330,705], ["DOM迷宮","重装要塞"], "MAZE")
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
      source: "npc", balanceVersion: BALANCE_VERSION
    };
  }


  function loadJson(key, fallback) {
    try { return JSON.parse(localStorage.getItem(key)) ?? fallback; }
    catch { return fallback; }
  }
  function saveJson(key, value) {
    localStorage.setItem(key, JSON.stringify(value));
  }
  function getCards() {
    const cards = loadJson(LS.cards, []);
    let changed = false;
    const migrated = cards.map(card => {
      if (card?.metrics && !card.metrics.isNpc && card.balanceVersion !== BALANCE_VERSION) {
        changed = true;
        return rebalanceCard(card);
      }
      return card;
    });
    if (changed) saveJson(LS.cards, migrated);
    return migrated;
  }
  function rebalanceCard(card) {
    const stats = makeStats(card.metrics || {});
    const skills = chooseSkills(card.metrics || {}, stats);
    return {
      ...card,
      stats,
      skills,
      className: chooseClass(card.metrics || {}, stats),
      bp: battlePower(stats),
      balanceVersion: BALANCE_VERSION
    };
  }
  function battlePower(stats) {
    const values = [stats.hp, stats.atk, stats.def, stats.spd, stats.tec];
    const avg = values.reduce((a,b)=>a+b,0) / values.length;
    const peak = Math.max(...values);
    return Math.round(avg * .88 + peak * .12);
  }
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
      setApiState("発見済み");
      let cachedCard = cache[key].card;
      if (cachedCard?.metrics && !cachedCard.metrics.isNpc && cachedCard.balanceVersion !== BALANCE_VERSION) {
        cachedCard = rebalanceCard(cachedCard);
        cache[key].card = cachedCard;
        setCache(cache);
      }
      return { ...cachedCard, source: "local-cache", discoveryStatus: "LOCAL" };
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
      throw new AppError("ENERGY_EMPTY", "最新データへの更新にはスキャンエナジーが1必要です。発見済みURLの通常召喚はエナジー0でも試せます。");
    }

    setApiState("測定中");
    showProgress(true, "サイト召喚中...", energy.remaining > 0
      ? "発見済みならエナジー0、未発見なら測定成功時に1消費します。"
      : "エナジー0のため、みんなの発見済みキャッシュだけを探します。");

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
      setApiState("通信失敗");
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
        throw new AppError("ENERGY_RACE", "スキャンエナジーの状態が変わったためカード生成を中止しました。");
      }
    }

    const card = buildCard(url, strategy, payload);
    card.source = cacheStatus === "HIT" ? "shared-cache" : "new-scan";
    card.discoveryStatus = cacheStatus === "HIT" ? "DISCOVERED" : "NEW";
    cache[key] = { cachedAt: now(), card };
    setCache(cache);
    setApiState(cacheStatus === "HIT" ? "発見済み" : "新発見");
    return card;
  }

  function parseScannerError(status, payload = {}) {
    const code = String(payload.code || "");
    const message = String(payload.message || "");

    if (status === 409 && code === "CACHE_MISS") {
      setApiState("エナジー0");
      return new AppError(
        "ENERGY_EMPTY",
        "このURLはまだ誰にも発見されていません。今日のスキャンエナジーを使い切っています。保存カード・連戦モードはそのまま遊べます。"
      );
    }
    if (status === 429 || code === "SCANNER_LIMIT" || code === "UPSTREAM_LIMIT") {
      setApiState("混雑中");
      return new AppError(
        "SCANNER_LIMIT",
        "スキャナーが混み合っているため、新しいURLの計測を現在受け付けられません。発見済みカード・保存カード・URL RUSHは遊べます。"
      );
    }
    if (status === 403) {
      setApiState("利用不可");
      return new AppError("DENIED", "このゲームからスキャナーを利用できません。公開設定を確認してください。");
    }
    if (status === 400 || status === 422) {
      setApiState("測定不可");
      return new AppError("SCAN_REJECTED", message || "このURLは計測できませんでした。");
    }
    if (status >= 500) {
      setApiState("混雑中");
      return new AppError("SERVICE", "スキャナーが一時的に利用できません。保存カードでの対戦は遊べます。");
    }
    setApiState("エラー");
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
    const bp = battlePower(stats);

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
      source: "new-scan",
      balanceVersion: BALANCE_VERSION
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
    return clamp(Math.log1p(Math.max(0, Number(x) || 0)) / Math.log1p(scale), 0, 1);
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
  // 通常域はおおむね120〜920。950超は生データがかなり極端な場合だけ。
  function softStat(n) {
    const x = clamp(Number(n) || 0, 0, 1);
    return Math.round(120 + 800 * Math.pow(x, .92));
  }
  function legendaryBoost(base, quality) {
    if (!Number.isFinite(quality) || quality <= 0) return base;
    return Math.min(999, Math.round(base + 79 * clamp(quality, 0, 1)));
  }

  function makeStats(m) {
    const hpN = weightedAvailable([
      [logNorm(m.totalBytes, 18 * 1024 * 1024), .48],
      [logNorm(m.domNodes, 6500), .24],
      [logNorm(m.requestCount, 320), .28]
    ], .34);
    const atkN = weightedAvailable([
      [logNorm(m.imageBytes, 12 * 1024 * 1024), .34],
      [logNorm(m.imageCount, 120), .17],
      [logNorm(m.documentBytes, 900 * 1024), .13],
      [logNorm(m.requestCount, 300), .16],
      [logNorm(m.domNodes, 6000), .20]
    ], .32);

    const defN = weightedAvailable([
      [m.best !== null && m.best !== undefined ? m.best / 100 : null, .48],
      [m.isHttps, .20],
      [m.httpsAudit, .10],
      [m.hsts, .09],
      [m.csp, .08],
      [m.noVuln, .05]
    ], .43);

    const spdN = weightedAvailable([
      [m.perf !== null && m.perf !== undefined ? m.perf / 100 : null, .36],
      [fastScore(m.fcp, 450, 4300), .18],
      [fastScore(m.lcp, 900, 6000), .24],
      [fastScore(m.tbt, 60, 1500), .13],
      [fastScore(m.si, 900, 6500), .09]
    ], .42);

    const tecN = weightedAvailable([
      [logNorm(m.scriptBytes, 4.5 * 1024 * 1024), .43],
      [logNorm(m.cssBytes, 1200 * 1024), .17],
      [logNorm(m.thirdPartyDomains, 32), .20],
      [logNorm(m.resourceTypes, 10), .08],
      [logNorm(m.requestCount, 300), .12]
    ], .30);

    let hp = softStat(hpN);
    let atk = softStat(atkN);
    let def = softStat(defN);
    let spd = softStat(spdN);
    let tec = softStat(tecN);

    hp = legendaryBoost(hp, Math.min(
      logNorm(Math.max(0, (m.totalBytes || 0) - 18*1024*1024), 45*1024*1024),
      logNorm(Math.max(0, (m.requestCount || 0) - 320), 500)
    ));
    atk = legendaryBoost(atk, Math.min(
      logNorm(Math.max(0, (m.imageBytes || 0) - 12*1024*1024), 30*1024*1024),
      logNorm(Math.max(0, (m.imageCount || 0) - 120), 250)
    ));
    const perfectGuard = (m.best === 100 ? .25 : 0) + (m.isHttps ? .15 : 0) + (m.hsts === 1 ? .2 : 0) + (m.csp === 1 ? .2 : 0) + (m.noVuln === 1 ? .2 : 0);
    def = legendaryBoost(def, perfectGuard >= .95 ? .55 : 0);
    const speedLegend = (m.perf === 100 && (m.lcp ?? 99999) < 350 && (m.fcp ?? 99999) < 250 && (m.tbt ?? 99999) <= 10)
      ? clamp((350 - (m.lcp || 350)) / 300 + .25, .25, 1) : 0;
    spd = legendaryBoost(spd, speedLegend);
    tec = legendaryBoost(tec, Math.min(
      logNorm(Math.max(0, (m.scriptBytes || 0) - 4.5*1024*1024), 10*1024*1024),
      logNorm(Math.max(0, (m.thirdPartyDomains || 0) - 32), 60)
    ));

    return { hp, atk, def, spd, tec };
  }

  function chooseSkills(m, s) {
    const found = [];
    const add = (name, cond) => { if (cond) { const sk = skillByName(name); if (sk) found.push(sk); } };

    add("神速", s.spd >= 870 || (m.perf >= 95 && (m.lcp || 99999) < 1400));
    add("古代HTML", m.scriptBytes < 70*1024 && m.cssBytes < 140*1024 && m.totalBytes < 800*1024 && s.spd >= 760);
    add("重装要塞", m.totalBytes >= 4*1024*1024);
    add("画像弾幕", m.imageCount >= 30 || m.imageBytes >= 3*1024*1024);
    add("魔術過積載", m.scriptBytes >= 1500*1024);
    add("無の境地", m.scriptBytes <= 35*1024);
    add("三重結界", m.isHttps && m.hsts === 1 && m.csp === 1);
    add("第三者召喚", m.thirdPartyDomains >= 10);
    add("DOM迷宮", m.domNodes >= 1400);
    add("鉄壁", m.isHttps && (m.best ?? 0) >= 94);
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

  const CLASS_LABELS = {
    STATIC:"軽量型", GUARD:"堅牢型", APP:"技術型", MEDIA:"画像型", TANK:"重量型", PORTAL:"複雑型",
    ARCHIVE:"文章型", DESIGN:"装飾型", LEGACY:"古代型", SUMMONER:"召喚型", TITAN:"超重量型", CLOUD:"万能型", MAZE:"迷宮型", WEB:"万能型"
  };
  const CLASS_SIGILS = { STATIC:"速", GUARD:"守", APP:"技", MEDIA:"画", TANK:"重", PORTAL:"網", ARCHIVE:"文", DESIGN:"飾", LEGACY:"古", SUMMONER:"召", TITAN:"巨", CLOUD:"雲", MAZE:"迷", WEB:"網" };
  function classLabel(cardOrName) {
    const key = typeof cardOrName === "string" ? cardOrName : cardOrName?.className;
    return CLASS_LABELS[key] || "ウェブ型";
  }
  function classSigil(card) { return CLASS_SIGILS[card?.className] || "網"; }
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
      card.source === "local-cache" ? "自分の発見済み" :
      card.source === "shared-cache" ? "みんなの発見済み" :
      card.source === "new-scan" ? "新発見" :
      card.source === "npc" ? "NPC" : "測定";
    return `
      <article class="site-card" style="--cardA:${a};--cardB:${b}">
        <div class="card-top">
          <div>
            <div class="card-name">${esc(displayName(card))}</div>
            <div class="card-domain">${esc(card.domain)}</div>
            <div class="card-path">${esc(path)}</div>
          </div>
          <div class="class-badge">${esc(classLabel(card))}</div>
        </div>
        <div class="card-bp"><small>戦闘力</small><strong>${fmt(card.bp)}</strong></div>
        <div class="stats">
          ${statBox("耐久",card.stats.hp)}
          ${statBox("火力",card.stats.atk)}
          ${statBox("守備",card.stats.def)}
          ${statBox("速さ",card.stats.spd)}
          ${statBox("技術",card.stats.tec)}
        </div>
        <div class="skills">
          ${(card.skills?.length ? card.skills : [{name:"ノーマル",desc:"目立った固有技なし"}]).map(s=>`
            <div class="skill"><strong>${esc(s.name)}</strong><span>${esc(s.desc)}</span></div>
          `).join("")}
        </div>
        <div class="card-meta"><span>${card.strategy === "mobile" ? "スマホ測定" : "PC測定"}</span><span>${source} / ${date}</span></div>
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
      <details class="scan-details">
        <summary>このカードの測定データを見る</summary>
        <p>
          Performance ${m.perf ?? "—"} / Best Practices ${m.best ?? "—"} / 転送 ${fmtBytes(m.totalBytes)} / ${fmt(m.requestCount)}リクエスト<br>
          画像 ${fmt(m.imageCount)}枚 (${fmtBytes(m.imageBytes)}) / JS ${fmtBytes(m.scriptBytes)} / CSS ${fmtBytes(m.cssBytes)} / 外部ホスト ${fmt(m.thirdPartyDomains)} / DOM ${m.domNodes ? fmt(m.domNodes) : "n/a"}<br>
          FCP ${m.fcp ? Math.round(m.fcp)+"ms" : "n/a"} / LCP ${m.lcp ? Math.round(m.lcp)+"ms" : "n/a"} / TBT ${m.tbt != null ? Math.round(m.tbt)+"ms" : "n/a"} / Lighthouse ${esc(m.lighthouseVersion || "?")}
        </p>
      </details>`;
  }

  function renderLatest(card) {
    const area = $("#latestCardArea");
    area.classList.remove("showcase");
    const discovery =
      card.discoveryStatus === "NEW"
        ? `<div class="discovery-banner new">★ 新発見! スキャンエナジー -1</div>`
        : card.discoveryStatus === "DISCOVERED"
          ? `<div class="discovery-banner">♻ 発見済み! みんなのキャッシュからエナジー0で召喚</div>`
          : `<div class="discovery-banner">✓ 自分の発見済みデータからエナジー0で召喚</div>`;
    area.innerHTML = `
      <div>
        ${cardHtml(card)}
        ${discovery}
        ${metricsHtml(card)}
        <div class="card-actions">
          <button class="primary" id="saveLatestCard">お気に入りに保存</button>
          <button class="secondary" id="shareLatestCard">SNSで見せる</button>
          <button class="secondary" id="downloadLatestCard">画像保存</button>
          <button class="secondary" id="battleLatestNpc">このカードで戦う</button>
          <button class="secondary" id="openLatestSite">元サイトを見る</button>
        </div>
        <div class="share-note">SNSで見せるは画像保存＋短い投稿文をローカル生成します。対応端末では画像付きWeb Shareを使います。</div>
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
            <button class="primary act-share">SNSで見せる</button>
            <button class="secondary act-image">画像</button>
            <button class="secondary act-name">名前変更</button>
            <button class="secondary act-battle">NPC戦</button>
            <button class="secondary act-open">サイト</button>
            <button class="secondary act-rescan">最新に更新 ⚡1</button>
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
      ? cards.map(c => `<option value="${esc(c.id)}">${esc(displayName(c))} — 戦闘力 ${fmt(c.bp)}</option>`).join("")
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

  const ATTACK_NAMES = {
    STATIC:"高速リクエスト", GUARD:"堅牢カウンター", APP:"コードバースト", MEDIA:"ビジュアルラッシュ",
    TANK:"メガバイトプレス", PORTAL:"DOMコンボ", ARCHIVE:"文章ラッシュ", DESIGN:"スタイルブレード",
    LEGACY:"古代の一撃", SUMMONER:"外部召喚", TITAN:"超重量プレス", CLOUD:"クラウドストライク", MAZE:"迷宮コンボ", WEB:"ウェブストライク"
  };
  const STAT_NAMES = { atk:"火力", def:"守備", spd:"速さ", tec:"技術" };

  function battle(cardA, cardB) {
    const seed = (Date.now() ^ Math.floor(Math.random()*0xffffffff)) >>> 0;
    const rnd = seededRandom(seed);
    const A = fighter(cardA);
    const B = fighter(cardB);
    const events = [];
    const log = [];

    applyOpening(A, rnd, events, log);
    applyOpening(B, rnd, events, log);

    let lastTurn = 1;
    for (let turn = 1; turn <= 18; turn++) {
      lastTurn = turn;
      events.push({ kind:"turn", turn });
      const first = actionOrder(A, B, turn, rnd);
      const second = first === A ? B : A;
      attack(first, second, rnd, turn, events, log);
      if (second.hp <= 0) return finishBattle(cardA, cardB, A, B, first.card.id, turn, seed, events, log);
      attack(second, first, rnd, turn, events, log);
      if (first.hp <= 0) return finishBattle(cardA, cardB, A, B, second.card.id, turn, seed, events, log);
    }

    const aRate = A.hp / A.maxHp;
    const bRate = B.hp / B.maxHp;
    const winner = aRate === bRate ? (A.spd >= B.spd ? A : B) : (aRate > bRate ? A : B);
    log.push(`18ターン終了。残りHP率で「${displayName(winner.card)}」が勝利。`);
    events.push({ kind:"judge", text:"長期戦! 残りHP率で判定" });
    return finishBattle(cardA, cardB, A, B, winner.card.id, lastTurn, seed, events, log);
  }

  function fighter(card) {
    const maxHp = Math.round(520 + card.stats.hp * 1.85);
    const f = {
      card, hp:maxHp, maxHp,
      atk:card.stats.atk, def:card.stats.def, spd:card.stats.spd, tec:card.stats.tec,
      skills:new Set((card.skills || []).map(s=>s.name)),
      passiveNotes:[], attacks:0, damageDealt:0, damageTaken:0
    };
    if (f.skills.has("重装要塞")) { f.maxHp = Math.round(f.maxHp * 1.18); f.hp=f.maxHp; f.spd*=.92; f.passiveNotes.push("重装要塞：最大HP+18% / 速さ-8%"); }
    if (f.skills.has("巨大生命")) { f.maxHp = Math.round(f.maxHp * 1.25); f.hp=f.maxHp; f.passiveNotes.push("巨大生命：最大HP+25%"); }
    if (f.skills.has("古代HTML")) { f.spd*=1.12; f.passiveNotes.push("古代HTML：速さ+12%"); }
    if (f.skills.has("魔術過積載")) { f.spd*=.92; f.passiveNotes.push("魔術過積載：技術攻撃アップ / 速さ-8%"); }
    if (f.skills.has("DOM迷宮")) { f.def*=1.10; f.passiveNotes.push("DOM迷宮：守備+10%"); }
    if (f.skills.has("鉄壁")) { f.def*=1.12; f.passiveNotes.push("鉄壁：守備+12%"); }
    if (f.skills.has("CSS甲冑")) { f.def*=1.07; f.passiveNotes.push("CSS甲冑：守備+7%"); }
    if (f.skills.has("三重結界")) f.passiveNotes.push("三重結界：被ダメージ-10%");
    if (f.skills.has("無の境地")) f.passiveNotes.push("無の境地：技術攻撃を軽減");
    if (f.skills.has("静寂のページ")) f.passiveNotes.push("静寂のページ：ときどき攻撃回避");
    return f;
  }

  function applyOpening(f, rnd, events, log) {
    for (const note of f.passiveNotes.slice(0, 3)) {
      events.push({ kind:"opening", cardId:f.card.id, skill:note.split("：")[0], text:note });
      log.push(`${displayName(f.card)}「${note}」`);
    }
    if (f.skills.has("第三者召喚")) {
      const keys = ["atk","def","spd","tec"];
      const k = keys[Math.floor(rnd()*keys.length)];
      f[k] *= 1.10;
      const text = `第三者召喚：${STAT_NAMES[k]}+10%`;
      events.push({ kind:"opening", cardId:f.card.id, skill:"第三者召喚", text });
      log.push(`${displayName(f.card)}「${text}」`);
    }
  }

  function actionOrder(A, B, turn, rnd) {
    if (turn === 1 && A.skills.has("神速") !== B.skills.has("神速")) return A.skills.has("神速") ? A : B;
    const a = A.spd * (.96 + rnd()*.08);
    const b = B.spd * (.96 + rnd()*.08);
    return a >= b ? A : B;
  }

  function attack(attacker, defender, rnd, turn, events, log) {
    attacker.attacks++;
    const techBias = attacker.card.className === "APP" || attacker.card.className === "SUMMONER" ? .12 : 0;
    const techChance = clamp(.29 + (attacker.tec - attacker.atk) / 1800 + techBias, .18, .68);
    const techAttack = rnd() < techChance;
    const offense = techAttack ? attacker.tec : attacker.atk;
    let defense = techAttack ? defender.def * .72 + defender.spd * .28 : defender.def;
    const tags = [];

    if (techAttack && defender.skills.has("無の境地")) { defense *= 1.28; tags.push("無の境地"); }
    let damage = 115 * Math.pow(clamp(offense / Math.max(180, defense), .38, 2.65), .48);
    damage *= .94 + rnd()*.12;

    let skillName = null;
    if (techAttack && attacker.skills.has("魔術過積載")) { damage *= 1.22; skillName="魔術過積載"; }
    if (defender.skills.has("三重結界")) { damage *= .90; tags.push("三重結界"); }

    if (defender.skills.has("静寂のページ") && rnd() < .11) {
      const attackName = techAttack ? "コードバースト" : (ATTACK_NAMES[attacker.card.className] || "ウェブストライク");
      const text = `${displayName(defender.card)}「静寂のページ」! ${attackName}を回避`;
      events.push({ kind:"evade", turn, attackerId:attacker.card.id, defenderId:defender.card.id, attackName, text });
      log.push(text);
      return;
    }

    let critical = false;
    const critChance = clamp(.045 + (attacker.spd - defender.spd) / 5200, .025, .16);
    if (rnd() < critChance) { damage *= 1.45; critical=true; }
    if (turn === 1 && attacker.skills.has("神速") && attacker.attacks === 1) { damage *= 1.12; skillName = skillName || "神速"; }
    if (attacker.skills.has("揺らぐ大地") && rnd() < .15) { damage *= 1.55; skillName="揺らぐ大地"; }

    damage = Math.max(36, Math.round(damage));
    defender.hp = Math.max(0, defender.hp - damage);
    attacker.damageDealt += damage;
    defender.damageTaken += damage;
    const attackName = techAttack ? "コードバースト" : (ATTACK_NAMES[attacker.card.className] || "ウェブストライク");
    const explain = `${techAttack ? "技術" : "火力"}${Math.round(offense)} vs 守備${Math.round(defense)}`;
    const text = `${displayName(attacker.card)}「${attackName}」→ ${damage}ダメージ${critical ? "! 会心!" : ""}`;
    events.push({
      kind:"attack", turn, attackerId:attacker.card.id, defenderId:defender.card.id,
      attackName, techAttack, damage, hpAfter:defender.hp, maxHp:defender.maxHp,
      critical, skillName, tags, explain, text
    });
    log.push(`${text} (${explain}${tags.length ? ` / ${tags.join("+")}で軽減` : ""})`);

    if (!techAttack && attacker.skills.has("画像弾幕") && rnd() < .34 && defender.hp > 0) {
      const extra = Math.max(20, Math.round(damage * .46));
      defender.hp = Math.max(0, defender.hp - extra);
      attacker.damageDealt += extra;
      defender.damageTaken += extra;
      const extraText = `${displayName(attacker.card)}「画像弾幕」→ 追加${extra}ダメージ`;
      events.push({ kind:"extra", turn, attackerId:attacker.card.id, defenderId:defender.card.id, attackName:"画像弾幕", damage:extra, hpAfter:defender.hp, maxHp:defender.maxHp, skillName:"画像弾幕", text:extraText });
      log.push(extraText);
    }
  }

  function finishBattle(cardA, cardB, A, B, winnerId, turns, seed, events, log) {
    const winner = winnerId === cardA.id ? cardA : cardB;
    const loser = winnerId === cardA.id ? cardB : cardA;
    const wf = winnerId === cardA.id ? A : B;
    const lf = winnerId === cardA.id ? B : A;
    const finisher = [...events].reverse().find(e => (e.kind === "attack" || e.kind === "extra") && e.attackerId === winnerId);
    const result = {
      id:`battle-${Date.now().toString(36)}-${Math.floor(Math.random()*9999)}`,
      playedAt:now(), seed, turns, log, events, cardA, cardB, winnerId, winner, loser,
      fighterA:{ hp:A.hp, maxHp:A.maxHp, damageDealt:A.damageDealt, damageTaken:A.damageTaken },
      fighterB:{ hp:B.hp, maxHp:B.maxHp, damageDealt:B.damageDealt, damageTaken:B.damageTaken },
      finisher
    };
    result.reasons = buildBattleReasons(result, wf, lf);
    return result;
  }

  function buildBattleReasons(r, wf, lf) {
    const reasons = [];
    const w = r.winner.stats, l = r.loser.stats;
    const statDiffs = [
      ["速さで先行", w.spd-l.spd, `速さ ${w.spd} vs ${l.spd}`],
      ["火力差", w.atk-l.atk, `火力 ${w.atk} vs ${l.atk}`],
      ["守備差", w.def-l.def, `守備 ${w.def} vs ${l.def}`],
      ["耐久差", w.hp-l.hp, `耐久 ${w.hp} vs ${l.hp}`],
      ["技術差", w.tec-l.tec, `技術 ${w.tec} vs ${l.tec}`]
    ].sort((a,b)=>b[1]-a[1]);
    if (statDiffs[0][1] >= 70) reasons.push({ title:statDiffs[0][0], detail:statDiffs[0][2] });

    const winnerEvents = r.events.filter(e => e.attackerId === r.winnerId && (e.kind === "attack" || e.kind === "extra"));
    const skillCounts = new Map();
    for (const e of winnerEvents) if (e.skillName) skillCounts.set(e.skillName, (skillCounts.get(e.skillName)||0)+1);
    const topSkill = [...skillCounts.entries()].sort((a,b)=>b[1]-a[1])[0];
    if (topSkill) reasons.push({ title:`固有技「${topSkill[0]}」`, detail:`バトル中に${topSkill[1]}回、ダメージへ影響` });

    if (wf.damageDealt >= lf.damageDealt * 1.12) reasons.push({ title:"ダメージ効率", detail:`与ダメ ${Math.round(wf.damageDealt)} / 被ダメ ${Math.round(wf.damageTaken)}` });
    if (r.finisher) reasons.push({ title:"決め手", detail:`${r.finisher.attackName} ${r.finisher.damage}ダメージ` });
    while (reasons.length < 3) {
      const next = statDiffs.find(x => !reasons.some(r=>r.detail === x[2]));
      if (next) reasons.push({ title:next[1] >= 0 ? `${next[0]}` : "接戦を制した", detail:next[2] });
      else reasons.push({ title:"接戦", detail:`${r.turns}ターンの勝負` });
    }
    return reasons.slice(0,3);
  }

  function showBattle(a, b, mode = "LOCAL", target = "dialog") {
    const r = battle(a,b);
    addHistory({
      id:r.id, playedAt:r.playedAt, seed:r.seed, turns:r.turns, mode,
      cardA:snapshot(a), cardB:snapshot(b), winnerId:r.winnerId,
      winnerDomain:displayName(r.winner), loserDomain:displayName(r.loser)
    });

    let root;
    if (target === "rush") {
      root = $("#rushArena");
      root.innerHTML = battleResultHtml(r);
    } else if (target === "arena") {
      root = $("#battleArena");
      root.innerHTML = battleResultHtml(r);
    } else {
      root = $("#battleDialogContent");
      root.innerHTML = battleResultHtml(r);
      if (!$("#battleDialog").open) $("#battleDialog").showModal();
    }
    playBattleAnimation(r, root, target === "rush", target);
    return r;
  }

  function snapshot(c) {
    return { id:c.id, domain:c.domain, siteName:c.siteName, url:c.url, className:c.className, stats:c.stats, bp:c.bp, skills:c.skills };
  }

  function fighterBattleHtml(card, hp, side) {
    return `
      <div class="battle-fighter ${side === "A" ? "left" : "right"}" data-side="${side}">
        <div class="fighter-head">
          <div><small>${side === "A" ? "1P" : "2P"} / ${esc(classLabel(card))}</small><strong>${esc(displayName(card))}</strong></div>
          <span class="fighter-sigil">${esc(classSigil(card))}</span>
        </div>
        <div class="hp-line">
          <div class="hp-label"><span>HP</span><b class="hp-text">${fmt(hp)} / ${fmt(hp)}</b></div>
          <div class="hp-track"><div class="hp-fill"></div></div>
        </div>
        <div class="fighter-mini-stats"><span>火力 ${card.stats.atk}</span><span>守備 ${card.stats.def}</span><span>速さ ${card.stats.spd}</span></div>
      </div>`;
  }

  function battleResultHtml(r) {
    return `
      <section class="battle-shell">
        <div class="battle-top"><b>URLバトル 実況中</b><span>能力差 + 固有技 + 少量の乱数で決着</span></div>
        <div class="battle-stage">
          ${fighterBattleHtml(r.cardA, r.fighterA.maxHp, "A")}
          <div class="battle-center">
            <span class="turn-chip">READY</span>
            <div class="battle-message">対戦データを読み込み中...</div>
            <button class="battle-skip" type="button">演出をスキップ</button>
          </div>
          ${fighterBattleHtml(r.cardB, r.fighterB.maxHp, "B")}
          <div class="battle-fx"></div><div class="skill-flash"></div>
        </div>
        <div class="battle-result hidden"></div>
      </section>`;
  }

  function sideForCard(r, id) { return id === r.cardA.id ? "A" : "B"; }
  function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

  async function playBattleAnimation(r, root, rush, target) {
    const playback = ++battlePlaybackId;
    const shell = $(".battle-shell", root);
    if (!shell) return;
    const msg = $(".battle-message", shell);
    const turnChip = $(".turn-chip", shell);
    const fx = $(".battle-fx", shell);
    const flash = $(".skill-flash", shell);
    const skip = $(".battle-skip", shell);
    let skipNow = false;
    skip.onclick = () => { skipNow = true; skip.textContent = "スキップ中..."; };

    const hpState = { A:r.fighterA.maxHp, B:r.fighterB.maxHp };
    msg.textContent = `${displayName(r.cardA)} vs ${displayName(r.cardB)} — バトル開始!`;
    showBattleFx(fx, "BATTLE!");
    await sleep(520);

    for (const e of r.events) {
      if (playback !== battlePlaybackId) return;
      if (skipNow) break;
      if (e.kind === "turn") {
        turnChip.textContent = `${e.turn}ターン目`;
        continue;
      }
      if (e.kind === "judge") {
        msg.textContent = e.text;
        showBattleFx(fx, "判定!");
        await sleep(520);
        continue;
      }
      if (e.kind === "opening") {
        const side = sideForCard(r, e.cardId);
        const fighterEl = $(`.battle-fighter[data-side="${side}"]`, shell);
        fighterEl?.classList.add(side === "A" ? "lunge-left" : "lunge-right");
        flash.classList.remove("on"); void flash.offsetWidth; flash.classList.add("on");
        msg.textContent = e.text;
        showBattleFx(fx, e.skill);
        await sleep(500);
        fighterEl?.classList.remove("lunge-left","lunge-right");
        continue;
      }
      if (e.kind === "evade") {
        const aSide = sideForCard(r, e.attackerId), dSide = sideForCard(r, e.defenderId);
        const aEl = $(`.battle-fighter[data-side="${aSide}"]`, shell);
        const dEl = $(`.battle-fighter[data-side="${dSide}"]`, shell);
        aEl?.classList.add(aSide === "A" ? "lunge-left" : "lunge-right");
        dEl?.classList.add(dSide === "A" ? "lunge-right" : "lunge-left");
        msg.textContent = e.text;
        showBattleFx(fx, "MISS!");
        await sleep(430);
        aEl?.classList.remove("lunge-left","lunge-right"); dEl?.classList.remove("lunge-left","lunge-right");
        continue;
      }
      if (e.kind === "attack" || e.kind === "extra") {
        const aSide = sideForCard(r, e.attackerId), dSide = sideForCard(r, e.defenderId);
        const aEl = $(`.battle-fighter[data-side="${aSide}"]`, shell);
        const dEl = $(`.battle-fighter[data-side="${dSide}"]`, shell);
        aEl?.classList.add(aSide === "A" ? "lunge-left" : "lunge-right");
        await sleep(90);
        dEl?.classList.add("hit");
        hpState[dSide] = e.hpAfter;
        updateBattleHp(dEl, e.hpAfter, e.maxHp);
        spawnDamage(shell, dEl, `${e.critical ? "会心! " : ""}-${e.damage}`);
        msg.textContent = e.kind === "extra" ? e.text : `${e.text} / ${e.explain}`;
        if (e.skillName) showBattleFx(fx, e.skillName);
        await sleep(e.kind === "extra" ? 390 : 470);
        aEl?.classList.remove("lunge-left","lunge-right"); dEl?.classList.remove("hit");
      }
    }

    const aEl = $('.battle-fighter[data-side="A"]', shell);
    const bEl = $('.battle-fighter[data-side="B"]', shell);
    updateBattleHp(aEl, r.fighterA.hp, r.fighterA.maxHp);
    updateBattleHp(bEl, r.fighterB.hp, r.fighterB.maxHp);
    turnChip.textContent = `${r.turns}ターン決着`;
    msg.textContent = `勝者「${displayName(r.winner)}」!`;
    showBattleFx(fx, "WIN!");
    await sleep(skipNow ? 120 : 500);
    showBattleFinal(shell, r, rush, target);
  }

  function showBattleFx(el, text) {
    if (!el) return;
    el.textContent = text;
    el.classList.remove("show"); void el.offsetWidth; el.classList.add("show");
  }

  function updateBattleHp(el, hp, maxHp) {
    if (!el) return;
    const rate = clamp(hp / maxHp, 0, 1);
    $(".hp-fill", el).style.width = `${rate*100}%`;
    $(".hp-text", el).textContent = `${fmt(Math.max(0,hp))} / ${fmt(maxHp)}`;
    if (rate < .28) $(".hp-fill", el).style.background = "linear-gradient(90deg,#f04c4c,#ff8a32)";
  }

  function spawnDamage(shell, target, text) {
    if (!target) return;
    const stage = $(".battle-stage", shell);
    const pop = document.createElement("span");
    pop.className="damage-pop"; pop.textContent=text;
    const tr=target.getBoundingClientRect(), sr=stage.getBoundingClientRect();
    pop.style.left=`${tr.left-sr.left+tr.width*.45}px`; pop.style.top=`${tr.top-sr.top+tr.height*.33}px`;
    stage.appendChild(pop); setTimeout(()=>pop.remove(),800);
  }

  function showBattleFinal(shell, r, rush, target) {
    const resultEl = $(".battle-result", shell);
    resultEl.classList.remove("hidden");
    resultEl.innerHTML = `
      <div class="winner-strip">
        <div><small>勝者 / ${r.turns}ターン</small><h3>${esc(displayName(r.winner))}</h3></div>
        <div class="winner-badge">勝<br>利!</div>
      </div>
      <div class="reason-grid">${r.reasons.map(x=>`<div class="reason-card"><b>${esc(x.title)}</b><span>${esc(x.detail)}</span></div>`).join("")}</div>
      <div class="result-actions">
        <button class="primary result-share">SNSで結果共有</button>
        <button class="secondary result-download">結果画像を保存</button>
        <button class="secondary result-rematch">もう一戦</button>
        <button class="secondary result-next hidden">次のNPCへ</button>
      </div>
      <details class="battle-log"><summary>詳しいバトルログを見る</summary>${r.log.map(x=>`<div class="log-line">${esc(x)}</div>`).join("")}</details>`;
    bindResultActions(resultEl, r, rush, target);
  }

  function bindResultActions(root, r, rush, target) {
    $(".result-download", root).onclick = () => downloadResultImage(r);
    $(".result-share", root).onclick = () => shareResult(r);
    $(".result-rematch", root).onclick = () => {
      if (rush) doRushBattle(r.cardA);
      else showBattle(r.cardA, r.cardB, "REMATCH", target);
    };
    const next = $(".result-next", root);
    if (rush) { next.classList.remove("hidden"); next.onclick = () => doRushBattle(r.cardA); }
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
    const statLine = `戦闘力 ${card.bp}｜耐久${card.stats.hp} 火力${card.stats.atk} 守備${card.stats.def} 速さ${card.stats.spd} 技術${card.stats.tec}`;
    let name = displayName(card).slice(0, 42);
    let text = `⚡強URL発見!「${name}」\n${statLine}\n${card.url}\n#URLバトラー\n${PUBLIC_APP_URL}`;
    while (xWeightedEstimate(text) > 270 && name.length > 8) {
      name = `${name.slice(0,-2)}…`;
      text = `⚡強URL発見!「${name}」\n${statLine}\n${card.url}\n#URLバトラー\n${PUBLIC_APP_URL}`;
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
        await navigator.share({ title:`URLバトラー - ${displayName(card)}`, text, files:[file] });
        return;
      }
      if (navigator.share) {
        await navigator.share({ title:`URLバトラー - ${displayName(card)}`, text });
        return;
      }
      await navigator.clipboard.writeText(text);
      await downloadCardImage(card);
      showAlert(`SNS投稿文をコピーし、カード画像も保存しました。X換算の推定文字数：約${xWeightedEstimate(text)} / 280`, "success");
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
      const [,accent] = cardColors(card);

      x.fillStyle = "#bfe8ff"; x.fillRect(0,0,1200,630);
      x.fillStyle = "#fff9ea"; roundRect(x,34,30,1132,570,28); x.fill();
      x.lineWidth=6; x.strokeStyle="#17202b"; x.stroke();
      x.fillStyle = "#ffd83d"; x.fillRect(34,30,1132,72);
      x.fillStyle = "#17202b"; x.font = "900 27px sans-serif"; x.fillText("URLバトラー / 強URLカード", 72,77);

      x.fillStyle = accent; x.globalAlpha=.18; x.beginPath(); x.arc(1050,175,170,0,Math.PI*2); x.fill(); x.globalAlpha=1;
      x.fillStyle="#ff5e9f"; x.font="900 72px sans-serif"; x.fillText(String(card.bp),72,216);
      x.fillStyle="#17202b"; x.font="900 20px sans-serif"; x.fillText("戦闘力",76,246);

      x.fillStyle="#17202b"; x.font="900 52px sans-serif"; fitText(x, displayName(card), 300, 176, 780);
      x.fillStyle="#208cff"; x.font="800 21px sans-serif"; x.fillText(compactUrlForImage(card.url,82),300,216);
      x.fillStyle="#17202b"; x.font="900 18px sans-serif"; x.fillText(`${classLabel(card)} / ${card.strategy === "mobile" ? "スマホ測定" : "PC測定"}`,300,250);

      const labels=["耐久","火力","守備","速さ","技術"];
      const vals=[card.stats.hp,card.stats.atk,card.stats.def,card.stats.spd,card.stats.tec];
      const fills=["#fff0df","#ffe2ef","#e0f3ff","#fff6bd","#eee8ff"];
      labels.forEach((lab,i)=>{
        const px=72+i*212;
        x.fillStyle=fills[i]; roundRect(x,px,304,188,112,14); x.fill(); x.lineWidth=4; x.strokeStyle="#17202b"; x.stroke();
        x.fillStyle="#667085"; x.font="900 17px sans-serif"; x.fillText(lab,px+16,337);
        x.fillStyle="#17202b"; x.font="900 46px sans-serif"; x.fillText(String(vals[i]),px+16,391);
      });

      const skills=(card.skills||[]).map(s=>s.name).slice(0,3);
      x.fillStyle="#17202b"; x.font="900 19px sans-serif"; x.fillText(`固有技  ${skills.length?skills.join(" / "):"ノーマル"}`,72,468);
      x.fillStyle="#667085"; x.font="700 17px sans-serif"; x.fillText(compactUrlForImage(card.domain,60),72,504);
      x.fillStyle="#ff5e9f"; x.font="900 24px sans-serif"; x.fillText("#URLバトラー",72,557);
      x.fillStyle="#17202b"; x.font="700 16px sans-serif"; x.fillText(compactUrlForImage(PUBLIC_APP_URL,88),260,557);

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
    const text = `⚔ URLバトラー!「${displayName(r.winner)}」勝利! ${r.turns}ターン決着 / 戦闘力${r.winner.bp} #URLバトラー ${PUBLIC_APP_URL}`;
    const blob = await makeResultImage(r);
    const file = new File([blob], `url-battler-${r.id}.png`, {type:"image/png"});
    try {
      if (navigator.share && navigator.canShare?.({files:[file]})) {
        await navigator.share({ title:"URLバトラー", text, files:[file] });
      } else if (navigator.share) {
        await navigator.share({ title:"URLバトラー", text });
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
      const c=document.createElement("canvas"); c.width=1200; c.height=630;
      const x=c.getContext("2d");
      x.fillStyle="#ffd83d"; x.fillRect(0,0,1200,630);
      x.fillStyle="#fff9ea"; roundRect(x,34,30,1132,570,28); x.fill();
      x.lineWidth=6; x.strokeStyle="#17202b"; x.stroke();
      x.fillStyle="#61c9ff"; x.fillRect(34,30,1132,74);
      x.fillStyle="#17202b"; x.font="900 26px sans-serif"; x.fillText("URLバトラー / 対戦結果",72,78);

      x.fillStyle="#ff5e9f"; x.font="900 70px sans-serif"; x.fillText("勝利!",72,184);
      x.fillStyle="#17202b"; x.font="900 52px sans-serif"; fitText(x,displayName(r.winner),270,180,840);
      x.fillStyle="#667085"; x.font="800 20px sans-serif"; x.fillText(`${r.turns}ターン決着 / 戦闘力 ${r.winner.bp}`,274,216);

      const labels=["耐久","火力","守備","速さ","技術"];
      const vals=[r.winner.stats.hp,r.winner.stats.atk,r.winner.stats.def,r.winner.stats.spd,r.winner.stats.tec];
      const fills=["#fff0df","#ffe2ef","#e0f3ff","#fff6bd","#eee8ff"];
      labels.forEach((lab,i)=>{
        const px=72+i*212; x.fillStyle=fills[i]; roundRect(x,px,264,188,105,14); x.fill(); x.lineWidth=4; x.strokeStyle="#17202b"; x.stroke();
        x.fillStyle="#667085"; x.font="900 16px sans-serif"; x.fillText(lab,px+15,295);
        x.fillStyle="#17202b"; x.font="900 43px sans-serif"; x.fillText(String(vals[i]),px+15,347);
      });

      const reason=r.reasons?.[0];
      x.fillStyle="#17202b"; x.font="900 23px sans-serif"; x.fillText(`勝因：${reason?.title || "総合力"}`,72,426);
      x.fillStyle="#667085"; x.font="700 18px sans-serif"; x.fillText(reason?.detail || "能力と固有技の組み合わせ",72,458);
      x.fillStyle="#17202b"; x.font="800 18px sans-serif"; x.fillText(`${displayName(r.cardA)}  VS  ${displayName(r.cardB)}`,72,505);
      x.fillStyle="#ff5e9f"; x.font="900 24px sans-serif"; x.fillText("#URLバトラー",72,557);
      x.fillStyle="#17202b"; x.font="700 16px sans-serif"; x.fillText(compactUrlForImage(PUBLIC_APP_URL,88),260,557);
      c.toBlob(blob=>resolve(blob),"image/png");
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
        showAlert("新発見! 未発見URLを測定しました。スキャンエナジー -1。", "success");
      } else if (card.discoveryStatus === "DISCOVERED") {
        showAlert("発見済みカード! みんなの共有キャッシュからエナジー0で召喚しました。", "success");
      } else {
        showAlert("自分の発見済みデータからエナジー0で召喚しました。", "success");
      }
    } catch(e) { handleAppError(e); }
    finally { $("#scanButton").disabled = false; showProgress(false); }
  }

  async function battleUrls() {
    const button = $("#battleUrlButton");
    try {
      button.disabled = true;
      showAlert("1PのURLを召喚中。発見済みならエナジー0です。");
      const a = await getPageSpeedCard($("#battleUrlA").value, $("#battleStrategy").value, false);
      showAlert("2PのURLを召喚中。発見済みならエナジー0です。");
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
    $("#battleDialogClose").onclick = () => { battlePlaybackId++; $("#battleDialog").close(); };
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