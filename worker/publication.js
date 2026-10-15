import scanner from "./worker.js";
export { ScanGuard } from "./worker.js";

// Publication is paused by the owner. Preserve game code and stored scan data.
const published = false;

export default {
  async fetch(request, env) {
    if (!published) {
      return new Response(request.method === "HEAD" ? null : `<!doctype html>
<html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow"><title>公開停止中 | YU-ZORA GAMES</title>
<style>body{margin:0;background:#111c2c;color:#ecf0f6;font:16px/1.8 system-ui,sans-serif}main{max-width:680px;margin:12vh auto;padding:24px}h1{font-size:clamp(24px,5vw,36px)}a{color:#a8d5ff}</style></head>
<body><main><p>YU-ZORA GAMES</p><h1>現在、公開を停止しています</h1><p>このゲームは現在ご利用いただけません。</p><a href="https://yu-zora.com/games/">ゲーム一覧へ戻る</a></main></body></html>`, {
        status: 404,
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-store",
          "X-Robots-Tag": "noindex, nofollow",
          "X-Content-Type-Options": "nosniff"
        }
      });
    }

    const path = new URL(request.url).pathname;
    const base = String(env.APP_BASE_PATH || "/games/url-battler").replace(/\/$/, "");
    if (path === "/scan" || path === "/energy" || path.startsWith(`${base}/api/`)) {
      return scanner.fetch(request, env);
    }
    return env.ASSETS.fetch(request);
  }
};
