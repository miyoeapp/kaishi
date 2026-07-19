import {
  APP_NAME, APP_VERSION, COLOR_MAP, COLORS, DOCUMENT_TYPES, MEMO_FOLDER_ID, STORE_NAMES, TRASH_DAYS
} from './constants.js';
import { estimateStorage } from './db.js';
import {
  applyImport, buildExport, createDocument, createFolder, createHistory, deleteSticky,
  dismissBackupForToday, duplicateHistory, emptyTrash, externalFileName, getDocument,
  getFolder, getFolderPath, getFolderSnapshot, getHomeSnapshot, getSettings, initializeLibrary,
  inspectImport, listDocuments, listFolders, listHistories, listInternalBackups, listTrash, markBackupSuccess,
  moveDocument, moveFolder, moveToTrash, permanentlyDelete, reorderItems, restoreFromTrash,
  restoreHistory, restoreInternalBackup, saveDocument, saveSettings, saveSticky, shouldRemindBackup, updateFolder
} from './library.js';
import { copyPlainText, copyRichText, fileFromText, readJsonFile, shareFile } from './io.js';
import { InstanceGuard } from './lock.js';
import { markdownToPlainText, renderMarkdown } from './markdown.js';
import { UndoManager } from './undo.js';
import {
  countCharacters, debounce, escapeHtml, formatDateTime, formatShortDate, safeFileName, timestampForFile
} from './utils.js';

const app = document.querySelector('#app');
const sheet = document.querySelector('#sheet');
const toast = document.querySelector('#toast');
const jsonInput = document.querySelector('#json-file-input');

export const runtime = {
  route: { name: 'home' },
  online: navigator.onLine,
  updateReady: false,
  updating: false,
  updateRegistration: null,
  guard: null,
  editor: null,
  importInspection: null,
  importFileName: '',
  pendingConflictIndex: 0,
  conflictResolutions: {},
  settings: null
};

const undoManager = new UndoManager(50);
let toastTimer;
let stopEditorViewportSync = () => {};

function isStandalone() {
  const local = ['localhost', '127.0.0.1'].includes(location.hostname);
  const dev = local && new URLSearchParams(location.search).get('dev') === '1';
  return dev || matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
}

function showToast(message, duration = 2600) {
  clearTimeout(toastTimer);
  toast.textContent = message;
  toast.hidden = false;
  toastTimer = setTimeout(() => { toast.hidden = true; }, duration);
}

function colorValue(id) { return COLOR_MAP[id] ?? COLOR_MAP.gray; }

function colorChoices(selected = 'gray', name = 'color') {
  return `<div class="color-choices" role="radiogroup" aria-label="色">
    ${COLORS.map((color) => `<button type="button" class="color-choice ${color.id === selected ? 'selected' : ''}" style="--choice-color:${color.value}" data-color-value="${color.id}" data-color-name="${name}" data-color-label="${color.label}" aria-pressed="${color.id === selected}">${color.id === selected ? '✓' : ''}<span class="sr-only">${color.label}</span></button>`).join('')}
  </div>`;
}

function applyAppearance(settings) {
  runtime.settings = settings;
  const root = document.documentElement;
  root.dataset.theme = settings.theme;
  root.style.setProperty('--editor-font-size', `${settings.fontSize}px`);
  root.style.setProperty('--editor-line-height', ({ compact: 1.65, standard: 1.9, wide: 2.15 })[settings.lineHeight] ?? 1.9);
  root.style.setProperty('--editor-margin', ({ compact: '12px', standard: '20px', wide: '30px' })[settings.pageMargin] ?? '20px');
  root.style.setProperty('--editor-font', settings.fontFamily === 'gothic' ? 'var(--font-sans)' : 'var(--font-mincho)');
}

function header({ title = '', subtitle = '', back = null, menu = null, extra = '', brand = false } = {}) {
  return `<header class="app-header">
    ${back ? `<button class="icon-button" data-action="${back}" aria-label="戻る">←</button>` : ''}
    ${brand ? `<h1 class="brand">懐紙</h1>` : `<h1 class="header-title"><span>${escapeHtml(title)}</span>${subtitle ? `<span class="save-state">${escapeHtml(subtitle)}</span>` : ''}</h1>`}
    ${extra}
    ${menu ? `<button class="icon-button" data-action="${menu}" aria-label="メニュー">…</button>` : ''}
  </header>`;
}

function setRoute(route) {
  runtime.route = { ...route };
  renderRoute().catch(handleFatal);
}

async function renderRoute() {
  closeSheet();
  clearEditorTimers();
  if (runtime.route.name === 'home') return renderHome();
  if (runtime.route.name === 'folder') return renderFolder(runtime.route.folderId);
  if (runtime.route.name === 'editor') return renderEditor(runtime.route.documentId);
  if (runtime.route.name === 'preview') return renderPreview(runtime.route.documentId);
  if (runtime.route.name === 'trash') return renderTrash();
  if (runtime.route.name === 'history') return renderHistory(runtime.route.documentId);
  if (runtime.route.name === 'settings') return renderSettings();
  if (runtime.route.name === 'about') return renderAbout();
  return renderHome();
}

function openSheet(title, content, { wide = false } = {}) {
  sheet.classList.toggle('wide', wide);
  sheet.innerHTML = `<div class="sheet-inner">
    <div class="sheet-handle" aria-hidden="true"></div>
    <div class="sheet-header"><h2 id="sheet-title">${escapeHtml(title)}</h2><button class="icon-button" data-sheet-close aria-label="閉じる">×</button></div>
    ${content}
  </div>`;
  if (!sheet.open) sheet.showModal();
}

function closeSheet() {
  if (sheet.open) sheet.close();
  sheet.innerHTML = '';
}

function renderInstall() {
  app.innerHTML = `<section class="install-screen">
    <div class="install-card">
      <img class="install-icon" src="./assets/apple-touch-icon.png" alt="懐紙のアイコン">
      <h1>懐紙</h1>
      <ol>
        <li>Safariの共有ボタン（四角から上向き矢印）を押す</li>
        <li>「ホーム画面に追加」を押す</li>
        <li>「Webアプリとして開く」を有効にして、右上の「追加」を押す</li>
      </ol>
      <p class="install-note">原稿の保存場所が二つに分かれないよう、執筆はホーム画面の懐紙だけで行います。このSafari画面では原稿を作成しません。</p>
    </div>
  </section>`;
}

async function boot() {
  registerServiceWorker();
  if (!isStandalone()) {
    renderInstall();
    return;
  }
  await initializeLibrary();
  applyAppearance(await getSettings());
  runtime.guard = new InstanceGuard({
    beforeRelinquish: async () => {
      await saveEditorNow({ quiet: true });
      if (runtime.editor?.failedError) throw runtime.editor.failedError;
    },
    onTakenOver: () => renderTakenOver()
  });
  if (!runtime.guard.start()) {
    renderInstanceConflict();
    return;
  }
  await renderHome();
}

async function registerServiceWorker() {
  if (!('serviceWorker' in navigator) || location.protocol === 'file:') return;
  try {
    const registration = await navigator.serviceWorker.register('./service-worker.js');
    runtime.updateRegistration = registration;
    if (registration.waiting && navigator.serviceWorker.controller) runtime.updateReady = true;
    registration.addEventListener('updatefound', () => {
      const worker = registration.installing;
      worker?.addEventListener('statechange', () => {
        if (worker.state === 'installed' && navigator.serviceWorker.controller) {
          runtime.updateReady = true;
          if (runtime.route.name === 'home') renderHome();
        }
      });
    });
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (runtime.updating) location.reload();
    });
  } catch {
    // オフライン本体の準備失敗は、オンライン利用を妨げず玄関で後から検査する。
  }
}

function renderInstanceConflict() {
  app.innerHTML = `<section class="install-screen"><div class="install-card">
    <h1 style="letter-spacing:0">別の画面で開いています</h1>
    <p>懐紙は、別の画面ですでに開かれています。同じ原稿を二つの画面から保存しないよう停止しています。</p>
    <div class="button-row"><button class="button primary" data-action="take-over">この画面で続ける</button><button class="button" data-action="stay-closed">ここでは開かない</button></div>
  </div></section>`;
}

function renderTakenOver() {
  clearEditorTimers();
  app.innerHTML = `<section class="install-screen"><div class="install-card">
    <h1 style="letter-spacing:0">別の画面へ切り替わりました</h1>
    <p>この画面での編集を停止しました。先ほど選んだ懐紙で続けてください。</p>
  </div></section>`;
}

async function renderHome() {
  const snapshot = await getHomeSnapshot();
  const reminder = await shouldRemindBackup(snapshot.settings);
  const folderMap = new Map(snapshot.folders.map((folder) => [folder.id, folder]));
  const pathFor = (folderId) => {
    const names = [];
    let current = folderMap.get(folderId);
    while (current) { names.unshift(current.name); current = current.parentId ? folderMap.get(current.parentId) : null; }
    return names.join(' ＞ ') || 'メモ';
  };
  app.innerHTML = `<section class="screen home-screen">
    ${header({ brand: true, menu: 'home-menu', extra: runtime.online ? '' : '<span class="offline-badge">オフライン</span>' })}
    ${runtime.updateReady ? `<div class="notice compact"><span>新しい版の懐紙を使えます</span><button class="small-button" data-action="apply-update">更新する</button><button class="small-button" data-action="dismiss-update">あとで</button></div>` : ''}
    ${reminder ? `<div class="notice compact"><span>そろそろ書庫のバックアップを作りますか？</span><button class="small-button" data-action="backup-library">今つくる</button><button class="small-button" data-action="dismiss-backup">今日は閉じる</button></div>` : ''}

    <div class="section-title-row"><h2 class="section-title">付箋</h2>${snapshot.stickies.length > 1 ? '<button class="small-button" data-action="reorder-stickies">並べ替え</button>' : ''}<button class="small-button" data-action="new-sticky">＋ 追加</button></div>
    ${snapshot.stickies.length ? `<div class="sticky-strip">${snapshot.stickies.map((sticky) => `<button class="sticky-card" style="background:${colorValue(sticky.color)}" data-action="edit-sticky" data-id="${sticky.id}">${escapeHtml(sticky.text)}<time>${formatShortDate(sticky.updatedAt)}</time></button>`).join('')}</div>` : '<div class="empty">付箋はまだありません</div>'}

    <div class="section-title-row"><h2 class="section-title">最近の原稿</h2></div>
    ${snapshot.recent.length ? `<div class="list">${snapshot.recent.map((doc) => documentRow(doc, `${pathFor(doc.folderId)} ・ ${formatShortDate(doc.updatedAt)}`)).join('')}</div>` : '<div class="empty">最近の原稿はまだありません</div>'}

    <div class="section-title-row"><h2 class="section-title">フォルダ</h2><button class="small-button" data-action="new-folder" data-parent-id="">＋ 作成</button></div>
    <div class="list">${snapshot.roots.map((folder) => folderRow(folder, `${snapshot.counts.get(folder.id) ?? 0}件`)).join('')}</div>
    <button class="fab" data-action="new-document" data-folder-id="${MEMO_FOLDER_ID}" aria-label="新しい原稿を書く">✎</button>
  </section>`;
}

function documentRow(doc, meta = '') {
  return `<button class="row-button" data-action="open-document" data-id="${doc.id}">
    <span class="color-bar" style="background:${colorValue(doc.color)}"></span>
    <span class="row-main"><span class="row-title">${escapeHtml(doc.title)}</span><span class="row-meta">${escapeHtml(meta || `${countCharacters(doc.body)}字 ・ ${formatShortDate(doc.updatedAt)}`)}</span></span>
    <span class="chevron">›</span>
  </button>`;
}

function folderRow(folder, meta = '') {
  return `<button class="row-button" data-action="open-folder" data-id="${folder.id}">
    <span class="folder-mark" style="--item-color:${colorValue(folder.color)}"></span>
    <span class="row-main"><span class="row-title">${escapeHtml(folder.name)}</span>${meta ? `<span class="row-meta">${escapeHtml(meta)}</span>` : ''}</span>
    <span class="chevron">›</span>
  </button>`;
}

async function renderFolder(folderId) {
  const snapshot = await getFolderSnapshot(folderId);
  const parentAction = snapshot.folder.parentId ? 'folder-back-parent' : 'go-home';
  app.innerHTML = `<section class="screen folder-screen">
    ${header({ title: snapshot.folder.name, back: parentAction, menu: 'folder-menu' })}
    <div class="section-title-row"><h2 class="section-title">下位フォルダ</h2></div>
    ${snapshot.childFolders.length ? `<div class="list">${snapshot.childFolders.map((folder) => folderRow(folder)).join('')}</div>` : '<div class="empty">下位フォルダはありません</div>'}
    <div class="section-title-row"><h2 class="section-title">原稿</h2></div>
    ${snapshot.documents.length ? `<div class="list">${snapshot.documents.map((doc) => documentRow(doc)).join('')}</div>` : `<div class="empty">まだ原稿がありません<br><button class="button primary" style="margin-top:12px" data-action="new-document" data-folder-id="${folderId}">新しい原稿を書く</button></div>`}
    <button class="fab" data-action="new-document" data-folder-id="${folderId}" aria-label="このフォルダに新しい原稿を書く">✎</button>
  </section>`;
}

function currentEditorSnapshot() {
  const textarea = document.querySelector('#editor');
  return textarea ? { value: textarea.value, start: textarea.selectionStart, end: textarea.selectionEnd } : null;
}

function clearEditorTimers() {
  stopEditorViewportSync();
  stopEditorViewportSync = () => {};
  document.documentElement.style.removeProperty('--editor-viewport-height');
  if (!runtime.editor) return;
  clearTimeout(runtime.editor.saveTimer);
  clearInterval(runtime.editor.historyTimer);
  runtime.editor.saveTimer = null;
  runtime.editor.historyTimer = null;
}

async function renderEditor(documentId) {
  const doc = await getDocument(documentId);
  if (!doc || doc.deletedAt) return setRoute({ name: 'home' });
  const previous = runtime.editor?.documentId === documentId ? runtime.editor : null;
  runtime.editor = {
    documentId,
    document: doc,
    composing: false,
    saveTimer: null,
    historyTimer: null,
    lastSavedBody: doc.body,
    lastHistoryBody: previous?.lastHistoryBody ?? doc.body,
    failedError: null,
    searchOpen: runtime.route.searchOpen ?? false,
    searchIndex: 0,
    searchMatches: [],
    returnRoute: runtime.route.returnRoute ?? previous?.returnRoute ?? { name: 'home' },
    scrollRatio: runtime.route.scrollRatio ?? 0
  };
  if (!previous) undoManager.clear();
  const toolbar = doc.type === 'markdown'
    ? `${toolButton('undo', '↶', '戻る')}${toolButton('redo', '↷', '進む')}${toolButton('markdown-menu', 'MD', 'Markdownの記法')}`
    : `${toolButton('undo', '↶', '戻る')}${toolButton('redo', '↷', '進む')}`;
  app.innerHTML = `<section class="screen editor-screen">
    ${header({ title: doc.title, subtitle: '保存済み', back: 'editor-back', menu: 'document-menu', extra: '<button class="icon-button" data-action="editor-new-document" aria-label="新しい原稿">✎</button>' })}
    <div id="save-error-slot"></div>
    <div class="editor-wrap">
      ${runtime.editor.searchOpen ? searchPanel() : ''}
      <textarea id="editor" class="editor" spellcheck="false" autocapitalize="off" autocomplete="off" aria-label="本文" placeholder="ここに書き始めます。">${escapeHtml(doc.body)}</textarea>
      <div class="editor-toolbar" aria-label="編集補助">${toolbar}</div>
    </div>
  </section>`;
  bindEditor();
}

function toolButton(action, label, aria = label) {
  return `<button class="tool-button" data-action="${action}" aria-label="${escapeHtml(aria)}">${escapeHtml(label)}</button>`;
}

function bindEditor() {
  const textarea = document.querySelector('#editor');
  if (!textarea || !runtime.editor) return;
  textarea.addEventListener('compositionstart', () => { runtime.editor.composing = true; });
  textarea.addEventListener('compositionend', () => { runtime.editor.composing = false; scheduleEditorSave(); });
  textarea.addEventListener('beforeinput', () => {
    if (!runtime.editor.composing) {
      const snapshot = currentEditorSnapshot();
      if (snapshot) undoManager.record(snapshot);
    }
  });
  textarea.addEventListener('input', () => {
    setSaveState('入力中');
    if (!runtime.editor.composing) scheduleEditorSave();
  });
  textarea.addEventListener('keydown', (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'z') {
      event.preventDefault();
      performUndo(event.shiftKey ? 'redo' : 'undo');
    }
  });
  runtime.editor.historyTimer = setInterval(async () => {
    await saveEditorNow({ quiet: true });
    const current = await getDocument(runtime.editor.documentId);
    if (current?.body !== runtime.editor.lastHistoryBody) {
      await createHistory(current.id, '10分ごとの履歴');
      runtime.editor.lastHistoryBody = current.body;
    }
  }, 10 * 60 * 1000);
  requestAnimationFrame(() => {
    if (runtime.editor.scrollRatio > 0) textarea.scrollTop = runtime.editor.scrollRatio * Math.max(0, textarea.scrollHeight - textarea.clientHeight);
    if (runtime.route.focus) textarea.focus();
  });
  if (runtime.editor.searchOpen) bindSearchPanel();
  bindEditorViewport();
  updateUndoButtons();
}

function bindEditorViewport() {
  stopEditorViewportSync();
  const viewport = window.visualViewport;
  const updateHeight = () => {
    const height = viewport?.height ?? window.innerHeight;
    if (height > 0) document.documentElement.style.setProperty('--editor-viewport-height', `${Math.round(height)}px`);
  };
  viewport?.addEventListener('resize', updateHeight);
  viewport?.addEventListener('scroll', updateHeight);
  window.addEventListener('resize', updateHeight);
  stopEditorViewportSync = () => {
    viewport?.removeEventListener('resize', updateHeight);
    viewport?.removeEventListener('scroll', updateHeight);
    window.removeEventListener('resize', updateHeight);
  };
  updateHeight();
}

function scheduleEditorSave() {
  if (!runtime.editor) return;
  clearTimeout(runtime.editor.saveTimer);
  runtime.editor.saveTimer = setTimeout(() => saveEditorNow(), 1000);
}

function setSaveState(text) {
  const element = document.querySelector('.save-state');
  if (element) element.textContent = text;
}

async function saveEditorNow({ quiet = false } = {}) {
  if (!runtime.editor) return null;
  const textarea = document.querySelector('#editor');
  if (!textarea || runtime.editor.composing) return runtime.editor.document;
  clearTimeout(runtime.editor.saveTimer);
  if (textarea.value === runtime.editor.lastSavedBody) return runtime.editor.document;
  if (!quiet) setSaveState('保存中…');
  try {
    const saved = await saveDocument(runtime.editor.documentId, { body: textarea.value });
    runtime.editor.document = saved;
    runtime.editor.lastSavedBody = saved.body;
    runtime.editor.failedError = null;
    document.querySelector('#save-error-slot')?.replaceChildren();
    setSaveState('保存済み');
    return saved;
  } catch (error) {
    runtime.editor.failedError = error;
    showSaveFailure(error);
    setSaveState('未保存');
    return null;
  }
}

function showSaveFailure(error) {
  const slot = document.querySelector('#save-error-slot');
  if (!slot) return;
  const reason = error?.name === 'QuotaExceededError' ? 'iPhoneの空き容量が不足しています。' : (error?.message || '原因を確認できませんでした。');
  slot.innerHTML = `<div class="notice danger"><strong>この原稿は、まだ保存できていません</strong><br><small>${escapeHtml(reason)} 安全な場所へ退避するまで、この画面を閉じないでください。</small><div class="button-row" style="margin-top:10px"><button class="button" data-action="retry-save">もう一度保存</button><button class="button" data-action="emergency-copy">本文をコピー</button><button class="button" data-action="emergency-file">ファイルとして退避</button></div></div>`;
}

function updateUndoButtons() {
  document.querySelector('[data-action="undo"]')?.toggleAttribute('disabled', !undoManager.canUndo);
  document.querySelector('[data-action="redo"]')?.toggleAttribute('disabled', !undoManager.canRedo);
}

async function prepareToLeaveEditor() {
  if (!runtime.editor) return true;
  const saved = await saveEditorNow();
  if (!saved && runtime.editor.failedError) {
    showToast('まだ保存できていないため、この画面に留まります。');
    return false;
  }
  if (saved.body !== runtime.editor.lastHistoryBody) {
    await createHistory(saved.id, '原稿を閉じた時');
    runtime.editor.lastHistoryBody = saved.body;
  }
  clearEditorTimers();
  runtime.editor = null;
  return true;
}

async function leaveEditor(targetRoute) {
  if (!(await prepareToLeaveEditor())) return false;
  setRoute(targetRoute);
  return true;
}

function applySnapshot(snapshot) {
  const textarea = document.querySelector('#editor');
  if (!textarea || !snapshot) return;
  textarea.value = snapshot.value;
  textarea.setSelectionRange(snapshot.start, snapshot.end);
  textarea.focus();
  setSaveState('入力中');
  scheduleEditorSave();
  updateUndoButtons();
}

function performUndo(direction) {
  const current = currentEditorSnapshot();
  if (!current) return;
  const target = direction === 'undo' ? undoManager.undo(current) : undoManager.redo(current);
  applySnapshot(target);
}

function replaceSelection(before, after = before, placeholder = '') {
  const textarea = document.querySelector('#editor');
  if (!textarea) return;
  const snapshot = currentEditorSnapshot();
  undoManager.record(snapshot);
  const selected = textarea.value.slice(textarea.selectionStart, textarea.selectionEnd) || placeholder;
  const replacement = `${before}${selected}${after}`;
  const start = textarea.selectionStart;
  textarea.setRangeText(replacement, textarea.selectionStart, textarea.selectionEnd, 'end');
  textarea.focus();
  if (!snapshot.value.slice(snapshot.start, snapshot.end)) textarea.setSelectionRange(start + before.length, start + before.length + selected.length);
  textarea.dispatchEvent(new Event('input', { bubbles: true }));
  updateUndoButtons();
}

function prefixSelectedLines(prefix) {
  const textarea = document.querySelector('#editor');
  if (!textarea) return;
  const snapshot = currentEditorSnapshot();
  undoManager.record(snapshot);
  const lineStart = textarea.value.lastIndexOf('\n', textarea.selectionStart - 1) + 1;
  const endBreak = textarea.value.indexOf('\n', textarea.selectionEnd);
  const lineEnd = endBreak === -1 ? textarea.value.length : endBreak;
  const selected = textarea.value.slice(lineStart, lineEnd);
  const replacement = selected.split('\n').map((line) => `${prefix}${line}`).join('\n');
  textarea.setRangeText(replacement, lineStart, lineEnd, 'end');
  textarea.focus();
  textarea.dispatchEvent(new Event('input', { bubbles: true }));
  updateUndoButtons();
}

function searchPanel() {
  return `<div class="search-panel">
    <div class="search-row"><input id="search-term" class="text-input" type="search" placeholder="探す言葉" aria-label="探す言葉"><span id="search-count" class="search-count">0／0件</span><button class="icon-button" data-action="close-search" aria-label="検索を閉じる">×</button></div>
    <div class="search-row"><button class="button" data-action="search-prev">前へ</button><button class="button" data-action="search-next">次へ</button><button class="button" data-action="show-replace">置換を開く</button></div>
    <div id="replace-row" hidden><div class="search-row"><input id="replace-term" class="text-input" placeholder="置き換え後の言葉" aria-label="置き換え後の言葉"></div><div class="search-row"><button class="button" data-action="replace-one">この1件を置換</button><button class="button" data-action="replace-all">すべて置換</button></div></div>
  </div>`;
}

function bindSearchPanel() {
  const input = document.querySelector('#search-term');
  input?.addEventListener('input', () => updateSearchMatches(0));
  setTimeout(() => input?.focus(), 0);
}

function updateSearchMatches(preferredIndex = null) {
  const textarea = document.querySelector('#editor');
  const term = document.querySelector('#search-term')?.value ?? '';
  if (!textarea || !runtime.editor) return;
  const matches = [];
  if (term) {
    let start = 0;
    while (start <= textarea.value.length) {
      const found = textarea.value.indexOf(term, start);
      if (found < 0) break;
      matches.push(found);
      start = found + Math.max(1, term.length);
    }
  }
  runtime.editor.searchMatches = matches;
  if (preferredIndex !== null) runtime.editor.searchIndex = Math.min(Math.max(0, preferredIndex), Math.max(0, matches.length - 1));
  if (runtime.editor.searchIndex >= matches.length) runtime.editor.searchIndex = 0;
  const count = document.querySelector('#search-count');
  if (count) count.textContent = matches.length ? `${runtime.editor.searchIndex + 1}／${matches.length}件` : '0／0件';
  if (matches.length) {
    const position = matches[runtime.editor.searchIndex];
    textarea.focus();
    textarea.setSelectionRange(position, position + term.length);
  }
}

function moveSearch(direction) {
  if (!runtime.editor?.searchMatches.length) return;
  const length = runtime.editor.searchMatches.length;
  runtime.editor.searchIndex = (runtime.editor.searchIndex + direction + length) % length;
  updateSearchMatches(runtime.editor.searchIndex);
}

async function replaceCurrentMatch() {
  const textarea = document.querySelector('#editor');
  const term = document.querySelector('#search-term')?.value ?? '';
  const replacement = document.querySelector('#replace-term')?.value ?? '';
  if (!textarea || !term || !runtime.editor.searchMatches.length) return;
  const position = runtime.editor.searchMatches[runtime.editor.searchIndex];
  undoManager.record(currentEditorSnapshot());
  textarea.setRangeText(replacement, position, position + term.length, 'end');
  textarea.dispatchEvent(new Event('input', { bubbles: true }));
  updateSearchMatches(runtime.editor.searchIndex);
}

async function replaceAllMatches() {
  const textarea = document.querySelector('#editor');
  const term = document.querySelector('#search-term')?.value ?? '';
  const replacement = document.querySelector('#replace-term')?.value ?? '';
  const count = runtime.editor?.searchMatches.length ?? 0;
  if (!textarea || !term || !count) return;
  if (!confirm(`${count}か所を置き換えます。`)) return;
  await saveEditorNow({ quiet: true });
  await createHistory(runtime.editor.documentId, '全置換直前');
  undoManager.record(currentEditorSnapshot());
  textarea.value = textarea.value.split(term).join(replacement);
  textarea.setSelectionRange(0, 0);
  textarea.dispatchEvent(new Event('input', { bubbles: true }));
  updateSearchMatches(0);
  showToast(`${count}か所を置き換えました。`);
}

async function renderPreview(documentId) {
  const doc = await getDocument(documentId);
  if (!doc || doc.deletedAt) return setRoute({ name: 'home' });
  const content = doc.type === 'markdown'
    ? renderMarkdown(doc.body)
    : `<div style="white-space:pre-wrap">${escapeHtml(doc.body)}</div>`;
  app.innerHTML = `<section class="screen preview-screen">
    ${header({ title: doc.title, back: 'preview-back' })}
    <article id="preview-content" class="preview-content">${content || '<p class="empty">本文はまだありません</p>'}</article>
    <button class="button primary preview-edit" data-action="preview-back">編集に戻る</button>
  </section>`;
  requestAnimationFrame(() => {
    const preview = document.querySelector('#preview-content');
    if (preview && runtime.route.scrollRatio) preview.scrollTop = runtime.route.scrollRatio * Math.max(0, preview.scrollHeight - preview.clientHeight);
  });
}

async function showHomeMenu() {
  openSheet('懐紙のメニュー', `<div class="sheet-list">
    <button class="menu-button" data-action="choose-json">JSONを読み込む<small>文机・バックアップから受け取る</small></button>
    <button class="menu-button" data-action="backup-library">書庫全体を書き出す<small>原稿・フォルダ・付箋・ゴミ箱をまとめる</small></button>
    <button class="menu-button" data-action="open-trash">ゴミ箱</button>
    <button class="menu-button" data-action="open-settings">表示設定</button>
    <button class="menu-button" data-action="open-about">懐紙について</button>
  </div>`);
}

async function showFolderMenu() {
  const { folder, childFolders, documents } = await getFolderSnapshot(runtime.route.folderId);
  openSheet(folder.name, `<p class="row-meta">原稿${documents.length}件・下位フォルダ${childFolders.length}件</p><div class="sheet-list">
    ${folder.parentId ? '' : `<button class="menu-button" data-action="new-folder" data-parent-id="${folder.id}">下位フォルダを作る</button>`}
    <button class="menu-button" data-action="edit-folder" data-id="${folder.id}">${folder.system ? '色を変更' : '名前・色を変更'}</button>
    <button class="menu-button" data-action="reorder-folder-items" data-id="${folder.id}">中身を並べ替える</button>
    ${folder.system ? '' : `<button class="menu-button" data-action="move-folder" data-id="${folder.id}">フォルダを移動</button>`}
    <button class="menu-button" data-action="export-folder" data-id="${folder.id}">このフォルダを書き出す<small>下位フォルダと原稿を含むJSON</small></button>
    ${folder.system ? '' : `<button class="menu-button danger" data-action="trash-folder" data-id="${folder.id}">ゴミ箱へ移す</button>`}
  </div>`);
}

async function showDocumentMenu() {
  const saved = await saveEditorNow({ quiet: true });
  if (!saved && runtime.editor?.failedError) return showToast('保存できていないため、先に本文を退避してください。');
  const document = await getDocument(runtime.editor.documentId);
  openSheet(document.title, `<p class="row-meta">${countCharacters(document.body)}字 ・ ${escapeHtml(DOCUMENT_TYPES[document.type])}</p><div class="sheet-list">
    <button class="menu-button" data-action="open-preview">プレビュー<small>キーボードの出ない読み返し</small></button>
    <button class="menu-button" data-action="open-search">検索・置換</button>
    ${document.type === 'markdown' ? '<button class="menu-button" data-action="copy-note">note用にコピー</button>' : ''}
    <button class="menu-button" data-action="copy-plain">本文をコピー</button>
    <button class="menu-button" data-action="export-document">書き出す・共有</button>
    <button class="menu-button" data-action="open-history">履歴</button>
    <button class="menu-button" data-action="document-info">原稿情報</button>
    <button class="menu-button" data-action="open-settings">表示設定</button>
    <button class="menu-button danger" data-action="trash-document">ゴミ箱へ移す</button>
  </div>`);
}

function showMarkdownMenu() {
  openSheet('Markdown', `<div class="sheet-list">
    <button class="menu-button" data-action="md-h1">大見出し<small>行の先頭に # を付ける</small></button>
    <button class="menu-button" data-action="md-h2">中見出し<small>行の先頭に ## を付ける</small></button>
    <button class="menu-button" data-action="md-h3">小見出し<small>行の先頭に ### を付ける</small></button>
    <button class="menu-button" data-action="md-bold">太字</button>
    <button class="menu-button" data-action="md-italic">斜体</button>
    <button class="menu-button" data-action="md-strike">打ち消し</button>
    <button class="menu-button" data-action="md-quote">引用</button>
    <button class="menu-button" data-action="md-rule">区切り線</button>
    <button class="menu-button" data-action="md-ruby">ルビ</button>
  </div>`);
}

function stickyForm(sticky = {}) {
  openSheet(sticky.id ? '付箋を編集' : '付箋を追加', `<form id="sticky-form">
    <input type="hidden" name="id" value="${escapeHtml(sticky.id ?? '')}">
    <label class="field"><span>内容</span><textarea class="text-area" name="text" required maxlength="500">${escapeHtml(sticky.text ?? '')}</textarea></label>
    <div class="field"><span>色</span>${colorChoices(sticky.color ?? 'yellow')}</div>
    <input type="hidden" name="color" value="${escapeHtml(sticky.color ?? 'yellow')}">
    <div class="button-row"><button class="button primary" type="submit">保存</button><button class="button" type="button" data-sheet-close>やめる</button></div>
    ${sticky.id ? '<div class="danger-zone"><button class="button danger" type="button" data-action="delete-sticky">この付箋を削除</button></div>' : ''}
  </form>`);
  bindColorChoices(sheet);
  sheet.querySelector('#sticky-form')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    if (!String(data.get('text')).trim()) return;
    await saveSticky({ id: data.get('id') || null, text: data.get('text'), color: data.get('color') });
    closeSheet(); await renderHome(); showToast('付箋を保存しました。');
  });
}

function bindColorChoices(root) {
  root.querySelectorAll('[data-color-value]').forEach((button) => button.addEventListener('click', () => {
    const name = button.dataset.colorName;
    root.querySelectorAll(`[data-color-name="${name}"]`).forEach((item) => {
      item.classList.toggle('selected', item === button);
      item.setAttribute('aria-pressed', String(item === button));
      item.innerHTML = `${item === button ? '✓' : ''}<span class="sr-only">${escapeHtml(item.dataset.colorLabel)}</span>`;
    });
    const input = root.querySelector(`[name="${name}"]`);
    if (input) input.value = button.dataset.colorValue;
  }));
}

async function folderForm(parentId, folder = {}) {
  const place = parentId ? await getFolderPath(parentId) : '書庫の直下';
  openSheet(folder.id ? 'フォルダを変更' : 'フォルダを作る', `<form id="folder-form">
    <input type="hidden" name="id" value="${escapeHtml(folder.id ?? '')}"><input type="hidden" name="parentId" value="${escapeHtml(parentId ?? '')}">
    <p class="row-meta">作成する場所：${escapeHtml(place)}</p>
    ${folder.system ? '' : `<label class="field"><span>フォルダ名</span><input class="text-input" name="name" required maxlength="80" value="${escapeHtml(folder.name ?? '')}"></label>`}
    <div class="field"><span>色</span>${colorChoices(folder.color ?? 'gray')}</div><input type="hidden" name="color" value="${escapeHtml(folder.color ?? 'gray')}">
    <div class="button-row"><button class="button primary" type="submit">${folder.id ? '変更を保存' : '作成'}</button><button class="button" type="button" data-sheet-close>やめる</button></div>
  </form>`);
  bindColorChoices(sheet);
  sheet.querySelector('#folder-form')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const id = data.get('id');
    if (id) await updateFolder(id, { name: data.get('name') || undefined, color: data.get('color') });
    else await createFolder(data.get('parentId') || null, data.get('name'), data.get('color'));
    closeSheet(); await renderRoute(); showToast(id ? 'フォルダを変更しました。' : 'フォルダを作りました。');
  });
}

function showSimpleReorder(title, items, storeName, onDone = renderRoute) {
  let order = [...items];
  const draw = () => {
    openSheet(title, `<div class="drag-list">${order.map((item, index) => `<div class="drag-item"><span class="row-main">${escapeHtml(item.text ?? item.title ?? item.name)}</span><button class="icon-button" data-reorder-index="${index}" data-direction="-1" aria-label="上へ" ${index === 0 ? 'disabled' : ''}>↑</button><button class="icon-button" data-reorder-index="${index}" data-direction="1" aria-label="下へ" ${index === order.length - 1 ? 'disabled' : ''}>↓</button></div>`).join('')}</div><div class="button-row" style="margin-top:14px"><button class="button primary" id="save-reorder">完了</button><button class="button" data-sheet-close>やめる</button></div>`);
    sheet.querySelectorAll('[data-reorder-index]').forEach((button) => button.addEventListener('click', () => {
      const index = Number(button.dataset.reorderIndex);
      const target = index + Number(button.dataset.direction);
      [order[index], order[target]] = [order[target], order[index]];
      draw();
    }));
    sheet.querySelector('#save-reorder')?.addEventListener('click', async () => {
      await reorderItems(storeName, order.map((item) => item.id));
      closeSheet(); await onDone(); showToast('並び順を保存しました。');
    });
  };
  draw();
}

async function showFolderContentsReorder(folderId) {
  const snapshot = await getFolderSnapshot(folderId);
  openSheet('中身を並べ替える', `<div class="sheet-list"><button class="menu-button" id="reorder-child-folders">下位フォルダを並べ替える<small>${snapshot.childFolders.length}件</small></button><button class="menu-button" id="reorder-documents">原稿を並べ替える<small>${snapshot.documents.length}件</small></button></div>`);
  sheet.querySelector('#reorder-child-folders')?.addEventListener('click', () => showSimpleReorder('下位フォルダの並べ替え', snapshot.childFolders, STORE_NAMES.folders));
  sheet.querySelector('#reorder-documents')?.addEventListener('click', () => showSimpleReorder('原稿の並べ替え', snapshot.documents, STORE_NAMES.documents));
}

async function showMovePicker(kind, id) {
  const folders = await listFolders();
  const item = kind === 'document' ? await getDocument(id) : await getFolder(id);
  const roots = folders.filter((folder) => folder.parentId === null);
  const ordered = [];
  roots.forEach((root) => {
    ordered.push({ ...root, depth: 0 });
    folders.filter((folder) => folder.parentId === root.id).forEach((child) => ordered.push({ ...child, depth: 1 }));
  });
  const options = kind === 'folder'
    ? [{ id: '', name: '書庫の直下', depth: 0 }, ...roots.filter((folder) => folder.id !== id)]
    : ordered;
  openSheet(kind === 'document' ? '原稿の移動先' : 'フォルダの移動先', `<form id="move-form"><div class="list">${options.map((folder) => `<label class="row-button" style="padding-left:${12 + folder.depth * 22}px"><input type="radio" name="folderId" value="${folder.id}" ${String(item.folderId ?? item.parentId ?? '') === folder.id ? 'checked' : ''}><span class="row-main" style="margin-left:10px"><span class="row-title">${escapeHtml(folder.name)}</span></span></label>`).join('')}</div><div class="button-row" style="margin-top:14px"><button class="button primary" type="submit">ここへ移動</button><button class="button" type="button" data-sheet-close>やめる</button></div></form>`);
  sheet.querySelector('#move-form')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const target = new FormData(event.currentTarget).get('folderId');
    if (kind === 'document') await moveDocument(id, target || MEMO_FOLDER_ID);
    else await moveFolder(id, target || null);
    closeSheet();
    if (kind === 'document' && runtime.editor) {
      runtime.editor.document = await getDocument(id);
      showToast('原稿を移動しました。');
    } else {
      setRoute({ name: target ? 'folder' : 'home', folderId: target || undefined });
      showToast('フォルダを移動しました。');
    }
  });
}

async function showDocumentInfo() {
  const document = await getDocument(runtime.editor.documentId);
  const folders = await listFolders();
  const roots = folders.filter((folder) => folder.parentId === null);
  const ordered = [];
  roots.forEach((root) => {
    ordered.push({ ...root, depth: 0 });
    folders.filter((folder) => folder.parentId === root.id).forEach((child) => ordered.push({ ...child, depth: 1 }));
  });
  openSheet('原稿情報', `<form id="document-info-form">
    <label class="field"><span>タイトル</span><input class="text-input" name="title" maxlength="120" required value="${escapeHtml(document.title)}"></label>
    <div class="field"><span>色</span>${colorChoices(document.color)}</div><input type="hidden" name="color" value="${escapeHtml(document.color)}">
    <label class="field"><span>保存先</span><select class="select-input" name="folderId">${ordered.map((folder) => `<option value="${folder.id}" ${folder.id === document.folderId ? 'selected' : ''}>${'　'.repeat(folder.depth)}${escapeHtml(folder.name)}</option>`).join('')}</select></label>
    <dl class="meta-grid"><dt>原稿の種類</dt><dd>${escapeHtml(DOCUMENT_TYPES[document.type])}</dd><dt>作成日時</dt><dd>${formatDateTime(document.createdAt)}</dd><dt>最終更新</dt><dd>${formatDateTime(document.updatedAt)}</dd><dt>文字数</dt><dd>${countCharacters(document.body)}字</dd></dl>
    <div class="button-row" style="margin-top:14px"><button class="button primary" type="submit">変更を保存</button><button class="button" type="button" data-sheet-close>やめる</button></div>
  </form>`);
  bindColorChoices(sheet);
  sheet.querySelector('#document-info-form')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const folderId = data.get('folderId');
    let next = await saveDocument(document.id, { title: data.get('title'), color: data.get('color') });
    if (folderId !== document.folderId) next = await moveDocument(document.id, folderId);
    runtime.editor.document = next;
    closeSheet();
    await renderEditor(document.id);
    showToast('原稿情報を保存しました。');
  });
}

async function showDocumentExport() {
  const document = await getDocument(runtime.editor.documentId);
  const defaultExtension = document.type === 'markdown' ? 'md' : 'txt';
  openSheet('書き出す・共有', `<form id="export-document-form">
    <label class="row-button"><input type="radio" name="kind" value="text" checked><span class="row-main" style="margin-left:10px"><span class="row-title">本文ファイルとして渡す</span><span class="row-meta">AirDropや「ファイル」で普通の文章として開く</span></span></label>
    <label class="row-button" style="margin-top:8px"><input type="radio" name="kind" value="json"><span class="row-main" style="margin-left:10px"><span class="row-title">文机と往復するJSON</span><span class="row-meta">所属先と同じ原稿を見分ける情報を含む</span></span></label>
    <label class="field"><span>ファイル名</span><input class="text-input" name="fileName" value="${escapeHtml(document.title)}" required></label>
    ${document.type === 'markdown' ? `<label class="field"><span>本文ファイルの種類</span><select class="select-input" name="extension"><option value="md" selected>.md</option><option value="txt">.txt</option></select></label>` : `<input type="hidden" name="extension" value="${defaultExtension}">`}
    <div class="button-row"><button class="button primary" type="submit">共有する</button><button class="button" type="button" data-sheet-close>やめる</button></div>
  </form>`);
  sheet.querySelector('#export-document-form')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const base = safeFileName(data.get('fileName'));
    try {
      if (data.get('kind') === 'json') {
        const payload = await buildExport('document', document.id);
        await shareFile(fileFromText(externalFileName('document', base), JSON.stringify(payload, null, 2), 'application/json'), document.title);
      } else {
        const extension = data.get('extension');
        await shareFile(fileFromText(`${base}.${extension}`, document.body), document.title);
      }
      closeSheet(); showToast('共有の準備ができました。');
    } catch (error) {
      if (!error.cancelled) showErrorSheet('共有できませんでした', error, `<button class="button" data-action="copy-plain">本文をコピー</button>`);
    }
  });
}

async function exportFolder(id) {
  const folder = await getFolder(id);
  const payload = await buildExport('folder', id);
  await shareFile(fileFromText(externalFileName('folder', folder.name), JSON.stringify(payload, null, 2), 'application/json'), folder.name);
  showToast('フォルダJSONを用意しました。');
}

async function showLibraryBackup() {
  const snapshot = await getHomeSnapshot();
  const trash = await listTrash();
  openSheet('書庫まるごとバックアップ', `<dl class="meta-grid"><dt>前回</dt><dd>${formatDateTime(snapshot.settings.lastBackupAt)}</dd><dt>原稿</dt><dd>${snapshot.documents.length}件</dd><dt>フォルダ</dt><dd>${snapshot.folders.length}件</dd><dt>付箋</dt><dd>${snapshot.stickies.length}件</dd><dt>ゴミ箱</dt><dd>${trash.length}件</dd></dl><p class="row-meta">原稿ごとの全20世代履歴は含みません。</p><button class="button primary" id="create-library-backup" style="width:100%;margin-top:12px">バックアップファイルを作る</button>`);
  sheet.querySelector('#create-library-backup')?.addEventListener('click', async () => {
    try {
      const payload = await buildExport('library');
      await shareFile(fileFromText(externalFileName('library'), JSON.stringify(payload, null, 2), 'application/json'), '懐紙の書庫全体');
      await markBackupSuccess(); closeSheet(); showToast('書庫バックアップを用意しました。');
      if (runtime.route.name === 'home') await renderHome();
    } catch (error) {
      if (!error.cancelled) showErrorSheet('バックアップできませんでした', error);
    }
  });
}

function showErrorSheet(title, error, extra = '') {
  openSheet(title, `<div class="notice danger">${escapeHtml(error?.message || '原因を確認できませんでした。')}</div>${extra}<button class="button" style="width:100%;margin-top:10px" data-sheet-close>閉じる</button>`);
}

async function showImportReview(inspection, fileName) {
  runtime.importInspection = inspection;
  runtime.importFileName = fileName;
  const { payload, counts, conflicts, missingFolderIds, replacementLoss } = inspection;
  const typeLabel = ({ document: '原稿1本', folder: 'フォルダ', library: '書庫全体' })[payload.scope] ?? '受け渡しデータ';
  openSheet('読み込む内容の確認', `<dl class="meta-grid"><dt>ファイル</dt><dd>${escapeHtml(fileName)}</dd><dt>種類</dt><dd>${typeLabel}</dd><dt>書き出し日時</dt><dd>${formatDateTime(payload.exportedAt)}</dd><dt>原稿</dt><dd>${counts.documents}件（新規${counts.added}・同じ原稿${counts.updated}）</dd><dt>フォルダ</dt><dd>${counts.folders}件</dd><dt>付箋</dt><dd>${counts.stickies}件</dd></dl>
    ${conflicts.length ? `<div class="notice warning">両方で変更された原稿が${conflicts.length}件あります。文章を失わないよう一件ずつ確認します。</div>` : ''}
    ${missingFolderIds.length ? `<div class="notice">保存先を再現できない原稿は「メモ」へ入れ、完了後に件数を表示します。</div>` : ''}
    ${payload.scope === 'library' ? `<div class="field"><span>読み込み方</span><label class="row-button"><input type="radio" name="import-mode" value="merge" checked><span class="row-main" style="margin-left:10px"><span class="row-title">現在の書庫へ合流する（おすすめ）</span></span></label><label class="row-button" style="margin-top:8px"><input type="radio" name="import-mode" value="replace"><span class="row-main" style="margin-left:10px"><span class="row-title">バックアップの内容に置き換える</span><span class="row-meta">現在だけにある原稿${replacementLoss.documents}件・フォルダ${replacementLoss.folders}件・付箋${replacementLoss.stickies}件・ゴミ箱${replacementLoss.trash}件が書庫から外れます</span></span></label></div>` : ''}
    <div class="button-row"><button class="button primary" id="start-import">読み込む</button><button class="button" data-sheet-close>やめる</button></div>`);
  sheet.querySelector('#start-import')?.addEventListener('click', async () => {
    const mode = sheet.querySelector('[name="import-mode"]:checked')?.value ?? 'merge';
    if (mode === 'replace') {
      if (!confirm(`現在だけにある原稿${replacementLoss.documents}件・フォルダ${replacementLoss.folders}件・付箋${replacementLoss.stickies}件・ゴミ箱${replacementLoss.trash}件が書庫から外れます。先に自動保護して続けますか？`)) return;
      if (!confirm('復旧用の置き換えを実行します。あとで「懐紙について」の自動保護記録から戻せます。本当によろしいですか？')) return;
    }
    runtime.importInspection.mode = mode;
    runtime.conflictResolutions = {};
    runtime.pendingConflictIndex = 0;
    if (conflicts.length) showConflictReview(); else executeImport();
  });
}

function showConflictReview() {
  const conflicts = runtime.importInspection.conflicts;
  const index = runtime.pendingConflictIndex;
  const conflict = conflicts[index];
  if (!conflict) return executeImport();
  openSheet('同じ原稿が両方で変更されています', `<p class="row-meta">${index + 1}／${conflicts.length}件</p>
    <div class="notice"><strong>iPhoneにある原稿</strong><br>${formatDateTime(conflict.local.updatedAt)}・${countCharacters(conflict.local.body)}字<p>${escapeHtml(conflict.local.body.slice(0, 120) || '本文なし')}</p></div>
    <div class="notice"><strong>読み込む原稿</strong><br>${formatDateTime(conflict.incoming.updatedAt)}・${countCharacters(conflict.incoming.body)}字<p>${escapeHtml(conflict.incoming.body.slice(0, 120) || '本文なし')}</p></div>
    <div class="sheet-list"><button class="menu-button" data-action="resolve-conflict" data-resolution="both">両方残す（おすすめ）</button><button class="menu-button" data-action="resolve-conflict" data-resolution="local">iPhone側を残す</button><button class="menu-button danger" data-action="resolve-conflict" data-resolution="incoming">読み込み側で上書き</button>${conflicts.length - index > 1 ? '<button class="menu-button" data-action="resolve-all-both">残りもすべて両方残す</button>' : ''}</div>`);
}

async function executeImport() {
  try {
    const report = await applyImport(runtime.importInspection.payload, {
      mode: runtime.importInspection.mode ?? 'merge', resolutions: runtime.conflictResolutions
    });
    openSheet('読み込みが完了しました', `<dl class="meta-grid"><dt>追加</dt><dd>${report.added}件</dd><dt>更新</dt><dd>${report.updated}件</dd><dt>両方残した原稿</dt><dd>${report.duplicated}件</dd><dt>読み込まなかった原稿</dt><dd>${report.skipped}件</dd></dl><button class="button primary" style="width:100%;margin-top:12px" data-action="finish-import">書庫を見る</button>`);
  } catch (error) {
    showErrorSheet('読み込めませんでした', error);
  }
}

async function renderTrash() {
  const items = await listTrash();
  const folders = await listFolders({ includeDeleted: true });
  app.innerHTML = `<section class="screen trash-screen">
    ${header({ title: 'ゴミ箱', back: 'go-home', menu: items.length ? 'trash-menu' : null })}
    ${items.length ? `<div class="list">${items.map((item) => {
      const elapsed = Math.max(0, Math.floor((Date.now() - new Date(item.deletedAt).getTime()) / 86_400_000));
      const remaining = Math.max(0, TRASH_DAYS - elapsed);
      const originalFolder = item.kind === 'document' ? folders.find((folder) => folder.id === item.originalFolderId) : folders.find((folder) => folder.id === item.originalParentId);
      return `<button class="row-button" data-action="trash-item" data-kind="${item.kind}" data-id="${item.id}"><span class="row-main"><span class="row-title">${escapeHtml(item.title ?? item.name)}</span><span class="row-meta">元の場所：${escapeHtml(originalFolder?.name ?? (item.kind === 'folder' ? '書庫の直下' : '場所不明'))} ・ あと${remaining}日</span></span><span class="chevron">›</span></button>`;
    }).join('')}</div>` : '<div class="empty">ゴミ箱は空です</div>'}
  </section>`;
}

async function showTrashItem(kind, id) {
  const item = kind === 'document' ? await getDocument(id) : await getFolder(id);
  if (!item) return;
  const originalFolder = kind === 'document' ? await getFolder(item.originalFolderId) : null;
  const restoreButtons = originalFolder?.deletedAt
    ? `<button class="menu-button" data-action="restore-trash" data-kind="${kind}" data-id="${id}" data-restore-folder="true">元のフォルダも一緒に戻す</button><button class="menu-button" data-action="restore-trash" data-kind="${kind}" data-id="${id}" data-restore-folder="false">原稿だけ「メモ」へ戻す</button>`
    : `<button class="menu-button" data-action="restore-trash" data-kind="${kind}" data-id="${id}" data-restore-folder="true">元の場所へ戻す</button>`;
  openSheet(item.title ?? item.name, `${kind === 'document' ? `<div class="notice" style="max-height:220px;overflow:auto;white-space:pre-wrap">${escapeHtml(item.body.slice(0, 1000) || '本文はありません')}</div>` : ''}<p class="row-meta">削除日：${formatDateTime(item.deletedAt)}</p><div class="sheet-list">${restoreButtons}<button class="menu-button danger" data-action="delete-forever" data-kind="${kind}" data-id="${id}">完全に削除する</button></div>`);
}

async function showTrashMenu() {
  const items = await listTrash();
  openSheet('ゴミ箱のメニュー', `<div class="notice danger">${items.length}件を完全に削除します。この操作は元に戻せません。</div><button class="button danger" style="width:100%" data-action="empty-trash">ゴミ箱を空にする</button>`);
}

async function renderHistory(documentId) {
  const [document, histories] = await Promise.all([getDocument(documentId), listHistories(documentId)]);
  if (!document) return setRoute({ name: 'home' });
  app.innerHTML = `<section class="screen history-screen">
    ${header({ title: '履歴', subtitle: document.title, back: 'history-back' })}
    ${histories.length ? `<div class="list">${histories.map((history) => `<button class="row-button" data-action="history-item" data-id="${history.id}"><span class="row-main"><span class="row-title">${formatDateTime(history.createdAt)}</span><span class="row-meta">${history.characterCount}字 ・ ${escapeHtml(history.body.slice(0, 42) || '本文なし')}</span></span><span class="chevron">›</span></button>`).join('')}</div>` : '<div class="empty">履歴はまだありません</div>'}
  </section>`;
}

async function showHistoryItem(id) {
  const histories = await listHistories(runtime.route.documentId);
  const history = histories.find((item) => item.id === id);
  if (!history) return;
  const content = history.type === 'markdown' ? renderMarkdown(history.body) : `<div style="white-space:pre-wrap">${escapeHtml(history.body)}</div>`;
  openSheet(formatDateTime(history.createdAt), `<div class="preview-content" style="max-height:48dvh">${content || '<p>本文はありません</p>'}</div><p class="row-meta">${history.characterCount}字</p><div class="button-row"><button class="button primary" data-action="restore-history" data-id="${id}">この内容に戻す</button><button class="button" data-action="duplicate-history" data-id="${id}">別の原稿として残す</button></div><p class="row-meta">現在の内容も履歴へ残るため、あとから戻せます。</p>`);
}

async function renderSettings() {
  const settings = await getSettings();
  applyAppearance(settings);
  const selected = (value, expected) => value === expected ? 'selected' : '';
  app.innerHTML = `<section class="screen settings-screen">
    ${header({ title: '表示設定', back: runtime.route.returnRoute?.name === 'editor' ? 'settings-back-editor' : 'go-home' })}
    <div class="preview-content" style="max-height:180px;min-height:150px;overflow:hidden"><h2>雨の日の原稿</h2><p>窓を叩く雨の音で目が覚めた。まだ朝には少し早い。</p></div>
    <div class="field"><span>文字の大きさ：${settings.fontSize}px</span><div class="button-row"><button class="button" data-action="font-size-down">小さく</button><button class="button" data-action="font-size-up">大きく</button></div></div>
    <div class="field"><span>行の間隔</span><div class="segmented"><button class="${selected(settings.lineHeight, 'compact')}" data-setting="lineHeight" data-value="compact">狭め</button><button class="${selected(settings.lineHeight, 'standard')}" data-setting="lineHeight" data-value="standard">標準</button><button class="${selected(settings.lineHeight, 'wide')}" data-setting="lineHeight" data-value="wide">広め</button></div></div>
    <div class="field"><span>左右の余白</span><div class="segmented"><button class="${selected(settings.pageMargin, 'compact')}" data-setting="pageMargin" data-value="compact">狭め</button><button class="${selected(settings.pageMargin, 'standard')}" data-setting="pageMargin" data-value="standard">標準</button><button class="${selected(settings.pageMargin, 'wide')}" data-setting="pageMargin" data-value="wide">広め</button></div></div>
    <div class="field"><span>書体</span><div class="segmented" style="grid-template-columns:1fr 1fr"><button class="${selected(settings.fontFamily, 'mincho')}" data-setting="fontFamily" data-value="mincho">明朝体</button><button class="${selected(settings.fontFamily, 'gothic')}" data-setting="fontFamily" data-value="gothic">ゴシック体</button></div></div>
    <div class="field"><span>画面の明るさ</span><div class="segmented"><button class="${selected(settings.theme, 'system')}" data-setting="theme" data-value="system">iPhoneに合わせる</button><button class="${selected(settings.theme, 'light')}" data-setting="theme" data-value="light">明るい</button><button class="${selected(settings.theme, 'dark')}" data-setting="theme" data-value="dark">暗い</button></div></div>
    <div class="button-row" style="margin-top:18px"><button class="button primary" data-action="settings-done">完了</button><button class="button" data-action="reset-settings">初期設定に戻す</button></div>
  </section>`;
}

async function renderAbout() {
  const [settings, storage, backups] = await Promise.all([getSettings(), estimateStorage(), listInternalBackups()]);
  const size = storage.usage ? `${(storage.usage / 1024 / 1024).toFixed(1)}MB` : '確認できません';
  app.innerHTML = `<section class="screen about-screen">
    ${header({ title: '懐紙について', back: 'go-home' })}
    <div style="text-align:center"><img src="./assets/apple-touch-icon.png" width="92" height="92" style="border-radius:22px" alt=""><h2 class="brand" style="margin:12px 0 4px">懐紙</h2><p class="row-meta">バージョン ${APP_VERSION}</p></div>
    <h2 class="section-title" style="margin-top:24px">データについて</h2>
    <div class="notice"><p>原稿は、このiPhoneのホーム画面版に保存されています。</p><p>GitHubや外部サービスへは送信しません。コピー・共有・書き出しを実行した時だけ外へ渡ります。</p></div>
    <dl class="meta-grid"><dt>使用容量</dt><dd>${size}</dd><dt>前回のバックアップ</dt><dd>${formatDateTime(settings.lastBackupAt)}</dd><dt>アプリ本体</dt><dd>${APP_VERSION}</dd><dt>保存データ形式</dt><dd>1（普段は気にしなくて大丈夫です）</dd></dl>
    <div class="button-row" style="margin-top:16px"><button class="button primary" data-action="backup-library">バックアップを作る</button><button class="button" data-action="open-recovery">自動保護の記録（${backups.length}）</button></div>
  </section>`;
}

async function showRecoveryRecords() {
  const backups = await listInternalBackups();
  openSheet('自動保護の記録', backups.length
    ? `<p class="row-meta">JSON読み込みやフォルダ削除の直前を、端末内に最新5件まで残しています。</p><div class="list">${backups.map((backup) => `<button class="row-button" data-action="recovery-item" data-id="${backup.id}"><span class="row-main"><span class="row-title">${escapeHtml(backup.reason)}</span><span class="row-meta">${formatDateTime(backup.createdAt)}</span></span><span class="chevron">›</span></button>`).join('')}</div>`
    : '<div class="empty">自動保護の記録はまだありません</div>');
}

async function showRecoveryItem(id) {
  const backup = (await listInternalBackups()).find((item) => item.id === id);
  if (!backup) return showToast('この記録は見つかりません。');
  const data = backup.data ?? {};
  openSheet('この時点へ戻す', `<dl class="meta-grid"><dt>記録</dt><dd>${escapeHtml(backup.reason)}</dd><dt>日時</dt><dd>${formatDateTime(backup.createdAt)}</dd><dt>原稿</dt><dd>${data.documents?.length ?? 0}件</dd><dt>フォルダ</dt><dd>${data.folders?.length ?? 0}件</dd><dt>付箋</dt><dd>${data.stickies?.length ?? 0}件</dd></dl><div class="notice warning">現在の書庫も先に自動保護してから、この時点へ戻します。</div><button class="button danger" style="width:100%" data-action="restore-recovery" data-id="${id}">この時点へ戻す</button>`);
}

async function applySetting(name, value) {
  const next = await saveSettings({ [name]: value });
  applyAppearance(next);
  await renderSettings();
}

async function copyForNote() {
  const document = await getDocument(runtime.editor.documentId);
  const html = renderMarkdown(document.body);
  const plain = markdownToPlainText(document.body);
  try {
    await copyRichText(html, plain);
    if (navigator.vibrate) navigator.vibrate(18);
    closeSheet(); showToast('note用にコピーしました。');
  } catch (error) {
    openSheet('書式付きコピーができませんでした', `<div class="notice danger">${escapeHtml(error.message)}</div><div class="button-row"><button class="button primary" data-action="copy-note">もう一度試す</button><button class="button" data-action="copy-note-plain">書式なしでコピー</button></div>`);
  }
}

async function handleAction(action, element) {
  if (!action) return;
  try {
    if (action === 'go-home') return runtime.editor ? leaveEditor({ name: 'home' }) : setRoute({ name: 'home' });
    if (action === 'home-menu') return showHomeMenu();
    if (action === 'open-folder') return setRoute({ name: 'folder', folderId: element.dataset.id });
    if (action === 'folder-back-parent') {
      const folder = await getFolder(runtime.route.folderId);
      return setRoute(folder.parentId ? { name: 'folder', folderId: folder.parentId } : { name: 'home' });
    }
    if (action === 'folder-menu') return showFolderMenu();
    if (action === 'new-folder') return folderForm(element.dataset.parentId || null);
    if (action === 'edit-folder') return folderForm((await getFolder(element.dataset.id)).parentId, await getFolder(element.dataset.id));
    if (action === 'move-folder') return showMovePicker('folder', element.dataset.id);
    if (action === 'reorder-folder-items') return showFolderContentsReorder(element.dataset.id);
    if (action === 'export-folder') { closeSheet(); return exportFolder(element.dataset.id); }
    if (action === 'trash-folder') {
      const contents = await buildExport('folder', element.dataset.id);
      const documentCount = contents.documents.filter((item) => !item.deletedAt).length;
      const folderCount = Math.max(0, contents.folders.filter((item) => !item.deletedAt).length - 1);
      if (confirm(`中の原稿${documentCount}件・下位フォルダ${folderCount}件もゴミ箱に入ります。`)) {
        await moveToTrash('folder', element.dataset.id); closeSheet(); setRoute({ name: 'home' }); showToast('フォルダをゴミ箱へ移しました。');
      }
      return;
    }
    if (action === 'open-document') return setRoute({ name: 'editor', documentId: element.dataset.id, returnRoute: { ...runtime.route } });
    if (action === 'new-document') {
      const doc = await createDocument(element.dataset.folderId || MEMO_FOLDER_ID);
      return setRoute({ name: 'editor', documentId: doc.id, returnRoute: { ...runtime.route }, focus: true });
    }
    if (action === 'editor-new-document') {
      const folderId = runtime.editor.document.folderId;
      if (!(await prepareToLeaveEditor())) return;
      const doc = await createDocument(folderId);
      return setRoute({ name: 'editor', documentId: doc.id, returnRoute: { name: 'folder', folderId }, focus: true });
    }
    if (action === 'editor-back') return leaveEditor(runtime.editor.returnRoute || { name: 'home' });
    if (action === 'document-menu') return showDocumentMenu();
    if (action === 'undo' || action === 'redo') return performUndo(action);
    if (action === 'markdown-menu') return showMarkdownMenu();
    if (action === 'md-h1') { closeSheet(); return prefixSelectedLines('# '); }
    if (action === 'md-h2') { closeSheet(); return prefixSelectedLines('## '); }
    if (action === 'md-h3') { closeSheet(); return prefixSelectedLines('### '); }
    if (action === 'md-bold') { closeSheet(); return replaceSelection('**', '**', '太字'); }
    if (action === 'md-italic') { closeSheet(); return replaceSelection('*', '*', '斜体'); }
    if (action === 'md-strike') { closeSheet(); return replaceSelection('~~', '~~', '打消し'); }
    if (action === 'md-quote') { closeSheet(); return prefixSelectedLines('> '); }
    if (action === 'md-rule') { closeSheet(); return replaceSelection('\n---\n', '', ''); }
    if (action === 'md-ruby') { closeSheet(); return replaceSelection('{', '|よみ}', '漢字'); }
    if (action === 'retry-save') { const result = await saveEditorNow(); if (result) showToast('保存できました。'); return; }
    if (action === 'emergency-copy') return copyPlainText(document.querySelector('#editor')?.value ?? '').then(() => showToast('本文をコピーしました。'));
    if (action === 'emergency-file') {
      const doc = runtime.editor.document;
      return shareFile(fileFromText(`${safeFileName(doc.title)}.txt`, document.querySelector('#editor')?.value ?? ''), doc.title);
    }
    if (action === 'open-preview') {
      closeSheet();
      const saved = await saveEditorNow({ quiet: true });
      if (!saved && runtime.editor?.failedError) return showToast('保存できていないため、プレビューへ移れません。');
      const textarea = document.querySelector('#editor');
      const ratio = textarea ? textarea.scrollTop / Math.max(1, textarea.scrollHeight - textarea.clientHeight) : 0;
      return setRoute({ name: 'preview', documentId: runtime.editor.documentId, scrollRatio: ratio, returnRoute: runtime.editor.returnRoute });
    }
    if (action === 'preview-back') {
      const preview = document.querySelector('#preview-content');
      const ratio = preview ? preview.scrollTop / Math.max(1, preview.scrollHeight - preview.clientHeight) : 0;
      return setRoute({ name: 'editor', documentId: runtime.route.documentId, scrollRatio: ratio, returnRoute: runtime.route.returnRoute });
    }
    if (action === 'open-search') {
      closeSheet();
      const saved = await saveEditorNow({ quiet: true });
      if (!saved && runtime.editor?.failedError) return showToast('保存できていないため、検索を開けません。');
      runtime.route.searchOpen = true; return renderEditor(runtime.editor.documentId);
    }
    if (action === 'close-search') {
      const saved = await saveEditorNow({ quiet: true });
      if (!saved && runtime.editor?.failedError) return showToast('保存できていないため、検索を閉じません。');
      runtime.route.searchOpen = false; return renderEditor(runtime.editor.documentId);
    }
    if (action === 'show-replace') { document.querySelector('#replace-row').hidden = false; document.querySelector('#replace-term')?.focus(); return; }
    if (action === 'search-prev') return moveSearch(-1);
    if (action === 'search-next') return moveSearch(1);
    if (action === 'replace-one') return replaceCurrentMatch();
    if (action === 'replace-all') return replaceAllMatches();
    if (action === 'copy-note') return copyForNote();
    if (action === 'copy-note-plain') {
      const doc = await getDocument(runtime.editor.documentId); await copyPlainText(markdownToPlainText(doc.body)); closeSheet(); return showToast('書式なしでコピーしました。');
    }
    if (action === 'copy-plain') {
      const doc = await getDocument(runtime.editor.documentId); await copyPlainText(doc.body); closeSheet(); return showToast('本文をコピーしました。');
    }
    if (action === 'export-document') return showDocumentExport();
    if (action === 'document-info') return showDocumentInfo();
    if (action === 'trash-document') {
      if (!confirm('この原稿をゴミ箱へ移しますか？')) return;
      const returnRoute = runtime.editor.returnRoute || { name: 'home' };
      const saved = await saveEditorNow({ quiet: true });
      if (!saved && runtime.editor?.failedError) return showToast('保存できていないため、ゴミ箱へ移しません。');
      await moveToTrash('document', runtime.editor.documentId);
      clearEditorTimers(); runtime.editor = null; closeSheet(); setRoute(returnRoute); return showToast('原稿をゴミ箱へ移しました。');
    }
    if (action === 'open-history') {
      closeSheet();
      const saved = await saveEditorNow({ quiet: true });
      if (!saved && runtime.editor?.failedError) return showToast('保存できていないため、履歴へ移れません。');
      return setRoute({ name: 'history', documentId: runtime.editor.documentId, returnRoute: runtime.editor.returnRoute });
    }
    if (action === 'history-back') return setRoute({ name: 'editor', documentId: runtime.route.documentId, returnRoute: runtime.route.returnRoute });
    if (action === 'history-item') return showHistoryItem(element.dataset.id);
    if (action === 'restore-history') {
      if (!confirm('現在の内容を履歴へ残して、この内容に戻しますか？')) return;
      const doc = await restoreHistory(element.dataset.id); closeSheet(); return setRoute({ name: 'editor', documentId: doc.id, returnRoute: runtime.route.returnRoute });
    }
    if (action === 'duplicate-history') { await duplicateHistory(element.dataset.id); closeSheet(); showToast('別の原稿として残しました。'); return; }
    if (action === 'new-sticky') return stickyForm();
    if (action === 'edit-sticky') return stickyForm((await getHomeSnapshot()).stickies.find((item) => item.id === element.dataset.id));
    if (action === 'delete-sticky') {
      const id = sheet.querySelector('[name="id"]')?.value;
      if (confirm('この付箋を削除しますか？')) { await deleteSticky(id); closeSheet(); await renderHome(); showToast('付箋を削除しました。'); }
      return;
    }
    if (action === 'reorder-stickies') return showSimpleReorder('付箋の並べ替え', (await getHomeSnapshot()).stickies, STORE_NAMES.stickies, renderHome);
    if (action === 'choose-json') { closeSheet(); jsonInput.value = ''; jsonInput.click(); return; }
    if (action === 'resolve-conflict') {
      const conflict = runtime.importInspection.conflicts[runtime.pendingConflictIndex];
      if (element.dataset.resolution === 'incoming' && !confirm('iPhone側の現在稿を履歴へ残して、読み込み側で上書きしますか？')) return;
      runtime.conflictResolutions[conflict.incoming.id] = element.dataset.resolution;
      runtime.pendingConflictIndex += 1; return showConflictReview();
    }
    if (action === 'resolve-all-both') {
      runtime.importInspection.conflicts.slice(runtime.pendingConflictIndex).forEach((conflict) => { runtime.conflictResolutions[conflict.incoming.id] = 'both'; });
      runtime.pendingConflictIndex = runtime.importInspection.conflicts.length; return executeImport();
    }
    if (action === 'finish-import') { closeSheet(); return setRoute({ name: 'home' }); }
    if (action === 'backup-library') { closeSheet(); return showLibraryBackup(); }
    if (action === 'dismiss-backup') { await dismissBackupForToday(); return renderHome(); }
    if (action === 'open-trash') { closeSheet(); return setRoute({ name: 'trash' }); }
    if (action === 'trash-menu') return showTrashMenu();
    if (action === 'trash-item') return showTrashItem(element.dataset.kind, element.dataset.id);
    if (action === 'restore-trash') {
      const result = await restoreFromTrash(element.dataset.kind, element.dataset.id, { restoreFolder: element.dataset.restoreFolder !== 'false' });
      closeSheet(); await renderTrash(); showToast(result?.fallbackToMemo ? '元のフォルダを戻さず、原稿を「メモ」へ戻しました。' : '元の場所へ戻しました。'); return;
    }
    if (action === 'delete-forever') {
      if (!confirm('完全に削除します。この操作は元に戻せません。')) return;
      if (!confirm('本当に完全削除しますか？')) return;
      await permanentlyDelete(element.dataset.kind, element.dataset.id); closeSheet(); return renderTrash();
    }
    if (action === 'empty-trash') {
      if (!confirm('ゴミ箱の中身をすべて完全に削除しますか？')) return;
      if (!confirm('この操作は元に戻せません。本当に削除しますか？')) return;
      await emptyTrash(); closeSheet(); return renderTrash();
    }
    if (action === 'open-settings') {
      const returnRoute = runtime.editor ? { name: 'editor', documentId: runtime.editor.documentId, returnRoute: runtime.editor.returnRoute } : { ...runtime.route };
      if (runtime.editor) {
        const saved = await saveEditorNow({ quiet: true });
        if (!saved && runtime.editor.failedError) return showToast('保存できていないため、設定へ移れません。');
      }
      closeSheet(); return setRoute({ name: 'settings', returnRoute });
    }
    if (action === 'settings-back-editor' || action === 'settings-done') return setRoute(runtime.route.returnRoute || { name: 'home' });
    if (action === 'font-size-down') return applySetting('fontSize', Math.max(14, (await getSettings()).fontSize - 1));
    if (action === 'font-size-up') return applySetting('fontSize', Math.min(26, (await getSettings()).fontSize + 1));
    if (action === 'reset-settings') {
      await saveSettings({ fontSize: 17, lineHeight: 'standard', pageMargin: 'standard', fontFamily: 'mincho', theme: 'system' });
      return renderSettings();
    }
    if (action === 'open-about') { closeSheet(); return setRoute({ name: 'about' }); }
    if (action === 'open-recovery') return showRecoveryRecords();
    if (action === 'recovery-item') return showRecoveryItem(element.dataset.id);
    if (action === 'restore-recovery') {
      if (!confirm('現在の書庫を先に自動保護してから、この記録の時点へ戻しますか？')) return;
      if (!confirm('書庫全体が入れ替わります。本当に戻しますか？')) return;
      await restoreInternalBackup(element.dataset.id); closeSheet(); setRoute({ name: 'home' }); return showToast('自動保護の時点へ戻しました。');
    }
    if (action === 'apply-update') {
      if (runtime.editor) await saveEditorNow({ quiet: true });
      runtime.updating = true;
      runtime.updateRegistration?.waiting?.postMessage({ type: 'SKIP_WAITING' }); return;
    }
    if (action === 'dismiss-update') { runtime.updateReady = false; return renderHome(); }
    if (action === 'take-over') {
      const result = await runtime.guard.requestTakeover();
      if (result.blocked) return showToast('先に開いている懐紙を閉じて、少し待ってからもう一度押してください。', 4200);
      return renderHome();
    }
    if (action === 'stay-closed') return renderTakenOver();
    if (action === 'reload-app') return location.reload();
  } catch (error) {
    showErrorSheet('操作を完了できませんでした', error);
  }
}

function handleFatal(error) {
  console.error(error);
  app.innerHTML = `<section class="install-screen"><div class="install-card"><h1 style="letter-spacing:0">懐紙を開けませんでした</h1><div class="notice danger">${escapeHtml(error?.message || '原因を確認できませんでした。')}</div><button class="button" data-action="reload-app">もう一度開く</button></div></section>`;
}

app.addEventListener('click', (event) => {
  const element = event.target.closest('[data-action]');
  if (element) handleAction(element.dataset.action, element);
});

sheet.addEventListener('click', (event) => {
  const close = event.target.closest('[data-sheet-close]');
  if (close) { closeSheet(); return; }
  const element = event.target.closest('[data-action]');
  if (element) handleAction(element.dataset.action, element);
});

sheet.addEventListener('click', (event) => {
  if (event.target === sheet) closeSheet();
});

document.addEventListener('click', (event) => {
  const setting = event.target.closest('[data-setting]');
  if (setting) applySetting(setting.dataset.setting, setting.dataset.value);
});

jsonInput.addEventListener('change', async () => {
  const file = jsonInput.files?.[0];
  if (!file) return;
  try {
    const payload = await readJsonFile(file);
    await showImportReview(await inspectImport(payload), file.name);
  } catch (error) {
    showErrorSheet('JSONを読み込めませんでした', error);
  }
});

window.addEventListener('online', () => { runtime.online = true; if (runtime.route.name === 'home') renderHome(); });
window.addEventListener('offline', () => { runtime.online = false; if (runtime.route.name === 'home') renderHome(); });
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') saveEditorNow({ quiet: true }); });
window.addEventListener('pagehide', () => { saveEditorNow({ quiet: true }); });
window.addEventListener('beforeunload', (event) => {
  if (runtime.editor?.failedError) { event.preventDefault(); event.returnValue = ''; }
});

boot().catch(handleFatal);
