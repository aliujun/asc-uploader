/* 轻量 Markdown 渲染器：为更新弹窗的「更新日志」提供渲染能力。
   覆盖 Release notes 常用语法：标题、无序/有序列表、围栏代码块、表格、粗体、斜体、行内代码、链接、分段；
   不支持的语法（引用块、嵌套列表、图片等）降级为原样文本显示，不丢失信息。
   渲染前先做 HTML 转义防注入，链接仅允许 http/https。
   该模块不依赖 DOM，可在 Node 中直接 import 做单元测试。 */

/** HTML 转义（与 common.js 同实现；此处独立一份以便 Node 环境无 DOM 测试） */
function escapeHtml(text) {
  return String(text == null ? '' : text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * 行内 Markdown：行内代码、粗体、斜体、链接（URL 仅允许 http/https）
 * @param {string} text 已 HTML 转义的文本
 * @returns {string} 渲染后的 HTML
 */
function inlineMarkdown(text) {
  return text
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*]+)\*/g, '<em>$1</em>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
}

/**
 * 判断表格分隔行（形如 | --- | :---: | ---: |）
 * @param {string} line 已 trim 的行
 * @returns {boolean} 是否分隔行
 */
function isTableSeparator(line) {
  return /^\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?$/.test(line);
}

/**
 * 按竖线拆分行内容并去掉首尾空列
 * @param {string} line 已 trim 的表格行
 * @returns {Array<string>} 单元格文本数组
 */
function splitTableRow(line) {
  return line.replace(/^\|/, '').replace(/\|$/, '').split('|').map((cell) => cell.trim());
}

/**
 * 渲染表格为 HTML（单元格内容跑行内 Markdown，列数以表头为准）
 * @param {Array<string>} rows 表格行（含表头与分隔行）
 * @returns {string} table HTML
 */
function renderTable(rows) {
  const header = splitTableRow(rows[0]);
  const bodyRows = rows.slice(2).map(splitTableRow);
  const head = `<thead><tr>${header.map((h) => `<th>${inlineMarkdown(h)}</th>`).join('')}</tr></thead>`;
  const body = `<tbody>${bodyRows
    .map((cells) => `<tr>${header.map((_, i) => `<td>${inlineMarkdown(cells[i] || '')}</td>`).join('')}</tr>`)
    .join('')}</tbody>`;
  return `<table>${head}${body}</table>`;
}

/**
 * 轻量 Markdown 渲染主入口
 * @param {string} markdown 原始 markdown 文本
 * @returns {string} 渲染后的 HTML
 */
export function renderMarkdown(markdown) {
  const lines = escapeHtml(markdown).split(/\r?\n/);
  const out = [];
  let listTag = null;
  let para = [];
  let codeLines = null;
  let tableRows = [];

  const flushPara = () => {
    if (para.length > 0) {
      out.push(`<p>${para.map(inlineMarkdown).join('<br>')}</p>`);
      para = [];
    }
  };
  const closeList = () => {
    if (listTag) {
      out.push(`</${listTag}>`);
      listTag = null;
    }
  };
  const flushTable = () => {
    const rows = tableRows;
    tableRows = [];
    if (rows.length >= 2 && isTableSeparator(rows[1])) {
      flushPara();
      closeList();
      out.push(renderTable(rows));
      return;
    }
    // 不是合法表格（缺分隔行等），按普通段落还原原文本
    para.push(...rows);
  };

  for (const raw of lines) {
    // 围栏代码块开/关（块内内容不再解析任何 Markdown）
    if (/^```/.test(raw.trim())) {
      if (codeLines) {
        flushPara();
        closeList();
        flushTable();
        out.push(`<pre class="version-notes-code"><code>${codeLines.join('\n')}</code></pre>`);
        codeLines = null;
      } else {
        flushPara();
        closeList();
        flushTable();
        codeLines = [];
      }
      continue;
    }
    if (codeLines) {
      codeLines.push(raw);
      continue;
    }
    const line = raw.trim();
    if (!line) {
      flushPara();
      closeList();
      flushTable();
      continue;
    }
    // 表格行（GitHub 风格：以 | 开头），连续收集后统一解析
    if (/^\|/.test(line)) {
      flushPara();
      closeList();
      tableRows.push(line);
      continue;
    }
    flushTable();
    const heading = line.match(/^#{1,6}\s+(.+)$/);
    if (heading) {
      flushPara();
      closeList();
      out.push('<h3>' + inlineMarkdown(heading[1]) + '</h3>'); // 弹窗内统一 h3，视觉不至于过大
      continue;
    }
    const bullet = line.match(/^[-*]\s+(.+)$/);
    const ordered = line.match(/^\d+[.)]\s+(.+)$/);
    if (bullet || ordered) {
      flushPara();
      const tag = bullet ? 'ul' : 'ol';
      if (listTag !== tag) {
        closeList();
        out.push(`<${tag}>`);
        listTag = tag;
      }
      out.push(`<li>${inlineMarkdown((bullet || ordered)[1])}</li>`);
      continue;
    }
    para.push(line);
  }
  // 未闭合的代码块按原样输出剩余内容
  if (codeLines) {
    out.push(`<pre class="version-notes-code"><code>${codeLines.join('\n')}</code></pre>`);
  }
  // 先 flushTable（伪表格会还原进段落缓冲），再输出段落，保证还原内容不丢失
  flushTable();
  flushPara();
  closeList();
  return out.join('');
}
