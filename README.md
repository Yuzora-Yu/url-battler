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
       └─ /games/url-battler/api/scan
            ├─ Workers KV（24時間共有発見キャッシュ）
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

このRouteは `yu-zora.com` 全体ではなく、`/games/url-battler` とその配下だけを担当します。

### APIの疎通確認

ブラウザで次を開くと、POSTスキャンを実行せずにWorkerのルーティングとBinding状態だけ確認できます。

`https://yu-zora.com/games/url-battler/api/scan`

`configured.pageSpeedApiKey` と `configured.scanCache` が両方 `true` なら、Git/Cloudflare設定上の必須Bindingは見えています。実際のPageSpeed疎通はゲームからのPOSTで確認します。

`worker/wrangler.toml` はローカル/旧standalone用で、production Worker名とは別名にしています。本番デプロイは必ずリポジトリルートで `npx wrangler deploy` を実行してください。

## SCAN ENERGY

- 1日5
- ローカル時刻0:00で回復
- 未発見URL: -1
- 共有KVに24時間以内の発見データあり: 0
- 自分の24時間キャッシュ: 0
- 最新データへ強制更新: -1
- 保存カード / NPC戦 / 連戦: 0

将来のRewarded Ad用に `rewardUsed` フラグは保持しています。

## 安全方針

- http / httpsのみ
- 認証情報入りURL拒否
- localhost / .local / .internal拒否
- private / loopback / link-local系IP直指定拒否
- Workerは対象サイトを直接fetchしない
- カードから元サイトへ開く前に警告表示
- 「守備」は脆弱性診断ではなく、Lighthouseの公開Best Practices等をゲーム値へ変換したもの

詳しいバトル設計は `docs/BATTLE_DESIGN.md`、公開前確認は `docs/QA_CHECKLIST.md` を参照してください。
