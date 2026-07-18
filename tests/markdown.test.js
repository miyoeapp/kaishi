import test from 'node:test';
import assert from 'node:assert/strict';
import { markdownToPlainText, renderMarkdown } from '../src/markdown.js';

test('見出し・太字・引用を描画する', () => {
  const html = renderMarkdown('# 見出し\n\n**太字**\n> 引用');
  assert.match(html, /<h1>見出し<\/h1>/);
  assert.match(html, /<strong>太字<\/strong>/);
  assert.match(html, /<blockquote>/);
});

test('ルビを描画する', () => {
  const html = renderMarkdown('{懐紙|かいし}');
  assert.match(html, /<ruby>懐紙/);
  assert.match(html, /<rt>かいし<\/rt>/);
});

test('元原稿のHTMLを実行可能な形で通さない', () => {
  const html = renderMarkdown('<script>alert(1)</script>');
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /&lt;script&gt;/);
});

test('危険なリンクを無効化する', () => {
  const html = renderMarkdown('[押す](javascript:alert(1))');
  assert.match(html, /href="#"/);
  assert.doesNotMatch(html, /href="javascript:/);
});

test('プレーン本文ではMarkdown記号を外す', () => {
  assert.equal(markdownToPlainText('## 見出し\n**本文**'), '見出し\n本文');
});

