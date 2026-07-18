# 懐紙

iPhoneのホーム画面から使う、走り書き・下書き・note原稿向けの執筆PWAです。

## V1でできること

- Markdown／通常テキスト原稿の作成と自動保存
- note向けの書式付きコピー、プレビュー、検索・置換、Undo／Redo
- 付箋、2階層フォルダ、履歴、30日間のゴミ箱
- 原稿1本・フォルダ・書庫全体の共通JSON読み書き
- オフライン起動と多重起動保護
- 明朝／ゴシック、文字サイズ、行間、余白、明暗の調整

Safariで開いた場合は設置案内だけを表示し、執筆機能はホーム画面版でのみ使用します。
原稿データはホーム画面版のiPhone内だけに保存し、GitHubへは送りません。

## 設計資料

- V1仕様: `docs/kaishi-v1-spec.md`
- 画面の地図: `docs/kaishi-v1-screen-map.md`
- 文机との共通JSON: `docs/common-json-v1.md`

## 開発用の確認

```bash
npm install
npm test
npm run check
npm run serve
```

PCでの開発表示は `http://localhost:4173/?dev=1` を開きます。本番URLのSafari表示では開発用表示を有効にしません。
