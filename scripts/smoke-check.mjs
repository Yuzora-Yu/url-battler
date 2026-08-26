import { readFile } from "node:fs/promises";
const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
const app = await readFile(new URL("../app.js", import.meta.url), "utf8");
const requiredIds = ["createUrl","scanButton","energyRemaining","cardsGrid","battleArena","rushArena","battleDialog"];
for (const id of requiredIds) if (!html.includes(`id="${id}"`)) throw new Error(`missing HTML id: ${id}`);
for (const token of ["BALANCE_VERSION = 6","playBattleAnimation","#URLバトラー","softStat","monsterForCard","battle-effect-art"]) if (!app.includes(token)) throw new Error(`missing app token: ${token}`);
console.log("Smoke check OK");
