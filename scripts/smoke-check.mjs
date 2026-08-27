import { readFile } from "node:fs/promises";

const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
const app = await readFile(new URL("../app.js", import.meta.url), "utf8");
const config = await readFile(new URL("../config.js", import.meta.url), "utf8");
const worker = await readFile(new URL("../worker/worker.js", import.meta.url), "utf8");
const rootWrangler = await readFile(new URL("../wrangler.jsonc", import.meta.url), "utf8");
const monsterLayout = await readFile(new URL("../assets/monster-layout.js", import.meta.url), "utf8");
const towerRivals = await readFile(new URL("../assets/tower-rivals.js", import.meta.url), "utf8");
const legacyWrangler = await readFile(new URL("../worker/wrangler.toml", import.meta.url), "utf8");

const requiredIds = ["createUrl","scanButton","energyRemaining","cardsGrid","battleArena","rushArena","towerArena","towerStartButton","towerRunTurns","towerBestScore","towerBandLabel","battleDialog","backupExportButton","backupImportButton"];
for (const id of requiredIds) if (!html.includes(`id="${id}"`)) throw new Error(`missing HTML id: ${id}`);
for (const token of ["BALANCE_VERSION = 8","playBattleAnimation","#URLバトラー","spreadStat","monsterForCard","battle-effect-art","towerEnemyForFloor","TOWER_MAX_FLOOR = 50","TOWER_BANDS","TOWER_BOSSES","bestClearTurns","tower-result-summary","radarSvg","battle-speed","LANDMARK_SKILLS","buddyLocks","rushAuto","winner-message","defeated"]) if (!app.includes(token) && !html.includes(token) && !towerRivals.includes(token)) throw new Error(`missing app feature token: ${token}`);

if (!monsterLayout.includes("URLB_MONSTER_LAYOUT")) throw new Error("monster layout map is missing");
const towerRivalCount = (towerRivals.match(/\{ name:/g) || []).length;
if (towerRivalCount < 50 || towerRivalCount > 100) throw new Error(`tower rival count must stay between 50 and 100: ${towerRivalCount}`);
if (!html.includes("./assets/tower-rivals.js")) throw new Error("tower rival data script is not loaded");

for (const floor of [10,20,30,40,50]) {
  if (!new RegExp(`\\b${floor}:\"https://`).test(app)) throw new Error(`tower fixed boss missing at ${floor}F`);
}
if (!app.includes('foughtFloor===TOWER_MAX_FLOOR')) throw new Error("tower clear must happen at 50F");
if (!app.includes('state.runTurns=attemptTurns') || !app.includes('resetTowerRun(state)')) throw new Error("tower cumulative-turn/reset logic is missing");
if (!config.includes('"/games/url-battler/api/scan"')) throw new Error("production scan endpoint must be absolute");
if (!worker.includes('service: "url-battler-scan"') || !worker.includes('request.method === "GET"')) throw new Error("scanner health GET is missing");
if (!worker.includes('\"UPSTREAM_TIMEOUT\"')) throw new Error("scanner upstream timeout handling is missing");
if (!worker.includes("GLOBAL_MINUTE_LIMIT = 150") || !worker.includes("GLOBAL_DAILY_LIMIT = 15_000")) throw new Error("scanner global quota limits are missing");
if (!worker.includes("USER_DAILY_ENERGY = 5") || !worker.includes("class ScanGuard")) throw new Error("server-side energy guard is missing");
if (!app.includes('credentials: "include"') || !app.includes("syncEnergyState")) throw new Error("client server-side energy sync is missing");
if (!rootWrangler.includes('"SCAN_GUARD"') || !rootWrangler.includes('"new_sqlite_classes"')) throw new Error("Durable Object scan guard binding/migration is missing");
if (!rootWrangler.includes('"yu-zora.com/games/url-battler/*"')) throw new Error("production route subtree is missing");
if (!rootWrangler.includes('"yu-zora.com/games/url-battler"')) throw new Error("production exact route is missing");
if (/^name\s*=\s*["']url-battler-scan["']/m.test(legacyWrangler)) throw new Error("legacy worker config must not reuse production worker name");

console.log("Smoke check OK");
