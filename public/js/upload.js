/* 上传页组件：IPA 选择/拖拽、本地进度、提交任务（SSE 实时进度）、历史任务 */
import {
  $, api, escapeHtml, fmtSize, toast, withLoading,
} from './common.js';

/** 组件标题（导航按钮文案唯一事实源） */
export const title = '上传';

/** 页面模板（原 index.html 上传区块整体搬运，active 类由注册器注入） */
export const template = `<section id="tab-upload" class="tab-panel">
            <div class="card">
                <h2>1. 选择 IPA 文件</h2>
                <label id="drop-zone" class="drop-zone">
                    拖拽 .ipa 文件到此处，或 <span class="file-label">点击选择</span>
                    <input type="file" id="ipa-input" accept=".ipa" hidden>
                </label>
                <div id="ipa-meta" class="ipa-meta hidden"></div>
                <div class="progress-wrap hidden" id="local-progress-wrap">
                    <span>本地传输</span>
                    <div class="progress">
                        <div id="local-progress-bar" class="progress-bar"></div>
                    </div>
                    <em id="local-progress-text">0%</em>
                </div>
            </div>

            <div class="card">
                <h2>2. 选择配置与分发选项</h2>
                <p id="no-config-hint" class="error hidden">还没有可用配置，请先到「配置管理」页创建并验证一条配置。</p>
                <div class="form-row">
                    <label>使用配置</label>
                    <select id="upload-config"></select>
                </div>
                <div class="form-row">
                    <label class="switch-label">
                        <input type="checkbox" id="auto-testflight">
                        上传完成后自动加入 TestFlight 测试组（默认关闭）
                    </label>
                </div>
                <div id="beta-group-block" class="form-row hidden">
                    <label>测试组（可多选）</label>
                    <div id="beta-groups" class="checkbox-list">请先在上方选择配置</div>
                </div>
                <button id="submit-task" class="primary" disabled>提交上传任务</button>
            </div>

            <div class="card">
                <h2>3. 任务进度</h2>
                <div id="task-progress" class="task-progress">
                    <p class="muted">暂无进行中的任务，提交后在此实时展示进度。</p>
                </div>
            </div>

            <div class="card">
                <h2>历史任务 <button id="btn-refresh-history" class="small">刷新</button></h2>
                <div id="task-history" class="muted">暂无任务记录</div>
            </div>
        </section>`;

/** 任务阶段英文名 → 中文名映射 */
const STAGE_TEXT = {
  QUEUED: '排队中',
  PREPARING: '准备中',
  PUSHING_CHUNKS: '上传中',
  COMMITTING: '提交校验',
  VALIDATING: 'Apple 校验中',
  WAITING_PROCESS: '等待 build 处理',
  DISTRIBUTING: 'TestFlight 分发中',
  DONE: '完成',
  FAILED: '失败',
  CANCELLED: '已取消',
};

/** 任务进行中的阶段集合（可中断 / 不可重试） */
const ACTIVE_STAGES = new Set([
  'QUEUED',
  'PREPARING',
  'PUSHING_CHUNKS',
  'COMMITTING',
  'VALIDATING',
  'WAITING_PROCESS',
  'DISTRIBUTING',
]);

/** 允许中断的阶段（提交校验之前；文件一旦提交给 Apple，中断无意义） */
const ABORTABLE_STAGES = new Set([
  'QUEUED',
  'PREPARING',
  'PUSHING_CHUNKS',
]);

/** 上传页状态（configCount 由 configs 组件通过 onConfigsChanged 单点通知） */
const uploadState = {
  file: null,
  ipaMeta: null,
  currentTaskId: null,
  eventSource: null,
  configCount: 0,
};

/** 标题闪烁定时器 */
let titleFlashTimer = null;

/**
 * 任务阶段的中文文案
 * @param {string} stage 阶段英文标识
 * @returns {string} 中文名，未知时原样返回
 */
function stageText(stage) {
  return STAGE_TEXT[stage] || stage || '-';
}

/**
 * 判断任务是否进行中
 * @param {string} stage 阶段英文标识
 * @returns {boolean} 进行中返回 true
 */
function isStageActive(stage) {
  return ACTIVE_STAGES.has(stage);
}

/**
 * 浏览器标签页标题闪烁提醒（窗口获得焦点后自动停止）
 * @param {string} message 提醒文字
 * @returns {void}
 */
function flashTitle(message) {
  stopFlashTitle();
  const originalTitle = document.title;
  let visible = false;
  titleFlashTimer = setInterval(() => {
    document.title = visible ? originalTitle : `【${message}】`;
    visible = !visible;
  }, 800);
}

/**
 * 停止标题闪烁并恢复默认标题
 * @returns {void}
 */
function stopFlashTitle() {
  if (titleFlashTimer) {
    clearInterval(titleFlashTimer);
    titleFlashTimer = null;
    document.title = 'App Store应用上架助手';
  }
}

/**
 * 校验并暂存所选 IPA 文件
 * @param {File} file 文件对象
 * @returns {void}
 */
function pickIpaFile(file) {
  if (!file || !file.name.toLowerCase().endsWith('.ipa')) {
    toast('请选择 .ipa 文件', true);
    return;
  }
  uploadState.file = file;
  uploadState.ipaMeta = null;
  $('ipa-meta').classList.add('hidden');
  updateSubmitButton();
  startLocalUpload(file);
}

/**
 * 上传 IPA 到本地服务（XHR 原始 body，带进度）
 * @param {File} file 文件对象
 * @returns {Promise<void>}
 */
function startLocalUpload(file) {
  return new Promise((resolve) => {
    const xhr = new XMLHttpRequest();
    $('local-progress-wrap').classList.remove('hidden');
    xhr.open('PUT', `/api/ipa?filename=${encodeURIComponent(file.name)}`);
    xhr.upload.onprogress = (event) => {
      if (!event.lengthComputable) {
        return;
      }
      const percent = Math.round((event.loaded / event.total) * 100);
      $('local-progress-bar').style.width = `${percent}%`;
      $('local-progress-text').textContent = `${percent}%`;
    };
    xhr.onload = async () => {
      if (xhr.status !== 200) {
        let message = `上传失败（HTTP ${xhr.status}）`;
        try {
          message = JSON.parse(xhr.responseText).error || message;
        } catch { /* 忽略解析失败 */ }
        toast(message, true);
        resolve();
        return;
      }
      const meta = JSON.parse(xhr.responseText);
      uploadState.ipaMeta = meta;
      renderIpaMeta(meta);
      updateSubmitButton();
      loadBetaGroups();
      resolve();
    };
    xhr.onerror = () => {
      toast('本地服务上传失败，请确认服务正在运行', true);
      resolve();
    };
    xhr.send(file);
  });
}

/**
 * 渲染 IPA 解析结果
 * @param {Object} meta IPA 元数据
 * @returns {void}
 */
function renderIpaMeta(meta) {
  const el = $('ipa-meta');
  el.classList.remove('hidden');
  el.innerHTML = `
    <b>${escapeHtml(meta.filename)}</b>（${fmtSize(meta.sizeBytes)}）<br>
    bundleId: ${meta.bundleId ? escapeHtml(meta.bundleId) : '<span style="color:var(--err)">未解析到</span>'} ·
    版本: ${meta.shortVersion ? escapeHtml(meta.shortVersion) : '?'} (${meta.buildVersion ? escapeHtml(meta.buildVersion) : '?'})<br>
    MD5: ${escapeHtml(meta.md5)}`;
}

/**
 * 加载测试组列表
 * @returns {Promise<void>}
 */
async function loadBetaGroups() {
  const block = $('beta-group-block');
  const wrap = $('beta-groups');
  const configId = $('upload-config').value;
  if (!configId || !$('auto-testflight').checked) {
    block.classList.add('hidden');
    return;
  }
  block.classList.remove('hidden');
  wrap.innerHTML = '<span class="inline-loading">正在加载测试组...</span>';
  try {
    const data = await api(`/api/beta-groups?configId=${configId}`);
    if (data.groups.length === 0) {
      wrap.innerHTML = '<span class="muted">该账号下暂无测试组，请先到 App Store Connect 创建。</span>';
      return;
    }
    wrap.innerHTML = '';
    data.groups.forEach((g) => {
      const label = document.createElement('label');
      label.innerHTML = `<input type="checkbox" value="${g.id}"> ${escapeHtml(g.name)}${g.isInternalGroup ? '（内部）' : ''}`;
      wrap.appendChild(label);
    });
  } catch (err) {
    wrap.innerHTML = `<span class="error">${escapeHtml(err.message)}</span>`;
  }
}

/**
 * 提交上传任务
 * @returns {Promise<void>}
 */
async function submitTask() {
  const configId = $('upload-config').value;
  if (!configId) {
    toast('请先选择配置', true);
    return;
  }
  if (!uploadState.ipaMeta) {
    toast('请先上传 IPA 文件', true);
    return;
  }
  const autoTestflight = $('auto-testflight').checked;
  const betaGroupIds = autoTestflight
    ? Array.from($('beta-groups').querySelectorAll('input:checked')).map((i) => i.value)
    : [];
  try {
    const task = await api('/api/tasks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ configId, ipaId: uploadState.ipaMeta.ipaId, autoTestflight, betaGroupIds }),
    });
    subscribeTask(task.id);
    toast('任务已提交');
    loadTaskHistory();
  } catch (err) {
    toast(err.message, true);
  }
}

/**
 * 订阅任务 SSE 并渲染进度
 * @param {string} taskId 任务 ID
 * @returns {void}
 */
function subscribeTask(taskId) {
  if (uploadState.eventSource) {
    uploadState.eventSource.close();
  }
  const source = new EventSource(`/api/tasks/${taskId}/events`);
  uploadState.eventSource = source;
  uploadState.currentTaskId = taskId;
  source.onmessage = (event) => {
    renderTaskProgress(JSON.parse(event.data));
  };
  source.onerror = async () => {
    // 断线后全量校准一次
    source.close();
    try {
      const task = await api(`/api/tasks/${taskId}`);
      renderTaskProgress(task);
    } catch { /* 服务可能已停止 */ }
  };
}

/**
 * 渲染任务进度面板
 * @param {Object} task 任务视图
 * @returns {void}
 */
function renderTaskProgress(task) {
  const wrap = $('task-progress');
  const percent = task.stage === 'PUSHING_CHUNKS' ? (task.progress || 0) : (task.stage === 'DONE' ? 100 : 0);
  const logLines = (task.logs || [])
    .map((l) => `[${new Date(l.time).toLocaleTimeString()}] ${escapeHtml(l.message)}`)
    .join('\n');
  wrap.innerHTML = `
    <div class="task-summary">
      <span class="stage-badge ${task.stage}">${escapeHtml(stageText(task.stage))}</span>
      <b class="task-filename" title="${escapeHtml(task.filename || '')}">${escapeHtml(task.filename || '')}</b>
      <span class="muted task-message" title="${escapeHtml(task.message || '')}">${escapeHtml(task.message || '')}</span>
    </div>
    <div class="progress" style="margin-top:10px;"><div class="progress-bar" style="width:${percent}%"></div></div>
    <div class="muted" style="margin-top:6px;">已上传 ${fmtSize(task.uploadedBytes || 0)} / ${fmtSize(task.sizeBytes || 0)}
      ${task.buildId ? ` · buildId: ${escapeHtml(task.buildId)}` : ''}</div>
    <div class="log">${logLines}</div>
    <div style="margin-top:8px;">
      ${ABORTABLE_STAGES.has(task.stage) ? `<button class="small danger" onclick="abortTask('${task.id}')">中断上传</button>` : ''}
      ${(task.stage === 'FAILED' || task.stage === 'CANCELLED') && task.ipaAvailable ? `<button class="small" onclick="retryTask('${task.id}')">重试</button>` : ''}
    </div>`;
  const logEl = wrap.querySelector('.log');
  if (logEl) {
    logEl.scrollTop = logEl.scrollHeight;
  }
  if (task.stage === 'DONE' || task.stage === 'FAILED' || task.stage === 'CANCELLED') {
    flashTitle(task.stage === 'DONE' ? '上传完成' : task.stage === 'CANCELLED' ? '已中断' : '上传失败');
    loadTaskHistory();
  }
}

/**
 * 加载并渲染历史任务列表
 * @returns {Promise<void>}
 */
export async function loadTaskHistory() {
  const wrap = $('task-history');
  try {
    const data = await api('/api/tasks');
    if (data.tasks.length === 0) {
      wrap.innerHTML = '<span class="muted">暂无任务记录</span>';
      return;
    }
    const rows = data.tasks.map((t) => `
      <tr>
        <td><b>${escapeHtml(t.filename || '-')}</b><div class="muted">${escapeHtml(t.bundleId || '')} ${t.shortVersion ? `v${escapeHtml(t.shortVersion)}` : ''}</div></td>
        <td><span class="stage-badge ${escapeHtml(t.stage)}">${escapeHtml(stageText(t.stage))}</span></td>
        <td>${new Date(t.createdAt).toLocaleString()}</td>
        <td>
          ${(t.stage === 'FAILED' || t.stage === 'CANCELLED') && t.ipaAvailable ? `<button class="small" data-retry="${t.id}">重试</button>` : ''}
          ${isStageActive(t.stage) ? '' : `<button class="small danger" data-remove="${t.id}" data-name="${escapeHtml(t.filename || '')}">删除</button>`}
        </td>
      </tr>`).join('');
    wrap.innerHTML = `
      <table class="builds">
        <thead><tr><th>文件</th><th>状态</th><th>创建时间</th><th>操作</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>`;
    wrap.querySelectorAll('[data-retry]').forEach((btn) => {
      btn.onclick = () => retryTask(btn.dataset.retry);
    });
    wrap.querySelectorAll('[data-remove]').forEach((btn) => {
      btn.onclick = async () => {
        const name = btn.dataset.name || '该任务';
        if (!confirm(`确定删除任务「${name}」吗？其本地 IPA 缓存将一并删除。`)) {
          return;
        }
        try {
          await api(`/api/tasks/${btn.dataset.remove}`, { method: 'DELETE' });
          toast('任务记录已删除');
          await loadTaskHistory();
        } catch (err) {
          toast(err.message, true);
        }
      };
    });
  } catch (err) {
    wrap.innerHTML = `<span class="error">${escapeHtml(err.message)}</span>`;
  }
}

/**
 * 重试任务（挂载到 window 供进度面板内联 onclick 调用）
 * @param {string} taskId 任务 ID
 * @returns {Promise<void>}
 */
async function retryTask(taskId) {
  try {
    await api(`/api/tasks/${taskId}/retry`, { method: 'POST' });
    subscribeTask(taskId);
    toast('已重新入队');
    // 同步刷新历史列表，避免残留上一次的"失败"状态
    loadTaskHistory();
  } catch (err) {
    toast(err.message, true);
  }
}

/**
 * 中断进行中的上传任务（确认弹窗说明 Apple 侧语义；挂载到 window 供内联 onclick 调用）
 * @param {string} taskId 任务 ID
 * @returns {Promise<void>}
 */
async function abortTask(taskId) {
  const confirmed = confirm(
    '确定中断该上传任务吗？\n\n' +
    '· 中断仅停止本地上传流程，已上传的分块将被作废\n' +
    '· 尚未向 Apple 提交校验，不会生成 build，也不占用版本号\n' +
    '· 中断后任务标记为“已取消”，本地 IPA 缓存保留，可重新重试'
  );
  if (!confirmed) {
    return;
  }
  try {
    await api(`/api/tasks/${taskId}/abort`, { method: 'POST' });
    toast('已发送中断请求，任务将在最近的检查点停止');
  } catch (err) {
    toast(err.message, true);
  }
}

/**
 * 同步"提交上传任务"按钮状态：既有可用配置、又已上传 IPA 才可点击
 * @returns {void}
 */
function updateSubmitButton() {
  $('submit-task').disabled = uploadState.configCount === 0 || !uploadState.ipaMeta;
}

/**
 * 配置列表变化时由 configs 组件通知：单点同步红字显隐与提交按钮状态
 * @param {Array<Object>} configList 最新配置列表
 * @returns {void}
 */
export function onConfigsChanged(configList) {
  uploadState.configCount = configList.length;
  $('no-config-hint').classList.toggle('hidden', uploadState.configCount > 0);
  updateSubmitButton();
}

/** 切到本页签时刷新历史任务（内部已自吞异常，直调即可） */
export function onShown() {
  loadTaskHistory();
}

/**
 * 绑定本组件全部事件（模板注入后由注册器调用一次）
 * @returns {void}
 */
export function init() {
  /* 拖拽与选择（拖拽目标为整个页面，drop-zone 内部处理时阻止冒泡） */
  const dropZone = $('drop-zone');
  dropZone.addEventListener('dragover', (e) => {
    e.preventDefault();
    dropZone.classList.add('dragover');
  });
  dropZone.addEventListener('dragleave', () => dropZone.classList.remove('dragover'));
  dropZone.addEventListener('drop', (e) => {
    e.preventDefault();
    e.stopPropagation();
    dropZone.classList.remove('dragover');
    pickIpaFile(e.dataTransfer.files[0]);
  });
  document.addEventListener('dragover', (e) => e.preventDefault());
  document.addEventListener('drop', (e) => {
    e.preventDefault();
    const file = e.dataTransfer && e.dataTransfer.files[0];
    if (file) {
      pickIpaFile(file);
    }
  });
  $('ipa-input').addEventListener('change', (e) => pickIpaFile(e.target.files[0]));

  $('auto-testflight').addEventListener('change', loadBetaGroups);
  $('upload-config').addEventListener('change', loadBetaGroups);
  $('submit-task').onclick = () => withLoading($('submit-task'), '提交中...', submitTask);
  $('btn-refresh-history').onclick = () => loadTaskHistory();

  // 进度面板模板中的内联 onclick 依赖 window 全局函数
  window.retryTask = retryTask;
  window.abortTask = abortTask;

  // 任务结束时标题闪烁，窗口回焦自动停止
  window.addEventListener('focus', stopFlashTitle);
}
