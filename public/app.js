'use strict';

/* ====================== 通用工具 ====================== */

/**
 * 显示提示信息
 * @param {string} message 提示内容
 * @param {boolean} [isError] 是否为错误样式
 * @returns {void}
 */
function toast(message, isError) {
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
async function api(url, opts) {
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
async function downloadFile(filename, content, mime) {
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
function $(id) {
  return document.getElementById(id);
}

/**
 * 格式化字节大小
 * @param {number} bytes 字节数
 * @returns {string} 可读大小
 */
function fmtSize(bytes) {
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

/** build 处理状态英文名 → 中文名映射（官方枚举：PROCESSING/FAILED/INVALID/VALID） */
const BUILD_STATE_TEXT = {
  PROCESSING: '处理中',
  FAILED: '失败',
  INVALID: '无效',
  VALID: '可用',
};

/**
 * 任务阶段的中文文案
 * @param {string} stage 阶段英文标识
 * @returns {string} 中文名，未知时原样返回
 */
function stageText(stage) {
  return STAGE_TEXT[stage] || stage || '-';
}

/**
 * build 处理状态的中文文案
 * @param {string} state 状态英文标识
 * @returns {string} 中文名，未知时原样返回
 */
function buildStateText(state) {
  return BUILD_STATE_TEXT[state] || state || '-';
}

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

/**
 * 判断任务是否进行中
 * @param {string} stage 阶段英文标识
 * @returns {boolean} 进行中返回 true
 */
function isStageActive(stage) {
  return ACTIVE_STAGES.has(stage);
}

/**
 * 按钮加载态包装：执行期间禁用按钮并显示加载文案，防止重复点击
 * @param {HTMLButtonElement} button 按钮元素
 * @param {string} loadingText 加载中显示的文字
 * @param {() => (void|Promise<void>)} fn 要执行的异步操作
 * @returns {Promise<void>}
 */
async function withLoading(button, loadingText, fn) {
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

/** 标题闪烁定时器 */
let titleFlashTimer = null;

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

window.addEventListener('focus', stopFlashTitle);

/* ====================== Tab 切换 ====================== */

/**
 * 切换到指定 Tab
 * @param {string} tabName Tab 标识（data-tab 值）
 * @returns {void}
 */
function switchTab(tabName) {
  document.querySelectorAll('.tab').forEach((b) => b.classList.remove('active'));
  document.querySelectorAll('.tab-panel').forEach((p) => p.classList.remove('active'));
  const target = document.querySelector(`.tab[data-tab="${tabName}"]`);
  if (!target) {
    return;
  }
  target.classList.add('active');
  $(`tab-${tabName}`).classList.add('active');
  localStorage.setItem('asc-active-tab', tabName);
  onTabShown(tabName);
}

/**
 * Tab 显示时按需刷新对应数据
 * @param {string} tabName Tab 标识
 * @returns {void}
 */
function onTabShown(tabName) {
  if (tabName === 'builds') {
    loadAppsForBuilds().catch(() => {});
    return;
  }
  if (tabName === 'certs') {
    loadCertKeys().catch(() => {});
    return;
  }
  if (tabName === 'connectivity') {
    loadConnectivityInfo().catch(() => {});
    return;
  }
  if (tabName === 'upload') {
    loadTaskHistory().catch(() => {});
  }
}

document.querySelectorAll('.tab').forEach((btn) => {
  btn.addEventListener('click', () => switchTab(btn.dataset.tab));
});

/* ====================== 配置管理 ====================== */

const configState = { list: [], editingId: null };

/**
 * 加载配置列表并刷新相关下拉框
 * @returns {Promise<void>}
 */
async function loadConfigs() {
  const data = await api('/api/configs');
  configState.list = data.configs;
  renderConfigList();
  fillConfigSelect($('upload-config'), '请选择配置');
  fillConfigSelect($('builds-config'), '选择配置');
  $('no-config-hint').classList.toggle('hidden', configState.list.length > 0);
  updateSubmitButton();
}

/**
 * 同步"提交上传任务"按钮状态：既有可用配置、又已上传 IPA 才可点击
 * @returns {void}
 */
function updateSubmitButton() {
  $('submit-task').disabled = configState.list.length === 0 || !uploadState.ipaMeta;
}

/**
 * 填充配置下拉框
 * @param {HTMLSelectElement} select 下拉框
 * @param {string} placeholder 占位文案
 * @returns {void}
 */
function fillConfigSelect(select, placeholder) {
  select.innerHTML = '';
  const defaultOption = document.createElement('option');
  defaultOption.value = '';
  defaultOption.textContent = placeholder;
  select.appendChild(defaultOption);
  configState.list.forEach((c) => {
    const option = document.createElement('option');
    option.value = c.id;
    option.textContent = c.name;
    select.appendChild(option);
  });
}

/**
 * 渲染配置卡片列表
 * @returns {void}
 */
function renderConfigList() {
  const wrap = $('config-list');
  wrap.innerHTML = '';
  if (configState.list.length === 0) {
    wrap.innerHTML = '<p class="muted">还没有配置，点击“新增配置”创建第一个。</p>';
    return;
  }
  configState.list.forEach((c) => {
    const item = document.createElement('div');
    item.className = 'config-item';
    item.innerHTML = `
      <div>
        <span class="name">${escapeHtml(c.name)}</span>
        ${c._verifyOk === true ? '<span class="badge ok">验证通过</span>' : ''}
        ${c._verifyOk === false ? '<span class="badge err">验证失败</span>' : ''}
        <div class="meta">Issuer ID: ${escapeHtml(c.issuerId)} · 密钥ID: ${escapeHtml(c.keyId)}</div>
      </div>
      <div class="actions">
        <button class="small" data-act="verify">验证</button>
        <button class="small" data-act="edit">编辑</button>
        <button class="small danger" data-act="delete">删除</button>
      </div>`;
    bindConfigAction(item, 'verify', () => verifyConfig(c));
    bindConfigAction(item, 'edit', () => openConfigForm(c));
    bindConfigAction(item, 'delete', () => deleteConfig(c));
    wrap.appendChild(item);
  });
}

/**
 * HTML 转义防注入
 * @param {string} text 原文本
 * @returns {string} 转义后文本
 */
function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text == null ? '' : String(text);
  return div.innerHTML;
}

/**
 * 验证配置连通性
 * @param {Object} config 配置
 * @returns {Promise<void>}
 */
async function verifyConfig(config) {
  toast('正在验证连接...');
  try {
    const result = await api(`/api/configs/${config.id}/verify`, { method: 'POST' });
    config._verifyOk = result.ok;
    toast(`验证通过，账号下有 ${result.appCount} 个 App`);
  } catch (err) {
    config._verifyOk = false;
    toast(`验证失败：${err.message}`, true);
  }
  renderConfigList();
}

/**
 * 为配置卡片上的操作按钮绑定加载态
 * @param {HTMLElement} item 配置卡片元素
 * @param {string} action 按钮标识（verify/edit/delete）
 * @param {() => Promise<void>} handler 点击处理
 * @returns {void}
 */
function bindConfigAction(item, action, handler) {
  const button = item.querySelector(`[data-act="${action}"]`);
  button.onclick = () => withLoading(button, '处理中...', handler);
}

/**
 * 删除配置
 * @param {Object} config 配置
 * @returns {Promise<void>}
 */
async function deleteConfig(config) {
  if (!confirm(`确定删除配置「${config.name}」吗？其 .p8 密钥文件将一并删除。`)) {
    return;
  }
  await api(`/api/configs/${config.id}`, { method: 'DELETE' });
  await loadConfigs();
  toast('已删除');
}

/**
 * 打开配置表单（新增或编辑）
 * @param {Object|null} config 待编辑配置，新增传 null
 * @returns {void}
 */
function openConfigForm(config) {
  configState.editingId = config ? config.id : null;
  $('config-form-title').textContent = config ? `编辑配置：${config.name}` : '新增配置';
  $('cf-p8-label').innerHTML = config
    ? '.p8 私钥内容（不填则保留原密钥）'
    : '.p8 私钥内容<span class="req">*</span>';
  $('cf-name').value = config ? config.name : '';
  $('cf-issuer').value = config ? config.issuerId : '';
  $('cf-keyid').value = config ? config.keyId : '';
  $('cf-p8').value = '';
  $('config-form-error').classList.add('hidden');
  $('config-form-modal').classList.remove('hidden');
  $('cf-name').focus();
}

/**
 * 保存配置表单
 * @returns {Promise<void>}
 */
async function saveConfigForm() {
  const body = {
    name: $('cf-name').value.trim(),
    issuerId: $('cf-issuer').value.trim(),
    keyId: $('cf-keyid').value.trim(),
  };
  const p8 = $('cf-p8').value.trim();
  const showFormError = (message) => {
    const el = $('config-form-error');
    el.textContent = message;
    el.classList.remove('hidden');
  };
  if (!body.name || !body.issuerId || !body.keyId) {
    showFormError('名称、Issuer ID、Key ID 均不能为空');
    return;
  }
  if (!configState.editingId && !p8) {
    showFormError('新增配置必须提供 .p8 私钥内容');
    return;
  }
  if (p8 && !p8.includes('-----BEGIN PRIVATE KEY-----')) {
    showFormError('.p8 私钥内容格式不正确，应以 -----BEGIN PRIVATE KEY----- 开头');
    return;
  }
  if (p8) {
    body.p8Content = p8;
  }
  try {
    if (configState.editingId) {
      await api(`/api/configs/${configState.editingId}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    } else {
      await api('/api/configs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    }
    $('config-form-modal').classList.add('hidden');
    await loadConfigs();
    toast('配置已保存');
  } catch (err) {
    showFormError(err.message);
  }
}

$('btn-new-config').onclick = () => openConfigForm(null);
$('cf-cancel').onclick = () => $('config-form-modal').classList.add('hidden');
$('cf-save').onclick = () => withLoading($('cf-save'), '保存中...', saveConfigForm);

/**
 * 选择 .p8 文件后自动填充内容并显示文件名
 * @returns {void}
 */
$('cf-p8-file').addEventListener('change', async (event) => {
  const file = event.target.files[0];
  if (!file) {
    return;
  }
  $('cf-p8').value = (await file.text()).trim();
  $('cf-p8-file-name').textContent = `已选 ${file.name}（${fmtSize(file.size)}）`;
  toast(`已读取 ${file.name}`);
});

/* ====================== IPA 上传 ====================== */

const uploadState = { file: null, ipaMeta: null, currentTaskId: null, eventSource: null };

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

$('auto-testflight').addEventListener('change', loadBetaGroups);
$('upload-config').addEventListener('change', loadBetaGroups);

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
    loadTaskHistory().catch(() => {});
  } catch (err) {
    toast(err.message, true);
  }
}

$('submit-task').onclick = () => withLoading($('submit-task'), '提交中...', submitTask);

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
    loadTaskHistory().catch(() => {});
  }
}

/**
 * 加载并渲染历史任务列表
 * @returns {Promise<void>}
 */
async function loadTaskHistory() {
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

$('btn-refresh-history').onclick = () => loadTaskHistory().catch((err) => toast(err.message, true));

/**
 * 重试任务
 * @param {string} taskId 任务 ID
 * @returns {Promise<void>}
 */
window.retryTask = async function retryTask(taskId) {
  try {
    await api(`/api/tasks/${taskId}/retry`, { method: 'POST' });
    subscribeTask(taskId);
    toast('已重新入队');
    // 同步刷新历史列表，避免残留上一次的"失败"状态
    loadTaskHistory().catch(() => {});
  } catch (err) {
    toast(err.message, true);
  }
};

/**
 * 中断进行中的上传任务（确认弹窗说明 Apple 侧语义）
 * @param {string} taskId 任务 ID
 * @returns {Promise<void>}
 */
window.abortTask = async function abortTask(taskId) {
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
};

/* ====================== Builds 页 ====================== */

/**
 * 设置下拉框加载态：显示 loading 文案并在下拉按钮上转圈，期间禁止交互
 * @param {HTMLSelectElement} select 已增强的下拉框
 * @param {boolean} loading 是否加载中
 * @param {string} [text='加载中...'] 加载中显示的文案
 * @returns {void}
 */
function setSelectLoading(select, loading, text = '加载中...') {
  const wrap = select.closest('.dropdown');
  if (!wrap) {
    return;
  }
  wrap.classList.toggle('is-loading', loading);
  if (loading) {
    const menu = wrap.querySelector('.dropdown-menu');
    if (menu) {
      menu.classList.add('hidden');
    }
    select.innerHTML = '';
    const option = document.createElement('option');
    option.value = '';
    option.textContent = text;
    select.appendChild(option);
  }
}

/**
 * 加载 App 下拉
 * @returns {Promise<void>}
 */
async function loadAppsForBuilds() {
  const configId = $('builds-config').value;
  const select = $('builds-app');
  $('builds-table').innerHTML = '<span class="muted">请选择 App</span>';
  if (!configId) {
    select.innerHTML = '<option value="">先选择配置</option>';
    return;
  }
  setSelectLoading(select, true, '正在加载 App 列表...');
  try {
    const data = await api(`/api/apps?configId=${configId}`);
    select.innerHTML = '<option value="">选择 App</option>';
    data.apps.forEach((app) => {
      const option = document.createElement('option');
      option.value = app.id;
      option.textContent = `${app.name} (${app.bundleId})`;
      select.appendChild(option);
    });
  } catch (err) {
    // 下拉框标记失败，避免残留上一个配置的 App 列表造成误选
    select.innerHTML = '<option value="">App 列表加载失败，请重试</option>';
    toast(err.message, true);
  } finally {
    setSelectLoading(select, false);
  }
}

/**
 * 加载并渲染 build 表格
 * @returns {Promise<void>}
 */
async function loadBuilds() {
  const configId = $('builds-config').value;
  const appId = $('builds-app').value;
  const wrap = $('builds-table');
  if (!configId || !appId) {
    wrap.innerHTML = '<span class="muted">请先在上方选择配置与 App</span>';
    return;
  }
  wrap.innerHTML = '<span class="inline-loading">正在加载 build 列表...</span>';
  try {
    const data = await api(`/api/apps/${appId}/builds?configId=${configId}`);
    if (data.builds.length === 0) {
      wrap.innerHTML = '<span class="muted">该 App 暂无 build</span>';
      return;
    }
    const rows = data.builds.map((b) => `
      <tr>
        <td>${escapeHtml(String(b.version))} ${b.shortVersion ? `(${escapeHtml(b.shortVersion)})` : ''}</td>
        <td><span class="stage-badge ${escapeHtml(b.processingState)}">${escapeHtml(buildStateText(b.processingState))}</span></td>
        <td>${b.uploadedDate ? new Date(b.uploadedDate).toLocaleString() : '-'}</td>
        <td><button class="small" data-build="${b.id}" data-version="${escapeHtml(String(b.version))}">加入测试组</button></td>
      </tr>`).join('');
    wrap.innerHTML = `
      <table class="builds">
        <thead><tr><th>版本</th><th>处理状态</th><th>上传时间</th><th>操作</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>`;
    wrap.querySelectorAll('[data-build]').forEach((btn) => {
      btn.onclick = () => openDistributeModal(btn.dataset.build, btn.dataset.version, configId);
    });
  } catch (err) {
    wrap.innerHTML = `<span class="error">${escapeHtml(err.message)}</span>`;
  }
}

$('builds-config').addEventListener('change', loadAppsForBuilds);
$('builds-app').addEventListener('change', loadBuilds);
$('btn-refresh-builds').onclick = () => withLoading($('btn-refresh-builds'), '刷新中...', loadBuilds);

/* 分发弹窗 */
const distributeState = { buildId: null, configId: null };

/**
 * 打开分发弹窗
 * @param {string} buildId build ID
 * @param {string} version 版本号
 * @param {string} configId 配置 ID
 * @returns {Promise<void>}
 */
async function openDistributeModal(buildId, version, configId) {
  distributeState.buildId = buildId;
  distributeState.configId = configId;
  $('distribute-build-info').textContent = `将为 build 版本 ${version} 加入测试组`;
  const wrap = $('distribute-groups');
  wrap.innerHTML = '<span class="muted">加载测试组中...</span>';
  $('distribute-modal').classList.remove('hidden');
  try {
    const data = await api(`/api/beta-groups?configId=${configId}`);
    wrap.innerHTML = data.groups.length === 0
      ? '<span class="muted">该账号下暂无测试组。</span>'
      : '';
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
 * 确认分发
 * @returns {Promise<void>}
 */
async function confirmDistribute() {
  const betaGroupIds = Array.from($('distribute-groups').querySelectorAll('input:checked')).map((i) => i.value);
  if (betaGroupIds.length === 0) {
    toast('请至少选择一个测试组', true);
    return;
  }
  try {
    await api(`/api/builds/${distributeState.buildId}/distribute`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ configId: distributeState.configId, betaGroupIds }),
    });
    $('distribute-modal').classList.add('hidden');
    toast('分发成功，测试员稍后可在 TestFlight 中收到');
  } catch (err) {
    toast(err.message, true);
  }
}

$('distribute-confirm').onclick = () => withLoading($('distribute-confirm'), '分发中...', confirmDistribute);
$('distribute-cancel').onclick = () => $('distribute-modal').classList.add('hidden');

/* ====================== 证书工具 ====================== */

/**
 * 生成 CSR
 * @returns {Promise<void>}
 */
async function generateCsr() {
  const commonName = $('cert-cn').value.trim();
  const remark = $('cert-remark').value.trim();
  if (!remark) {
    toast('请先填写所属项目（必填，用于区分各私钥对应的项目）', true);
    $('cert-remark').focus();
    return;
  }
  if (!commonName) {
    toast('请先填写通用名称（一般填邮箱）', true);
    return;
  }
  try {
    const result = await api('/api/certs/keypair', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ commonName, remark }),
    });
    $('csr-text').value = result.csrPem;
    $('csr-result').classList.remove('hidden');
    toast(remark ? `CSR 已生成（${remark}），私钥已保存在本地` : 'CSR 已生成，私钥已保存在本地');
    loadCertKeys();
  } catch (err) {
    toast(err.message, true);
  }
}

/**
 * 随机生成通用名称（形如 cert-3k9f2x）并填入输入框
 * @returns {void}
 */
function randomCommonName() {
  const chars = 'abcdefghijkmnpqrstuvwxyz23456789';
  let suffix = '';
  for (let i = 0; i < 6; i++) {
    suffix += chars[Math.floor(Math.random() * chars.length)];
  }
  $('cert-cn').value = `cert-${suffix}`;
}

$('btn-random-cn').onclick = () => randomCommonName();
$('btn-gen-csr').onclick = () => withLoading($('btn-gen-csr'), '生成中...', generateCsr);
$('btn-download-csr').onclick = () => downloadFile('certificate signing request.csr', $('csr-text').value);

/** 私钥列表数据缓存（供合成 p12 时按 keyId 反查所属项目） */
const certKeysCache = { list: [] };

/**
 * 加载本地私钥列表
 * @returns {Promise<void>}
 */
async function loadCertKeys() {
  const select = $('cert-key');
  const wrap = $('cert-keys');
  try {
    const data = await api('/api/certs/keys');
    certKeysCache.list = data.keys;
    select.innerHTML = '<option value="">请选择私钥</option>';
    wrap.innerHTML = data.keys.length === 0
      ? '<span class="muted">暂无私钥</span>'
      : '';
    data.keys.forEach((k) => {
      const label = k.remark ? `${k.remark} · ${k.commonName}` : k.commonName;
      const option = document.createElement('option');
      option.value = k.keyId;
      option.textContent = `${label}（${new Date(k.createdAt).toLocaleString()}）`;
      select.appendChild(option);
      const row = document.createElement('div');
      row.className = 'config-item';
      row.innerHTML = `
        <div>
          <span class="name">${escapeHtml(k.remark || k.commonName)}</span>
          <div class="meta">${escapeHtml(k.remark ? `${k.commonName} · ` : '')}${new Date(k.createdAt).toLocaleString()} · ${k.keyId.slice(0, 8)}…</div>
        </div>
        <button class="small danger" data-key="${k.keyId}">删除</button>`;
      row.querySelector('[data-key]').onclick = async () => {
        const label = k.remark || k.commonName;
        if (!confirm(`确定删除私钥「${label}」？删除后无法再为它合成 p12。`)) {
          return;
        }
        await api(`/api/certs/keys/${k.keyId}`, { method: 'DELETE' });
        loadCertKeys();
      };
      wrap.appendChild(row);
    });
    updateGenP12Button();
  } catch (err) {
    wrap.innerHTML = `<span class="error">${escapeHtml(err.message)}</span>`;
  }
}

/**
 * 读取证书文件：PEM 文本直接填充；DER 二进制（Apple 下载的 .cer）转 Base64 后填充
 * @returns {void}
 */
$('cert-cer-file').addEventListener('change', async (event) => {
  const file = event.target.files[0];
  if (!file) {
    return;
  }
  $('cert-cer-file-name').textContent = `已选 ${file.name}（${fmtSize(file.size)}）`;
  try {
    const text = await file.text();
    if (text.includes('-----BEGIN CERTIFICATE-----')) {
      $('cert-cer').value = text.trim();
    } else {
      const bytes = new Uint8Array(await file.arrayBuffer());
      let binary = '';
      for (let i = 0; i < bytes.length; i++) {
        binary += String.fromCharCode(bytes[i]);
      }
      $('cert-cer').value = btoa(binary);
    }
    toast(`已读取 ${file.name}`);
  } catch (err) {
    toast(`读取文件失败：${err.message}`, true);
  }
});

/**
 * 切换 p12 密码输入框的显示/隐藏
 * @returns {void}
 */
$('btn-toggle-password').onclick = () => {
  const input = $('cert-password');
  const hidden = input.type === 'password';
  input.type = hidden ? 'text' : 'password';
  $('btn-toggle-password').textContent = hidden ? '隐藏' : '显示';
};

/**
 * 清空 p12 密码输入框
 * @returns {void}
 */
$('btn-clear-password').onclick = () => {
  $('cert-password').value = '';
  $('cert-password').focus();
};

/**
 * 合成 p12 并下载（合成前解析证书，识别开发证书并提醒）
 * @returns {Promise<void>}
 */
async function generateP12() {
  const keyId = $('cert-key').value;
  const cerContent = $('cert-cer').value.trim();
  const inputPassword = $('cert-password').value;
  const password = inputPassword || '123456';
  if (!keyId) {
    toast('请选择本地私钥', true);
    return;
  }
  if (!cerContent) {
    toast('请选择或粘贴 .cer 证书内容', true);
    return;
  }
  if (inputPassword && inputPassword.length < 6) {
    toast('p12 导出密码至少 6 位', true);
    $('cert-password').focus();
    return;
  }
  try {
    const info = await api(`/api/certs/keys/${keyId}/describe`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cerContent }),
    });
    if (info.isDevelopmentCert) {
      const goOn = confirm(
        '检测到这是 Apple Development（开发）证书，仅适用于真机调试。\n'
        + '发布 App Store / Ad Hoc 版本需要 Apple Distribution（分发）证书。\n仍要继续合成 p12 吗？'
      );
      if (!goOn) {
        return;
      }
    }
    const response = await fetch(`/api/certs/keys/${keyId}/p12`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cerContent, password }),
    });
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      throw new Error(data.error || `合成失败（HTTP ${response.status}）`);
    }
    const blob = await response.blob();
    const keyEntry = certKeysCache.list.find((k) => k.keyId === keyId);
    const safeRemark = (keyEntry && keyEntry.remark || '').replace(/[\\/:*?"<>|]/g, '');
    // 拼接证书用途标识：dev=开发证书，release=发布（Distribution）证书
    const typeLabel = info.certType === 'development' ? 'dev' : (info.certType === 'distribution' ? 'release' : '');
    const nameParts = [safeRemark, typeLabel].filter(Boolean).join('-');
    downloadFile(nameParts ? `certificate-${nameParts}.p12` : 'certificate.p12', blob);
    toast(inputPassword ? 'p12 已合成并开始下载' : 'p12 已合成（未填密码，默认密码 123456）');
  } catch (err) {
    toast(err.message, true);
  }
}

/**
 * 同步"合成并下载 .p12"与"删除所选"按钮可用状态：未选择本地私钥时置灰
 * @returns {void}
 */
function updateGenP12Button() {
  const hasKey = Boolean($('cert-key').value);
  $('btn-gen-p12').disabled = !hasKey;
  $('btn-del-key').disabled = !hasKey;
}

$('cert-key').addEventListener('change', updateGenP12Button);

/**
 * 清除"选择本地私钥"下拉框的当前选择（不删除私钥本身）
 * @returns {void}
 */
function clearKeySelection() {
  $('cert-key').value = '';
  updateGenP12Button();
}

$('btn-del-key').onclick = () => clearKeySelection();

$('btn-gen-p12').onclick = () => withLoading($('btn-gen-p12'), '合成中...', async () => {
  await generateP12();
  updateGenP12Button();
});

/* ====================== 从 .p12 提取私钥 ====================== */

const importP12State = { base64: '' };

/**
 * 同步"从 .p12 提取"按钮状态：已选文件且填写所属项目才可点击（密码可不填，默认 123456）
 * @returns {void}
 */
function updateImportP12Button() {
  $('btn-import-p12').disabled = !importP12State.base64
    || !$('import-p12-remark').value.trim();
}

$('import-p12-file').addEventListener('change', async (event) => {
  const file = event.target.files[0];
  if (!file) {
    return;
  }
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    let binary = '';
    for (let i = 0; i < bytes.length; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    importP12State.base64 = btoa(binary);
    $('import-p12-file-name').textContent = `已选 ${file.name}（${fmtSize(file.size)}）`;
    updateImportP12Button();
  } catch (err) {
    toast(`读取文件失败：${err.message}`, true);
  }
});

$('import-p12-remark').addEventListener('input', updateImportP12Button);

/**
 * 从 .p12 文件提取私钥并导入（密码不填时默认 123456）
 * @returns {Promise<void>}
 */
async function importP12Key() {
  const remark = $('import-p12-remark').value.trim();
  const inputPassword = $('import-p12-password').value;
  const password = inputPassword || '123456';
  if (!importP12State.base64) {
    toast('请先选择 .p12 文件', true);
    return;
  }
  if (!remark) {
    toast('请填写所属项目（必填）', true);
    return;
  }
  try {
    const result = await api('/api/certs/keys/import-p12', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ p12Base64: importP12State.base64, password, remark }),
    });
    let message = `私钥已提取导入（${remark}）`;
    if (result.cert) {
      message += `，对应证书有效期至 ${new Date(result.cert.validNotAfter).toLocaleDateString()}`;
    }
    toast(message);
    importP12State.base64 = '';
    $('import-p12-file-name').textContent = '选择 .p12 文件';
    $('import-p12-password').value = '';
    $('import-p12-remark').value = '';
    updateImportP12Button();
    loadCertKeys();
  } catch (err) {
    toast(err.message, true);
  }
}

$('btn-import-p12').onclick = () => withLoading($('btn-import-p12'), '提取中...', importP12Key);

/* ====================== 连通性测试 ====================== */

/**
 * 加载当前生效的网络出口（直连或代理地址）
 * @returns {Promise<void>}
 */
async function loadConnectivityInfo() {
  const el = $('conn-proxy');
  try {
    const data = await api('/api/connectivity/info');
    el.textContent = data.proxyUrl ? `代理 ${data.proxyUrl}` : '直连（未配置代理）';
  } catch (err) {
    el.textContent = `检测失败：${err.message}`;
  }
}

/**
 * 执行连通性测试并渲染结果表格
 * @returns {Promise<void>}
 */
async function runConnectivityTest() {
  const wrap = $('conn-results');
  const button = $('btn-conn-test');
  button.disabled = true;
  wrap.innerHTML = '<span class="inline-loading">测试中，最长等待约 8 秒/项...</span>';
  try {
    const data = await api('/api/connectivity/test', { method: 'POST' });
    const rows = data.results.map((r) => `
      <tr>
        <td><b>${escapeHtml(r.name)}</b><div class="muted">${escapeHtml(r.note || '')}</div></td>
        <td>${r.ok ? '<span class="badge ok">连通</span>' : '<span class="badge err">不通</span>'}</td>
        <td>${r.httpStatus == null ? '-' : escapeHtml(String(r.httpStatus))}</td>
        <td>${r.latencyMs} ms</td>
        <td class="muted conn-error" title="${escapeHtml(r.error || '')}">${r.ok ? '-' : escapeHtml(r.error || '')}</td>
      </tr>`).join('');
    wrap.innerHTML = `
      <table class="builds">
        <thead><tr><th>目标</th><th>状态</th><th>HTTP 状态码</th><th>延迟</th><th>错误信息</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>`;
    const allOk = data.results.every((r) => r.ok);
    toast(allOk ? '全部目标连通正常' : '存在不通的目标，请检查代理配置', !allOk);
  } catch (err) {
    wrap.innerHTML = `<span class="error">${escapeHtml(err.message)}</span>`;
  } finally {
    button.disabled = false;
    loadConnectivityInfo();
  }
}

$('btn-conn-test').onclick = () => runConnectivityTest();

/* ====================== 通用 ⓘ 提示交互（事件委托，点击开关） ====================== */

/**
 * 关闭页面上所有已打开的 ⓘ 提示
 * @returns {void}
 */
function closeAllHints() {
  document.querySelectorAll('.hint-wrap.open').forEach((wrap) => wrap.classList.remove('open'));
}

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

/* ====================== 自定义下拉组件（替代原生 select 的系统样式） ====================== */

/**
 * 将原生 select 增强为自定义下拉：隐藏原生控件，渲染样式可控的触发按钮与选项列表。
 * 原生 select 的 value 读写与 change 事件保持不变，业务代码零改动。
 * @param {HTMLSelectElement} select 原生下拉框
 * @returns {void}
 */
function enhanceSelect(select) {
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

// 点击组件外部时关闭所有下拉列表
document.addEventListener('click', (event) => {
  document.querySelectorAll('.dropdown-menu:not(.hidden)').forEach((m) => {
    if (!m.parentNode.contains(event.target)) {
      m.classList.add('hidden');
    }
  });
});

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    document.querySelectorAll('.dropdown-menu:not(.hidden)').forEach((m) => m.classList.add('hidden'));
  }
});

document.querySelectorAll('select').forEach(enhanceSelect);

/* ====================== 通用交互：回车提交 / 遮罩与 Esc 关闭 ====================== */

/**
 * 为输入框绑定回车触发（textarea 不适用）
 * @param {string} inputId 输入框 ID
 * @param {() => void} handler 回车时执行的回调
 * @returns {void}
 */
function bindEnter(inputId, handler) {
  $(inputId).addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      handler();
    }
  });
}

bindEnter('cf-name', saveConfigForm);
bindEnter('cf-issuer', saveConfigForm);
bindEnter('cf-keyid', saveConfigForm);
bindEnter('cert-remark', generateCsr);
bindEnter('cert-cn', generateCsr);
bindEnter('cert-password', generateP12);
bindEnter('setting-proxy', saveSettings);

/**
 * 点击弹窗遮罩（非内容区）关闭弹窗
 * @returns {void}
 */
function bindModalBackdropClose() {
  document.querySelectorAll('.modal').forEach((modal) => {
    modal.addEventListener('click', (event) => {
      if (event.target === modal) {
        modal.classList.add('hidden');
      }
    });
  });
}

bindModalBackdropClose();

document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') {
    return;
  }
  document.querySelectorAll('.modal:not(.hidden)').forEach((modal) => modal.classList.add('hidden'));
  closeAllHints();
});

/* ====================== 初始化 ====================== */

/**
 * 加载代理设置与数据目录
 * @returns {Promise<void>}
 */
async function loadSettings() {
  const data = await api('/api/settings');
  $('setting-proxy').value = data.proxyUrl || '';
  $('data-dir').textContent = data.dataDir || '-';
}

/**
 * 保存代理设置
 * @returns {Promise<void>}
 */
async function saveSettings() {
  await api('/api/settings', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ proxyUrl: $('setting-proxy').value }),
  });
  toast('代理设置已保存');
}

$('btn-save-proxy').onclick = () => withLoading($('btn-save-proxy'), '保存中...', saveSettings);

/**
 * 探测本机常见代理端口，命中后自动填入输入框（不自动保存，由用户确认）
 * @returns {Promise<void>}
 */
async function detectProxy() {
  try {
    const data = await api('/api/settings/detect-proxy', { method: 'POST' });
    if (!data.found) {
      toast('未检测到常见端口（7890/7897/10809/1080/8118/8888）上的可用代理，请手动填写', true);
      return;
    }
    $('setting-proxy').value = data.proxyUrl;
    toast(`已检测到代理 ${data.proxyUrl} 并填入，点击“保存”生效`);
  } catch (err) {
    toast(err.message, true);
  }
}

$('btn-detect-proxy').onclick = () => withLoading($('btn-detect-proxy'), '检测中...', detectProxy);

/**
 * 清空代理设置并立即保存（恢复直连）
 * @returns {Promise<void>}
 */
async function clearProxy() {
  $('setting-proxy').value = '';
  try {
    await api('/api/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ proxyUrl: '' }),
    });
    toast('已清空代理，恢复直连');
    loadConnectivityInfo().catch(() => {});
  } catch (err) {
    toast(err.message, true);
  }
}

$('btn-clear-proxy').onclick = () => withLoading($('btn-clear-proxy'), '清空中...', clearProxy);

loadConfigs().catch((err) => toast(`初始化失败：${err.message}`, true));
loadSettings().catch(() => {});
loadCertKeys().catch((err) => toast(`私钥列表加载失败：${err.message}`, true));
loadConnectivityInfo().catch(() => {});
loadTaskHistory().catch(() => {});

// 恢复上次所在的 Tab（默认停留上传页）
const savedTab = localStorage.getItem('asc-active-tab');
if (savedTab && savedTab !== 'upload') {
  switchTab(savedTab);
}
