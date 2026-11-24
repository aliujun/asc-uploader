/* App ID 管理组件：Identifiers 列表（含已启用能力徽章）、新建显式 App ID（可勾选常用能力）、删除 */
import {
  $, api, escapeHtml, fillSelect, toast, withLoading,
} from './common.js';

/** 组件标题（导航按钮文案唯一事实源） */
export const title = 'App ID 管理';

/** 组件状态：configs 供下拉，identifiers 为当前配置下的 App ID 列表，capsSupported 表示当前密钥能否读取能力列表 */
const state = {
  configs: [],
  identifiers: [],
  configId: '',
  resourcesLoaded: false,
  capsSupported: true,
};

/** 列表加载请求序号（防快速切换配置时的响应竞态） */
let listReqSeq = 0;

/** 常用能力清单（新建弹框勾选项）：capabilityType → 中文短名 */
const COMMON_CAPABILITIES = [
  { type: 'PUSH_NOTIFICATIONS', label: '推送通知' },
  { type: 'APP_GROUPS', label: 'App Groups（App 群组）' },
  { type: 'ASSOCIATED_DOMAINS', label: '关联域（Universal Links）' },
  { type: 'APPLE_ID_AUTH', label: 'Sign in with Apple' },
  { type: 'ICLOUD', label: 'iCloud' },
  { type: 'HEALTHKIT', label: 'HealthKit（健康数据）' },
  { type: 'HOMEKIT', label: 'HomeKit（家庭）' },
  { type: 'NFC_TAG_READING', label: 'NFC 标签读取' },
];

/** 能力类型 → 展示短名（未知能力原样返回），与弹框清单保持一致 */
const CAPABILITY_LABELS = new Map(COMMON_CAPABILITIES.map((item) => [item.type, item.label]));

/** 能力类型 → 展示短名（未知能力原样返回）：弹框可勾选的常用项 + 列表展示用的其余常见项 */
const EXTRA_CAPABILITY_LABELS = {
  IN_APP_PURCHASE: 'App 内购买',
  APPLE_PAY: 'Apple Pay',
  GAME_CENTER: 'Game Center',
  DATA_PROTECTION: '数据保护',
  MAPS: '地图',
  WALLET: '钱包（Passbook）',
  NETWORK_EXTENSIONS: '网络扩展',
  WIFI_ACCESSORY: '无线配件配置',
  ICLOUD_VERSION: 'iCloud（旧版）',
};

/**
 * 能力类型的展示文案
 * @param {string} capabilityType ASC capabilityType 枚举
 * @returns {string} 中文短名，未知时原样返回
 */
function capabilityLabel(capabilityType) {
  return CAPABILITY_LABELS.get(capabilityType) || EXTRA_CAPABILITY_LABELS[capabilityType] || capabilityType;
}

/**
 * App ID 平台枚举 → 展示文案
 * @param {string} platform 平台标识
 * @returns {string} 展示文案
 */
function platformLabel(platform) {
  const map = { IOS: 'iOS', MAC_OS: 'macOS', SERVICES: 'Services', UNIVERSAL: '通用' };
  return map[platform] || platform || '-';
}

/** 页面模板 */
export const template = `<section id="tab-identifiers" class="tab-panel">
            <div class="card">
                <h2>App ID 列表</h2>
                <p class="muted">通过 ASC API 读取账号下的 App ID（Identifiers）及其已启用能力，也可在这里直接注册新的显式 App ID 并启用常用能力。</p>
                <div class="form-row inline">
                    <select id="identifier-config">
                        <option value="">选择 ASC 配置</option>
                    </select>
                    <button id="btn-identifier-refresh">刷新</button>
                    <button id="btn-identifier-add" class="primary">注册 App ID</button>
                </div>
                <div id="identifier-list" class="config-list"></div>
            </div>

            <div class="card">
                <h2>说明</h2>
                <ol class="steps">
                    <li>App ID 分<b>显式</b>（如 com.example.app）与<b>通配符</b>（如 com.example.*）两类；本工具仅支持注册显式 App ID，通配符类型请前往 Apple Developer 官网处理。</li>
                    <li>注册时可直接勾选常用能力（推送、App Groups、关联域等），能力也可随时在 Apple Developer 官网增改。</li>
                    <li>Sign in with Apple 由工具默认以「非主 App ID」启用；同一 App ID 下若有多个 App 使用，主 App ID 需在官网调整。</li>
                    <li>删除 App ID 立即生效且不可恢复，使用该 App ID 的描述文件会随之失效；打包描述文件请在「描述文件」页生成。</li>
                </ol>
            </div>

            <div id="identifier-add-modal" class="modal hidden">
                <div class="modal-box">
                    <h3>注册 App ID</h3>
                    <div class="form-row">
                        <label>ASC 配置<span class="req">*</span></label>
                        <select id="identifier-add-config">
                            <option value="">请选择配置</option>
                        </select>
                    </div>
                    <div class="form-row">
                        <label>名称<span class="req">*</span></label>
                        <input id="identifier-add-name" placeholder="如：示例 App（仅用于在 Apple 后台识别）" autocomplete="off">
                    </div>
                    <div class="form-row">
                        <label>平台<span class="req">*</span></label>
                        <select id="identifier-add-platform">
                            <option value="IOS">iOS / iPadOS</option>
                            <option value="UNIVERSAL">通用（iOS + watchOS / tvOS 等）</option>
                            <option value="MAC_OS">macOS</option>
                            <option value="SERVICES">Services（仅服务端）</option>
                        </select>
                    </div>
                    <div class="form-row">
                        <label>Bundle ID<span class="req">*</span></label>
                        <input id="identifier-add-bundle" placeholder="显式写法，如 com.example.app（不允许通配符）" autocomplete="off">
                    </div>
                    <div class="form-row">
                        <label>常用能力（可多选）</label>
                        <div id="identifier-add-caps" class="checkbox-list"></div>
                    </div>
                    <p class="muted">Bundle ID 注册后不可修改；需与打包 IPA 中的包名一致，否则描述文件无法匹配。</p>
                    <p id="identifier-add-error" class="error hidden"></p>
                    <div class="form-actions">
                        <button id="btn-identifier-add-submit" class="primary">注册</button>
                        <button id="btn-identifier-add-cancel">取消</button>
                    </div>
                </div>
            </div>
        </section>`;

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
  fillSelect($('identifier-config'), '选择 ASC 配置', state.configs.map((c) => ({ value: c.id, label: c.name })));
  state.resourcesLoaded = true;
}

/**
 * 渲染 App ID 列表
 * @returns {void}
 */
function renderIdentifierList() {
  const wrap = $('identifier-list');
  const list = state.identifiers;
  // Apple 限制当前密钥不可读能力列表时，顶部给出统一说明
  const degradeNote = state.capsSupported ? '' : '<div class="muted">当前 API 密钥受 Apple 限制无法读取能力列表，以下列表不展示能力徽章；注册时勾选的能力以提交结果为准。</div>';
  if (list.length === 0) {
    wrap.innerHTML = `${degradeNote}<span class="muted">该账号暂无 App ID</span>`;
    return;
  }
  wrap.innerHTML = degradeNote;
  list.forEach((item) => {
    const row = document.createElement('div');
    row.className = 'config-item';
    const capBadges = (item.capabilities || [])
      .map((cap) => `<span class="badge">${escapeHtml(capabilityLabel(cap))}</span>`)
      .join('');
    row.innerHTML = `
      <div>
        <span class="name">${escapeHtml(item.name || '未命名 App ID')}</span>
        <span class="badge">${escapeHtml(platformLabel(item.platform))}</span>
        ${capBadges}
        <div class="meta">${escapeHtml(item.identifier || '-')}</div>
      </div>
      <div class="actions">
        <button class="small danger" data-act="delete">删除</button>
      </div>`;
    row.querySelector('[data-act="delete"]').onclick = (event) => {
      const label = item.name || item.id;
      const goOn = confirm(`确定删除 App ID「${label}」（${item.identifier || '-'}）？\n`
        + '删除后立即生效且不可恢复，使用该 App ID 的描述文件会随之失效。');
      if (!goOn) {
        return;
      }
      withLoading(event.currentTarget, '删除中...', () => deleteIdentifier(item));
    };
    wrap.appendChild(row);
  });
}

/**
 * 加载当前配置下的 App ID 列表并渲染
 * @returns {Promise<void>}
 */
async function loadIdentifierList() {
  const wrap = $('identifier-list');
  // 请求序号守卫：快速切换配置时丢弃过期响应
  const seq = ++listReqSeq;
  try {
    const data = await api(`/api/identifiers?configId=${encodeURIComponent(state.configId)}`);
    if (seq !== listReqSeq) {
      return;
    }
    state.identifiers = data.identifiers || [];
    state.capsSupported = data.capabilitiesSupported !== false;
    renderIdentifierList();
  } catch (err) {
    if (seq !== listReqSeq) {
      return;
    }
    state.identifiers = [];
    wrap.innerHTML = `<span class="error">${escapeHtml(err.message)}</span>`;
  }
}

/**
 * 打开注册弹窗：填充配置下拉（默认取列表卡当前选择）并渲染能力勾选项
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
  fillSelect($('identifier-add-config'), '请选择配置', state.configs.map((c) => ({ value: c.id, label: c.name })));
  $('identifier-add-config').value = state.configId;
  $('identifier-add-name').value = '';
  $('identifier-add-platform').value = 'IOS';
  $('identifier-add-bundle').value = '';
  const capWrap = $('identifier-add-caps');
  capWrap.innerHTML = '';
  COMMON_CAPABILITIES.forEach((cap) => {
    const label = document.createElement('label');
    label.innerHTML = `<input type="checkbox" value="${escapeHtml(cap.type)}"> ${escapeHtml(cap.label)}`;
    capWrap.appendChild(label);
  });
  $('identifier-add-error').classList.add('hidden');
  $('identifier-add-modal').classList.remove('hidden');
}

/**
 * 关闭注册弹窗并清空错误提示
 * @returns {void}
 */
function closeAddModal() {
  $('identifier-add-modal').classList.add('hidden');
  $('identifier-add-error').classList.add('hidden');
}

/**
 * 校验注册表单，通过后返回请求参数
 * @returns {Object|null} {configId, name, platform, identifier, capabilities}，校验失败返回 null
 */
function validateAddForm() {
  const configId = $('identifier-add-config').value;
  const name = $('identifier-add-name').value.trim();
  const platform = $('identifier-add-platform').value;
  const identifier = $('identifier-add-bundle').value.trim();
  const capabilities = Array.from($('identifier-add-caps').querySelectorAll('input:checked')).map((i) => i.value);
  if (!configId) {
    toast('请选择 ASC 配置', true);
    return null;
  }
  if (!name) {
    toast('请填写名称', true);
    $('identifier-add-name').focus();
    return null;
  }
  if (!identifier) {
    toast('请填写 Bundle ID', true);
    $('identifier-add-bundle').focus();
    return null;
  }
  const segment = /^[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?$/;
  const parts = identifier.split('.');
  if (identifier.includes('*')) {
    toast('本工具仅支持显式 App ID，不支持通配符（*）', true);
    $('identifier-add-bundle').focus();
    return null;
  }
  if (parts.length < 2 || !parts.every((p) => segment.test(p))) {
    toast('Bundle ID 需为域名式写法且至少两段，如 com.example.app', true);
    $('identifier-add-bundle').focus();
    return null;
  }
  return { configId, name, platform, identifier, capabilities };
}

/**
 * 提交注册请求：成功后刷新列表并关弹窗；能力部分启用失败时在弹窗内持久展示详情
 * @returns {Promise<void>}
 */
async function submitAdd() {
  const form = validateAddForm();
  if (!form) {
    return;
  }
  const errorEl = $('identifier-add-error');
  try {
    await withLoading($('btn-identifier-add-submit'), '注册中...', async () => {
      const data = await api('/api/identifiers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form),
      });
      const failed = (data.results || []).filter((r) => !r.ok);
      state.configId = form.configId;
      $('identifier-config').value = form.configId;
      await loadIdentifierList();
      if (failed.length === 0) {
        closeAddModal();
        toast(`App ID「${form.identifier}」已注册`);
        return;
      }
      // App ID 已创建无法回滚：弹窗保留并展示失败的能力，列表已刷新
      const detail = failed
        .map((r) => `${capabilityLabel(r.capabilityType)}：${r.error || '失败'}`)
        .join('；');
      errorEl.textContent = `App ID 已创建，但以下能力启用失败（可稍后在官网补开）：${detail}`;
      errorEl.classList.remove('hidden');
    });
  } catch (err) {
    errorEl.textContent = err.message;
    errorEl.classList.remove('hidden');
  }
}

/**
 * 删除 App ID（调用前需已确认，成功后刷新列表）
 * @param {Object} item App ID 条目
 * @returns {Promise<void>}
 */
async function deleteIdentifier(item) {
  try {
    await api(`/api/identifiers/${encodeURIComponent(item.id)}?configId=${encodeURIComponent(state.configId)}`, {
      method: 'DELETE',
    });
    toast('App ID 已删除');
    loadIdentifierList();
  } catch (err) {
    toast(err.message, true);
  }
}

/**
 * 绑定组件内事件
 * @returns {void}
 */
export function init() {
  $('identifier-config').addEventListener('change', () => {
    state.configId = $('identifier-config').value;
    if (!state.configId) {
      state.identifiers = [];
      renderIdentifierList();
      return;
    }
    loadIdentifierList();
  });
  $('btn-identifier-refresh').addEventListener('click', (event) => {
    if (!state.configId) {
      toast('请先选择 ASC 配置', true);
      return;
    }
    withLoading(event.currentTarget, '刷新中...', loadIdentifierList);
  });
  $('btn-identifier-add').addEventListener('click', () => {
    openAddModal();
  });
  $('btn-identifier-add-submit').addEventListener('click', () => {
    submitAdd();
  });
  $('btn-identifier-add-cancel').addEventListener('click', closeAddModal);
}

/**
 * 切换到本页时触发：首次加载配置资源并默认选中第一个配置，之后每次刷新列表
 * @returns {Promise<void>}
 */
export async function onShown() {
  try {
    await loadResources();
  } catch (err) {
    toast(`资源加载失败：${err.message}`, true);
    return;
  }
  if (!state.configId && state.configs.length > 0) {
    state.configId = state.configs[0].id;
    $('identifier-config').value = state.configId;
  }
  if (state.configId) {
    await loadIdentifierList();
  }
}
