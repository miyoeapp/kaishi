export function fileFromText(name, text, type = 'text/plain;charset=utf-8') {
  return new File([text], name, { type, lastModified: Date.now() });
}

export async function copyPlainText(text) {
  if (!navigator.clipboard?.writeText) throw new Error('この画面ではコピー機能を使用できません。');
  await navigator.clipboard.writeText(String(text));
}

export async function copyRichText(html, plainText) {
  if (!navigator.clipboard?.write || typeof ClipboardItem === 'undefined') {
    throw new Error('書式付きコピーを使用できません。');
  }
  const item = new ClipboardItem({
    'text/html': new Blob([html], { type: 'text/html' }),
    'text/plain': new Blob([plainText], { type: 'text/plain' })
  });
  await navigator.clipboard.write([item]);
}

function downloadFile(file) {
  const url = URL.createObjectURL(file);
  const link = document.createElement('a');
  link.href = url;
  link.download = file.name;
  link.hidden = true;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}

export async function shareFile(file, title = '懐紙から共有') {
  if (navigator.share && (!navigator.canShare || navigator.canShare({ files: [file] }))) {
    try {
      await navigator.share({ title, files: [file] });
      return { method: 'share' };
    } catch (error) {
      if (error?.name === 'AbortError') {
        const cancelled = new Error('共有を中止しました。');
        cancelled.cancelled = true;
        throw cancelled;
      }
    }
  }
  downloadFile(file);
  return { method: 'download' };
}

export async function readJsonFile(file) {
  if (!file) throw new Error('ファイルが選ばれていません。');
  const maxBytes = 50 * 1024 * 1024;
  if (file.size > maxBytes) throw new Error('このJSONは50MBを超えているため、安全に読み込めません。');
  let text;
  try {
    text = await file.text();
  } catch {
    throw new Error('ファイルを読み取れませんでした。');
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error('JSONの形が壊れているため読み込めません。');
  }
}

