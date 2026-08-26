# URL BATTLER v0.3

「未発見URLを探すこと自体がゲーム」になる低コストMVPです。

## v0.3の中心ルール

- SCAN ENERGY: 1日5
- 毎日ローカル時刻0:00に5まで全回復
- 未発見URLの新規PageSpeed計測: ENERGY -1
- 誰かが24時間以内に発見済みのURL: ENERGY 0
- ローカルに24時間キャッシュ済み: ENERGY 0
- 保存カード / NPC戦 / URL RUSH / 戦歴: ENERGY 0
- 強制再計測: ENERGY -1
- マイカード最大5枚
- カード名を自由に変更
- カード画像PNGをローカル生成
- Web Share APIでSNS共有
- 非対応環境は投稿文コピー + PNG保存
- 投稿文にはサイト名 / URL / BP / 5能力 / #URLBATTLER / URL BATTLER本体URLを含む

## 構成

Browser
  -> Cloudflare Worker
      -> Workers KV（24時間の共有発見キャッシュ）
      -> cache miss時だけ PageSpeed Insights API
          -> 対象サイト

Worker自身は対象サイトへ直接アクセスしません。

PageSpeed APIキーはユーザーに要求せず、Cloudflare Worker Secretとして運営側が保持します。

## 共有キャッシュ

WorkerはPageSpeedの巨大JSONを保存せず、ゲームに必要な計測指標だけを小さいJSONへ圧縮してKVへ保存します。

同一URL + 同一strategyが24時間以内にKVへ存在すれば `cacheStatus: HIT`。
フロントはSCAN ENERGYを消費しません。

KVに存在しなければ `cacheStatus: MISS`。
PageSpeed計測が成功してからENERGYを1消費します。

ENERGY 0のユーザーは `allowFresh:false` でWorkerへ問い合わせるため、発見済みURLだけ召喚できます。
未発見ならPageSpeedを呼ばずに `409 CACHE_MISS` を返します。

## セットアップ

### 1. Cloudflare KVを作る

Workers KV namespaceを1つ作成し、`worker/wrangler.toml.example` を `wrangler.toml` にコピーしてIDを設定します。

### 2. PageSpeed Insights APIキーを用意

運営者がGoogle CloudでPageSpeed Insights API用キーを作成します。

### 3. APIキーをWorker Secretへ保存

```bash
cd worker
npx wrangler secret put PAGESPEED_API_KEY
```

ソースやwrangler.tomlへキーを直接書かないでください。

### 4. Workerをデプロイ

```bash
npx wrangler deploy
```

### 5. フロント設定

`config.js`:

```js
window.URL_BATTLER_CONFIG = {
  scanEndpoint: "https://YOUR-WORKER.workers.dev/scan",
  publicAppUrl: "https://YOUR-URL-BATTLER.example/"
};
```

### 6. 静的フロントを公開

`index.html / styles.css / app.js / config.js` はCloudflare PagesやGitHub Pages等へ静的配置できます。

## ローカルフロント起動

```bash
python -m http.server 8000
```

`http://localhost:8000`

Worker側 `ALLOWED_ORIGIN` に localhost も許可したい場合はカンマ区切りにしてください。

## SNS共有

マイカードの「SNS共有」から1200x630のPNGを生成します。

共有文の形式:

```text
強URL発見⚡ カード名
BP 842｜HP ... ATK ... DEF ... SPD ... TEC ...
https://target.example/character/hero
#URLBATTLER
https://url-battler.example/
```

Xの通常投稿を意識し、URLを23文字として数える簡易weighted-length推定で270以内を目標にカード名を自動短縮します。

Web Share APIが画像共有に対応している端末では画像+本文を共有します。
非対応時は本文をコピーしPNGを保存します。

## リワード広告の将来拡張

`energy` stateには `rewardUsed` を予約済みです。

将来は「広告クリック報酬」ではなく、正式なRewarded Adの完了イベントを受けて
1日1回だけENERGYを5まで全回復する設計を想定します。

## 安全設計

フロントとWorkerの両方で以下を拒否します。

- http/https以外
- 認証情報入りURL
- localhost
- .local / .internal
- private / loopback / link-local系IP直指定

カードから元サイトを開くときは警告ダイアログを表示します。

DEFは脆弱性診断ではありません。
Lighthouseの公開Best Practices等をゲーム能力へ変換したものです。

## 注意

- Workers KVはグローバルな共有キャッシュですが、更新反映は即時完全同期ではありません。
- 24時間を超えたURLは再発見扱いになり、fresh scan成功時にENERGYを1消費します。
- 「NEW DISCOVERY」はこのMVPでは永続的な世界初発見記録ではなく、24時間共有キャッシュ上の新規発見を意味します。
- 本当の「世界初発見者」を残すなら、後で永続DBを追加します。
