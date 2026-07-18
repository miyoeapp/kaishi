# 懐紙

iPhoneのホーム画面から使う、走り書き・下書き・note原稿向けの執筆PWAです。

## 現在地

- V1仕様: `docs/kaishi-v1-spec.md`
- 画面の地図: `docs/kaishi-v1-screen-map.md`
- 公開先: GitHub Pagesを予定
- 原稿データ: ホーム画面版のiPhone内だけに保存

Safariで開いた場合は設置案内だけを表示し、執筆機能はホーム画面版でのみ使用します。

## 開発用の確認

```bash
npm test
npm run serve
```

PCでの開発表示は `http://localhost:4173/?dev=1` を開きます。本番URLのSafari表示では開発用表示を有効にしません。

