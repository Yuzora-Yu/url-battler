(() => {
  const localStatic = ["localhost", "127.0.0.1"].includes(location.hostname) && location.port === "8000";
  window.URL_BATTLER_CONFIG = {
    // python -m http.server 8000 での確認時だけ既存workers.devを使う。
    // 本番・wrangler devでは同一オリジンの /games/url-battler/api/scan を使う。
    scanEndpoint: localStatic
      ? "https://url-battler-scan.rikai-829.workers.dev/scan"
      : "./api/scan",
    publicAppUrl: "https://yu-zora.com/games/url-battler/"
  };
})();
