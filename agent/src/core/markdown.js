/* Markdown 渲染：先转义再拼 HTML；代码块渲染器由宿主注入（ESM 模块） */
/* 轻量 Markdown 渲染器 —— 无外部依赖、先转义再解析（防 XSS）
   支持：围栏代码块、行内代码、粗体/斜体/删除线、标题、有序/无序列表、
        引用、分割线、链接、表格                                        */
const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = s => String(s).replace(/[&<>"']/g, c => ESC[c]);

/* ---------------- 行内 ---------------- */
function inline(s) {
  s = s.replace(/`([^`\n]+)`/g, '<code class="md-code">$1</code>');
  s = s.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/(^|[^*\w])\*([^*\n]+)\*/g, '$1<em>$2</em>');
  s = s.replace(/~~([^~\n]+)~~/g, '<del>$1</del>');
  s = s.replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g,
    '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
  return s;
}

/* ---------------- 表格 ---------------- */
function tableFrom(lines, start) {
  const head = lines[start];
  const sep = lines[start + 1] || '';
  if (!/^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(sep) || !sep.includes('-')) return null;
  const cells = row => row.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map(c => c.trim());
  const th = cells(head), aligns = cells(sep).map(c =>
    c.startsWith(':') && c.endsWith(':') ? 'center' : c.endsWith(':') ? 'right' : 'left');
  let i = start + 2; const body = [];
  while (i < lines.length && lines[i].includes('|') && lines[i].trim()) { body.push(cells(lines[i])); i++; }
  const thead = '<tr>' + th.map((c, k) =>
    `<th style="text-align:${aligns[k] || 'left'}">${inline(c)}</th>`).join('') + '</tr>';
  const tbody = body.map(r => '<tr>' + r.map((c, k) =>
    `<td style="text-align:${aligns[k] || 'left'}">${inline(c)}</td>`).join('') + '</tr>').join('');
  return { html: `<div class="md-table-wrap"><table><thead>${thead}</thead><tbody>${tbody}</tbody></table></div>`, next: i };
}

/* ---------------- 主渲染 ---------------- */
const CODE_TOKEN = '\u0000C';
function render(src, codeRenderer) {
  if (!src) return '';
  const fences = [];
  // 1) 先抽出代码块（用占位符保护，避免内部被当成 markdown 解析）
  let text = String(src).replace(/```([\w+#.-]*)[ \t]*\r?\n([\s\S]*?)```/g, (m, lang, code) => {
    fences.push({ lang: (lang || '').toLowerCase(), code: code.replace(/\n$/, '') });
    return `${CODE_TOKEN}${fences.length - 1}\u0000`;
  });
  // 未闭合的代码块（流式中常见）也先兜住，避免闪烁成乱码
  text = text.replace(/```([\w+#.-]*)[ \t]*\r?\n([\s\S]*)$/, (m, lang, code) => {
    fences.push({ lang: (lang || '').toLowerCase(), code: code.replace(/\n$/, ''), open: true });
    return `${CODE_TOKEN}${fences.length - 1}\u0000`;
  });

  const lines = esc(text).split('\n');
  const out = [];
  let i = 0, para = [];

  const flushPara = () => {
    if (para.length) { out.push(`<p>${inline(para.join('<br>'))}</p>`); para = []; }
  };

  while (i < lines.length) {
    const ln = lines[i];

    // 代码块占位
    if (ln.indexOf(CODE_TOKEN) !== -1) {
      flushPara();
      const rest = ln; let m;
      const re = new RegExp(CODE_TOKEN + '(\\d+)\\u0000', 'g');
      let last = 0, buf = '';
      while ((m = re.exec(rest))) {
        buf += inline(rest.slice(last, m.index));
        // 正文里若恰好含字面量 \u0000C0\u0000（模型复述占位符时会出现），fences 里没有对应项——
        // 兜个空块，别让 codeRenderer(undefined) 把渲染整个炸掉
        const f = fences[+m[1]] || { lang: '', code: '' };
        buf += codeRenderer(f, f);
        last = m.index + m[0].length;
      }
      buf += inline(rest.slice(last));
      out.push(buf);
      i++; continue;
    }

    // 空行
    if (!ln.trim()) { flushPara(); i++; continue; }

    // 分割线
    if (/^\s*([-*_])\s*\1\s*\1[\s\-*_]*$/.test(ln)) { flushPara(); out.push('<hr>'); i++; continue; }

    // 标题
    const m = /^(#{1,6})\s+(.*)$/.exec(ln);
    if (m) { flushPara(); const lv = m[1].length; out.push(`<h${lv}>${inline(m[2])}</h${lv}>`); i++; continue; }

    // 表格
    if (ln.includes('|')) {
      const t = tableFrom(lines, i);
      if (t) { flushPara(); out.push(t.html); i = t.next; continue; }
    }

    // 引用
    if (/^\s*&gt;\s?/.test(ln)) {
      flushPara();
      const buf = [];
      while (i < lines.length && /^\s*&gt;\s?/.test(lines[i])) {
        buf.push(lines[i].replace(/^\s*&gt;\s?/, '')); i++;
      }
      out.push(`<blockquote>${inline(buf.join('<br>'))}</blockquote>`);
      continue;
    }

    // 列表
    if (/^\s*([-*+]|\d+\.)\s+/.test(ln)) {
      flushPara();
      const ordered = /^\s*\d+\.\s+/.test(ln);
      const items = [];
      const re = ordered ? /^\s*\d+\.\s+(.*)$/ : /^\s*[-*+]\s+(.*)$/;
      while (i < lines.length) {
        const mm = re.exec(lines[i]);
        if (!mm) break;
        items.push(`<li>${inline(mm[1])}</li>`); i++;
      }
      out.push(`<${ordered ? 'ol' : 'ul'}>${items.join('')}</${ordered ? 'ol' : 'ul'}>`);
      continue;
    }

    para.push(ln); i++;
  }
  flushPara();
  return out.join('\n');
}

export const MD = { render, esc };
