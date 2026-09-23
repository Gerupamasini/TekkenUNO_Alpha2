# 鉄研UNO Online v2

鉄研UNO（ドボンUNO）をブラウザで遊ぶためのオンライン版です。PC・スマホ（縦持ち）・タブレットで動きます。
同じ**合言葉**を入れた人どうしが同じ部屋に入ります（ゴッドフィールドの隠れ乱闘方式）。

- ルールの正は [docs/RULES.md](docs/RULES.md)。取扱説明書と「不明点リスト」の回答をまとめたものです
- 変更履歴は [CHANGELOG.md](CHANGELOG.md)。いまのバージョンは `package.json` の `version`
- 旧版（TekkenUNO_Beta）からの作り直しです。旧版のコードは使っていません

## できること

- 合言葉で部屋を作る・入る。最初に入った人がホスト（START・END GAME・キック）
- 2〜10人で対戦、観戦（次のゲームから参加の予約つき）
- 重ね出し、カットイン、累積ドロー、ドボン、ダブロン・トリロン…、ドボン返し
- 再読み込み・スマホのスリープ・回線切れから同じ席に戻れる（部屋がある間）
- 部屋ごとの成績（試合数・累計点・平均・最高・ドボン・被ドボン）と、試合別の記録
- スタンプ、UNO!・カットイン・ドボンなどの演出
- カードは画像を使わず CSS と SVG で描画（公式UNOのロゴ・図柄は使っていません）

## 動かし方

Node.js 20 以上が必要です。

配布した zip には作成済みの `dist/` が入っているので、`npm install` なしで `npm start` だけでも試せます（http://localhost:10000/）。

```bash
npm install          # 開発用の道具（esbuild・TypeScript・tsx）を入れる
npm run dev          # 開発サーバー http://localhost:10000/ （保存すると自動で作り直し）
npm test             # ルールとサーバーのテスト
npm run typecheck    # 型チェック
npm run build        # 本番用に dist/ を作る
npm start            # dist/server.js を起動（PORT 環境変数でポート指定）
```

同じPCで複数人を試すときは、ブラウザの別プロファイルやシークレットウィンドウを使ってください
（同じブラウザのタブどうしは同じ人として扱われます）。

## Render へのデプロイ

`render.yaml` があるので、Render の Blueprint としてそのまま使えます。
すでにある Web Service を使う場合は、ダッシュボードで次のように設定してください。

| 項目 | 値 |
| --- | --- |
| Build Command | `npm install --include=dev && npm run build` |
| Start Command | `npm start` |
| Health Check Path | `/healthz` |

注意点（無料プラン）

- 15分間アクセスがないと停止し、次に開くとき起動まで1分ほどかかります（画面に「サーバーを起動しています…」と出ます）
- 再起動・再デプロイ・停止のたびに、部屋と成績はすべて消えます（メモリにだけ保存しているため）
- `autoDeploy: true` なので、GitHub に push すると遊んでいる途中の部屋も消えます。遊んでいる時間帯の push は避けるか、`autoDeploy: false` にして手動でデプロイしてください
- 新しい版を公開すると、開いている画面は再接続のときに自動で読み込み直します

## しくみ

- **サーバー**：Node.js の標準機能だけで動きます（実行時の依存パッケージなし）。WebSocket も `src/server/ws.ts` に自前で実装しています
- **画面**：フレームワークを使わない TypeScript。変わった部分だけを書き換え、演出は transform と opacity だけで動かしています。圧縮後の転送量は JS・CSS 合わせて25KB前後です
- **通信**：状態が変わったときだけ、各プレイヤー向けの表示データ（自分の手札だけを含む）と「出来事」（出した・引いた・ドボンなど）を送ります。演出は「出来事」から作ります
- **不正対策**：ルールの判定はすべてサーバー側。他人の手札や山札の中身は画面に送りません

```
src/
  shared/cards.ts      カード定義と小さなルール関数（サーバー・画面で共有）
  shared/engine.ts     ゲーム進行の本体（docs/RULES.md の実装）
  shared/protocol.ts   通信メッセージと表示データの型
  server/rooms.ts      部屋・ホスト・再接続・キック・成績
  server/app.ts        HTTP（画面の配信）と WebSocket の受け口
  server/ws.ts         WebSocket の最小実装
  server/index.ts      起動
  client/              画面（main.ts から読み込み）
    version.ts         バージョン（ビルドで埋め込む）
    ui/game.ts         ゲーム画面（席・場・ボタン・手札・結果）
    ui/stats.ts        成績（通算・試合別）
    ui/events.ts       出来事 → 演出
    fx.ts              演出の部品
    cardview.ts        カードの描画
    styles.css         見た目（色は :root の変数）
test/                  node:test によるテスト
scripts/               ビルド用スクリプト（meta.mjs がバージョンと更新内容を読む）
CHANGELOG.md           変更履歴
```

## バージョン

- バージョンは `package.json` の `"version"` がもとです。ビルドのときに画面へ埋め込まれ、入室画面・ロビー・メニュー（☰）に表示されます
- 公開中のバージョンは `https://（サービスのURL）/version` でも確かめられます
- 更新するときは次の2つをそろえてください
  1. `package.json` の `"version"` を上げる（不具合の修正は3つ目、機能の追加や変更は2つ目の数字）
  2. `CHANGELOG.md` のいちばん上に、そのバージョンの変更点を書き足す（画面の「更新内容」に新しいほうから5つ出ます）
- GitHub に上げるときは、コミットのメッセージにもバージョン（例：`v2.2.0`）を書いておくと、あとで戻すときに探しやすくなります

## ルールを変えるとき

1. `docs/RULES.md` を直す
2. `src/shared/engine.ts` を直す（章番号をコメントに書いています）
3. `test/engine.test.ts` にテストを足して `npm test`

制限時間などの数値は `src/shared/engine.ts` の先頭、部屋の設定は `src/server/rooms.ts` と `src/shared/protocol.ts` の先頭にあります。
