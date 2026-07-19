import test from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';

function installDom({ standalone }) {
  const window = new Window({ url: 'https://example.github.io/kaishi/' });
  window.document.body.innerHTML = '<main id="app"></main><dialog id="sheet"></dialog><div id="toast" hidden></div><input id="json-file-input" type="file" hidden>';
  Object.defineProperty(window.navigator, 'standalone', { value: standalone, configurable: true });
  Object.defineProperty(window.navigator, 'storage', {
    value: {
      persisted: async () => true,
      persist: async () => true,
      estimate: async () => ({ usage: 1024, quota: 1024 * 1024 })
    }, configurable: true
  });
  window.matchMedia = () => ({ matches: standalone, addEventListener() {}, removeEventListener() {} });
  const visualViewport = new window.EventTarget();
  Object.defineProperty(visualViewport, 'height', { value: 844, writable: true, configurable: true });
  Object.defineProperty(window, 'visualViewport', { value: visualViewport, configurable: true });
  const idb = new IDBFactory();
  const globals = {
    window,
    document: window.document,
    navigator: window.navigator,
    location: window.location,
    localStorage: window.localStorage,
    indexedDB: idb,
    IDBKeyRange,
    File: window.File,
    Blob: window.Blob,
    Event: window.Event,
    CustomEvent: window.CustomEvent,
    HTMLElement: window.HTMLElement,
    HTMLDialogElement: window.HTMLDialogElement,
    matchMedia: window.matchMedia.bind(window),
    requestAnimationFrame: (callback) => setTimeout(callback, 0),
    cancelAnimationFrame: clearTimeout,
    confirm: () => true
  };
  for (const [name, value] of Object.entries(globals)) {
    Object.defineProperty(globalThis, name, { value, writable: true, configurable: true });
  }
  if (!window.HTMLDialogElement.prototype.showModal) {
    window.HTMLDialogElement.prototype.showModal = function showModal() { this.open = true; };
    window.HTMLDialogElement.prototype.close = function close() { this.open = false; };
  }
  return window;
}

async function waitFor(check, timeout = 3000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    const value = check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('画面の準備が時間内に終わりませんでした。');
}

test('Safari表示では設置案内だけを出す', async () => {
  const window = installDom({ standalone: false });
  await import(`../src/app.js?safari=${Date.now()}`);
  await waitFor(() => window.document.querySelector('.install-card'));
  assert.match(window.document.body.textContent, /ホーム画面に追加/);
  assert.equal(window.document.querySelector('[data-action="new-document"]'), null);
  window.close();
});

test('ホーム画面版で新規原稿を保存し玄関へ戻せる', async () => {
  const window = installDom({ standalone: true });
  const module = await import(`../src/app.js?standalone=${Date.now()}`);
  try {
    await waitFor(() => window.document.querySelector('.home-screen'));
    const create = window.document.querySelector('[data-action="new-document"]');
    assert.ok(create);
    create.click();
    const editor = await waitFor(() => window.document.querySelector('#editor'));
    const toolbarActions = [...window.document.querySelectorAll('.editor-toolbar [data-action]')]
      .map((button) => button.dataset.action);
    assert.deepEqual(toolbarActions, ['undo', 'redo', 'markdown-menu']);
    assert.equal(window.document.documentElement.style.getPropertyValue('--editor-viewport-height'), '844px');
    window.visualViewport.height = 420;
    window.visualViewport.dispatchEvent(new window.Event('resize'));
    assert.equal(window.document.documentElement.style.getPropertyValue('--editor-viewport-height'), '420px');

    window.document.querySelector('[data-action="markdown-menu"]').click();
    await waitFor(() => window.document.querySelector('#sheet[open]'));
    assert.match(window.document.querySelector('#sheet').textContent, /大見出し/);
    window.document.querySelector('[data-sheet-close]').click();

    editor.value = '雨の日\n\n# 見出し';
    editor.dispatchEvent(new window.Event('input', { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 1200));
    assert.match(window.document.querySelector('.save-state').textContent, /保存済み/);
    window.document.querySelector('[data-action="editor-back"]').click();
    await waitFor(() => window.document.querySelector('.home-screen'));
    const recent = window.document.querySelector('[data-action="open-document"]');
    assert.ok(recent);
    recent.click();
    const reopened = await waitFor(() => window.document.querySelector('#editor'));
    assert.equal(reopened.value, '雨の日\n\n# 見出し');

    reopened.dispatchEvent(new window.Event('compositionstart', { bubbles: true }));
    reopened.value += '変換中';
    reopened.dispatchEvent(new window.Event('input', { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 1100));
    assert.equal(module.runtime.editor.lastSavedBody, '雨の日\n\n# 見出し');
    reopened.dispatchEvent(new window.Event('compositionend', { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 1100));
    assert.equal(module.runtime.editor.lastSavedBody, '雨の日\n\n# 見出し変換中');

    reopened.value = 'あ'.repeat(50_000);
    reopened.dispatchEvent(new window.Event('input', { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 1100));
    window.document.querySelector('[data-action="editor-back"]').click();
    await waitFor(() => window.document.querySelector('.home-screen'));
    window.document.querySelector('[data-action="open-document"]').click();
    const longDocument = await waitFor(() => window.document.querySelector('#editor'));
    assert.equal(longDocument.value.length, 50_000);
    window.document.querySelector('[data-action="editor-back"]').click();
    await waitFor(() => window.document.querySelector('.home-screen'));
  } finally {
    module.runtime.guard?.destroy();
    window.close();
  }
});
