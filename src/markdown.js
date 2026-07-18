import { escapeHtml, stripMarkdown } from './utils.js';

function safeUrl(raw) {
  const value = String(raw ?? '').trim();
  if (/^(https?:|mailto:)/i.test(value)) return escapeHtml(value);
  return '#';
}

export function renderInline(source = '') {
  let html = escapeHtml(source);
  html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, label, url) => `<a href="${safeUrl(url)}" rel="noopener noreferrer">${label}</a>`);
  html = html.replace(/\{([^{}|]+)\|([^{}]+)\}/g, '<ruby>$1<rp>（</rp><rt>$2</rt><rp>）</rp></ruby>');
  html = html.replace(/\|([^《》\n|]{1,60})《([^《》\n]{1,60})》/g, '<ruby>$1<rp>（</rp><rt>$2</rt><rp>）</rp></ruby>');
  html = html.replace(/`([^`]+)`/g, '<code>$1</code>');
  html = html.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/__([^_\n]+)__/g, '<strong>$1</strong>');
  html = html.replace(/~~([^~\n]+)~~/g, '<del>$1</del>');
  html = html.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>');
  html = html.replace(/(^|[^_])_([^_\n]+)_(?!_)/g, '$1<em>$2</em>');
  return html;
}

export function renderMarkdown(source = '') {
  const lines = String(source).replace(/\r\n?/g, '\n').split('\n');
  const output = [];
  let listType = null;
  let quoteOpen = false;
  let codeOpen = false;

  const closeList = () => {
    if (listType) output.push(`</${listType}>`);
    listType = null;
  };
  const closeQuote = () => {
    if (quoteOpen) output.push('</blockquote>');
    quoteOpen = false;
  };

  for (const line of lines) {
    if (/^```/.test(line)) {
      closeList(); closeQuote();
      output.push(codeOpen ? '</code></pre>' : '<pre><code>');
      codeOpen = !codeOpen;
      continue;
    }
    if (codeOpen) {
      output.push(`${escapeHtml(line)}\n`);
      continue;
    }
    if (!line.trim()) {
      closeList(); closeQuote();
      output.push('<div class="blank-line" aria-hidden="true"></div>');
      continue;
    }
    const heading = line.match(/^(#{1,3})\s+(.+)$/);
    if (heading) {
      closeList(); closeQuote();
      const level = heading[1].length;
      output.push(`<h${level}>${renderInline(heading[2])}</h${level}>`);
      continue;
    }
    if (/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      closeList(); closeQuote(); output.push('<hr>'); continue;
    }
    const quote = line.match(/^>\s?(.*)$/);
    if (quote) {
      closeList();
      if (!quoteOpen) { output.push('<blockquote>'); quoteOpen = true; }
      output.push(`<p>${renderInline(quote[1])}</p>`);
      continue;
    }
    closeQuote();
    const unordered = line.match(/^\s*[-+*]\s+(.+)$/);
    const ordered = line.match(/^\s*\d+\.\s+(.+)$/);
    if (unordered || ordered) {
      const nextType = ordered ? 'ol' : 'ul';
      if (listType !== nextType) { closeList(); output.push(`<${nextType}>`); listType = nextType; }
      output.push(`<li>${renderInline((ordered || unordered)[1])}</li>`);
      continue;
    }
    closeList();
    output.push(`<p>${renderInline(line)}</p>`);
  }
  closeList(); closeQuote();
  if (codeOpen) output.push('</code></pre>');
  return output.join('\n');
}

export function markdownToPlainText(source = '') {
  return stripMarkdown(source).replace(/\n{3,}/g, '\n\n');
}

