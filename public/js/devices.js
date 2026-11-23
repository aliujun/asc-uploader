/* 设备管理组件：注册设备列表、状态统计、注册新设备（UDID） */
import {
  $, api, escapeHtml, fillSelect, formatDate, toast, withLoading,
} from './common.js';

/** 组件标题（导航按钮文案唯一事实源） */
export const title = '设备管理';

/** 页面模板 */
export const template = `<section id="tab-devices" class="tab-panel">
            <div class="card">
                <h2>注册设备</h2>
                <p class="muted">通过 ASC API 读取账号下已注册的设备，也可在这里直接注册新设备（UDID）。Ad Hoc / 开发描述文件必须关联设备。</p>
                <div class="form-row inline">
                    <select id="device-config">
                        <option value="">选择 ASC 配置</option>
                    </select>
                    <button id="btn-device-refresh">刷新</button>
                    <button id="btn-device-add" class="primary">注册设备</button>
                </div>
                <div id="device-stats" class="stats-bar hidden"></div>
                <div id="device-list" class="config-list"></div>
            </div>

            <div class="card">
                <h2>说明</h2>
                <ol class="steps">
                    <li>UDID 获取方式：iOS 设备可连接电脑后在 Xcode「Devices and Simulators」查看，或访问 udid.io 等在线工具页获取。</li>
                    <li>Apple 对每年新增设备数量有配额限制（会员类型不同配额不同），超限注册会被拒绝。</li>
                    <li>设备的删除与停用仅支持在 <b>Apple Developer 官网</b>（Certificates, Identifiers &amp; Profiles → Devices）操作，工具暂不提供。</li>
                    <li>注册成功后即可在「描述文件」页生成 Ad Hoc / 开发描述文件时勾选该设备。</li>
                </ol>
            </div>

            <div id="device-add-modal" class="modal hidden">
                <div class="modal-box">
                    <h3>注册设备</h3>
                    <div class="form-row">
                        <label class="switch-label">
                            <input type="checkbox" id="device-batch-mode"> 批量录入模式（一次录入多台）
                        </label>
                    </div>
                    <div class="form-row">
                        <label>平台<span class="req">*</span></label>
                        <select id="device-platform">
                            <option value="IOS">iOS / iPadOS（iPhone、iPad、iPod touch）</option>
                            <option value="MAC_OS">macOS（Mac）</option>
                            <option value="UNIVERSAL">通用（Watch、Apple TV 等）</option>
                        </select>
                    </div>
                    <div id="device-single-fields">
                        <div class="form-row">
                            <label>UDID<span class="req">*</span></label>
                            <input id="device-udid" placeholder="设备的 UDID（40 位十六进制或 8-4-4-4-12 格式）" autocomplete="off">
                        </div>
                        <div class="form-row">
                            <label>设备名称</label>
                            <input id="device-name" placeholder="默认取 UDID 前 6 位，建议填设备型号便于识别" autocomplete="off">
                        </div>
                    </div>
                    <div id="device-batch-fields" class="form-row hidden">
                        <label>设备列表（每行一台：UDID 或 名称+空格+UDID）<span class="req">*</span></label>
                        <textarea id="device-batch-text" rows="6" placeholder="例如：&#10;测试机一 00008101-001234567890001E&#10;测试机二 00008101-001234567890002E&#10;或仅填UDID：&#10;00008101-001234567890003E"></textarea>
                    </div>
                    <p id="device-add-error" class="error hidden"></p>
                    <div class="form-actions">
                        <button id="btn-device-add-submit" class="primary">注册</button>
                        <button id="btn-device-add-cancel">取消</button>
                    </div>
                </div>
            </div>
        </section>`;

/** 组件状态：configs 供下拉，devices 为当前配置下的设备列表 */
const state = {
  configs: [],
  devices: [],
  configId: '',
  resourcesLoaded: false,
};

/**
 * 平台枚举的中文文案
 * @param {string} platform 平台标识
 * @returns {string} 展示文案
 */
function platformLabel(platform) {
  const map = { IOS: 'iOS', MAC_OS: 'macOS', UNIVERSAL: '通用' };
  return map[platform] || platform || '-';
}

/**
 * 设备类别枚举的展示文案
 * @param {string} deviceClass 设备类别标识
 * @returns {string} 展示文案
 */
function deviceClassLabel(deviceClass) {
  const map = {
    IPHONE: 'iPhone',
    IPAD: 'iPad',
    IPOD: 'iPod touch',
    MAC: 'Mac',
    APPLE_WATCH: 'Apple Watch',
    APPLE_TV: 'Apple TV',
  };
  return map[deviceClass] || deviceClass || '-';
}

/**
 * 设备状态徽章 HTML（ENABLED 绿色、DISABLED 红色）
 * @param {string} status 状态标识
 * @returns {string} 徽章 HTML
 */
function statusBadgeHtml(status) {
  if (status === 'ENABLED') {
    return '<span class="badge ok">已启用</span>';
  }
  if (status === 'DISABLED') {
    return '<span class="badge err">已停用</span>';
  }
  return `<span class="badge">${escapeHtml(status || '未知')}</span>`;
}

/**
 * 首次进入时加载 ASC 配置（供下拉选择）
 * @returns {Promise<void>}
 * @throws {Error} 接口请求失败时抛出
 */
async function loadResources() {
  if (state.resourcesLoaded) {
    return;
  }
  const data = await api('/api/configs');
  state.configs = data.configs || [];
  fillSelect($('device-config'), '选择 ASC 配置', state.configs.map((c) => ({ value: c.id, label: c.name })));
  state.resourcesLoaded = true;
}

/**
 * 渲染统计条与设备列表
 * @returns {void}
 */
function renderDeviceList() {
  const stats = $('device-stats');
  const wrap = $('device-list');
  const devices = state.devices;
  if (devices.length === 0) {
    stats.classList.add('hidden');
    stats.innerHTML = '';
    wrap.innerHTML = '<span class="muted">该账号暂无注册设备</span>';
    return;
  }
  const enabled = devices.filter((d) => d.status === 'ENABLED').length;
  stats.innerHTML = `
                <div class="stat">
                    <span class="stat-num">${enabled}</span>
                    <span class="stat-label">已启用</span>
                </div>
                <div class="stat${enabled < devices.length ? ' warn' : ''}">
                    <span class="stat-num">${devices.length - enabled}</span>
                    <span class="stat-label">已停用</span>
                </div>
                <div class="stat">
                    <span class="stat-num">${devices.length}</span>
                    <span class="stat-label">设备总数</span>
                </div>`;
  stats.classList.remove('hidden');

  wrap.innerHTML = '';
  devices.forEach((device) => {
    const row = document.createElement('div');
    row.className = 'config-item';
    row.innerHTML = `
      <div>
        <span class="name">${escapeHtml(device.name || '未命名设备')}</span>
        ${statusBadgeHtml(device.status)}
        <span class="badge">${escapeHtml(platformLabel(device.platform))}</span>
        <div class="meta">UDID ${escapeHtml(device.udid || '-')} · ${escapeHtml(device.model || deviceClassLabel(device.deviceClass))} · 添加于 ${escapeHtml(formatDate(device.addedDate))}</div>
      </div>
      <div class="actions">
        <button class="small" data-copy-udid="${escapeHtml(device.udid || '')}">复制 UDID</button>
      </div>`;
    const copyBtn = row.querySelector('[data-copy-udid]');
    if (copyBtn) {
      copyBtn.onclick = async () => {
        try {
          await navigator.clipboard.writeText(copyBtn.dataset.copyUdid);
          toast('UDID 已复制到剪贴板');
        } catch {
          toast('复制失败，请手动选择复制', true);
        }
      };
    }
    wrap.appendChild(row);
  });
}

/**
 * 加载当前配置下的设备列表并渲染
 * @returns {Promise<void>}
 */
async function loadDeviceList() {
  const wrap = $('device-list');
  try {
    const data = await api(`/api/devices?configId=${encodeURIComponent(state.configId)}`);
    state.devices = data.devices || [];
    renderDeviceList();
  } catch (err) {
    state.devices = [];
    $('device-stats').classList.add('hidden');
    $('device-stats').innerHTML = '';
    wrap.innerHTML = `<span class="error">${escapeHtml(err.message)}</span>`;
  }
}

/**
 * 打开注册设备弹窗
 * @returns {Promise<void>}
 */
async function openAddModal() {
  try {
    await loadResources();
  } catch (err) {
    toast(err.message, true);
    return;
  }
  if (state.configs.length === 0) {
    toast('暂无 ASC 配置，请先到「配置管理」页添加', true);
    return;
  }
  $('device-udid').value = '';
  $('device-name').value = '';
  const batchText = $('device-batch-text');
  if (batchText) {
    batchText.value = '';
  }
  const batchMode = $('device-batch-mode');
  if (batchMode) {
    batchMode.checked = false;
    $('device-single-fields').classList.remove('hidden');
    $('device-batch-fields').classList.add('hidden');
  }
  // 重置名称占位符，避免残留上一轮输入 UDID 时动态预填的前 6 位
  $('device-name').placeholder = '默认取 UDID 前 6 位，建议填设备型号便于识别';
  $('device-platform').value = 'IOS';
  $('device-add-error').classList.add('hidden');
  $('device-add-modal').classList.remove('hidden');
}

/**
 * 关闭注册设备弹窗并清空错误提示
 * @returns {void}
 */
function closeAddModal() {
  $('device-add-modal').classList.add('hidden');
  $('device-add-error').classList.add('hidden');
}

/**
 * 提交注册请求（支持单台注册与批量多台）：成功后刷新列表并关弹窗
 * @returns {Promise<void>}
 */
async function submitAdd() {
  const isBatch = $('device-batch-mode') && $('device-batch-mode').checked;
  const platform = $('device-platform').value;
  const errorEl = $('device-add-error');

  // 批量注册分支
  if (isBatch) {
    const rawText = ($('device-batch-text').value || '').trim();
    if (!rawText) {
      toast('请填写待注册的设备信息', true);
      return;
    }
    const lines = rawText.split('\n').map((l) => l.trim()).filter(Boolean);
    const devices = [];
    for (const line of lines) {
      const parts = line.split(/\s+/);
      if (parts.length >= 2) {
        devices.push({ name: parts[0], udid: parts[1], platform });
        continue;
      }
      if (parts.length === 1) {
        devices.push({ name: parts[0].slice(0, 6), udid: parts[0], platform });
      }
    }
    if (devices.length === 0) {
      toast('未解析到有效设备行', true);
      return;
    }
    try {
      await withLoading($('btn-device-add-submit'), '批量注册中...', async () => {
        const res = await api('/api/devices', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ configId: state.configId, devices }),
        });
        const successCount = (res.results || []).filter((r) => r.ok).length;
        const failCount = devices.length - successCount;
        closeAddModal();
        if (failCount === 0) {
          toast(`批量注册成功，共 ${successCount} 台设备`);
        } else {
          toast(`注册完成：成功 ${successCount} 台，失败 ${failCount} 台（详情可在列表核对）`, true);
        }
        loadDeviceList();
      });
    } catch (err) {
      errorEl.textContent = err.message;
      errorEl.classList.remove('hidden');
    }
    return;
  }

  // 单台注册分支
  const udid = $('device-udid').value.trim();
  const name = $('device-name').value.trim() || udid.slice(0, 6);
  if (!udid) {
    toast('请填写设备 UDID', true);
    return;
  }
  try {
    await withLoading($('btn-device-add-submit'), '注册中...', async () => {
      await api('/api/devices', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ configId: state.configId, name, platform, udid }),
      });
      closeAddModal();
      toast('设备注册成功');
      loadDeviceList();
    });
  } catch (err) {
    errorEl.textContent = err.message;
    errorEl.classList.remove('hidden');
  }
}

/** 切到本页签时按当前配置刷新列表（首次加载配置下拉） */
export async function onShown() {
  try {
    await loadResources();
  } catch (err) {
    toast(`资源加载失败：${err.message}`, true);
    return;
  }
  if (!state.configId && state.configs.length > 0) {
    state.configId = state.configs[0].id;
    $('device-config').value = state.configId;
    loadDeviceList();
    return;
  }
  if (state.configId) {
    loadDeviceList();
  }
}

/**
 * 绑定本组件全部事件（模板注入后由注册器调用一次）
 * @returns {void}
 */
export function init() {
  $('device-config').addEventListener('change', () => {
    state.configId = $('device-config').value;
    if (!state.configId) {
      state.devices = [];
      renderDeviceList();
      return;
    }
    loadDeviceList();
  });
  $('btn-device-refresh').addEventListener('click', (event) => {
    if (!state.configId) {
      toast('请先选择 ASC 配置', true);
      return;
    }
    withLoading(event.currentTarget, '刷新中...', loadDeviceList);
  });
  $('btn-device-add').addEventListener('click', () => {
    openAddModal();
  });
  const batchModeCheckbox = $('device-batch-mode');
  if (batchModeCheckbox) {
    batchModeCheckbox.addEventListener('change', () => {
      const isBatch = batchModeCheckbox.checked;
      $('device-single-fields').classList.toggle('hidden', isBatch);
      $('device-batch-fields').classList.toggle('hidden', !isBatch);
    });
  }
  // UDID 输入后名称为空时自动预填（取 UDID 前 6 位）
  $('device-udid').addEventListener('input', () => {
    const nameEl = $('device-name');
    if (!nameEl.value.trim()) {
      nameEl.placeholder = $('device-udid').value.trim().slice(0, 6) || '默认取 UDID 前 6 位';
    }
  });
  $('btn-device-add-submit').addEventListener('click', () => {
    submitAdd();
  });
  $('btn-device-add-cancel').addEventListener('click', closeAddModal);
}
