import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, normalize } from 'node:path';
import puppeteer from 'puppeteer-core';

mkdirSync('artifacts', { recursive: true });
mkdirSync('/tmp/kaishi-browser', { recursive: true });
process.env.TMPDIR = '/tmp/kaishi-browser';
const { default: chromium, inflate } = await import('@sparticuz/chromium');
chromium.setGraphicsMode = false;
const executablePath = existsSync('/tmp/kaishi-browser/chromium')
  ? '/tmp/kaishi-browser/chromium'
  : await inflate('node_modules/@sparticuz/chromium/bin/chromium.br');
const browser = await puppeteer.launch({
  executablePath,
  args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--single-process'],
  headless: 'shell',
  userDataDir: mkdtempSync('/tmp/kaishi-profile-'),
  defaultViewport: { width: 390, height: 844, deviceScaleFactor: 2 }
});
console.log('ブラウザ起動');

const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.png': 'image/png' };
const server = createServer((request, response) => {
  const pathname = new URL(request.url, 'http://127.0.0.1').pathname;
  const relative = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const filePath = normalize(join(process.cwd(), relative));
  if (!filePath.startsWith(process.cwd()) || !existsSync(filePath) || !statSync(filePath).isFile()) {
    response.writeHead(404); response.end('not found'); return;
  }
  response.writeHead(200, { 'Content-Type': mime[extname(filePath)] ?? 'application/octet-stream' });
  response.end(readFileSync(filePath));
});
await new Promise((resolve) => server.listen(4173, '127.0.0.1', resolve));
console.log('確認用サーバー起動');

const page = await browser.newPage();
const problems = [];
page.on('pageerror', (error) => problems.push(`pageerror: ${error.message}`));
page.on('console', (message) => {
  if (message.type() === 'error') problems.push(`console: ${message.text()}`);
});

await page.goto('http://127.0.0.1:4173/?dev=1', { waitUntil: 'domcontentloaded', timeout: 10_000 });
console.log('玄関URL読込');
await new Promise((resolve) => setTimeout(resolve, 800));
console.log(`画面本文: ${(await page.evaluate(() => document.body.innerText)).slice(0, 300)}`);
if (problems.length) console.log(problems.join('\n'));
await page.waitForFunction(() => Boolean(document.querySelector('.home-screen')), { timeout: 10_000 });
await page.screenshot({ path: 'artifacts/home.png', fullPage: true });
console.log('玄関撮影');

await page.click('[data-action="new-document"]');
await page.waitForFunction(() => Boolean(document.querySelector('#editor')), { timeout: 10_000 });
await page.evaluate(() => {
  const editor = document.querySelector('#editor');
  editor.value = '# 第三章　雨の日\n\n窓を叩く雨の音で目が覚めた。\nまだ朝には少し早い。\n\n**ここは後で直す。**';
  editor.dispatchEvent(new Event('input', { bubbles: true }));
});
await new Promise((resolve) => setTimeout(resolve, 1200));
await page.screenshot({ path: 'artifacts/editor.png', fullPage: true });
console.log('エディタ撮影');

await page.click('[data-action="document-menu"]');
await page.waitForFunction(() => Boolean(document.querySelector('#sheet[open]')), { timeout: 10_000 });
await page.screenshot({ path: 'artifacts/document-menu.png', fullPage: true });
console.log('原稿メニュー撮影');

await page.click('[data-action="open-preview"]');
await page.waitForFunction(() => Boolean(document.querySelector('.preview-screen')), { timeout: 10_000 });
await page.screenshot({ path: 'artifacts/preview.png', fullPage: true });
console.log('プレビュー撮影');

await page.setOfflineMode(true);
await page.goto('http://127.0.0.1:4173/?dev=1', { waitUntil: 'domcontentloaded', timeout: 10_000 });
await page.waitForFunction(() => Boolean(document.querySelector('.home-screen')), { timeout: 10_000 });
await page.click('[data-action="open-document"]');
await page.waitForFunction(() => document.querySelector('#editor')?.value.includes('窓を叩く雨の音'), { timeout: 10_000 });
console.log('機内モード相当で起動・原稿再表示を確認');
await page.setOfflineMode(false);

await page.goto('http://127.0.0.1:4173/', { waitUntil: 'domcontentloaded', timeout: 10_000 });
await page.waitForFunction(() => Boolean(document.querySelector('.install-card')), { timeout: 10_000 });
await page.screenshot({ path: 'artifacts/install.png', fullPage: true });
console.log('設置案内撮影');

await browser.close();
await new Promise((resolve) => server.close(resolve));
if (problems.length) {
  throw new Error(`ブラウザ内でエラーを検出しました。\n${problems.join('\n')}`);
}
console.log('home / editor / document-menu / preview / install の画面確認用画像を作成しました。');
