import test from 'node:test';
import assert from 'node:assert/strict';
import { countCharacters, safeFileName, stripMarkdown, timestampForFile } from '../src/utils.js';

test('文字数は空白・改行・Markdown記号を数えない', () => {
  assert.equal(countCharacters(' **雨** の日\n「朝」'), 6);
  assert.equal(countCharacters('# 見出し'), 3);
  assert.equal(countCharacters('{漢字|かんじ}'), 2);
});

test('句読点と括弧は文字数に含める', () => {
  assert.equal(countCharacters('「雨。」'), 4);
});

test('リンクは表示文字だけを残す', () => {
  assert.equal(stripMarkdown('[懐紙](https://example.com)'), '懐紙');
});

test('ファイル名に使えない記号を安全に置き換える', () => {
  assert.equal(safeFileName('雨:朝/夜?'), '雨＿朝＿夜＿');
  assert.equal(safeFileName('   '), '無題');
});

test('書き出し日時は固定形式になる', () => {
  assert.equal(timestampForFile(new Date(2026, 6, 19, 8, 5)), '20260719-0805');
});

