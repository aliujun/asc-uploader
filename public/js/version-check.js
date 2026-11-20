/* 版本更新检测：启动时调 /api/version/check，发现新版本在头部显示绿色胶囊；
   点击弹窗按运行方式（exe / npm / git）给出对应的更新指引，可跳过当前版本提示 */
import { $, api, escapeHtml, toast } from './common.js';

/** 最近一次检测结果缓存（弹窗渲染复用） */
let lastResult = null;

/** 弹窗 DOM 是否已创建标记 */
let modalBuilt = false;

/**
 * 启动加载版本检测结果（失败静默，不打扰页面主流程）
 * @returns {Promise<void>}
 */
export async function loadCheck() {
  try {
    await refresh(false);
  } catch {
    // 离线、GitHub 限流等场景静默跳过
  }
}

/**
 * 请求版本检测并渲染头部胶囊
 * @param {boolean} force 是否跳过服务端缓存强制检测
 * @returns {Promise<Object>} 检测结果
 * @throws {Error} 接口失败时抛出
 */
export async function refresh(force) {
  const result = await api(`/api/version/check${force ? '?force=1' : ''}`);
  lastResult = result;
  renderPill(result);
  return result;
}

/**
 * 渲染头部右侧新版本胶囊：无更新或用户已跳过该版本时隐藏
 * @param {Object} result 版本检测结果
 * @returns {void}
 */
function renderPill(result) {
  const banner = $('version-banner');
  if (!result.hasUpdate || isSkipped(result.latest)) {
    banner.classList.add('hidden');
    banner.innerHTML = '';
    return;
  }
  banner.classList.remove('hidden');
  banner.innerHTML = `
    <button id="btn-version-pill" class="version-pill" title="点击查看更新内容与升级方式">
      新版本 v${escapeHtml(result.latest)} 可用
    </button>`;
  $('btn-version-pill').addEventListener('click', openModal);
}

/**
 * 判断该最新版本是否被用户跳过
 * @param {string} latest 最新版本号
 * @returns {boolean} 是否跳过
 */
function isSkipped(latest) {
  return localStorage.getItem('version.skipped') === latest;
}

/**
 * 打开更新弹窗（首次调用时创建 DOM 并绑定事件）
 * @returns {void}
 */
function openModal() {
  ensureModal();
  fillModal(lastResult);
  $('version-modal').classList.remove('hidden');
}

/**
 * 关闭更新弹窗
 * @returns {void}
 */
function closeModal() {
  $('version-modal').classList.add('hidden');
}

/**
 * 创建弹窗骨架并绑定一次性事件
 * @returns {void}
 */
function ensureModal() {
  if (modalBuilt) {
    return;
  }
  document.body.insertAdjacentHTML('beforeend', `
    <div id="version-modal" class="modal hidden">
      <div class="modal-box">
        <h3>发现新版本</h3>
        <div id="version-modal-body"></div>
        <div class="form-actions">
          <button id="btn-version-detail" class="btn-ghost">更新详情</button>
          <button id="btn-version-skip" class="btn-ghost">此版本不再提示</button>
          <button id="btn-version-close" class="btn">知道了</button>
        </div>
      </div>
    </div>`);
  $('version-modal').addEventListener('click', (event) => {
    if (event.target === $('version-modal')) {
      closeModal();
    }
  });
  $('btn-version-close').addEventListener('click', closeModal);
  $('btn-version-detail').addEventListener('click', () => {
    if (lastResult && lastResult.releaseUrl) {
      window.open(lastResult.releaseUrl, '_blank');
    }
  });
  $('btn-version-skip').addEventListener('click', () => {
    if (lastResult && lastResult.latest) {
      localStorage.setItem('version.skipped', lastResult.latest);
    }
    closeModal();
    renderPill(lastResult);
  });
  modalBuilt = true;
}

/**
 * 按检测结果填充弹窗内容（版本对比 + 按运行方式生成升级指引 + 更新日志）
 * @param {Object} result 版本检测结果
 * @returns {void}
 */
function fillModal(result) {
  const body = $('version-modal-body');
  if (result.error) {
    body.innerHTML = `<p class="error">版本检测失败：${escapeHtml(result.error)}（可稍后重新检测）</p>`;
    return;
  }
  const behind = result.runMode === 'git' && Number.isFinite(result.behindCount)
    ? `<span class="muted">（本地落后远程 ${result.behindCount} 个提交）</span>`
    : '';
  const commandBlock = result.command
    ? `<div class="version-cmd-row">
         <code class="version-cmd">${escapeHtml(result.command)}</code>
         <button id="btn-version-copy" class="btn-ghost btn-sm">复制命令</button>
       </div>`
    : '';
  const modeLine = result.runMode === 'exe'
    ? `<a href="${escapeHtml(result.downloadUrl || result.releaseUrl)}" target="_blank" rel="noopener">
         <button id="btn-version-download" class="btn">前往下载 ${escapeHtml(result.assetName || '新版本 exe')}</button>
       </a>
       ${result.assetSize ? `<span class="muted">（${(result.assetSize / 1024 / 1024).toFixed(1)} MB）</span>` : ''}`
    : commandBlock;
  const notes = result.notes
    ? `<div class="version-notes-title">更新日志</div>
       <pre class="version-notes">${escapeHtml(result.notes)}</pre>`
    : '';
  body.innerHTML = `
    <p>
      当前版本 <strong>v${escapeHtml(result.current)}</strong>
      → 最新版本 <strong>v${escapeHtml(result.latest)}</strong>
      <span class="version-mode-badge">${escapeHtml(result.runModeLabel)}</span>
      ${behind}
    </p>
    <p class="muted">${escapeHtml(result.hint || '')}</p>
    ${modeLine}
    ${notes}`;
  const copyBtn = $('btn-version-copy');
  if (copyBtn) {
    copyBtn.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(result.command);
        toast('命令已复制到剪贴板');
      } catch {
        toast('复制失败，请手动选择命令复制', true);
      }
    });
  }
}
