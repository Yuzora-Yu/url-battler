(() => {
  "use strict";

  const SCAN_ENDPOINT = String(window.URL_BATTLER_CONFIG?.scanEndpoint || "").trim();
  const ENERGY_ENDPOINT = SCAN_ENDPOINT ? SCAN_ENDPOINT.replace(/\/scan$/, "/energy") : "";
  const PUBLIC_APP_URL = String(window.URL_BATTLER_CONFIG?.publicAppUrl || location.origin).trim();
  const CACHE_TTL = 24 * 60 * 60 * 1000;
  const DAILY_ENERGY_MAX = 5;
  const MAX_CARDS = 5;
  const MAX_HISTORY = 100;
  const BALANCE_VERSION = 6;
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
    { id:"dom-maze", name:"DOM迷宮", desc:"要素が入り組むほど守備アップ", priority:65 },
    { id:"iron-wall", name:"鉄壁", desc:"守りの整ったページで守備アップ", priority:68 },
    { id:"css-armor", name:"CSS甲冑", desc:"装飾の厚みで守備アップ", priority:55 },
    { id:"giant-life", name:"巨大生命", desc:"超重量ページで最大HPアップ", priority:74 },
    { id:"clean-page", name:"静寂のページ", desc:"通信の少なさで攻撃を回避", priority:60 },
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
    const cached = loadJson(LS.energy, null);
    const resetExpired = Number(cached?.resetsAt || 0) > 0 && now() >= Number(cached.resetsAt);
    if (resetExpired) {
      return {
        date: localDateKey(), remaining: DAILY_ENERGY_MAX, limit: DAILY_ENERGY_MAX,
        baseLimit: DAILY_ENERGY_MAX, rewardUsed:false, rewardBonus:0,
        resetsAt:null, synced:false
      };
    }
    const limit = clamp(Number(cached?.limit ?? cached?.baseLimit ?? DAILY_ENERGY_MAX), DAILY_ENERGY_MAX, DAILY_ENERGY_MAX + 1);
    return {
      date: String(cached?.date || localDateKey()),
      remaining: clamp(Number(cached?.remaining ?? DAILY_ENERGY_MAX), 0, limit),
      limit,
      baseLimit: DAILY_ENERGY_MAX,
      rewardUsed: Boolean(cached?.rewardUsed),
      rewardBonus: Number(cached?.rewardBonus || 0) === 1 ? 1 : 0,
      resetsAt: Number(cached?.resetsAt || 0) || null,
      synced: Boolean(cached?.synced)
    };
  }

  function energyNeedsSync() {
    const cached = loadJson(LS.energy, null);
    if (!cached?.synced) return true;
    const resetsAt = Number(cached?.resetsAt || 0);
    return resetsAt > 0 && now() >= resetsAt;
  }

  function updateEnergyFromServer(energy) {
    if (!energy || !Number.isFinite(Number(energy.remaining))) return;
    const limit = clamp(Number(energy.limit ?? energy.baseLimit ?? DAILY_ENERGY_MAX), DAILY_ENERGY_MAX, DAILY_ENERGY_MAX + 1);
    const state = {
      date: String(energy.date || localDateKey()),
      remaining: clamp(Number(energy.remaining), 0, limit),
      limit,
      baseLimit: DAILY_ENERGY_MAX,
      rewardUsed: Boolean(energy.rewardUsed),
      rewardBonus: Number(energy.rewardBonus || 0) === 1 ? 1 : 0,
      resetsAt: Number(energy.resetsAt || 0) || null,
      synced: true
    };
    saveJson(LS.energy, state);
    renderEnergy();
  }

  async function syncEnergyState() {
    if (!ENERGY_ENDPOINT) return;
    try {
      const response = await fetch(ENERGY_ENDPOINT, {
        method: "GET",
        mode: "cors",
        cache: "no-store",
        credentials: "include"
      });
      const payload = await response.json().catch(() => null);
      if (response.ok && payload?.energy) updateEnergyFromServer(payload.energy);
    } catch {
      // 表示用同期に失敗しても、実際の新規スキャン可否はWorker側で判定する。
    }
  }

  function renderEnergy() {
    const state = getEnergyState();
    $("#headerEnergy").textContent = `${state.remaining} / ${state.limit}`;
    $("#energyRemaining").textContent = state.remaining;
    $("#energyResetText").textContent = `毎日0:00（日本時間）に全回復`;
    const orbs = $("#energyOrbs");
    if (orbs) {
      orbs.innerHTML = Array.from({length:state.limit}, (_,i) =>
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
        "いまは新しいURLを探索できません。少し時間をおいてもう一度お試しください。"
      );
    }

    const energy = getEnergyState();

    setApiState("測定中");
    showProgress(true, "サイト召喚中...", energy.remaining > 0
      ? "みんなが発見済みなら消費なし。未発見なら探索エナジーを1使います。"
      : "発見済みURLは消費なし。未発見URLはサーバー側の残り回数を確認します。");

    let response, payload;
    try {
      response = await fetch(SCAN_ENDPOINT, {
        method: "POST",
        mode: "cors",
        cache: "no-store",
        headers: { "content-type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          url,
          strategy,
          force: Boolean(force),
          allowFresh: true
        })
      });
      const text = await response.text();
      try { payload = JSON.parse(text); } catch { payload = { message: text }; }
    } catch (err) {
      setApiState("通信失敗");
      throw new AppError("NETWORK", "新しいURLを探索できませんでした。保存したカードでの対戦は遊べます。", err);
    } finally {
      showProgress(false);
    }

    if (payload?.energy) updateEnergyFromServer(payload.energy);
    if (!response.ok) {
      throw parseScannerError(response.status, payload);
    }
    if (!payload?.ok || !payload?.scan) {
      throw new AppError("SCAN_FAILED", "このURLの強さをうまく判定できませんでした。");
    }

    const cacheStatus = String(payload.cacheStatus || "MISS").toUpperCase();

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
    const details = { status, code, message };

    // ユーザー向け表示は簡潔に保ちつつ、原因コードはDevToolsに残す。
    console.error("[URL Battler scanner]", details);

    if (code === "USER_DAILY_LIMIT") {
      setApiState("エナジー0");
      return new AppError(
        "ENERGY_EMPTY",
        "今日の探索エナジーを使い切りました。発見済みURL・保存カード・連戦モードはそのまま遊べます。探索エナジーは毎日0:00（日本時間）に回復します。",
        details
      );
    }
    if (code === "SCANNER_MINUTE_LIMIT") {
      const wait = Math.max(1, Number(payload.retryAfter || 60));
      setApiState("短時間混雑");
      return new AppError(
        "SCANNER_MINUTE_LIMIT",
        `新しいURLの探索が短時間に集中しています（全体で最大150回/分）。約${wait}秒後にもう一度お試しください。発見済みURLはそのまま召喚できます。`,
        details
      );
    }
    if (code === "SCANNER_DAILY_LIMIT") {
      setApiState("本日上限");
      return new AppError(
        "SCANNER_DAILY_LIMIT",
        "本日の新規URL探索上限（全体で15,000回）に達しました。発見済みURL・保存カード・連戦モードはそのまま遊べます。新規探索は翌0:00（日本時間）に再開します。",
        details
      );
    }
    if (status === 409 && code === "CACHE_MISS") {
      setApiState("エナジー0");
      return new AppError(
        "ENERGY_EMPTY",
        "このURLはまだ誰にも発見されていません。今日のスキャンエナジーを使い切っています。保存カード・連戦モードはそのまま遊べます。",
        details
      );
    }
    if (status === 429 || code === "SCANNER_LIMIT" || code === "UPSTREAM_LIMIT") {
      setApiState("混雑中");
      return new AppError(
        "SCANNER_LIMIT",
        "新しいURLの探索が混み合っています。発見済みカードや保存カードでの対戦は遊べます。",
        details
      );
    }
    if (code === "NO_API_KEY" || code === "NO_CACHE" || code === "NO_SCAN_GUARD") {
      setApiState("設定エラー");
      return new AppError(
        "SCANNER_CONFIG",
        "新しいURL探索サーバーの設定に問題があります。保存カードでの対戦は遊べます。",
        details
      );
    }
    if (code === "SCAN_GUARD_UNAVAILABLE") {
      setApiState("制御サーバー障害");
      return new AppError(
        "SCAN_GUARD_UNAVAILABLE",
        "新規探索の回数確認が一時的に利用できません。安全のため新しいURLの探索を停止しています。発見済みカードでの対戦は遊べます。",
        details
      );
    }
    if (code === "CACHE_UNAVAILABLE") {
      setApiState("キャッシュ障害");
      return new AppError(
        "CACHE_UNAVAILABLE",
        "発見済みURLの確認機能が一時的に利用できません。少し時間をおいてお試しください。",
        details
      );
    }
    if (code === "UPSTREAM_NETWORK" || code === "UPSTREAM_TIMEOUT") {
      setApiState("外部通信障害");
      return new AppError(
        "UPSTREAM_NETWORK",
        "強さを測定する外部サービスへ接続できませんでした。少し時間をおいてお試しください。",
        details
      );
    }
    if (code === "UPSTREAM_BUSY") {
      setApiState("外部API混雑");
      return new AppError(
        "UPSTREAM_BUSY",
        "強さを測定する外部サービスが一時的に利用できません。保存カードでの対戦は遊べます。",
        details
      );
    }
    if (status === 403) {
      setApiState("利用不可");
      return new AppError("DENIED", "いまは新しいURLを探索できません。しばらくしてからお試しください。", details);
    }
    if (status === 400 || status === 422) {
      setApiState("測定不可");
      return new AppError("SCAN_REJECTED", message || "このURLはカードにできませんでした。", details);
    }
    if (status >= 500) {
      setApiState("サービス障害");
      return new AppError("SERVICE", "新しいURLの探索を一時休止しています。保存カードでの対戦は遊べます。", details);
    }
    setApiState("エラー");
    return new AppError("API", message || "このURLはうまく探索できませんでした。", details);
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

  const MONSTER_POOL = Array.isArray(window.URLB_MONSTERS) ? window.URLB_MONSTERS : [];
  const ICONS = window.URLB_ICON_MAP || {};
  const STAT_ICON_KEYS = { hp:"hp", atk:"atk", def:"def", spd:"spd", tec:"tec" };
  const SKILL_EFFECTS = {
    "神速":"./assets/effects/fx-wind-ai.png",
    "古代HTML":"./assets/effects/fx_phys_neutral_chain.png",
    "重装要塞":"./assets/effects/fx_phys_smash_impact.png",
    "画像弾幕":"./assets/effects/fx_phys_ranged_volley.png",
    "魔術過積載":"./assets/effects/fx-spell-chaos-ai.png",
    "無の境地":"./assets/effects/fx_spell_dark.png",
    "三重結界":"./assets/effects/fx_support_buff.png",
    "第三者召喚":"./assets/effects/fx_support_buff.png",
    "DOM迷宮":"./assets/effects/fx_special_rupture.png",
    "鉄壁":"./assets/effects/fx_support_buff.png",
    "CSS甲冑":"./assets/effects/fx_support_buff.png",
    "巨大生命":"./assets/effects/fx_support_heal_radiance.png",
    "静寂のページ":"./assets/effects/fx-light-ai.png",
    "揺らぐ大地":"./assets/effects/fx-neutral-smash-ai.png"
  };
  const CLASS_EFFECTS = {
    STATIC:"./assets/effects/fx-wind-ai.png",
    GUARD:"./assets/effects/fx_phys_slash_arc.png",
    APP:"./assets/effects/fx_spell_light.png",
    MEDIA:"./assets/effects/fx_phys_ranged_volley.png",
    TANK:"./assets/effects/fx_phys_smash_impact.png",
    PORTAL:"./assets/effects/fx_special_rupture.png",
    ARCHIVE:"./assets/effects/fx_phys_neutral_chain.png",
    DESIGN:"./assets/effects/fx_phys_slash_arc.png",
    LEGACY:"./assets/effects/fx-wind-ai.png",
    SUMMONER:"./assets/effects/fx-spell-chaos-ai.png",
    TITAN:"./assets/effects/fx_phys_smash_impact.png",
    CLOUD:"./assets/effects/fx-thunder-ai.png",
    MAZE:"./assets/effects/fx_special_rupture.png",
    WEB:"./assets/effects/fx_phys_slash_arc.png"
  };
  const SKILL_MOVE_NAMES = {
    "神速":"先駆け",
    "画像弾幕":"雨垂れ突き",
    "揺らぐ大地":"蒼天落とし",
    "魔術過積載":"イグナリス"
  };

  function stableHashInt(text) {
    let h = 2166136261;
    for (const ch of String(text || "")) {
      h ^= ch.charCodeAt(0);
      h = Math.imul(h, 16777619);
    }
    return h >>> 0;
  }

  function targetMonsterRank(bp) {
    const x = clamp((Number(bp || 0) - 280) / 650, 0, 1);
    return Math.max(1, Math.min(200, Math.round(1 + 199 * Math.pow(x, 1.28))));
  }

  function preferredMonsterRaces(card) {
    const s = card?.stats || {};
    const entries = [
      ["hp", s.hp || 0], ["atk", s.atk || 0], ["def", s.def || 0],
      ["spd", s.spd || 0], ["tec", s.tec || 0]
    ].sort((a,b)=>b[1]-a[1]);
    const top = entries[0]?.[0];
    if (top === "hp") return ["竜","無生物","粘体","植物"];
    if (top === "atk") return ["獣","獣人","竜","人"];
    if (top === "def") return ["無生物","機械","竜","死霊"];
    if (top === "spd") return ["獣","精霊","魔族","獣人"];
    return ["精霊","魔族","機械","死霊"];
  }

  function monsterForCard(card) {
    if (!MONSTER_POOL.length) return null;
    const bp = Number(card?.bp || 0);
    const target = targetMonsterRank(bp);
    let pool;
    if (bp >= 955) {
      pool = MONSTER_POOL.filter(m => m.special);
    } else if (bp >= 895) {
      pool = MONSTER_POOL.filter(m => m.boss && m.rank >= Math.max(120, target - 30));
    } else if (bp >= 845) {
      pool = MONSTER_POOL.filter(m => (m.boss || m.rare || (!m.boss && m.rank >= 170)) && m.rank <= 220);
    } else {
      pool = MONSTER_POOL.filter(m => !m.boss && !m.special && m.rank <= 200 && Math.abs(m.rank - target) <= 22);
    }
    if (!pool.length) pool = MONSTER_POOL.filter(m => !m.special && Math.abs(Math.min(m.rank,200) - target) <= 35);
    if (!pool.length) pool = MONSTER_POOL;

    const preferred = preferredMonsterRaces(card);
    const seed = stableHashInt(`${card?.url || card?.id || ""}|${card?.strategy || ""}|${Math.round(bp/10)}`);
    let best = null;
    let bestScore = Infinity;
    for (const m of pool) {
      const rankGap = Math.abs(Math.min(m.rank, 200) - target);
      const raceBonus = preferred.includes(m.race) ? -18 : 0;
      const bossBonus = bp >= 895 && m.boss ? -14 : 0;
      const jitter = stableHashInt(`${seed}|${m.id}`) % 21;
      const score = rankGap * 3 + raceBonus + bossBonus + jitter;
      if (score < bestScore) { best = m; bestScore = score; }
    }
    return best || pool[seed % pool.length];
  }

  function monsterBadge(monster) {
    if (!monster) return "";
    if (monster.special) return "伝説級";
    if (monster.boss) return "ボス級";
    if (monster.rare) return "レア";
    if (monster.rank >= 170) return "超上級";
    if (monster.rank >= 120) return "上級";
    if (monster.rank >= 70) return "中級";
    return "初級";
  }


  function cardGrade(card) {
    const bp = Number(card?.bp || 0);
    if (bp >= 920) return "LEGEND";
    if (bp >= 860) return "SS";
    if (bp >= 790) return "S";
    if (bp >= 710) return "A";
    if (bp >= 620) return "B";
    return "C";
  }

  const BUDDY_RACE_BONUS = {
    "竜":       { key:"atk", name:"火力", title:"竜の猛攻" },
    "竜人":     { key:"atk", name:"火力", title:"竜人の猛攻" },
    "獣":       { key:"spd", name:"速さ", title:"獣の疾走" },
    "獣人":     { key:"spd", name:"速さ", title:"獣人の疾走" },
    "機械":     { key:"def", name:"守備", title:"機鋼の守り" },
    "無生物":   { key:"def", name:"守備", title:"鉄壁の守り" },
    "粘体":     { key:"hp",  name:"耐久", title:"粘体の生命力" },
    "植物":     { key:"hp",  name:"耐久", title:"大地の生命力" },
    "精霊":     { key:"tec", name:"技術", title:"精霊のひらめき" },
    "魔族":     { key:"tec", name:"技術", title:"魔族のひらめき" },
    "死霊":     { key:"tec", name:"技術", title:"死霊のひらめき" },
    "人":       { key:"atk", name:"火力", title:"人の闘志" }
  };

  function monsterBond(card) {
    const monster = monsterForCard(card);
    if (!monster) return null;
    const rule = BUDDY_RACE_BONUS[monster.race] || { key:"atk", name:"火力", title:"相棒の闘志" };
    let percent = 2 + Math.floor(Math.min(200, Number(monster.rank || 1)) / 45);
    if (monster.boss) percent += 1;
    if (monster.special) percent += 1;
    percent = clamp(percent, 2, 8);
    return { ...rule, percent, monster };
  }

  function buddyText(card) {
    const buddy = monsterBond(card);
    return buddy ? `${buddy.title}：${buddy.name}+${buddy.percent}%` : "";
  }

  function skillIcon(skill) {
    const key = skill?.id || "normal";
    return ICONS[key] || ICONS.normal || "";
  }

  function statIcon(key) {
    return ICONS[STAT_ICON_KEYS[key]] || "";
  }

  function effectForEvent(event, attackerCard) {
    if (event?.skillName && SKILL_EFFECTS[event.skillName]) return SKILL_EFFECTS[event.skillName];
    if (event?.critical) return "./assets/effects/fx_special_rupture.png";
    if (event?.techAttack) return "./assets/effects/fx_spell_light.png";
    return CLASS_EFFECTS[attackerCard?.className] || "./assets/effects/fx_phys_slash_arc.png";
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
    showAlert("お気に入りに保存しました。", "success");
    return true;
  }

  function removeCard(id) {
    if (!confirm("このカードを手持ちから外しますか？")) return;
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
    const date = card.capturedAt ? new Date(card.capturedAt).toLocaleString("ja-JP", {month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit"}) : "ライバル";
    const source =
      card.source === "local-cache" ? "発見済み" :
      card.source === "shared-cache" ? "みんなが発見済み" :
      card.source === "new-scan" ? "新発見" :
      card.source === "npc" ? "ライバル" : "カード";
    const monster = monsterForCard(card);
    const monsterHtml = monster ? `
      <div class="monster-panel">
        <div class="monster-art">
          <img src="${esc(monster.image)}" alt="${esc(monster.name)}" loading="lazy" />
        </div>
        <div class="monster-info">
          <small>相棒モンスター</small>
          <strong>${esc(monster.name)}</strong>
          <span>ランク ${fmt(monster.rank)} ・ ${esc(monster.race)} ・ ${esc(monsterBadge(monster))}</span><em>${esc(buddyText(card))}</em>
        </div>
      </div>` : "";
    return `
      <article class="site-card" style="--cardA:${a};--cardB:${b}">
        <div class="card-top">
          <div>
            <div class="card-name">${esc(displayName(card))}</div>
            <div class="card-domain">${esc(card.domain)}</div>
            <div class="card-path">${esc(path)}</div>
          </div>
          <div class="class-badge"><b>${esc(cardGrade(card))}</b><span>${esc(classLabel(card))}</span></div>
        </div>
        <div class="card-core">
          <div class="card-bp"><small>戦闘力</small><strong>${fmt(card.bp)}</strong></div>
          ${monsterHtml}
        </div>
        <div class="stats">
          ${statBox("hp","耐久",card.stats.hp)}
          ${statBox("atk","火力",card.stats.atk)}
          ${statBox("def","守備",card.stats.def)}
          ${statBox("spd","速さ",card.stats.spd)}
          ${statBox("tec","技術",card.stats.tec)}
        </div>
        <div class="skills">
          ${(card.skills?.length ? card.skills : [{id:"normal",name:"ノーマル",desc:"目立った固有技なし"}]).map(s=>`
            <div class="skill">
              <img class="skill-icon" src="${esc(skillIcon(s))}" alt="" />
              <strong>${esc(s.name)}</strong><span>${esc(s.desc)}</span>
            </div>
          `).join("")}
        </div>
        <div class="card-meta"><span>${card.strategy === "mobile" ? "スマホ版" : "PC版"}</span><span>${source} / ${date}</span></div>
      </article>`;
  }
  function statBox(key, name, value) {
    return `<div class="statbox">
      <img class="stat-icon" src="${esc(statIcon(key))}" alt="" />
      <small>${name}</small><strong>${fmt(value)}</strong>
    </div>`;
  }
  function esc(v) {
    return String(v ?? "").replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  }

  function metricsHtml(card) {
    const m = card.metrics || {};
    if (m.isNpc) return "";
    const speedSec = Number.isFinite(m.lcp) ? `${(m.lcp / 1000).toFixed(m.lcp < 1000 ? 2 : 1)}秒` : "—";
    const programBytes = (Number(m.scriptBytes || 0) + Number(m.cssBytes || 0));
    return `
      <details class="scan-details">
        <summary>このカードの個性を見る</summary>
        <div class="trait-grid">
          <span><b>表示の軽快さ</b>${m.perf ?? "—"} / 100</span>
          <span><b>ページの重さ</b>${fmtBytes(m.totalBytes)}</span>
          <span><b>画像</b>${fmt(m.imageCount)}枚</span>
          <span><b>プログラム量</b>${fmtBytes(programBytes)}</span>
          <span><b>外部サービス</b>${fmt(m.thirdPartyDomains)}種類</span>
          <span><b>大きな表示まで</b>${speedSec}</span>
        </div>
      </details>`;
  }

  function renderLatest(card) {
    const area = $("#latestCardArea");
    area.classList.remove("showcase");
    const discovery =
      card.discoveryStatus === "NEW"
        ? `<div class="discovery-banner new">★ 新発見! 探索エナジー -1</div>`
        : card.discoveryStatus === "DISCOVERED"
          ? `<div class="discovery-banner">♻ みんなが発見済み! エナジー消費なし</div>`
          : `<div class="discovery-banner">✓ 発見済み! エナジー消費なし</div>`;
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
        <div class="share-note">SNSで見せると、カード画像と短い投稿文をまとめて共有できます。</div>
      </div>`;
    $("#saveLatestCard").onclick = () => saveCard(card);
    $("#shareLatestCard").onclick = () => shareCard(card);
    $("#downloadLatestCard").onclick = () => downloadCardImage(card);
    $("#battleLatestNpc").onclick = () => showBattle(card, randomNpc(), "ライバル");
    $("#openLatestSite").onclick = () => requestExternalOpen(card.url);
  }

  function renderCards() {
    const cards = getCards();
    $("#cardsCounter").textContent = `${cards.length} / ${MAX_CARDS}`;
    $("#headerCardCount").textContent = `${cards.length} / ${MAX_CARDS}`;
    const grid = $("#cardsGrid");
    if (!cards.length) {
      grid.innerHTML = `<p class="muted">まだお気に入りカードはありません。「URL探索」で見つけたカードを最大5枚まで残せます。</p>`;
    } else {
      grid.innerHTML = cards.map(c => `
        <div class="card-wrap" data-card-id="${esc(c.id)}">
          ${cardHtml(c)}
          <div class="card-actions">
            <button class="primary act-share">SNSで見せる</button>
            <button class="secondary act-image">画像</button>
            <button class="secondary act-name">名前変更</button>
            <button class="secondary act-battle">おまかせ対戦</button>
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
        $(".act-battle", el).onclick = () => showBattle(card, randomNpc(), "ライバル");
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
    STATIC:"光速タップ", GUARD:"ガードクラッシュ", APP:"コードバースト", MEDIA:"イメージラッシュ",
    TANK:"ヘビープレス", PORTAL:"リンクストーム", ARCHIVE:"テキストラッシュ", DESIGN:"スタイルブレード",
    LEGACY:"古代の一撃", SUMMONER:"助っ人召喚", TITAN:"ギガプレス", CLOUD:"クラウドストライク", MAZE:"迷宮コンボ", WEB:"ウェブストライク"
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

    const buddy = monsterBond(card);
    f.buddy = buddy;
    if (buddy) {
      const rate = 1 + buddy.percent / 100;
      if (buddy.key === "hp") {
        f.maxHp = Math.round(f.maxHp * rate);
        f.hp = f.maxHp;
      } else if (buddy.key in f) {
        f[buddy.key] *= rate;
      }
    }
    return f;
  }

  function applyOpening(f, rnd, events, log) {
    if (f.buddy) {
      const text = `相棒「${f.buddy.monster.name}」が援護! ${f.buddy.name}+${f.buddy.percent}%`;
      events.push({ kind:"opening", cardId:f.card.id, skill:"相棒", text });
      log.push(text);
    }
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
    const baseAttackName = techAttack ? "コードバースト" : (ATTACK_NAMES[attacker.card.className] || "ウェブストライク");
    const attackName = skillName && SKILL_MOVE_NAMES[skillName]
      ? `${SKILL_MOVE_NAMES[skillName]}・${skillName}`
      : baseAttackName;
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
      const extraText = `${displayName(attacker.card)}「雨垂れ突き・画像弾幕」→ 追加${extra}ダメージ`;
      events.push({ kind:"extra", turn, attackerId:attacker.card.id, defenderId:defender.card.id, attackName:"雨垂れ突き・画像弾幕", damage:extra, hpAfter:defender.hp, maxHp:defender.maxHp, skillName:"画像弾幕", text:extraText });
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

    if (wf.buddy && wf.buddy.percent >= 5) {
      reasons.push({
        title:"相棒の援護",
        detail:`${wf.buddy.monster.name}の「${wf.buddy.title}」で${wf.buddy.name}+${wf.buddy.percent}%`
      });
    }

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
    const monster = monsterForCard(card);
    return `
      <div class="battle-fighter ${side === "A" ? "left" : "right"}" data-side="${side}">
        <div class="fighter-head">
          <div><small>${side === "A" ? "1P" : "2P"} / ${esc(classLabel(card))}</small><strong>${esc(displayName(card))}</strong></div>
          <span class="fighter-sigil">${esc(classSigil(card))}</span>
        </div>
        ${monster ? `
          <div class="fighter-monster">
            <img src="${esc(monster.image)}" alt="${esc(monster.name)}" />
            <div><b>${esc(monster.name)}</b><span>ランク ${fmt(monster.rank)} ・ ${esc(monster.race)}<br>${esc(buddyText(card))}</span></div>
          </div>` : ""}
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
        <div class="battle-top"><b>URLバトル!</b><span>相棒と固有技が勝負を決める</span></div>
        <div class="battle-stage">
          ${fighterBattleHtml(r.cardA, r.fighterA.maxHp, "A")}
          <div class="battle-center">
            <span class="turn-chip">開始!</span>
            <div class="battle-message">まもなくバトル開始!</div>
            <button class="battle-skip" type="button">演出をスキップ</button>
          </div>
          ${fighterBattleHtml(r.cardB, r.fighterB.maxHp, "B")}
          <div class="battle-effect-art" aria-hidden="true"><img alt="" /></div>
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
    const effectArt = $(".battle-effect-art", shell);
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
        showBattleEffect(effectArt, SKILL_EFFECTS[e.skill] || "./assets/effects/fx_support_buff.png");
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
        showBattleEffect(effectArt, "./assets/effects/fx-wind-ai.png");
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
        const attackerCard = e.attackerId === r.cardA.id ? r.cardA : r.cardB;
        showBattleEffect(effectArt, effectForEvent(e, attackerCard));
        await sleep(e.kind === "extra" ? 430 : 520);
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

  function showBattleEffect(el, src) {
    if (!el || !src) return;
    const img = $("img", el);
    if (!img) return;
    img.src = src;
    el.classList.remove("show");
    void el.offsetWidth;
    el.classList.add("show");
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
        <div><small>勝者 / ${r.turns}ターン</small><h3>${esc(displayName(r.winner))}</h3>
          ${monsterForCard(r.winner) ? `<p class="winner-monster-name">相棒 ${esc(monsterForCard(r.winner).name)} / ランク ${fmt(monsterForCard(r.winner).rank)}</p>` : ""}
        </div>
        ${monsterForCard(r.winner) ? `<img class="winner-monster" src="${esc(monsterForCard(r.winner).image)}" alt="${esc(monsterForCard(r.winner).name)}" />` : ""}
        <div class="winner-badge">勝<br>利!</div>
      </div>
      <div class="reason-grid">${r.reasons.map(x=>`<div class="reason-card"><b>${esc(x.title)}</b><span>${esc(x.detail)}</span></div>`).join("")}</div>
      <div class="result-actions">
        <button class="primary result-share">SNSで結果共有</button>
        <button class="secondary result-download">結果画像を保存</button>
        <button class="secondary result-rematch">もう一戦</button>
        <button class="secondary result-next hidden">次の相手へ</button>
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
    const statLine = `戦闘力 ${card.bp}【${cardGrade(card)}級】｜耐久${card.stats.hp} 火力${card.stats.atk} 守備${card.stats.def} 速さ${card.stats.spd} 技術${card.stats.tec}`;
    const monster = monsterForCard(card);
    const buddyLine = monster ? `相棒 ${monster.name} / ランク${monster.rank}` : "";
    let name = displayName(card).slice(0, 42);
    let text = `⚡強URL発見!「${name}」\n${statLine}${buddyLine ? `\n${buddyLine}` : ""}\n${card.url}\n#URLバトラー\n${PUBLIC_APP_URL}`;
    while (xWeightedEstimate(text) > 270 && name.length > 8) {
      name = `${name.slice(0,-2)}…`;
      text = `⚡強URL発見!「${name}」\n${statLine}${buddyLine ? `\n${buddyLine}` : ""}\n${card.url}\n#URLバトラー\n${PUBLIC_APP_URL}`;
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

  function loadCanvasImage(src) {
    return new Promise(resolve => {
      if (!src) return resolve(null);
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => resolve(null);
      img.src = src;
    });
  }

  function canvasBlob(canvas) {
    return new Promise(resolve => canvas.toBlob(resolve, "image/png"));
  }

  function drawImageContain(ctx, img, x, y, w, h) {
    if (!img) return;
    const scale = Math.min(w / img.width, h / img.height);
    const dw = img.width * scale, dh = img.height * scale;
    ctx.drawImage(img, x + (w-dw)/2, y + (h-dh)/2, dw, dh);
  }

  async function makeCardImage(card) {
    const c = document.createElement("canvas");
    c.width = 1200; c.height = 630;
    const x = c.getContext("2d");
    const monster = monsterForCard(card);
    const buddy = monsterBond(card);
    const [monsterImg, ...statImgs] = await Promise.all([
      loadCanvasImage(monster?.image),
      ...["hp","atk","def","spd","tec"].map(k => loadCanvasImage(statIcon(k)))
    ]);
    const skillImgs = await Promise.all((card.skills || []).slice(0,3).map(s => loadCanvasImage(skillIcon(s))));
    const [,accent] = cardColors(card);

    // Background and solid printable frame.
    x.fillStyle = "#bfe8ff"; x.fillRect(0,0,1200,630);
    x.fillStyle = "#fff9ea"; roundRect(x,30,22,1140,586,30); x.fill();
    x.lineWidth=6; x.strokeStyle="#17202b"; x.stroke();

    // Header.
    x.fillStyle = "#ffd83d"; roundRect(x,48,42,1104,70,16); x.fill();
    x.fillStyle = "#17202b"; x.font = "900 28px sans-serif"; x.fillText("URLバトラー",74,86);
    x.fillStyle = "#ff5e9f"; roundRect(x,954,54,174,46,23); x.fill();
    x.fillStyle = "#fff"; x.font = "900 19px sans-serif"; x.textAlign="center";
    x.fillText(`${cardGrade(card)}級・${classLabel(card)}`,1041,84); x.textAlign="left";

    // Left info.
    x.fillStyle="#17202b"; x.font="900 50px sans-serif"; fitText(x, displayName(card), 72, 168, 600);
    x.fillStyle="#208cff"; x.font="800 19px sans-serif"; fitText(x, compactUrlForImage(card.url,72),72,202,600);

    x.fillStyle="#667085"; x.font="900 15px sans-serif";
    x.fillText(card.strategy === "mobile" ? "スマホ表示" : "PC表示",72,232);

    x.fillStyle="#ff5e9f"; x.font="900 84px sans-serif"; x.fillText(String(card.bp),72,326);
    x.fillStyle="#17202b"; x.font="900 18px sans-serif"; x.fillText("戦闘力",77,354);

    // Skill chips.
    const skills=(card.skills||[]).slice(0,3);
    const skillY = 378;
    if (skills.length) {
      skills.forEach((s,i)=>{
        const py=skillY+i*38;
        x.fillStyle=i===0 ? "#fff2bf" : "#ffffff"; roundRect(x,72,py,570,31,9); x.fill();
        x.lineWidth=2; x.strokeStyle="#17202b"; x.stroke();
        drawImageContain(x, skillImgs[i], 80, py+3, 25,25);
        x.fillStyle="#17202b"; x.font="900 15px sans-serif"; x.fillText(s.name,114,py+21);
        x.fillStyle="#667085"; x.font="800 12px sans-serif"; fitText(x,s.desc,245,py+20,385);
      });
    } else {
      x.fillStyle="#667085"; x.font="800 14px sans-serif"; x.fillText("固有技：ノーマル",72,402);
    }

    // Monster showcase.
    x.fillStyle="#edf8ff"; roundRect(x,694,132,426,322,24); x.fill();
    x.lineWidth=4; x.strokeStyle="#17202b"; x.stroke();
    x.fillStyle=accent; x.globalAlpha=.15; x.beginPath(); x.arc(910,265,170,0,Math.PI*2); x.fill(); x.globalAlpha=1;
    drawImageContain(x, monsterImg, 730,145,355,230);
    if (monster) {
      x.fillStyle="#17202b"; x.textAlign="center"; x.font="900 24px sans-serif"; fitText(x,monster.name,735,392,350);
      x.fillStyle="#667085"; x.font="900 14px sans-serif";
      x.fillText(`${monsterBadge(monster)} ・ ランク ${monster.rank} ・ ${monster.race}`,907,420);
      if (buddy) {
        x.fillStyle="#ff5e9f"; x.font="900 14px sans-serif";
        x.fillText(`${buddy.title}　${buddy.name}+${buddy.percent}%`,907,444);
      }
      x.textAlign="left";
    }

    // Stats.
    const labels=["耐久","火力","守備","速さ","技術"];
    const vals=[card.stats.hp,card.stats.atk,card.stats.def,card.stats.spd,card.stats.tec];
    const fills=["#fff0df","#ffe2ef","#e0f3ff","#fff6bd","#eee8ff"];
    labels.forEach((lab,i)=>{
      const px=72+i*212;
      x.fillStyle=fills[i]; roundRect(x,px,484,192,80,13); x.fill();
      x.lineWidth=3; x.strokeStyle="#17202b"; x.stroke();
      drawImageContain(x, statImgs[i], px+10,498,30,30);
      x.fillStyle="#667085"; x.font="900 13px sans-serif"; x.fillText(lab,px+47,508);
      x.fillStyle="#17202b"; x.font="900 34px sans-serif"; x.fillText(String(vals[i]),px+47,548);
    });

    // Footer safe area.
    x.fillStyle="#ff5e9f"; x.font="900 21px sans-serif"; x.fillText("#URLバトラー",72,592);
    x.fillStyle="#17202b"; x.font="800 14px sans-serif"; fitText(x,compactUrlForImage(PUBLIC_APP_URL,80),246,591,700);
    return canvasBlob(c);
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
    const wm = monsterForCard(r.winner);
    const text = `⚔ URLバトラー!「${displayName(r.winner)}」勝利! ${r.turns}ターン決着 / 戦闘力${r.winner.bp}${wm ? ` / 相棒 ${wm.name}` : ""} #URLバトラー ${PUBLIC_APP_URL}`;
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

  async function makeResultImage(r) {
    const c=document.createElement("canvas"); c.width=1200; c.height=630;
    const x=c.getContext("2d");
    const monster=monsterForCard(r.winner);
    const buddy=monsterBond(r.winner);
    const monsterImg=await loadCanvasImage(monster?.image);

    x.fillStyle="#ffd83d"; x.fillRect(0,0,1200,630);
    x.fillStyle="#fff9ea"; roundRect(x,30,22,1140,586,30); x.fill();
    x.lineWidth=6; x.strokeStyle="#17202b"; x.stroke();

    x.fillStyle="#61c9ff"; roundRect(x,48,42,1104,70,16); x.fill();
    x.fillStyle="#17202b"; x.font="900 27px sans-serif"; x.fillText("URLバトラー",74,86);
    x.fillStyle="#fff"; x.font="900 18px sans-serif"; x.textAlign="right";
    x.fillText(`${r.turns}ターン決着`,1126,84); x.textAlign="left";

    x.fillStyle="#ff5e9f"; x.font="900 72px sans-serif"; x.fillText("WIN!",70,184);
    x.fillStyle="#17202b"; x.font="900 46px sans-serif"; fitText(x,displayName(r.winner),260,180,520);
    x.fillStyle="#667085"; x.font="900 17px sans-serif"; x.fillText(`戦闘力 ${r.winner.bp} ・ ${cardGrade(r.winner)}級`,264,214);

    // Winner reason panel.
    const reason=r.reasons?.[0];
    x.fillStyle="#ffffff"; roundRect(x,70,248,630,126,16); x.fill();
    x.lineWidth=3; x.strokeStyle="#17202b"; x.stroke();
    x.fillStyle="#ff5e9f"; x.font="900 16px sans-serif"; x.fillText("勝負を決めたポイント",90,279);
    x.fillStyle="#17202b"; x.font="900 27px sans-serif"; fitText(x,reason?.title || "総合力",90,319,575);
    x.fillStyle="#667085"; x.font="800 15px sans-serif"; fitText(x,reason?.detail || "能力と固有技の組み合わせ",90,350,575);

    // Winner monster.
    x.fillStyle="#edf8ff"; roundRect(x,748,126,372,300,22); x.fill();
    x.lineWidth=4; x.strokeStyle="#17202b"; x.stroke();
    drawImageContain(x,monsterImg,775,138,320,220);
    if (monster) {
      x.fillStyle="#17202b"; x.textAlign="center"; x.font="900 23px sans-serif"; fitText(x,monster.name,778,378,315);
      x.fillStyle="#667085"; x.font="900 14px sans-serif"; x.fillText(`ランク ${monster.rank} ・ ${monster.race}`,934,404);
      if (buddy) {
        x.fillStyle="#ff5e9f"; x.font="900 13px sans-serif"; x.fillText(`${buddy.name}+${buddy.percent}%`,934,426);
      }
      x.textAlign="left";
    }

    // Stats.
    const labels=["耐久","火力","守備","速さ","技術"];
    const vals=[r.winner.stats.hp,r.winner.stats.atk,r.winner.stats.def,r.winner.stats.spd,r.winner.stats.tec];
    const fills=["#fff0df","#ffe2ef","#e0f3ff","#fff6bd","#eee8ff"];
    labels.forEach((lab,i)=>{
      const px=70+i*212;
      x.fillStyle=fills[i]; roundRect(x,px,458,192,82,13); x.fill();
      x.lineWidth=3; x.strokeStyle="#17202b"; x.stroke();
      x.fillStyle="#667085"; x.font="900 14px sans-serif"; x.fillText(lab,px+14,485);
      x.fillStyle="#17202b"; x.font="900 36px sans-serif"; x.fillText(String(vals[i]),px+14,526);
    });

    x.fillStyle="#17202b"; x.font="800 15px sans-serif"; fitText(x,`${displayName(r.cardA)}  VS  ${displayName(r.cardB)}`,70,584,780);
    x.fillStyle="#ff5e9f"; x.textAlign="right"; x.font="900 21px sans-serif"; x.fillText("#URLバトラー",1125,584); x.textAlign="left";
    return canvasBlob(c);
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
    const count = $("#headerHistoryCount");
    if (count) count.textContent = String(h.length);
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
    const el = $("#headerApiState");
    if (el) el.textContent = state;
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
        showAlert("新発見! 探索エナジーを1使ってカードを召喚しました。", "success");
      } else if (card.discoveryStatus === "DISCOVERED") {
        showAlert("みんなが発見済みのURLです。エナジー消費なしで召喚しました。", "success");
      } else {
        showAlert("発見済みのURLです。エナジー消費なしで召喚しました。", "success");
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
      if (confirm("対戦記録をすべて削除しますか？")) { saveJson(LS.history, []); renderHistory(); }
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
    if (energyNeedsSync()) syncEnergyState();
    setInterval(() => {
      renderEnergy();
      if (energyNeedsSync()) syncEnergyState();
    }, 60 * 1000);
  }

  init();
})();