import test from 'node:test';
import assert from 'node:assert/strict';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import {
  applyImport,
  buildExport,
  createDocument,
  createFolder,
  createInternalBackup,
  getFolderSnapshot,
  initializeLibrary,
  inspectImport,
  listDocuments,
  listFolders,
  listHistories,
  listInternalBackups,
  listTrash,
  moveToTrash,
  restoreFromTrash,
  restoreInternalBackup,
  saveDocument
} from '../src/library.js';
import { MEMO_FOLDER_ID } from '../src/constants.js';

Object.defineProperties(globalThis, {
  indexedDB: { value: new IDBFactory(), configurable: true },
  IDBKeyRange: { value: IDBKeyRange, configurable: true },
  navigator: {
    value: {
      storage: {
        persisted: async () => true,
        persist: async () => true,
        estimate: async () => ({ usage: 2048, quota: 1024 * 1024 })
      }
    },
    configurable: true
  }
});

test('書庫の並び・履歴・ゴミ箱・JSON往復で原稿を守る', async () => {
  await initializeLibrary();

  const first = await createDocument(MEMO_FOLDER_ID);
  const second = await createDocument(MEMO_FOLDER_ID);
  let memo = await getFolderSnapshot(MEMO_FOLDER_ID);
  assert.deepEqual(memo.documents.map((document) => document.id), [second.id, first.id]);

  await saveDocument(first.id, { title: '最初の原稿', body: '元の本文' });
  const root = await createFolder(null, '小説');
  const child = await createFolder(root.id, '第一部');
  await assert.rejects(() => createFolder(child.id, '第三階層'), /2階層まで/);
  const chapter = await createDocument(child.id);
  await saveDocument(chapter.id, { title: '第一章', body: '雨が降っていた。' });

  await moveToTrash('folder', root.id);
  assert.equal((await listTrash()).some((item) => item.id === root.id), true);
  assert.equal((await listDocuments()).some((document) => document.id === chapter.id), false);
  await restoreFromTrash('folder', root.id);
  assert.equal((await listFolders()).some((folder) => folder.id === child.id), true);
  assert.equal((await listDocuments()).find((document) => document.id === chapter.id)?.folderId, child.id);

  const exported = await buildExport('library');
  assert.equal(exported.sourceApp, 'kaishi');
  assert.equal(exported.exportScope, 'library');
  assert.ok(exported.projectId);
  await assert.rejects(() => applyImport({ ...exported, exportScope: 'file' }, { mode: 'replace' }), /書庫全体/);
  const incoming = structuredClone(exported);
  const incomingDocument = incoming.documents.find((document) => document.id === first.id);
  incomingDocument.body = '文机で直した本文';
  incomingDocument.revision += 2;
  incomingDocument.updatedAt = new Date(Date.now() + 1000).toISOString();
  await saveDocument(first.id, { body: 'iPhoneで直した本文' });

  const inspection = await inspectImport(incoming);
  assert.equal(inspection.conflicts.some((conflict) => conflict.incoming.id === first.id), true);
  const report = await applyImport(incoming, { mode: 'merge', resolutions: { [first.id]: 'both' } });
  assert.equal(report.duplicated, 1);
  assert.equal((await listDocuments()).some((document) => document.title.includes('読み込み')), true);

  await moveToTrash('document', second.id);
  assert.equal((await listHistories(second.id)).length > 0, true);
  const restored = await restoreFromTrash('document', second.id);
  assert.equal(restored.item.folderId, MEMO_FOLDER_ID);

  const checkpoint = await createInternalBackup('試験用の保護記録');
  await saveDocument(first.id, { body: '復元後には消える変更' });
  await restoreInternalBackup(checkpoint.id);
  assert.equal((await listDocuments()).find((document) => document.id === first.id)?.body, 'iPhoneで直した本文');
  assert.equal((await listInternalBackups()).length <= 5, true);
});
