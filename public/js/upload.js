/* 上传页组件：IPA 选择/拖拽、本地进度、提交任务（SSE 实时进度）、历史任务 */
import {
  $, api, daysLeft, escapeHtml, formatDate, fmtSize, toast, withLoading,
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

/** SSE 断线重连的初始间隔（毫秒） */
const SSE_RETRY_BASE_MS = 2000;

/** SSE 断线重连的最大间隔（毫秒） */
const SSE_RETRY_MAX_MS = 30000;

/** SSE 断线重连的最大次数（超过后提示用户手动刷新） */
const SSE_RETRY_MAX = 5;

/** 上传页状态（configCount 由 configs 组件通过 onConfigsChanged 单点通知） */
const uploadState = {
  file: null,
  ipaMeta: null,
  currentTaskId: null,
  eventSource: null,
  sseTimer: null,
  uploading: false,
  configCount: 0,
  /** 各任务最近一次渲染的阶段（taskId → stage），用于判断"刚从进行中变为终态" */
  lastStages: new Map(),
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
  if (uploadState.uploading) {
    toast('当前有 IPA 正在上传，请等待完成后再选择新文件', true);
    return;
  }
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
    uploadState.uploading = true;
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
      uploadState.uploading = false;
      if (xhr.status !== 200) {
        let message = `上传失败（HTTP ${xhr.status}）`;
        try {
          message = JSON.parse(xhr.responseText).error || message;
        } catch { /* 忽略解析失败 */ }
        toast(message, true);
        resolve();
        return;
      }
      let meta;
      try {
        meta = JSON.parse(xhr.responseText);
      } catch {
        toast('本地服务返回数据异常，请重新上传', true);
        resolve();
        return;
      }
      uploadState.ipaMeta = meta;
      renderIpaMeta(meta);
      updateSubmitButton();
      loadBetaGroups();
      resolve();
    };
    xhr.onerror = () => {
      uploadState.uploading = false;
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
  const profile = meta.profile;
  let profileLine = '';
  if (profile) {
    const left = daysLeft(profile.expirationDate);
    const expiredText = left !== null && left < 0 ? ' <span style="color:var(--err)">已过期，上传会被 Apple 拒绝</span>' : '';
    profileLine = `描述文件: 「${escapeHtml(profile.name || '未命名')}」${profile.typeLabel ? `（${escapeHtml(profile.typeLabel)}）` : ''} · 到期 ${formatDate(profile.expirationDate)}${expiredText}<br>`;
  }
  el.innerHTML = `
    <b>${escapeHtml(meta.filename)}</b>（${fmtSize(meta.sizeBytes)}）<br>
    bundleId: ${meta.bundleId ? escapeHtml(meta.bundleId) : '<span style="color:var(--err)">未解析到</span>'} ·
    版本: ${meta.shortVersion ? escapeHtml(meta.shortVersion) : '?'} (${meta.buildVersion ? escapeHtml(meta.buildVersion) : '?'})<br>
    ${profileLine}
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
      label.innerHTML = `<input type="checkbox" value="${escapeHtml(g.id)}"> ${escapeHtml(g.name)}${g.isInternalGroup ? '（内部）' : ''}`;
      wrap.appendChild(label);
    });
  } catch (err) {
    wrap.innerHTML = `<span class="error">${escapeHtml(err.message)}</span>`;
  }
}

/**
 * 提交上传任务（支持签名预检警告二次确认与强制提交）
 * @param {boolean} [ignorePrecheckWarning=false] 是否忽略预检警告强制提交
 * @returns {Promise<void>}
 */
async function submitTask(ignorePrecheckWarning = false) {
  const shouldIgnore = ignorePrecheckWarning === true;
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
      body: JSON.stringify({
        configId,
        ipaId: uploadState.ipaMeta.ipaId,
        autoTestflight,
        betaGroupIds,
        ignorePrecheckWarning: shouldIgnore,
      }),
    });
    subscribeTask(task.id);
    toast('任务已提交');
    loadTaskHistory();
    resetUploadSelection();
  } catch (err) {
    if (err.isPrecheckWarning) {
      const confirmed = confirm(`【签名预检提示】\n${err.message}\n\n是否忽略此警告并继续强制提交上传？`);
      if (confirmed) {
        await submitTask(true);
        return;
      }
    }
    toast(err.message, true);
  }
}

/**
 * 任务提交成功后重置文件选择状态：清空已选文件与本地传输进度，
 * 防止对同一 IPA 重复建任务（Apple 会以 409 build 号冲突拒绝）
 * @returns {void}
 */
function resetUploadSelection() {
  uploadState.file = null;
  uploadState.ipaMeta = null;
  $('ipa-input').value = '';
  $('ipa-meta').classList.add('hidden');
  $('local-progress-wrap').classList.add('hidden');
  $('local-progress-bar').style.width = '0%';
  $('local-progress-text').textContent = '0%';
  updateSubmitButton();
}

/**
 * 订阅任务 SSE 并渲染进度（断线自动重连，指数退避）
 * @param {string} taskId 任务 ID
 * @returns {void}
 */
function subscribeTask(taskId) {
  closeTaskEvents();
  uploadState.currentTaskId = taskId;
  connectTaskEvents(taskId, 0);
}

/**
 * 建立 SSE 连接，断线后自动重连
 * @param {string} taskId 任务 ID
 * @param {number} attempt 当前重连次数
 * @returns {void}
 */
function connectTaskEvents(taskId, attempt) {
  const source = new EventSource(`/api/tasks/${taskId}/events`);
  uploadState.eventSource = source;
  source.onmessage = (event) => {
    renderTaskProgress(JSON.parse(event.data));
  };
  source.onerror = async () => {
    source.close();
    // 已切换到其它任务时不再处理旧连接的错误
    if (uploadState.currentTaskId !== taskId) {
      return;
    }
    // 断线后全量校准一次；任务已结束则无需重连
    let task = null;
    try {
      task = await api(`/api/tasks/${taskId}`);
      renderTaskProgress(task);
    } catch { /* 服务可能已停止 */ }
    if (task && !isStageActive(task.stage)) {
      return;
    }
    if (attempt >= SSE_RETRY_MAX) {
      toast('实时进度连接已断开，可点击「刷新」查看最新状态', true);
      return;
    }
    const delay = Math.min(SSE_RETRY_MAX_MS, SSE_RETRY_BASE_MS * 2 ** attempt);
    uploadState.sseTimer = setTimeout(() => {
      if (uploadState.currentTaskId === taskId) {
        connectTaskEvents(taskId, attempt + 1);
      }
    }, delay);
  };
}

/**
 * 关闭 SSE 连接与待触发的重连定时器
 * @returns {void}
 */
function closeTaskEvents() {
  if (uploadState.sseTimer) {
    clearTimeout(uploadState.sseTimer);
    uploadState.sseTimer = null;
  }
  if (uploadState.eventSource) {
    uploadState.eventSource.close();
    uploadState.eventSource = null;
  }
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
      ${ABORTABLE_STAGES.has(task.stage) ? `<button class="small danger" data-abort="${task.id}">中断上传</button>` : ''}
      ${(task.stage === 'FAILED' || task.stage === 'CANCELLED') && task.ipaAvailable ? `<button class="small" data-retry="${task.id}">重试</button>` : ''}
    </div>`;
  // 按钮事件渲染后绑定（替代旧的内联 onclick + window 全局函数）
  wrap.querySelectorAll('[data-abort]').forEach((btn) => {
    btn.onclick = () => abortTask(btn.dataset.abort);
  });
  wrap.querySelectorAll('[data-retry]').forEach((btn) => {
    btn.onclick = () => withLoading(btn, '重试中...', () => retryTask(btn.dataset.retry));
  });
  const logEl = wrap.querySelector('.log');
  if (logEl) {
    logEl.scrollTop = logEl.scrollHeight;
  }
  // 仅当任务"刚从进行中变为终态"时闪烁标题并刷新历史列表；
  // 回看（订阅）已结束的历史任务不算新完成，不闪烁
  const prevStage = uploadState.lastStages.get(task.id);
  const becameFinal = Boolean(prevStage) && isStageActive(prevStage) && !isStageActive(task.stage);
  uploadState.lastStages.set(task.id, task.stage);
  if (becameFinal) {
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
          <button class="small" data-view="${t.id}">查看</button>
          ${(t.stage === 'FAILED' || t.stage === 'CANCELLED') && t.ipaAvailable ? `<button class="small" data-retry="${t.id}">重试</button>` : ''}
          ${isStageActive(t.stage) ? '' : `<button class="small danger" data-remove="${t.id}" data-name="${escapeHtml(t.filename || '')}">删除</button>`}
        </td>
      </tr>`).join('');
    wrap.innerHTML = `
      <table class="builds">
        <thead><tr><th>文件</th><th>状态</th><th>创建时间</th><th>操作</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>`;
    wrap.querySelectorAll('[data-view]').forEach((btn) => {
      btn.onclick = () => subscribeTask(btn.dataset.view);
    });
    wrap.querySelectorAll('[data-retry]').forEach((btn) => {
      btn.onclick = () => withLoading(btn, '重试中...', () => retryTask(btn.dataset.retry));
    });
    wrap.querySelectorAll('[data-remove]').forEach((btn) => {
      btn.onclick = (event) => {
        const name = btn.dataset.name || '该任务';
        if (!confirm(`确定删除任务「${name}」吗？其本地 IPA 缓存将一并删除。`)) {
          return;
        }
        withLoading(event.currentTarget, '删除中...', async () => {
          try {
            await api(`/api/tasks/${btn.dataset.remove}`, { method: 'DELETE' });
            toast('任务记录已删除');
            await loadTaskHistory();
          } catch (err) {
            toast(err.message, true);
          }
        });
      };
    });
  } catch (err) {
    wrap.innerHTML = `<span class="error">${escapeHtml(err.message)}</span>`;
  }
}

/**
 * 重试任务（重新入队并在进度面板实时跟踪）
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
 * 中断进行中的上传任务（确认弹窗说明 Apple 侧语义）
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
 * 同步"提交上传任务"按钮状态：有可用配置、已上传 IPA 且解析到 bundleId 才可点击。
 * bundleId 缺失时任务必然失败（后端无法定位 App），提前拦截并给出原因
 * @returns {void}
 */
function updateSubmitButton() {
  const meta = uploadState.ipaMeta;
  const missingBundleId = Boolean(meta && !meta.bundleId);
  const button = $('submit-task');
  button.disabled = uploadState.configCount === 0 || !meta || missingBundleId;
  button.title = missingBundleId
    ? 'IPA 未解析到 bundleId，无法提交：请确认文件是有效的 .ipa 签名包'
    : '';
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
  $('btn-refresh-history').onclick = () => withLoading($('btn-refresh-history'), '刷新中...', loadTaskHistory);

  // 任务结束时标题闪烁，窗口回焦自动停止
  window.addEventListener('focus', stopFlashTitle);
}
