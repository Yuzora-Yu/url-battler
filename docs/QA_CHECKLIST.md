# URLバトラー v0.4 公開前チェック

## 発見

- 未発見URLでエナジーが1だけ減る
- 同じURLを再度入力してエナジーが減らない
- シークレットウィンドウで同URLを入力して共有HITになる
- エナジー0で共有HITは利用できる
- エナジー0で共有MISSはWorker側で `USER_DAILY_LIMIT` になりPageSpeedを呼ばず停止する
- 強制更新で1消費する
- ブラウザのlocalStorageを書き換えてもWorker側残数は増えない
- PageSpeed失敗時はユーザーのエナジーだけ返却される
- `/games/url-battler/api/energy` の残数と画面表示が一致する
- 直近60秒150件到達時は `SCANNER_MINUTE_LIMIT` / 429 になる
- 当日15,000件到達時は `SCANNER_DAILY_LIMIT` / 429 になる
- 429時でも共有HIT URLは召喚できる

## v0.3移行

- 保存済みカードが残る
- raw metricsを持つカードがv0.4能力へ自動再計算される
- 以前999だったカードが不自然に999のまま残らない

## バトル

- HPゲージがダメージと同期する
- 速いカードが先手を取りやすい
- 神速が初ターンに反映される
- 三重結界 / 無の境地の軽減がログへ反映される
- 画像弾幕の追加攻撃が別表示される
- 演出スキップ後も最終HP・勝敗が正しい
- 再戦が開始できる
- 連戦の勝敗で連勝数が更新される
- 勝因が実際の能力・イベントと矛盾しない

## 共有

- カード画像にサイト名・URL・戦闘力・5能力・#URLバトラー・ゲームURLが入る
- 結果画像に勝者・勝因が入る
- Web Share対応端末で画像共有できる
- 非対応PCで投稿文コピー + PNG保存できる

## 安全

- localhost拒否
- 127.0.0.1拒否
- private IP拒否
- 認証情報入りURL拒否
- 外部サイトを開く前に警告

## 本番URL

- https://yu-zora.com/games/url-battler/ が200
- styles.css / app.jsが同パス配下から取得できる
- GET /games/url-battler/api/scan で `configured.scanGuard: true` が返る
- GET /games/url-battler/api/energy が200でサーバー側残数を返す
- POST /games/url-battler/api/scan が200または正常なゲームエラーを返す
- https://yu-zora.com/ 本体へ影響がない
- /games/yubi-strategy/ へ影響がない
