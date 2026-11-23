/* Builds 组件：App 下拉加载、build 列表三态渲染、TestFlight 分发弹窗 */
import { $, api, escapeHtml, toast, withLoading } from './common.js';

/** 组件标题（导航按钮文案唯一事实源） */
export const title = 'Builds';

/** 页面模板（原 index.html Builds 区块整体搬运，active 类由注册器注入） */
export const template = `<section id="tab-builds" class="tab-panel">
            <div class="card">
                <h2>Build 列表</h2>
                <div class="form-row inline">
                    <select id="builds-config"></select>
                    <select id="builds-app">
                        <option value="">先选择配置后加载 App</option>
                    </select>
                    <button id="btn-refresh-builds">刷新</button>
                </div>
                <div id="builds-table" class="muted">请先在上方选择配置与 App</div>
            </div>

            <div id="distribute-modal" class="modal hidden">
                <div class="modal-box">
                    <h3>加入 TestFlight 测试组</h3>
                    <p id="distribute-build-info" class="muted"></p>
                    <div id="distribute-groups" class="checkbox-list"></div>
                    <div class="form-actions">
                        <button id="distribute-confirm" class="primary">确认分发</button>
                        <button id="distribute-cancel">取消</button>
                    </div>
                </div>
            </div>
        </section>`;

/** build 处理状态英文名 → 中文名映射（官方枚举：PROCESSING/FAILED/INVALID/VALID） */
const BUILD_STATE_TEXT = {
  PROCESSING: '处理中',
  FAILED: '失败',
  INVALID: '无效',
  VALID: '可用',
};

/** 分发弹窗状态 */
const distributeState = { buildId: null, configId: null };

/** build 列表加载请求序号（防竞态：丢弃快速切换后的过期响应） */
let buildsReqSeq = 0;

/**
 * build 处理状态的中文文案
 * @param {string} state 状态英文标识
 * @returns {string} 中文名，未知时原样返回
 */
function buildStateText(state) {
  return BUILD_STATE_TEXT[state] || state || '-';
}

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
  // 请求序号守卫：快速切换配置/App 时丢弃过期响应，避免旧数据覆盖新数据
  const seq = ++buildsReqSeq;
  wrap.innerHTML = '<span class="inline-loading">正在加载 build 列表...</span>';
  try {
    const data = await api(`/api/apps/${appId}/builds?configId=${configId}`);
    if (seq !== buildsReqSeq) {
      return;
    }
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
      label.innerHTML = `<input type="checkbox" value="${escapeHtml(g.id)}"> ${escapeHtml(g.name)}${g.isInternalGroup ? '（内部）' : ''}`;
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
    await api(`/api/apps/${distributeState.buildId}/distribute`, {
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

/** 切到本页签时按当前配置刷新 App 下拉（内部已自吞异常，直调即可） */
export function onShown() {
  loadAppsForBuilds();
}

/**
 * 绑定本组件全部事件（模板注入后由注册器调用一次）
 * @returns {void}
 */
export function init() {
  $('builds-config').addEventListener('change', loadAppsForBuilds);
  $('builds-app').addEventListener('change', loadBuilds);
  $('btn-refresh-builds').onclick = () => withLoading($('btn-refresh-builds'), '刷新中...', loadBuilds);
  $('distribute-confirm').onclick = () => withLoading($('distribute-confirm'), '分发中...', confirmDistribute);
  $('distribute-cancel').onclick = () => $('distribute-modal').classList.add('hidden');
}
