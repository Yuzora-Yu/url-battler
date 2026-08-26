# URL BATTLER ZERO — PageSpeed API直呼び MVP

任意の公開WebページURLをGoogle PageSpeed Insights APIで測定し、Lighthouseの結果からカードを生成して戦う静的Webアプリです。

## できること

- トップページ以外のURL（パス・クエリ付き）をそのままカード化
- PageSpeed Insights APIをブラウザから直接呼び出し
- HP / ATK / DEF / SPD / TEC と最大3スキルを自動生成
- 最大5枚のマイカードをローカル保存
- 同一URL・同一計測モードを24時間キャッシュ
- URL vs URL
- 保存カード vs 同梱NPCのURL RUSH（API利用0）
- ローカル戦歴（最大100件）
- バトル結果PNG生成
- Web Share API対応
- PageSpeedの429/403系quota/rate-limitエラーを専用表示
- API制限中でも保存済みカード・NPC戦は遊べる

## 起動

ローカルでは `file://` 直開きよりHTTPサーバーを推奨します。

```bash
cd url-battler-zero
python -m http.server 8000
```

ブラウザで `http://localhost:8000` を開きます。

そのままGitHub Pages / Cloudflare Pages / Netlify / Vercelなどの静的ホスティングにも置けます。

## APIキー

Google公式ドキュメント上、PageSpeed Insights APIはAPIキーなしでも利用できますが、頻繁・自動的な問い合わせではAPIキーが推奨されています。

このMVPはデフォルトでキーなしです。画面の「高度な設定」から任意のAPIキーを入力できます。入力したキーは `sessionStorage` のみに保存され、タブを閉じると消えます。

## 重要な設計

URL BATTLERのサーバーは存在せず、対象サイトを取得しません。

Browser -> Google PageSpeed Insights API -> 対象ページ

カード・キャッシュ・戦歴はブラウザのlocalStorageに保存されます。

### URL制限

以下はブラウザ側で拒否します。

- http/https以外
- username/passwordを含むURL
- localhost / .local / .internal
- private / loopback / link-local等のIPv4
- 一部のローカルIPv6

トップページ限定にはせず、pathname/queryは保持します。fragment (`#...`) は測定リクエストから除外します。

## 注意

- DEFは脆弱性診断ではありません。HTTPS、Lighthouse Best Practices、取得できた公開監査結果をゲーム用に数値化しています。
- Lighthouseの監査項目は将来変更される可能性があります。本実装は `network-requests` からリソース情報を集計し、欠落監査はフォールバックするようにしています。
- PageSpeed APIの利用規約・クォータ・仕様はGoogle側で変更される可能性があります。
- 公開を意図したページのみ利用してください。
