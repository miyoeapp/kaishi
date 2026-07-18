import { createId } from './utils.js';

const ACTIVE_KEY = 'kaishi-active-instance';
const CHANNEL_NAME = 'kaishi-instance-channel';
const SESSION_KEY = 'kaishi-instance-id';
const FRESH_MS = 8_000;

function readActive() {
  try { return JSON.parse(localStorage.getItem(ACTIVE_KEY) || 'null'); }
  catch { return null; }
}

export class InstanceGuard {
  constructor({ beforeRelinquish, onTakenOver } = {}) {
    let rememberedId = null;
    try { rememberedId = globalThis.sessionStorage?.getItem(SESSION_KEY); } catch { /* 使用できない環境では毎回作る */ }
    this.id = rememberedId || createId('instance');
    try { globalThis.sessionStorage?.setItem(SESSION_KEY, this.id); } catch { /* 多重起動保護はlocalStorage側で継続する */ }
    this.beforeRelinquish = beforeRelinquish;
    this.onTakenOver = onTakenOver;
    this.channel = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel(CHANNEL_NAME) : null;
    this.timer = null;
    this.active = false;
    this.pendingTakeover = null;
    this.channel?.addEventListener('message', (event) => this.handleMessage(event.data));
  }

  hasFreshOther() {
    const record = readActive();
    return Boolean(record && record.id !== this.id && Date.now() - record.at < FRESH_MS);
  }

  start() {
    if (this.hasFreshOther()) return false;
    this.claim();
    return true;
  }

  claim() {
    this.active = true;
    this.writeHeartbeat();
    clearInterval(this.timer);
    this.timer = setInterval(() => this.writeHeartbeat(), 2_500);
    this.channel?.postMessage({ type: 'claimed', from: this.id });
  }

  writeHeartbeat() {
    if (!this.active) return;
    try { localStorage.setItem(ACTIVE_KEY, JSON.stringify({ id: this.id, at: Date.now() })); }
    catch { /* IndexedDB側でも保存衝突を検査するため、ここでは停止しない */ }
  }

  async requestTakeover() {
    const other = readActive()?.id;
    if (!other || Date.now() - (readActive()?.at ?? 0) >= FRESH_MS) {
      this.claim();
      return { forced: true };
    }
    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        this.pendingTakeover = null;
        const record = readActive();
        if (record?.id === other && Date.now() - record.at < FRESH_MS) {
          resolve({ blocked: true });
        } else {
          this.claim();
          resolve({ forced: true });
        }
      }, 4_000);
      this.pendingTakeover = () => {
        clearTimeout(timeout);
        this.pendingTakeover = null;
        this.claim();
        resolve({ forced: false });
      };
      this.channel?.postMessage({ type: 'takeover-request', from: this.id, target: other });
    });
  }

  async handleMessage(message) {
    if (!message || message.from === this.id) return;
    if (message.type === 'takeover-request' && this.active && (!message.target || message.target === this.id)) {
      try { await this.beforeRelinquish?.(); } catch { return; }
      this.release(false);
      this.channel?.postMessage({ type: 'takeover-ready', from: this.id, target: message.from });
      this.onTakenOver?.();
    } else if (message.type === 'takeover-ready' && message.target === this.id) {
      this.pendingTakeover?.();
    } else if (message.type === 'claimed' && this.active) {
      const record = readActive();
      if (record?.id !== this.id && record?.id === message.from) {
        this.release(false);
        this.onTakenOver?.();
      }
    }
  }

  release(clearRecord = true) {
    this.active = false;
    clearInterval(this.timer);
    this.timer = null;
    if (clearRecord) {
      const record = readActive();
      if (record?.id === this.id) localStorage.removeItem(ACTIVE_KEY);
    }
  }

  destroy() {
    this.release();
    this.channel?.close();
  }
}
