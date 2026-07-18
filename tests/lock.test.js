import test from 'node:test';
import assert from 'node:assert/strict';
import { InstanceGuard } from '../src/lock.js';

class MemoryStorage {
  constructor() { this.values = new Map(); }
  getItem(key) { return this.values.has(key) ? this.values.get(key) : null; }
  setItem(key, value) { this.values.set(key, String(value)); }
  removeItem(key) { this.values.delete(key); }
}

test('同じ画面の再読み込みは多重起動と誤判定しない', () => {
  Object.defineProperty(globalThis, 'localStorage', { value: new MemoryStorage(), configurable: true });
  Object.defineProperty(globalThis, 'sessionStorage', { value: new MemoryStorage(), configurable: true });
  const first = new InstanceGuard();
  const reloaded = new InstanceGuard();
  try {
    assert.equal(first.start(), true);
    assert.equal(reloaded.start(), true);
    assert.equal(reloaded.id, first.id);
  } finally {
    first.destroy();
    reloaded.destroy();
  }
});

test('別の画面は先に開いている懐紙を検知する', () => {
  Object.defineProperty(globalThis, 'localStorage', { value: new MemoryStorage(), configurable: true });
  Object.defineProperty(globalThis, 'sessionStorage', { value: new MemoryStorage(), configurable: true });
  const first = new InstanceGuard();
  assert.equal(first.start(), true);
  Object.defineProperty(globalThis, 'sessionStorage', { value: new MemoryStorage(), configurable: true });
  const second = new InstanceGuard();
  try {
    assert.equal(second.start(), false);
    assert.notEqual(second.id, first.id);
  } finally {
    first.destroy();
    second.destroy();
  }
});
