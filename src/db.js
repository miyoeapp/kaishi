import { DB_NAME, DB_VERSION, STORE_NAMES } from './constants.js';

let databasePromise;

function requestToPromise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('端末内データを読み書きできませんでした。'));
  });
}

function createStore(database, name, options = { keyPath: 'id' }) {
  if (database.objectStoreNames.contains(name)) return null;
  return database.createObjectStore(name, options);
}

export function openDatabase() {
  if (databasePromise) return databasePromise;
  databasePromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      const documents = createStore(database, STORE_NAMES.documents);
      documents?.createIndex('folderId', 'folderId', { unique: false });
      documents?.createIndex('updatedAt', 'updatedAt', { unique: false });
      const folders = createStore(database, STORE_NAMES.folders);
      folders?.createIndex('parentId', 'parentId', { unique: false });
      const histories = createStore(database, STORE_NAMES.histories);
      histories?.createIndex('documentId', 'documentId', { unique: false });
      histories?.createIndex('createdAt', 'createdAt', { unique: false });
      createStore(database, STORE_NAMES.stickies);
      createStore(database, STORE_NAMES.settings);
      createStore(database, STORE_NAMES.meta);
      createStore(database, STORE_NAMES.backups);
    };
    request.onsuccess = () => {
      const database = request.result;
      database.onversionchange = () => database.close();
      resolve(database);
    };
    request.onerror = () => {
      databasePromise = null;
      reject(request.error ?? new Error('懐紙の保存場所を開けませんでした。'));
    };
    request.onblocked = () => reject(new Error('別の画面が保存場所の更新を妨げています。'));
  });
  return databasePromise;
}

async function storeFor(name, mode = 'readonly') {
  const database = await openDatabase();
  const transaction = database.transaction(name, mode);
  return { store: transaction.objectStore(name), transaction };
}

function transactionDone(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error('保存処理に失敗しました。'));
    transaction.onabort = () => reject(transaction.error ?? new Error('保存処理が中断されました。'));
  });
}

export async function getItem(storeName, id) {
  const { store } = await storeFor(storeName);
  return requestToPromise(store.get(id));
}

export async function getAll(storeName) {
  const { store } = await storeFor(storeName);
  return requestToPromise(store.getAll());
}

export async function getAllByIndex(storeName, indexName, query) {
  const { store } = await storeFor(storeName);
  return requestToPromise(store.index(indexName).getAll(query));
}

export async function putItem(storeName, value) {
  const { store, transaction } = await storeFor(storeName, 'readwrite');
  store.put(value);
  await transactionDone(transaction);
  return value;
}

export async function putMany(storeName, values) {
  if (!values.length) return;
  const { store, transaction } = await storeFor(storeName, 'readwrite');
  values.forEach((value) => store.put(value));
  await transactionDone(transaction);
}

export async function deleteItem(storeName, id) {
  const { store, transaction } = await storeFor(storeName, 'readwrite');
  store.delete(id);
  await transactionDone(transaction);
}

export async function deleteMany(storeName, ids) {
  if (!ids.length) return;
  const { store, transaction } = await storeFor(storeName, 'readwrite');
  ids.forEach((id) => store.delete(id));
  await transactionDone(transaction);
}

export async function clearStore(storeName) {
  const { store, transaction } = await storeFor(storeName, 'readwrite');
  store.clear();
  await transactionDone(transaction);
}

export async function commitStoreChanges({ clear = [], deletes = {}, puts = {} }) {
  const names = [...new Set([...clear, ...Object.keys(deletes), ...Object.keys(puts)])];
  if (!names.length) return;
  const database = await openDatabase();
  const transaction = database.transaction(names, 'readwrite');
  try {
    clear.forEach((name) => transaction.objectStore(name).clear());
    Object.entries(deletes).forEach(([name, ids]) => {
      const store = transaction.objectStore(name);
      ids.forEach((id) => store.delete(id));
    });
    Object.entries(puts).forEach(([name, values]) => {
      const store = transaction.objectStore(name);
      values.forEach((value) => store.put(value));
    });
  } catch (error) {
    transaction.abort();
    throw error;
  }
  await transactionDone(transaction);
}

export async function requestPersistentStorage() {
  if (!navigator.storage?.persist) return false;
  try {
    if (await navigator.storage.persisted?.()) return true;
    return Boolean(await navigator.storage.persist());
  } catch {
    return false;
  }
}

export async function estimateStorage() {
  try {
    const estimate = await navigator.storage?.estimate?.();
    return { usage: estimate?.usage ?? 0, quota: estimate?.quota ?? 0 };
  } catch {
    return { usage: 0, quota: 0 };
  }
}
