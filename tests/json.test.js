import test from 'node:test';
import assert from 'node:assert/strict';
import { validateImport } from '../src/library.js';

test('共通JSONの最低限の形を受け入れる', () => {
  const payload = { format: 'kaishi-common-json', schemaVersion: 1, exportScope: 'library', documents: [], folders: [] };
  assert.equal(validateImport(payload).scope, 'library');
});

test('別形式と新しすぎる形式を拒否する', () => {
  assert.throws(() => validateImport({ format: 'other', schemaVersion: 1, exportScope: 'library', documents: [], folders: [] }), /懐紙・文机用/);
  assert.throws(() => validateImport({ format: 'kaishi-common-json', schemaVersion: 99, exportScope: 'library', documents: [], folders: [] }), /新しい形式/);
});

test('文机が正式項目名で書き出したJSONを受け入れる', () => {
  const payload = { sourceApp: 'fuzukue', schemaVersion: 1, exportScope: 'file', documents: [], folders: [] };
  assert.equal(validateImport(payload).scope, 'document');
});
