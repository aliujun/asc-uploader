/* 描述文件组件：Profiles 列表、到期看板、下载 .mobileprovision、删除、生成 App Store 描述文件 */
import {
  $, api, downloadFile, escapeHtml, toast, withLoading,
} from './common.js';

/** 组件标题（导航按钮文案唯一事实源） */
export const title = '描述文件';

/** 组件状态：configs 供配置下拉，bundleIds/certs 供生成弹窗，profiles 为当前列表 */
const state = {
  configs: [],
  bundleIds: [],
  certs: [],
  profiles: [],
  configId: '',
  resourcesLoaded: false,
};

/** 页面模板 */
export const template = `<section id="tab-profiles" class="tab-panel">
            <div class="card">
                <h2>描述文件列表与到期看板</h2>
                <p class="muted">通过 ASC API 读取账号下的全部描述文件（.mobileprovision），临近到期自动标红/标黄，下载与删除也在这里操作。</p>
                <div class="form-row inline">
                    <select id="profile-config">
                        <option value="">选择 ASC 配置</option>
                    </select>
                    <button id="btn-profile-refresh">刷新</button>
                    <button id="btn-profile-create-open" class="primary">生成描述文件</button>
                </div>
                <div id="profile-stats" class="stats-bar hidden"></div>
                <div id="profile-list" class="config-list"></div>
            </div>

            <div class="card">
                <h2>说明</h2>
                <ol class="steps">
                    <li>打包 IPA 需要「.p12 证书 + .mobileprovision 描述文件」两件套，证书在<b>证书管理</b>页签发。</li>
                    <li>生成时选择 App ID 与一张或多张证书；同一 App ID + 类型重复生成会被 Apple 以"已存在"拒绝。</li>
                    <li>一期仅支持生成 <b>App Store</b> 类型；Ad Hoc / 开发类型需先在开发者后台注册设备，暂不支持。</li>
                    <li>删除立即生效且不可恢复，但随时可以重新生成同名描述文件。</li>
                </ol>
            </div>

            <div id="profile-create-modal" class="modal hidden">
                <div class="modal-box">
                    <h3>生成描述文件</h3>
                    <div class="form-row">
                        <label>ASC 配置<span class="req">*</span></label>
                        <select id="profile-create-config">
                            <option value="">请选择配置</option>
                        </select>
                    </div>
                    <div class="form-row">
                        <label>App ID<span class="req">*</span></label>
                        <select id="profile-create-bundle">
                            <option value="">请选择 App ID</option>
                        </select>
                    </div>
                    <div class="form-row">
                        <label>包含证书<span class="req">*</span>（可多选）</label>
                        <div id="profile-create-certs" class="checkbox-list"></div>
                    </div>
                    <div class="form-row">
                        <label>名称</label>
                        <input id="profile-create-name" placeholder="默认：App ID 名称 + AppStore" autocomplete="off">
                    </div>
                    <p class="muted">类型固定为 Apple App Store（发布 App Store 版本）；Ad Hoc / 开发类型需注册设备，暂不支持。</p>
                    <p id="profile-create-error" class="error hidden"></p>
                    <div class="form-actions">
                        <button id="btn-profile-create-submit" class="primary">生成并下载 .mobileprovision</button>
                        <button id="btn-profile-create-cancel">取消</button>
                    </div>
                </div>
            </div>
        </section>`;

/**
 * 计算剩余有效天数
 * @param {string} expirationDate 到期时间（ISO 字符串）
 * @returns {number|null} 剩余天数（负数表示已过期），无有效期时返回 null
 */
function daysLeft(expirationDate) {
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
function expiryBadgeHtml(expirationDate) {
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

/** 描述文件状态英文标识 → 中文名映射（官方枚举） */
const PROFILE_STATE_TEXT = {
  ACTIVE: '生效中',
  EXPIRED: '已过期',
  INVALID: '已失效',
};

/**
 * 描述文件状态的徽章 HTML
 * @param {string} profileState 状态英文标识（ACTIVE/EXPIRED/INVALID）
 * @returns {string} 徽章 HTML
 */
function stateBadgeHtml(profileState) {
  const text = PROFILE_STATE_TEXT[profileState] || profileState || '-';
  const cls = profileState === 'ACTIVE' ? 'ok' : 'err';
  return `<span class="badge ${cls}">${escapeHtml(text)}</span>`;
}

/**
 * 描述文件类型的中文展示文案
 * @param {string} type ASC 描述文件类型枚举
 * @returns {string} 展示文案
 */
function typeLabel(type) {
  const map = {
    IOS_APP_STORE: 'App Store',
    IOS_APP_ADHOC: 'Ad Hoc',
    IOS_APP_DEVELOPMENT: '开发',
    IOS_APP_INHOUSE: '企业',
  };
  return map[type] || type || '未知类型';
}

/**
 * 格式化日期为本地日期文本
 * @param {string} iso ISO 时间字符串
 * @returns {string} 本地日期，无效时返回 '-'
 */
function formatDate(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return '-';
  }
  return date.toLocaleDateString('zh-CN');
}

/**
 * 通用下拉填充
 * @param {HTMLSelectElement} select 目标下拉框
 * @param {string} placeholder 占位文案
 * @param {Array<{value: string, label: string}>} items 选项列表
 * @returns {void}
 */
function fillSelect(select, placeholder, items) {
  select.innerHTML = '';
  const defaultOption = document.createElement('option');
  defaultOption.value = '';
  defaultOption.textContent = placeholder;
  select.appendChild(defaultOption);
  items.forEach((item) => {
    const option = document.createElement('option');
    option.value = item.value;
    option.textContent = item.label;
    select.appendChild(option);
  });
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
  const configsData = await api('/api/configs');
  state.configs = configsData.configs || [];
  fillSelect($('profile-config'), '选择 ASC 配置', state.configs.map((c) => ({ value: c.id, label: c.name })));
  state.resourcesLoaded = true;
}

/**
 * 渲染统计条与描述文件列表
 * @returns {void}
 */
function renderProfileList() {
  const stats = $('profile-stats');
  const wrap = $('profile-list');
  const profiles = state.profiles;
  if (profiles.length === 0) {
    stats.classList.add('hidden');
    stats.innerHTML = '';
    wrap.innerHTML = '<span class="muted">该配置下暂无描述文件</span>';
    return;
  }
  const expiring30 = profiles.filter((p) => daysLeft(p.expirationDate) !== null && daysLeft(p.expirationDate) <= 30).length;
  const expiring60 = profiles.filter((p) => daysLeft(p.expirationDate) !== null && daysLeft(p.expirationDate) <= 60).length;
  stats.innerHTML = `
                <div class="stat${expiring30 > 0 ? ' warn' : ''}">
                    <span class="stat-num">${expiring30}</span>
                    <span class="stat-label">30 天内到期</span>
                </div>
                <div class="stat${expiring60 > 30 ? ' warn' : ''}">
                    <span class="stat-num">${expiring60}</span>
                    <span class="stat-label">60 天内到期</span>
                </div>
                <div class="stat">
                    <span class="stat-num">${profiles.length}</span>
                    <span class="stat-label">描述文件总数</span>
                </div>`;
  stats.classList.remove('hidden');

  wrap.innerHTML = '';
  profiles.forEach((profile) => {
    const row = document.createElement('div');
    row.className = 'config-item';
    const certNames = profile.certs.map((c) => c.displayName).filter(Boolean).join('、');
    row.innerHTML = `
      <div>
        <span class="name">${escapeHtml(profile.name || '未命名描述文件')}</span>
        <span class="badge">${escapeHtml(typeLabel(profile.profileType))}</span>
        ${stateBadgeHtml(profile.profileState)}
        ${expiryBadgeHtml(profile.expirationDate)}
        <div class="meta">${escapeHtml(profile.bundleId || '-')}${profile.bundleName ? `（${escapeHtml(profile.bundleName)}）` : ''} · 到期 ${escapeHtml(formatDate(profile.expirationDate))}${certNames ? ` · 证书：${escapeHtml(certNames)}` : ''}</div>
      </div>
      <div class="actions">
        <button class="small" data-act="download">下载</button>
        <button class="small danger" data-act="delete">删除</button>
      </div>`;
    row.querySelector('[data-act="download"]').onclick = () => downloadProfile(profile);
    row.querySelector('[data-act="delete"]').onclick = () => deleteProfile(profile);
    wrap.appendChild(row);
  });
}

/**
 * 加载当前配置下的描述文件列表并渲染
 * @returns {Promise<void>}
 */
async function loadProfileList() {
  const wrap = $('profile-list');
  try {
    const data = await api(`/api/profiles?configId=${encodeURIComponent(state.configId)}`);
    state.profiles = data.profiles || [];
    renderProfileList();
  } catch (err) {
    state.profiles = [];
    $('profile-stats').classList.add('hidden');
    $('profile-stats').innerHTML = '';
    wrap.innerHTML = `<span class="error">${escapeHtml(err.message)}</span>`;
  }
}

/**
 * 打开生成弹窗：填充配置下拉并按当前配置加载 App ID 与证书
 * @returns {Promise<void>}
 */
async function openCreateModal() {
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
  fillSelect($('profile-create-config'), '请选择配置', state.configs.map((c) => ({ value: c.id, label: c.name })));
  $('profile-create-config').value = state.configId;
  fillSelect($('profile-create-bundle'), '请选择 App ID', []);
  $('profile-create-certs').innerHTML = '<span class="muted">加载中...</span>';
  $('profile-create-name').value = '';
  $('profile-create-error').classList.add('hidden');
  $('profile-create-modal').classList.remove('hidden');
  if (state.configId) {
    await loadModalResources(state.configId);
  }
}

/**
 * 按配置并发加载弹窗所需的 App ID 与证书列表（配置变更时复用）
 * @param {string} configId ASC 配置 ID
 * @returns {Promise<void>}
 */
async function loadModalResources(configId) {
  const certWrap = $('profile-create-certs');
  try {
    const [bundleData, certData] = await Promise.all([
      api(`/api/profiles/bundle-ids?configId=${encodeURIComponent(configId)}`),
      api(`/api/asc-certs?configId=${encodeURIComponent(configId)}`),
    ]);
    state.bundleIds = bundleData.bundleIds || [];
    state.certs = certData.certs || [];
    fillSelect(
      $('profile-create-bundle'),
      '请选择 App ID',
      state.bundleIds.map((b) => ({ value: b.id, label: b.name ? `${b.name}（${b.identifier}）` : b.identifier })),
    );
    if (state.certs.length === 0) {
      certWrap.innerHTML = '<span class="muted">该账号暂无证书，请先到「证书管理」页签发</span>';
      return;
    }
    certWrap.innerHTML = '';
    state.certs.forEach((cert) => {
      const label = document.createElement('label');
      label.innerHTML = `<input type="checkbox" value="${escapeHtml(cert.id)}"> ${escapeHtml(cert.displayName || '未命名证书')}（${escapeHtml(typeLabel(cert.certificateType))}，到期 ${escapeHtml(formatDate(cert.expirationDate))}）`;
      certWrap.appendChild(label);
    });
  } catch (err) {
    certWrap.innerHTML = `<span class="error">${escapeHtml(err.message)}</span>`;
  }
}

/**
 * 关闭生成弹窗并清空错误提示
 * @returns {void}
 */
function closeCreateModal() {
  $('profile-create-modal').classList.add('hidden');
  $('profile-create-error').classList.add('hidden');
}

/**
 * 校验生成表单，通过后返回请求参数
 * @returns {Object|null} {configId, bundleIdResourceId, certificateIds, name}，校验失败返回 null
 */
function validateCreateForm() {
  const configId = $('profile-create-config').value;
  const bundleIdResourceId = $('profile-create-bundle').value;
  const certificateIds = Array.from($('profile-create-certs').querySelectorAll('input:checked')).map((i) => i.value);
  const name = $('profile-create-name').value.trim();
  if (!configId) {
    toast('请选择 ASC 配置', true);
    return null;
  }
  if (!bundleIdResourceId) {
    toast('请选择 App ID', true);
    return null;
  }
  if (certificateIds.length === 0) {
    toast('请至少勾选一个证书', true);
    return null;
  }
  // 名称默认：App ID 名称 + AppStore
  const bundleEntry = state.bundleIds.find((b) => b.id === bundleIdResourceId);
  const defaultName = bundleEntry ? `${bundleEntry.name || bundleEntry.identifier} AppStore` : 'AppStore Profile';
  return { configId, bundleIdResourceId, certificateIds, name: name || defaultName };
}

/**
 * 下载 .mobileprovision 内容（原生 fetch + blob，api() 会 JSON.parse 二进制不可用）
 * @param {Object} profile 描述文件条目
 * @returns {Promise<void>}
 */
async function downloadProfile(profile) {
  try {
    const response = await fetch(`/api/profiles/${encodeURIComponent(profile.id)}/content?configId=${encodeURIComponent(state.configId)}`);
    const blob = await response.blob();
    if (blob.type.includes('application/json')) {
      const data = JSON.parse(await blob.text());
      throw new Error(data.error || `下载失败（HTTP ${response.status}）`);
    }
    if (!response.ok) {
      throw new Error(`下载失败（HTTP ${response.status}）`);
    }
    const safeName = (profile.bundleName || profile.bundleId || 'profile').replace(/[\\/:*?"<>|]/g, '');
    await downloadFile(`${safeName}-${profile.name || 'profile'}.mobileprovision`, blob);
    toast('描述文件已开始下载');
  } catch (err) {
    toast(err.message, true);
  }
}

/**
 * 删除描述文件（二次确认后调用 ASC API，成功后刷新列表）
 * @param {Object} profile 描述文件条目
 * @returns {Promise<void>}
 */
async function deleteProfile(profile) {
  const label = profile.name || profile.id;
  const goOn = confirm(`确定删除描述文件「${label}」（${profile.bundleId || '-'}）？\n`
    + '删除后立即失效且不可恢复，使用它的打包签名会失败，但可以重新生成。');
  if (!goOn) {
    return;
  }
  try {
    await api(`/api/profiles/${encodeURIComponent(profile.id)}?configId=${encodeURIComponent(state.configId)}`, {
      method: 'DELETE',
    });
    toast('描述文件已删除');
    loadProfileList();
  } catch (err) {
    toast(err.message, true);
  }
}

/**
 * 提交生成请求：创建成功后立即下载 .mobileprovision，下载失败时降级提示
 * @returns {Promise<void>}
 */
async function submitCreate() {
  const form = validateCreateForm();
  if (!form) {
    return;
  }
  const errorEl = $('profile-create-error');
  try {
    await withLoading($('btn-profile-create-submit'), '生成中…', async () => {
      const data = await api('/api/profiles', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form),
      });
      const created = data.profile || {};
      try {
        const response = await fetch(`/api/profiles/${encodeURIComponent(created.id)}/content?configId=${encodeURIComponent(form.configId)}`);
        const blob = await response.blob();
        if (blob.type.includes('application/json')) {
          throw new Error('内容暂不可下载');
        }
        if (!response.ok) {
          throw new Error(`下载失败（HTTP ${response.status}）`);
        }
        const safeName = (created.name || form.name).replace(/[\\/:*?"<>|]/g, '');
        await downloadFile(`${safeName}.mobileprovision`, blob);
        closeCreateModal();
        toast('描述文件已生成并开始下载');
      } catch (downloadErr) {
        // 描述文件已生成无法回滚：关弹窗提示稍后在列表中下载
        closeCreateModal();
        toast(`描述文件「${created.name || form.name}」已生成，但下载失败：${downloadErr.message}，稍后可在列表中刷新下载`, true);
      }
      state.configId = form.configId;
      $('profile-config').value = form.configId;
      loadProfileList();
    });
  } catch (err) {
    errorEl.textContent = err.message;
    errorEl.classList.remove('hidden');
  }
}

/**
 * 绑定组件内事件
 * @returns {void}
 */
export function init() {
  $('profile-config').addEventListener('change', () => {
    state.configId = $('profile-config').value;
    if (!state.configId) {
      state.profiles = [];
      renderProfileList();
      return;
    }
    loadProfileList();
  });
  $('btn-profile-refresh').addEventListener('click', () => {
    if (!state.configId) {
      toast('请先选择 ASC 配置', true);
      return;
    }
    loadProfileList();
  });
  $('btn-profile-create-open').addEventListener('click', () => {
    openCreateModal();
  });
  $('profile-create-config').addEventListener('change', async () => {
    const configId = $('profile-create-config').value;
    if (!configId) {
      return;
    }
    fillSelect($('profile-create-bundle'), '请选择 App ID', []);
    $('profile-create-certs').innerHTML = '<span class="muted">加载中...</span>';
    await loadModalResources(configId);
  });
  $('btn-profile-create-submit').addEventListener('click', () => {
    submitCreate();
  });
  $('btn-profile-create-cancel').addEventListener('click', closeCreateModal);
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
    $('profile-config').value = state.configId;
  }
  if (state.configId) {
    await loadProfileList();
  }
}
