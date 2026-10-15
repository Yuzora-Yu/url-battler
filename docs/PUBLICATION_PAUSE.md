# 公開停止

2026-10-15、所有者の判断で一時公開停止。

実際の本番Routeは `url-battler` Workerが担当しているため、ルートの `wrangler.jsonc` の名前を実環境へ整合。旧API用の `url-battler-scan` も同じ停止コードを配信済み。両Workerの既存KV・Durable Objectを削除・移管せず保持する。

`worker/publication.js` の `published = false` により、ゲーム画面・静的ファイル・スキャンAPIをすべて404・noindexの停止案内へ切り替える。`assets.run_worker_first = true` が静的ファイルにもこの判定を適用する。元のゲームとスキャン実装、KV・Durable Objectのデータは保持する。

ゲームポータルの `config/game-pages.json` と `scripts/news-data.js`、メインポータルの `config/portal.json` では、該当作品・告知に `active: false` を設定。公開用ビルドから紹介ページ・告知記事・一覧・サイトマップ・RSSへの掲載を除外する。

再開は所有者の指示後に行う。公開フラグ、両ポータルの掲載設定を見直し、ゲーム画面とAPIを確認する。
