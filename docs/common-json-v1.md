# 懐紙・文机 共通JSON V1

懐紙と文机の間で、原稿1本・フォルダ・書庫全体を同じ形式で往復するための記録です。
本文以外の未対応項目も、読み込み後に再び書き出せるよう各項目の追加情報を保持します。

## 全体

| 項目 | 内容 |
|---|---|
| `format` | `kaishi-common-json` |
| `schemaVersion` | 現在は `1` |
| `projectId` | 書き出し元の書庫を見分ける固定ID |
| `exportedAt` | 書き出した日時（ISO 8601） |
| `appVersion` | 書き出したアプリの版 |
| `sourceApp` | `kaishi` または `fuzukue` |
| `exportScope` | `file`、`folder`、`library` |
| `exportedRootIds` | 書き出し対象として選んだ原稿・フォルダの固定ID |
| `folders` | フォルダの配列 |
| `documents` | 原稿の配列 |
| `stickies` | 付箋の配列。原稿・フォルダ書き出しでは空配列 |
| `settings` | 書庫全体の時だけ含める主要設定 |

## 原稿

必須の中心項目は `id`、`title`、`body`、`type`、`folderId`、`color`、`order`、
`createdAt`、`updatedAt`、`revision` です。`type` は `markdown` または `fuzukue` とします。
ゴミ箱内では `deletedAt`、`originalFolderId`、`originalOrder` 等も保持します。

## フォルダ

必須の中心項目は `id`、`name`、`parentId`、`color`、`order`、`createdAt`、
`updatedAt`、`revision` です。ゴミ箱内では `deletedAt`、`originalParentId`、
`originalOrder` 等も保持します。

## 付箋

必須の中心項目は `id`、`text`、`color`、`order`、`createdAt`、`updatedAt`、
`revision` です。

## 読み込み時の原則

- 同じ原稿かどうかは、タイトルではなく `id` で判断します。
- 部分JSONに入っていない既存原稿は削除しません。
- 同じ `id` で本文が異なる時は、利用者が「両方残す／iPhone側／読み込み側」を選びます。
- 書庫の置き換えは `exportScope: "library"` の時だけ許可します。
- 未対応の新しい `schemaVersion` は読み込みません。
- 読み込みは、全変更が成功した時だけ一括確定します。

