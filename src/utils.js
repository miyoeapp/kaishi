export function createId(prefix = 'item') {
  const uuid = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return `${prefix}-${uuid}`;
}

export function nowIso() {
  return new Date().toISOString();
}

export function deepClone(value) {
  return typeof structuredClone === 'function'
    ? structuredClone(value)
    : JSON.parse(JSON.stringify(value));
}

export function escapeHtml(value = '') {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

export function safeFileName(value, fallback = '無題') {
  const cleaned = String(value ?? '')
    .normalize('NFC')
    .replace(/[\\/:*?"<>|\u0000-\u001F]/g, '＿')
    .replace(/[. ]+$/g, '')
    .trim();
  return cleaned || fallback;
}

export function timestampForFile(date = new Date()) {
  const pad = (number) => String(number).padStart(2, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}`;
}

export function formatDateTime(value) {
  if (!value) return '記録なし';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '日時不明';
  return new Intl.DateTimeFormat('ja-JP', {
    year: 'numeric', month: 'numeric', day: 'numeric',
    hour: '2-digit', minute: '2-digit'
  }).format(date);
}

export function formatShortDate(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const diff = Date.now() - date.getTime();
  if (diff >= 0 && diff < 60_000) return 'たった今';
  if (diff >= 0 && diff < 3_600_000) return `${Math.max(1, Math.floor(diff / 60_000))}分前`;
  if (diff >= 0 && diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}時間前`;
  return new Intl.DateTimeFormat('ja-JP', { month: 'numeric', day: 'numeric' }).format(date);
}

export function stripMarkdown(source = '') {
  return String(source)
    .replace(/```[^\n]*\n([\s\S]*?)```/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/\{([^{}|]+)\|([^{}]+)\}/g, '$1')
    .replace(/\|([^《》\n|]{1,60})《([^《》\n]{1,60})》/g, '$1')
    .replace(/^(?:\s{0,3}#{1,6}|\s{0,3}>|\s*[-+*]|\s*\d+\.)\s+/gm, '')
    .replace(/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/gm, '')
    .replace(/\*\*|__|~~|(?<!\*)\*(?!\*)|(?<!_)_(?!_)/g, '')
    .replace(/\\([\\`*{}\[\]()#+\-.!_>])/g, '$1');
}

export function countCharacters(source = '') {
  return [...stripMarkdown(source).replace(/[\s\u3000]/gu, '')].length;
}

export function sortByOrder(items) {
  return [...items].sort((a, b) => {
    const order = (a.order ?? 0) - (b.order ?? 0);
    if (order !== 0) return order;
    return String(b.createdAt ?? '').localeCompare(String(a.createdAt ?? ''));
  });
}

export function nextTopOrder(items) {
  if (!items.length) return 0;
  return Math.min(...items.map((item) => Number(item.order ?? 0))) - 1;
}

export function debounce(fn, wait = 250) {
  let timer;
  const wrapped = (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), wait);
  };
  wrapped.cancel = () => clearTimeout(timer);
  return wrapped;
}

export function daysBetween(older, newer = new Date()) {
  if (!older) return Infinity;
  const start = new Date(older).getTime();
  const end = new Date(newer).getTime();
  return Math.floor((end - start) / 86_400_000);
}

export function isSameLocalDate(value, date = new Date()) {
  if (!value) return false;
  const other = new Date(value);
  return other.getFullYear() === date.getFullYear()
    && other.getMonth() === date.getMonth()
    && other.getDate() === date.getDate();
}

