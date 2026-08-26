# URLバトラー v0.4 POP

URLを入れるとWebページのPageSpeed/Lighthouse測定値からカードを生成し、自動戦闘するブラウザゲームです。

公開予定URL:

`https://yu-zora.com/games/url-battler/`

## v0.4 の主な変更

- UIを日本語中心のポップな「Webカードゲーム」調へ全面変更
- 5能力を `耐久 / 火力 / 守備 / 速さ / 技術` に変更
- 999が簡単に出ない新バランス
  - 通常域はおおむね120〜920
  - 950超はかなり極端なページだけ
  - 999は超軽量・超高速などの極端条件を満たした場合のみ狙える
- v0.3で保存したカードは、raw metricsが残っていれば自動的にv0.4能力へ再計算
- バトルを全面改修
  - HPゲージ
  - 攻撃モーション / 被弾シェイク / ダメージポップ
  - 固有技のカットイン
  - 狭い乱数幅で能力差を重視
  - バトル後に「勝因」を3つ表示
  - 詳細ログでは攻撃値と守備値の根拠を確認可能
- カード共有画像 / 対戦結果画像もポップデザインへ変更
- ハッシュタグを `#URLバトラー` に統一
- YU-ZORA PORTALへの導線を追加
- Cloudflare Worker + Static Assetsを1つのWorkerに統合可能な構成へ変更

## 本番構成

```text
https://yu-zora.com/games/url-battler/
  ├─ Static Assets
  │    ├─ index.html
  │    ├─ styles.css
  │    ├─ app.js
  │    └─ config.js
  │
  └─ Worker API
       ├─ /games/url-battler/api/scan
       ├─ /games/url-battler/api/energy
       ├─ Workers KV（24時間共有発見キャッシュ）
       ├─ Durable Object（厳密な回数制御 / 探索エナジー）
       └─ PageSpeed Insights API
```

Worker自身は対象サイトへ直接アクセスしません。

PageSpeed APIキーは `PAGESPEED_API_KEY` SecretとしてCloudflareに保持します。

## 既存環境からの移行

既存Worker名 `url-battler-scan` と既存KVをそのまま使う構成です。

設定の正本はルートの `wrangler.jsonc` です。

既存のPageSpeed Secretは通常そのまま残ります。デプロイ後に `NO_API_KEY` が出た場合だけ、再度以下を実行してください。

```powershell
npx.cmd wrangler secret put PAGESPEED_API_KEY
```

## Windows: ローカルUIだけ素早く確認

ルートフォルダで:

```powershell
py -m http.server 8000
```

ブラウザ:

`http://localhost:8000/`

このポートで開いた時だけ `config.js` が既存の `workers.dev/scan` を利用します。

## Windows: 本番と同じパス構成で確認

```powershell
npm.cmd install
npm.cmd run check
npm.cmd run build
npx.cmd wrangler dev
```

ブラウザ:

`http://localhost:8787/games/url-battler/`

## Cloudflareへデプロイ

```powershell
npm.cmd run build
npx.cmd wrangler deploy
```

`wrangler.jsonc` に以下を設定済みです。

- Worker: `url-battler-scan`
- Routes: `yu-zora.com/games/url-battler` / `yu-zora.com/games/url-battler/*`
- Zone: `yu-zora.com`
- Static Assets: `./dist`
- API: `/games/url-battler/api/scan`
- KV binding: `SCAN_CACHE`
- Durable Object binding: `SCAN_GUARD`（SQLite-backed）

このRouteは `yu-zora.com` 全体ではなく、`/games/url-battler` とその配下だけを担当します。

### APIの疎通確認

ブラウザで次を開くと、POSTスキャンを実行せずにWorkerのルーティングとBinding状態だけ確認できます。

`https://yu-zora.com/games/url-battler/api/scan`

`configured.pageSpeedApiKey` / `configured.scanCache` / `configured.scanGuard` がすべて `true` なら、Git/Cloudflare設定上の必須Bindingは見えています。実際のPageSpeed疎通はゲームからのPOSTで確認します。

`worker/wrangler.toml` はローカル/旧standalone用で、production Worker名とは別名にしています。本番デプロイは必ずリポジトリルートで `npx wrangler deploy` を実行してください。

## SCAN ENERGY / PageSpeed保護

探索エナジーとPageSpeed新規測定枠は、ブラウザの `localStorage` ではなくWorker側のSQLite-backed Durable Objectを正として管理します。

- 1ユーザー: 1日5回
- リセット: 毎日0:00（日本時間 / Asia/Tokyo）
- 未発見URL: -1
- 共有KVに24時間以内の発見データあり: 0
- 自分の24時間キャッシュ: 0
- 最新データへ強制更新: -1
- 保存カード / NPC戦 / 連戦: 0
- PageSpeed新規測定: 全ユーザー合計で直近60秒150回まで
- PageSpeed新規測定: 全ユーザー合計で1日15,000回まで

PageSpeedがタイムアウト・エラー・測定不可になった場合、ユーザーの探索エナジーは返却します。ただしGoogle API保護用の全体枠は「上流へ送った試行」として返却しません。

匿名ユーザーの識別にはWorkerが発行するHttpOnly Cookieを使います。Cookie削除や別ブラウザまで完全に同一人物と判定することは、ログインなしではできません。その場合でも全体150回/60秒・15,000回/日の上限はDurable Object側で厳密に維持されるため、PageSpeed APIが無制限に叩かれることはありません。

### 超過時

- `USER_DAILY_LIMIT`: 今日の探索エナジーを使い切った
- `SCANNER_MINUTE_LIMIT`: 直近60秒で150回に達した
- `SCANNER_DAILY_LIMIT`: 当日15,000回に達した

いずれも共有KVの発見済みURLは引き続き召喚できます。

### 将来のRewarded Ad

`ScanGuard.grantDailyReward()` に「消費済みエナジーを1日1回だけ1枠回復」のサーバー側状態を用意済みです。たとえば `0/5 → 1/5` になります。現時点では公開HTTPルートには接続していません。

リワード広告を実装する際は、ブラウザの「広告視聴完了」イベントをそのまま信用せず、広告事業者のServer-Side Verification（SSV）等をWorkerで検証してから `grantDailyReward()` を呼び出してください。これにより、DevToolsからの偽装で回復される構成を避けられます。

## 安全方針

- http / httpsのみ
- 認証情報入りURL拒否
- localhost / .local / .internal拒否
- private / loopback / link-local系IP直指定拒否
- Workerは対象サイトを直接fetchしない
- カードから元サイトへ開く前に警告表示
- 「守備」は脆弱性診断ではなく、Lighthouseの公開Best Practices等をゲーム値へ変換したもの

詳しいバトル設計は `docs/BATTLE_DESIGN.md`、公開前確認は `docs/QA_CHECKLIST.md` を参照してください。
