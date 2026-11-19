/* 全局通用工具与 document 级监听（唯一注册点，各组件共用） */

/**
 * 显示提示信息
 * @param {string} message 提示内容
 * @param {boolean} [isError] 是否为错误样式
 * @returns {void}
 */
export function toast(message, isError) {
  const el = document.getElementById('toast');
  el.textContent = message;
  el.classList.toggle('err', Boolean(isError));
  el.classList.remove('hidden');
  clearTimeout(el._timer);
  el._timer = setTimeout(() => el.classList.add('hidden'), 3000);
}

/**
 * 请求 JSON 接口
 * @param {string} url 地址
 * @param {Object} [opts] fetch 配置
 * @returns {Promise<Object>} 响应 JSON，失败时抛出带 error 信息的异常
 */
export async function api(url, opts) {
  let response;
  try {
    response = await fetch(url, opts);
  } catch {
    throw new Error('无法连接本地服务，请确认服务正在运行，然后刷新页面');
  }
  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    throw new Error(`响应解析失败：${text.slice(0, 120)}`);
  }
  if (!response.ok) {
    throw new Error((data && data.error) || `请求失败（HTTP ${response.status}）`);
  }
  return data;
}

/**
 * 触发浏览器保存文件：优先弹出"另存为"对话框由用户选择保存位置，
 * 浏览器不支持 File System Access API 时回退为直接下载到默认目录
 * @param {string} filename 建议的文件名
 * @param {string|Blob} content 内容
 * @param {string} [mime] MIME 类型
 * @returns {Promise<void>}
 */
export async function downloadFile(filename, content, mime) {
  const blob = content instanceof Blob ? content : new Blob([content], { type: mime || 'text/plain' });
  if (window.showSaveFilePicker) {
    try {
      const dotIndex = filename.lastIndexOf('.');
      const ext = dotIndex >= 0 ? filename.slice(dotIndex) : '';
      const handle = await window.showSaveFilePicker({
        suggestedName: filename,
        types: ext
          ? [{ description: `${ext.slice(1).toUpperCase()} 文件`, accept: { 'application/octet-stream': [ext] } }]
          : undefined,
      });
      const writable = await handle.createWritable();
      await writable.write(blob);
      await writable.close();
      return;
    } catch (err) {
      if (err.name === 'AbortError') {
        return; // 用户取消保存
      }
      // 其它异常（如用户手势过期）回退为直接下载
    }
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

/**
 * DOM 快捷选择
 * @param {string} id 元素 ID
 * @returns {HTMLElement} 元素
 */
export function $(id) {
  return document.getElementById(id);
}

/**
 * 格式化字节大小
 * @param {number} bytes 字节数
 * @returns {string} 可读大小
 */
export function fmtSize(bytes) {
  if (!Number.isFinite(bytes)) {
    return '-';
  }
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i += 1;
  }
  return `${value.toFixed(value >= 100 || i === 0 ? 0 : 2)} ${units[i]}`;
}

/**
 * HTML 转义防注入
 * @param {string} text 原文本
 * @returns {string} 转义后文本
 */
export function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text == null ? '' : String(text);
  return div.innerHTML;
}

/**
 * 按钮加载态包装：执行期间禁用按钮并显示加载文案，防止重复点击
 * @param {HTMLButtonElement} button 按钮元素
 * @param {string} loadingText 加载中显示的文字
 * @param {() => (void|Promise<void>)} fn 要执行的异步操作
 * @returns {Promise<void>}
 */
export async function withLoading(button, loadingText, fn) {
  if (button.disabled) {
    return;
  }
  button.disabled = true;
  const originalText = button.textContent;
  button.textContent = loadingText;
  try {
    await fn();
  } finally {
    button.textContent = originalText;
    button.disabled = false;
  }
}

/**
 * 将原生 select 增强为自定义下拉：隐藏原生控件，渲染样式可控的触发按钮与选项列表。
 * 原生 select 的 value 读写与 change 事件保持不变，业务代码零改动。
 * @param {HTMLSelectElement} select 原生下拉框
 * @returns {void}
 */
export function enhanceSelect(select) {
  if (select._enhanced) {
    return;
  }
  select._enhanced = true;
  select.style.display = 'none';

  const wrap = document.createElement('div');
  wrap.className = 'dropdown';
  select.parentNode.insertBefore(wrap, select);
  wrap.appendChild(select);

  const trigger = document.createElement('button');
  trigger.type = 'button';
  trigger.className = 'dropdown-trigger';
  const menu = document.createElement('div');
  menu.className = 'dropdown-menu hidden';
  wrap.appendChild(trigger);
  wrap.appendChild(menu);

  /**
   * 按当前 select 的选项重建下拉列表
   * @returns {void}
   */
  function rebuildMenu() {
    menu.innerHTML = '';
    Array.from(select.options).forEach((opt) => {
      const item = document.createElement('div');
      item.className = `dropdown-item${opt.value === select.value ? ' selected' : ''}`;
      item.textContent = opt.textContent;
      item.onclick = () => {
        select.value = opt.value;
        select.dispatchEvent(new Event('change', { bubbles: true }));
        menu.classList.add('hidden');
      };
      menu.appendChild(item);
    });
  }

  /**
   * 同步触发按钮显示为当前选中项文本
   * @returns {void}
   */
  function updateTrigger() {
    const current = select.options[select.selectedIndex];
    trigger.textContent = current ? current.textContent : '请选择';
    trigger.classList.toggle('placeholder', !select.value);
  }

  trigger.onclick = () => {
    const hidden = menu.classList.contains('hidden');
    document.querySelectorAll('.dropdown-menu:not(.hidden)').forEach((m) => m.classList.add('hidden'));
    if (hidden) {
      rebuildMenu();
      menu.classList.remove('hidden');
    }
  };

  // 业务代码重建 options（innerHTML）后自动同步按钮文本
  new MutationObserver(updateTrigger).observe(select, { childList: true });

  // 拦截 value 赋值：JS 直接设置 select.value 时同步按钮
  const descriptor = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value');
  Object.defineProperty(select, 'value', {
    get: descriptor.get,
    set(v) {
      descriptor.set.call(this, v);
      updateTrigger();
    },
  });

  updateTrigger();
}

/**
 * 为输入框绑定回车触发（textarea 不适用）
 * @param {string} inputId 输入框 ID
 * @param {() => void} handler 回车时执行的回调
 * @returns {void}
 */
export function bindEnter(inputId, handler) {
  $(inputId).addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      handler();
    }
  });
}

/**
 * 点击弹窗遮罩（非内容区）关闭弹窗（由注册器在模板注入后统一调用一次）
 * @returns {void}
 */
export function bindModalBackdropClose() {
  document.querySelectorAll('.modal').forEach((modal) => {
    modal.addEventListener('click', (event) => {
      if (event.target === modal) {
        modal.classList.add('hidden');
      }
    });
  });
}

/**
 * 计算剩余有效天数
 * @param {string} expirationDate 到期时间（ISO 字符串）
 * @returns {number|null} 剩余天数（负数表示已过期），无有效期或无效日期时返回 null
 */
export function daysLeft(expirationDate) {
  if (!expirationDate) {
    return null;
  }
  const diff = Math.ceil((new Date(expirationDate).getTime() - Date.now()) / 86400000);
  return Number.isFinite(diff) ? diff : null;
}

/**
 * 生成剩余天数徽章 HTML（红 ≤30 天/已过期、黄 31~60 天、绿 >60 天）
 * @param {string} expirationDate 到期时间（ISO 字符串）
 * @returns {string} 徽章 HTML，无有效期时返回空串
 */
export function expiryBadgeHtml(expirationDate) {
  const left = daysLeft(expirationDate);
  if (left === null) {
    return '';
  }
  if (left < 0) {
    return `<span class="badge err">已过期 ${-left} 天</span>`;
  }
  if (left <= 30) {
    return `<span class="badge err">剩 ${left} 天</span>`;
  }
  if (left <= 60) {
    return `<span class="badge warn">剩 ${left} 天</span>`;
  }
  return `<span class="badge ok">剩 ${left} 天</span>`;
}

/**
 * 格式化日期为本地日期文本
 * @param {string} iso ISO 时间字符串
 * @returns {string} 本地日期，无效时返回 '-'
 */
export function formatDate(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return '-';
  }
  return date.toLocaleDateString('zh-CN');
}

/**
 * 关闭页面上所有已打开的 ⓘ 提示
 * @returns {void}
 */
function closeAllHints() {
  document.querySelectorAll('.hint-wrap.open').forEach((wrap) => wrap.classList.remove('open'));
}

// ⓘ 提示点击开关（事件委托，document 级只注册一次）
document.addEventListener('click', (event) => {
  const icon = event.target.closest('.hint-icon');
  if (icon) {
    event.preventDefault();
    const wrap = icon.closest('.hint-wrap');
    const wasOpen = wrap.classList.contains('open');
    closeAllHints();
    if (!wasOpen) {
      wrap.classList.add('open');
    }
    return;
  }
  // 点击提示内容本身（含"了解更多"链接）不关闭
  if (event.target.closest('.hint-tip')) {
    return;
  }
  closeAllHints();
});

// 点击下拉组件外部时关闭所有下拉列表（document 级只注册一次）
document.addEventListener('click', (event) => {
  document.querySelectorAll('.dropdown-menu:not(.hidden)').forEach((m) => {
    if (!m.parentNode.contains(event.target)) {
      m.classList.add('hidden');
    }
  });
});

// Escape 统一关闭：下拉 → 弹窗 → ⓘ 提示（原版两处监听合并，顺序保持）
document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') {
    return;
  }
  document.querySelectorAll('.dropdown-menu:not(.hidden)').forEach((m) => m.classList.add('hidden'));
  document.querySelectorAll('.modal:not(.hidden)').forEach((modal) => modal.classList.add('hidden'));
  closeAllHints();
});
