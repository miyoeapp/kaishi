import {
  APP_NAME, APP_VERSION, BACKUP_REMINDER_DAYS, DEFAULT_SETTINGS, MAX_FILE_HISTORIES,
  MAX_LIBRARY_BACKUPS, MEMO_FOLDER_ID, SCHEMA_VERSION, STORE_NAMES, TRASH_DAYS
} from './constants.js';
import {
  commitStoreChanges, deleteItem, deleteMany, getAll, getAllByIndex, getItem, putItem, putMany,
  requestPersistentStorage
} from './db.js';
import {
  countCharacters, createId, daysBetween, deepClone, isSameLocalDate, nextTopOrder,
  nowIso, safeFileName, sortByOrder, timestampForFile
} from './utils.js';

function active(item) { return item && !item.deletedAt; }

async function markChanged() {
  const settings = await getSettings();
  await putItem(STORE_NAMES.settings, { ...settings, changedSinceBackup: true });
}

export async function initializeLibrary() {
  const now = nowIso();
  const memo = await getItem(STORE_NAMES.folders, MEMO_FOLDER_ID);
  if (!memo) {
    await putItem(STORE_NAMES.folders, {
      id: MEMO_FOLDER_ID, name: 'メモ', color: 'gray', parentId: null,
      order: 0, createdAt: now, updatedAt: now, revision: 1, system: true
    });
  }
  const settings = await getItem(STORE_NAMES.settings, DEFAULT_SETTINGS.id);
  if (!settings) await putItem(STORE_NAMES.settings, { ...DEFAULT_SETTINGS });
  const meta = await getItem(STORE_NAMES.meta, 'library');
  if (!meta) {
    await putItem(STORE_NAMES.meta, {
      id: 'library', libraryId: createId('library'), schemaVersion: SCHEMA_VERSION,
      createdAt: now, updatedAt: now, appVersion: APP_VERSION
    });
  }
  await requestPersistentStorage();
  await purgeExpiredTrash();
}

export async function getSettings() {
  return { ...DEFAULT_SETTINGS, ...(await getItem(STORE_NAMES.settings, DEFAULT_SETTINGS.id) ?? {}) };
}

export async function saveSettings(patch, { markLibraryChanged = false } = {}) {
  const current = await getSettings();
  const next = { ...current, ...patch, id: DEFAULT_SETTINGS.id };
  await putItem(STORE_NAMES.settings, next);
  if (markLibraryChanged && patch.changedSinceBackup !== false) await markChanged();
  return next;
}

export async function listFolders({ includeDeleted = false } = {}) {
  const folders = await getAll(STORE_NAMES.folders);
  return includeDeleted ? folders : folders.filter(active);
}

export async function listDocuments({ includeDeleted = false } = {}) {
  const documents = await getAll(STORE_NAMES.documents);
  return includeDeleted ? documents : documents.filter(active);
}

export async function listStickies() {
  return sortByOrder(await getAll(STORE_NAMES.stickies));
}

export async function getFolder(id) { return getItem(STORE_NAMES.folders, id); }
export async function getDocument(id) { return getItem(STORE_NAMES.documents, id); }

export async function getFolderPath(folderId, foldersInput) {
  const folders = foldersInput ?? await listFolders({ includeDeleted: true });
  const map = new Map(folders.map((folder) => [folder.id, folder]));
  const names = [];
  const seen = new Set();
  let current = map.get(folderId);
  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    names.unshift(current.name);
    current = current.parentId ? map.get(current.parentId) : null;
  }
  return names.join(' ＞ ') || 'メモ';
}

export async function getHomeSnapshot() {
  const [folders, documents, stickies, settings] = await Promise.all([
    listFolders(), listDocuments(), listStickies(), getSettings()
  ]);
  const roots = sortByOrder(folders.filter((folder) => folder.parentId === null));
  const recent = [...documents].sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt))).slice(0, 5);
  const counts = new Map();
  for (const folder of folders) {
    if (folder.parentId) counts.set(folder.parentId, (counts.get(folder.parentId) ?? 0) + 1);
  }
  for (const document of documents) counts.set(document.folderId, (counts.get(document.folderId) ?? 0) + 1);
  return { folders, roots, documents, recent, stickies, settings, counts };
}

export async function getFolderSnapshot(folderId) {
  const [folder, folders, documents] = await Promise.all([
    getFolder(folderId), listFolders(), listDocuments()
  ]);
  if (!active(folder)) throw new Error('このフォルダは見つかりません。');
  return {
    folder,
    childFolders: sortByOrder(folders.filter((item) => item.parentId === folderId)),
    documents: sortByOrder(documents.filter((item) => item.folderId === folderId)),
    folders
  };
}

async function uniqueDocumentTitle(base, folderId, exceptId = null) {
  const documents = (await listDocuments()).filter((doc) => doc.folderId === folderId && doc.id !== exceptId);
  const title = String(base || '無題').trim() || '無題';
  if (!documents.some((doc) => doc.title === title)) return title;
  let number = 2;
  while (documents.some((doc) => doc.title === `${title} ${number}`)) number += 1;
  return `${title} ${number}`;
}

async function uniqueFolderName(base, parentId, exceptId = null) {
  const folders = (await listFolders()).filter((folder) => folder.parentId === parentId && folder.id !== exceptId);
  const name = String(base || '新しいフォルダ').trim() || '新しいフォルダ';
  if (!folders.some((folder) => folder.name === name)) return name;
  let number = 2;
  while (folders.some((folder) => folder.name === `${name} ${number}`)) number += 1;
  return `${name} ${number}`;
}

export async function createDocument(folderId = MEMO_FOLDER_ID, type = 'markdown') {
  const target = active(await getFolder(folderId)) ? folderId : MEMO_FOLDER_ID;
  const peers = (await listDocuments()).filter((doc) => doc.folderId === target);
  const now = nowIso();
  const document = {
    id: createId('doc'), title: await uniqueDocumentTitle('無題', target), body: '',
    type, folderId: target, color: 'gray', order: nextTopOrder(peers),
    createdAt: now, updatedAt: now, revision: 1, lastSharedRevision: 0
  };
  await putItem(STORE_NAMES.documents, document);
  await markChanged();
  return document;
}

export async function saveDocument(id, patch, { incrementRevision = true } = {}) {
  const current = await getDocument(id);
  if (!active(current)) throw new Error('保存する原稿が見つかりません。');
  const title = patch.title !== undefined
    ? await uniqueDocumentTitle(patch.title, patch.folderId ?? current.folderId, id)
    : current.title;
  const next = {
    ...current, ...patch, title, id,
    updatedAt: nowIso(),
    revision: incrementRevision ? (current.revision ?? 0) + 1 : current.revision
  };
  await putItem(STORE_NAMES.documents, next);
  await markChanged();
  return next;
}

export async function moveDocument(id, folderId) {
  const document = await getDocument(id);
  const target = await getFolder(folderId);
  if (!active(document) || !active(target)) throw new Error('移動先を確認できません。');
  const peers = (await listDocuments()).filter((doc) => doc.folderId === folderId);
  return saveDocument(id, {
    folderId,
    order: nextTopOrder(peers),
    title: await uniqueDocumentTitle(document.title, folderId, id)
  });
}

export async function createFolder(parentId = null, name = '新しいフォルダ', color = 'gray') {
  if (parentId) {
    const parent = await getFolder(parentId);
    if (!active(parent) || parent.parentId) throw new Error('フォルダは2階層までです。');
  }
  const peers = (await listFolders()).filter((folder) => folder.parentId === parentId);
  const now = nowIso();
  const folder = {
    id: createId('folder'), name: await uniqueFolderName(name, parentId), color, parentId,
    order: nextTopOrder(peers), createdAt: now, updatedAt: now, revision: 1
  };
  await putItem(STORE_NAMES.folders, folder);
  await markChanged();
  return folder;
}

export async function updateFolder(id, patch) {
  const current = await getFolder(id);
  if (!active(current)) throw new Error('フォルダが見つかりません。');
  const safePatch = { ...patch };
  if (current.system) {
    delete safePatch.name;
    delete safePatch.parentId;
  }
  if (safePatch.name !== undefined) safePatch.name = await uniqueFolderName(safePatch.name, current.parentId, id);
  const next = { ...current, ...safePatch, id, updatedAt: nowIso(), revision: (current.revision ?? 0) + 1 };
  await putItem(STORE_NAMES.folders, next);
  await markChanged();
  return next;
}

export async function moveFolder(id, parentId) {
  const folder = await getFolder(id);
  if (!active(folder) || folder.system) throw new Error('このフォルダは移動できません。');
  if (id === parentId) throw new Error('自分自身の中には移動できません。');
  const allFolders = await listFolders();
  const children = allFolders.filter((item) => item.parentId === id);
  if (parentId) {
    const parent = allFolders.find((item) => item.id === parentId);
    if (!parent || parent.parentId) throw new Error('3階層目になる場所へは移動できません。');
    if (children.length) throw new Error('下位フォルダがあるため、別のフォルダの中へは移動できません。');
  }
  const peers = allFolders.filter((item) => item.parentId === parentId && item.id !== id);
  return updateFolder(id, {
    parentId,
    order: nextTopOrder(peers),
    name: await uniqueFolderName(folder.name, parentId, id)
  });
}

export async function saveSticky({ id, text, color = 'yellow' }) {
  const current = id ? await getItem(STORE_NAMES.stickies, id) : null;
  const now = nowIso();
  const sticky = current ? {
    ...current, text: String(text).trim(), color, updatedAt: now, revision: (current.revision ?? 0) + 1
  } : {
    id: createId('sticky'), text: String(text).trim(), color,
    order: nextTopOrder(await listStickies()), createdAt: now, updatedAt: now, revision: 1
  };
  await putItem(STORE_NAMES.stickies, sticky);
  await markChanged();
  return sticky;
}

export async function deleteSticky(id) {
  await deleteItem(STORE_NAMES.stickies, id);
  await markChanged();
}

export async function reorderItems(storeName, ids) {
  const items = await getAll(storeName);
  const map = new Map(items.map((item) => [item.id, item]));
  const changed = ids.map((id, order) => ({ ...map.get(id), order })).filter(Boolean);
  await putMany(storeName, changed);
  await markChanged();
}

export async function createHistory(documentId, reason = '自動履歴') {
  const document = await getDocument(documentId);
  if (!document) return null;
  const history = {
    id: createId('history'), documentId, title: document.title, body: document.body,
    type: document.type, color: document.color, folderId: document.folderId,
    characterCount: countCharacters(document.body), reason, createdAt: nowIso()
  };
  await putItem(STORE_NAMES.histories, history);
  const histories = (await getAllByIndex(STORE_NAMES.histories, 'documentId', documentId))
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  await deleteMany(STORE_NAMES.histories, histories.slice(MAX_FILE_HISTORIES).map((item) => item.id));
  return history;
}

export async function listHistories(documentId) {
  return (await getAllByIndex(STORE_NAMES.histories, 'documentId', documentId))
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

export async function restoreHistory(historyId) {
  const history = await getItem(STORE_NAMES.histories, historyId);
  if (!history) throw new Error('履歴が見つかりません。');
  await createHistory(history.documentId, '復元直前');
  return saveDocument(history.documentId, { body: history.body, title: history.title, type: history.type });
}

export async function duplicateHistory(historyId) {
  const history = await getItem(STORE_NAMES.histories, historyId);
  if (!history) throw new Error('履歴が見つかりません。');
  const document = await createDocument(history.folderId, history.type);
  const date = new Date(history.createdAt);
  const suffix = `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日の履歴`;
  return saveDocument(document.id, { title: `${history.title}（${suffix}）`, body: history.body, color: history.color });
}

async function descendantFolderIds(rootId, folders) {
  const ids = new Set([rootId]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const folder of folders) {
      if (folder.parentId && ids.has(folder.parentId) && !ids.has(folder.id)) {
        ids.add(folder.id); changed = true;
      }
    }
  }
  return ids;
}

export async function moveToTrash(kind, id) {
  const now = nowIso();
  if (kind === 'document') {
    const document = await getDocument(id);
    if (!active(document)) return;
    await createHistory(id, 'ゴミ箱へ移動する前');
    await putItem(STORE_NAMES.documents, {
      ...document, deletedAt: now, trashRoot: true,
      originalFolderId: document.folderId, originalOrder: document.order
    });
  } else {
    const root = await getFolder(id);
    if (!active(root) || root.system) throw new Error('このフォルダは削除できません。');
    await createInternalBackup('フォルダをゴミ箱へ移す前');
    const folders = await listFolders();
    const ids = await descendantFolderIds(id, folders);
    const documents = await listDocuments();
    await commitStoreChanges({ puts: {
      [STORE_NAMES.folders]: folders.filter((folder) => ids.has(folder.id)).map((folder) => ({
        ...folder, deletedAt: now, trashRoot: folder.id === id,
        originalParentId: folder.parentId, originalOrder: folder.order
      })),
      [STORE_NAMES.documents]: documents.filter((doc) => ids.has(doc.folderId)).map((doc) => ({
        ...doc, deletedAt: now, trashRoot: false,
        originalFolderId: doc.folderId, originalOrder: doc.order
      }))
    } });
  }
  await markChanged();
}

export async function listTrash() {
  const [documents, folders] = await Promise.all([
    listDocuments({ includeDeleted: true }), listFolders({ includeDeleted: true })
  ]);
  return [
    ...documents.filter((item) => item.deletedAt && item.trashRoot).map((item) => ({ ...item, kind: 'document' })),
    ...folders.filter((item) => item.deletedAt && item.trashRoot).map((item) => ({ ...item, kind: 'folder' }))
  ].sort((a, b) => String(b.deletedAt).localeCompare(String(a.deletedAt)));
}

export async function restoreFromTrash(kind, id, { restoreFolder = true } = {}) {
  const folders = await listFolders({ includeDeleted: true });
  if (kind === 'document') {
    const document = await getDocument(id);
    if (!document?.deletedAt) return null;
    let folderId = document.originalFolderId;
    const original = folders.find((folder) => folder.id === folderId);
    if (original?.deletedAt && restoreFolder) await restoreFromTrash('folder', original.id);
    const resolved = await getFolder(folderId);
    if (!active(resolved)) folderId = MEMO_FOLDER_ID;
    const restored = {
      ...document, folderId, order: document.originalOrder ?? 0,
      deletedAt: null, trashRoot: false, updatedAt: nowIso()
    };
    await putItem(STORE_NAMES.documents, restored);
    await markChanged();
    return { item: restored, fallbackToMemo: folderId === MEMO_FOLDER_ID && document.originalFolderId !== MEMO_FOLDER_ID };
  }
  const root = folders.find((folder) => folder.id === id);
  if (!root?.deletedAt) return null;
  const ids = await descendantFolderIds(id, folders);
  const documents = await listDocuments({ includeDeleted: true });
  let parentId = root.originalParentId ?? null;
  if (parentId) {
    const parent = folders.find((folder) => folder.id === parentId);
    if (parent?.deletedAt) await restoreFromTrash('folder', parent.id);
    if (!active(await getFolder(parentId))) parentId = null;
  }
  await commitStoreChanges({ puts: {
    [STORE_NAMES.folders]: folders.filter((folder) => ids.has(folder.id)).map((folder) => ({
      ...folder,
      parentId: folder.id === id ? parentId : (folder.originalParentId ?? folder.parentId),
      order: folder.originalOrder ?? folder.order,
      deletedAt: null, trashRoot: false, updatedAt: nowIso()
    })),
    [STORE_NAMES.documents]: documents.filter((doc) => ids.has(doc.originalFolderId ?? doc.folderId)).map((doc) => ({
      ...doc, folderId: doc.originalFolderId ?? doc.folderId,
      order: doc.originalOrder ?? doc.order, deletedAt: null, trashRoot: false, updatedAt: nowIso()
    }))
  } });
  await markChanged();
  return { item: await getFolder(id), fallbackToMemo: false };
}

export async function permanentlyDelete(kind, id) {
  if (kind === 'document') {
    const histories = await listHistories(id);
    await commitStoreChanges({ deletes: {
      [STORE_NAMES.histories]: histories.map((item) => item.id),
      [STORE_NAMES.documents]: [id]
    } });
  } else {
    const folders = await listFolders({ includeDeleted: true });
    const ids = await descendantFolderIds(id, folders);
    const documents = (await listDocuments({ includeDeleted: true })).filter((doc) => ids.has(doc.folderId) || ids.has(doc.originalFolderId));
    const histories = await Promise.all(documents.map((document) => listHistories(document.id)));
    await commitStoreChanges({ deletes: {
      [STORE_NAMES.histories]: histories.flat().map((item) => item.id),
      [STORE_NAMES.documents]: documents.map((item) => item.id),
      [STORE_NAMES.folders]: [...ids]
    } });
  }
  await markChanged();
}

export async function emptyTrash() {
  const items = await listTrash();
  for (const item of items) await permanentlyDelete(item.kind, item.id);
}

export async function purgeExpiredTrash() {
  const items = await listTrash();
  for (const item of items) {
    if (daysBetween(item.deletedAt) >= TRASH_DAYS) await permanentlyDelete(item.kind, item.id);
  }
}

async function snapshotLibrary() {
  const [meta, folders, documents, stickies, settings, histories] = await Promise.all([
    getItem(STORE_NAMES.meta, 'library'), listFolders({ includeDeleted: true }),
    listDocuments({ includeDeleted: true }), getAll(STORE_NAMES.stickies), getSettings(),
    getAll(STORE_NAMES.histories)
  ]);
  return { meta, folders, documents, stickies, settings, histories };
}

export async function createInternalBackup(reason) {
  const backup = { id: createId('backup'), reason, createdAt: nowIso(), data: await snapshotLibrary() };
  await putItem(STORE_NAMES.backups, backup);
  const backups = (await getAll(STORE_NAMES.backups)).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  await deleteMany(STORE_NAMES.backups, backups.slice(MAX_LIBRARY_BACKUPS).map((item) => item.id));
  return backup;
}

export async function listInternalBackups() {
  return (await getAll(STORE_NAMES.backups))
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

export async function restoreInternalBackup(id) {
  const backup = await getItem(STORE_NAMES.backups, id);
  if (!backup?.data) throw new Error('自動保護の記録が見つかりません。');
  await createInternalBackup('自動保護から戻す直前');
  const data = backup.data;
  const settings = { ...DEFAULT_SETTINGS, ...(data.settings ?? {}), id: DEFAULT_SETTINGS.id, changedSinceBackup: true };
  await commitStoreChanges({
    clear: [
      STORE_NAMES.documents, STORE_NAMES.folders, STORE_NAMES.stickies,
      STORE_NAMES.histories, STORE_NAMES.settings, STORE_NAMES.meta
    ],
    puts: {
      [STORE_NAMES.documents]: data.documents ?? [],
      [STORE_NAMES.folders]: data.folders ?? [],
      [STORE_NAMES.stickies]: data.stickies ?? [],
      [STORE_NAMES.histories]: data.histories ?? [],
      [STORE_NAMES.settings]: [settings],
      [STORE_NAMES.meta]: data.meta ? [data.meta] : []
    }
  });
  await initializeLibrary();
  return backup;
}

export async function buildExport(scope = 'library', rootId = null) {
  const snapshot = await snapshotLibrary();
  let folders = snapshot.folders;
  let documents = snapshot.documents;
  let stickies = snapshot.stickies;
  if (scope === 'document') {
    const document = documents.find((item) => item.id === rootId && !item.deletedAt);
    if (!document) throw new Error('書き出す原稿が見つかりません。');
    const ids = new Set();
    let folder = folders.find((item) => item.id === document.folderId);
    while (folder) {
      ids.add(folder.id);
      folder = folder.parentId ? folders.find((item) => item.id === folder.parentId) : null;
    }
    documents = [document]; folders = folders.filter((item) => ids.has(item.id) && !item.deletedAt); stickies = [];
  } else if (scope === 'folder') {
    const activeFolders = folders.filter((item) => !item.deletedAt);
    const ids = await descendantFolderIds(rootId, activeFolders);
    folders = activeFolders.filter((item) => ids.has(item.id));
    documents = documents.filter((item) => !item.deletedAt && ids.has(item.folderId)); stickies = [];
  }
  const payload = {
    format: 'kaishi-common-json', schemaVersion: SCHEMA_VERSION,
    projectId: snapshot.meta?.libraryId, exportedAt: nowIso(), appVersion: APP_VERSION,
    sourceApp: 'kaishi', exportScope: scope === 'document' ? 'file' : scope,
    exportedRootIds: rootId ? [rootId] : [],
    folders: deepClone(folders), documents: deepClone(documents), stickies: deepClone(stickies),
    settings: scope === 'library' ? deepClone(snapshot.settings) : undefined
  };
  return payload;
}

export function validateImport(payload) {
  const recognized = payload?.format === 'kaishi-common-json'
    || ['kaishi', 'fuzukue'].includes(payload?.sourceApp);
  if (!recognized) throw new Error('懐紙・文机用のJSONではありません。');
  if (!Number.isInteger(payload.schemaVersion) || payload.schemaVersion > SCHEMA_VERSION) {
    throw new Error('このJSONは、現在の懐紙より新しい形式です。懐紙を更新してください。');
  }
  if (!Array.isArray(payload.documents) || !Array.isArray(payload.folders)) throw new Error('JSONの中身が途中で欠けています。');
  if (payload.documents.some((item) => !item || typeof item.id !== 'string' || typeof item.body !== 'string')
    || payload.folders.some((item) => !item || typeof item.id !== 'string')) {
    throw new Error('JSON内の原稿またはフォルダ情報が壊れています。');
  }
  const exportScope = payload.exportScope ?? (payload.scope === 'document' ? 'file' : payload.scope);
  const scope = exportScope === 'file' ? 'document' : exportScope;
  if (!['document', 'folder', 'library'].includes(scope)) throw new Error('JSONの書き出し範囲を確認できません。');
  return {
    ...payload,
    projectId: payload.projectId ?? payload.libraryId,
    sourceApp: payload.sourceApp ?? (payload.app === APP_NAME ? 'kaishi' : payload.app),
    exportScope,
    scope
  };
}

export async function inspectImport(payloadInput) {
  const payload = validateImport(payloadInput);
  const [localDocuments, localFolders] = await Promise.all([
    listDocuments({ includeDeleted: true }), listFolders({ includeDeleted: true })
  ]);
  const localMap = new Map(localDocuments.map((item) => [item.id, item]));
  const conflicts = payload.documents.filter((incoming) => {
    const local = localMap.get(incoming.id);
    return local && local.body !== incoming.body;
  }).map((incoming) => ({ incoming, local: localMap.get(incoming.id) }));
  const missingFolderIds = payload.documents
    .filter((doc) => doc.folderId
      && !localFolders.some((folder) => folder.id === doc.folderId && !folder.deletedAt)
      && !payload.folders.some((folder) => folder.id === doc.folderId && !folder.deletedAt))
    .map((doc) => doc.folderId);
  const incomingDocumentIds = new Set(payload.documents.map((item) => item.id));
  const incomingFolderIds = new Set(payload.folders.map((item) => item.id));
  const incomingStickyIds = new Set((payload.stickies ?? []).map((item) => item.id));
  const localStickies = await getAll(STORE_NAMES.stickies);
  return {
    payload,
    conflicts,
    missingFolderIds: [...new Set(missingFolderIds)],
    counts: {
      documents: payload.documents.length,
      folders: payload.folders.length,
      stickies: payload.stickies?.length ?? 0,
      added: payload.documents.filter((item) => !localMap.has(item.id)).length,
      updated: payload.documents.filter((item) => localMap.has(item.id)).length
    },
    replacementLoss: {
      documents: localDocuments.filter((item) => !item.deletedAt && !incomingDocumentIds.has(item.id)).length,
      folders: localFolders.filter((item) => !item.deletedAt && !incomingFolderIds.has(item.id)).length,
      stickies: localStickies.filter((item) => !incomingStickyIds.has(item.id)).length,
      trash: [...localDocuments, ...localFolders].filter((item) => item.deletedAt
        && !(item.title ? incomingDocumentIds : incomingFolderIds).has(item.id)).length
    }
  };
}

export async function applyImport(payloadInput, { mode = 'merge', resolutions = {} } = {}) {
  const payload = validateImport(payloadInput);
  if (mode === 'replace' && payload.scope !== 'library') throw new Error('書庫全体のJSONだけが復旧用の置き換えに使えます。');
  await createInternalBackup(mode === 'replace' ? '書庫置き換え直前' : 'JSON読み込み直前');
  const report = { added: 0, updated: 0, duplicated: 0, skipped: 0 };
  const [localFolders, localDocuments, localStickies, localHistories, currentSettings] = await Promise.all([
    listFolders({ includeDeleted: true }), listDocuments({ includeDeleted: true }),
    getAll(STORE_NAMES.stickies), getAll(STORE_NAMES.histories), getSettings()
  ]);
  const folderMap = new Map((mode === 'replace' ? [] : localFolders).map((folder) => [folder.id, deepClone(folder)]));
  for (const incomingRaw of payload.folders) {
    const incoming = { ...incomingRaw, deletedAt: incomingRaw.deletedAt ?? null };
    const local = folderMap.get(incoming.id);
    if (!local) {
      const peers = [...folderMap.values()]
        .filter((folder) => folder.parentId === incoming.parentId && !folder.deletedAt);
      incoming.order = nextTopOrder(peers);
      folderMap.set(incoming.id, incoming);
    } else if (String(incoming.updatedAt ?? '') > String(local.updatedAt ?? '')) {
      folderMap.set(incoming.id, { ...local, ...incoming });
    }
  }
  if (!folderMap.has(MEMO_FOLDER_ID)) {
    const now = nowIso();
    folderMap.set(MEMO_FOLDER_ID, {
      id: MEMO_FOLDER_ID, name: 'メモ', color: 'gray', parentId: null, order: 0,
      createdAt: now, updatedAt: now, revision: 1, system: true
    });
  }
  folderMap.set(MEMO_FOLDER_ID, {
    ...folderMap.get(MEMO_FOLDER_ID), id: MEMO_FOLDER_ID, name: 'メモ',
    parentId: null, system: true, deletedAt: null
  });
  folderMap.forEach((folder, id) => {
    if (id === MEMO_FOLDER_ID || !folder.parentId) return;
    const parent = folderMap.get(folder.parentId);
    if (!parent || parent.deletedAt || parent.id === id || parent.parentId) {
      folderMap.set(id, { ...folder, parentId: null });
    }
  });
  const documentMap = new Map((mode === 'replace' ? [] : localDocuments).map((document) => [document.id, deepClone(document)]));
  const histories = mode === 'replace' ? [] : deepClone(localHistories);
  const uniqueImportedTitle = (base, folderId) => {
    const titleBase = String(base || '無題').trim() || '無題';
    const titles = new Set([...documentMap.values()].filter((item) => !item.deletedAt && item.folderId === folderId).map((item) => item.title));
    if (!titles.has(titleBase)) return titleBase;
    let number = 2;
    while (titles.has(`${titleBase} ${number}`)) number += 1;
    return `${titleBase} ${number}`;
  };
  for (const incomingRaw of payload.documents) {
    const incoming = deepClone(incomingRaw);
    if (folderMap.get(incoming.folderId)?.deletedAt || !folderMap.has(incoming.folderId)) incoming.folderId = MEMO_FOLDER_ID;
    const local = documentMap.get(incoming.id);
    if (!local) {
      const peers = [...documentMap.values()].filter((doc) => !doc.deletedAt && doc.folderId === incoming.folderId);
      incoming.order = nextTopOrder(peers);
      documentMap.set(incoming.id, incoming);
      report.added += 1;
      continue;
    }
    if (local.body === incoming.body) {
      if (String(incoming.updatedAt ?? '') > String(local.updatedAt ?? '')) {
        documentMap.set(incoming.id, { ...local, ...incoming });
        report.updated += 1;
      } else report.skipped += 1;
      continue;
    }
    const resolution = resolutions[incoming.id] ?? 'both';
    if (resolution === 'local') { report.skipped += 1; continue; }
    if (resolution === 'incoming') {
      histories.push({
        id: createId('history'), documentId: local.id, title: local.title, body: local.body,
        type: local.type, color: local.color, folderId: local.folderId,
        characterCount: countCharacters(local.body), reason: 'JSON上書き直前', createdAt: nowIso()
      });
      documentMap.set(incoming.id, incoming);
      report.updated += 1;
      continue;
    }
    const duplicateId = createId('doc');
    const title = uniqueImportedTitle(`${incoming.title}（読み込み）`, incoming.folderId);
    const peers = [...documentMap.values()].filter((doc) => !doc.deletedAt && doc.folderId === incoming.folderId);
    documentMap.set(duplicateId, {
      ...incoming, id: duplicateId, title, revision: 1,
      order: nextTopOrder(peers), sourceDocumentId: incoming.id, createdAt: nowIso(), updatedAt: nowIso()
    });
    report.duplicated += 1;
  }
  const stickyMap = new Map((mode === 'replace' ? [] : localStickies).map((sticky) => [sticky.id, deepClone(sticky)]));
  let topOrder = nextTopOrder([...stickyMap.values()]);
  for (const sticky of payload.stickies ?? []) {
    const local = stickyMap.get(sticky.id);
    if (!local) stickyMap.set(sticky.id, { ...sticky, order: topOrder-- });
    else if (String(sticky.updatedAt ?? '') > String(local.updatedAt ?? '')) stickyMap.set(sticky.id, { ...local, ...sticky });
  }
  const limitedHistories = [];
  const historyGroups = new Map();
  histories.forEach((history) => {
    const group = historyGroups.get(history.documentId) ?? [];
    group.push(history); historyGroups.set(history.documentId, group);
  });
  historyGroups.forEach((group) => limitedHistories.push(...group
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))).slice(0, MAX_FILE_HISTORIES)));
  const settings = {
    ...DEFAULT_SETTINGS,
    ...(mode === 'replace' ? (payload.settings ?? {}) : currentSettings),
    id: DEFAULT_SETTINGS.id,
    changedSinceBackup: true
  };
  const storeNames = [
    STORE_NAMES.documents, STORE_NAMES.folders, STORE_NAMES.stickies,
    STORE_NAMES.histories, STORE_NAMES.settings
  ];
  await commitStoreChanges({
    clear: storeNames,
    puts: {
      [STORE_NAMES.documents]: [...documentMap.values()],
      [STORE_NAMES.folders]: [...folderMap.values()],
      [STORE_NAMES.stickies]: [...stickyMap.values()],
      [STORE_NAMES.histories]: limitedHistories,
      [STORE_NAMES.settings]: [settings]
    }
  });
  return report;
}

export async function markBackupSuccess() {
  return saveSettings({ lastBackupAt: nowIso(), changedSinceBackup: false, backupDismissedDate: null });
}

export async function shouldRemindBackup(settingsInput) {
  const settings = settingsInput ?? await getSettings();
  if (!settings.changedSinceBackup) return false;
  if (isSameLocalDate(settings.backupDismissedDate)) return false;
  const base = settings.lastBackupAt ?? (await getItem(STORE_NAMES.meta, 'library'))?.createdAt;
  return daysBetween(base) >= BACKUP_REMINDER_DAYS;
}

export async function dismissBackupForToday() {
  return saveSettings({ backupDismissedDate: nowIso() });
}

export function externalFileName(scope, title = '') {
  const stamp = timestampForFile();
  if (scope === 'document') return `懐紙_${safeFileName(title)}_${stamp}.json`;
  if (scope === 'folder') return `懐紙_${safeFileName(title)}_${stamp}.json`;
  return `懐紙_書庫全体_${stamp}.json`;
}
