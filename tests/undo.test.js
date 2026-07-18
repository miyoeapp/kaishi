import test from 'node:test';
import assert from 'node:assert/strict';
import { UndoManager } from '../src/undo.js';

test('戻ると進むで本文と選択位置を往復する', () => {
  const manager = new UndoManager(50);
  const before = { value: '雨', start: 1, end: 1 };
  const after = { value: '雨の日', start: 3, end: 3 };
  manager.record(before);
  assert.deepEqual(manager.undo(after), before);
  assert.deepEqual(manager.redo(before), after);
});

test('上限を超えた古い操作を捨てる', () => {
  const manager = new UndoManager(2);
  manager.record({ value: '1', start: 1, end: 1 });
  manager.record({ value: '2', start: 1, end: 1 });
  manager.record({ value: '3', start: 1, end: 1 });
  assert.equal(manager.undoStack.length, 2);
  assert.equal(manager.undoStack[0].value, '2');
});

