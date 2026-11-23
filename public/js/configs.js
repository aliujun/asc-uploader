/* 配置管理组件：网络代理设置、API 配置增删改验、配置表单弹窗 */
import {
  $, api, bindEnter, escapeHtml, fillSelect, fmtSize, toast, withLoading,
} from './common.js';
import { onConfigsChanged } from './upload.js';
import { loadConnectivityInfo } from './connectivity.js';

/** 组件标题（导航按钮文案唯一事实源） */
export const title = '配置管理';

/** 页面模板（原 index.html 配置管理区块整体搬运，active 类由注册器注入） */
export const template = `<section id="tab-configs" class="tab-panel">
            <div class="card">
                <h2>网络代理</h2>
                <p class="muted">国内网络环境直连 Apple API 可能失败，Node.js 也不会使用系统代理。请填写代理地址（如
                    http://127.0.0.1:7890），留空则直连。所有请求（含分块上传）均会走该代理。可在“连通性”页测试是否可达。</p>
                <div class="form-row inline">
                    <input id="setting-proxy" placeholder="http://127.0.0.1:7890（留空为直连）">
                    <button id="btn-detect-proxy">自动检测</button>
                    <button id="btn-save-proxy" class="primary">保存</button>
                    <button id="btn-clear-proxy">清空代理</button>
                </div>
                <p class="muted">数据目录（配置、密钥、IPA 缓存均存放于此）：<code id="data-dir">-</code></p>
                <p class="muted"><button id="btn-clear-ipa-cache" class="small">清理 IPA 缓存</button> <span class="muted">删除未被进行中任务引用的本地 IPA 缓存文件</span></p>
            </div>
            <div class="card">
                <h2>配置列表 <button id="btn-new-config" class="small">新增配置</button></h2>
                <div id="config-list" class="config-list"></div>
                <details class="help">
                    <summary>如何获取 API 密钥（.p8 文件）</summary>
                    <ol>
                        <li>登录 <a href="https://appstoreconnect.apple.com/access/integrations/api" target="_blank">App
                                Store Connect API 密钥页</a>（用户和访问 → 集成 → App Store Connect API → 团队密钥）；</li>
                        <li>点击“生成 API 密钥”，需要 <b>App Manager</b> 及以上角色；</li>
                        <li>记下 <b>Key ID</b> 和页面顶部的 <b>Issuer ID</b>；</li>
                        <li>点击“下载”得到 <code>AuthKey_XXXXXXXXXX.p8</code>（<b>只能下载一次</b>，丢失需吊销重新生成）；</li>
                        <li>注意区分：.p12 分发证书用于签名（本工具“证书工具”页可生成）、App 专用密码是旧版 altool 用的，均不能用于此处。</li>
                    </ol>
                </details>
            </div>

            <div id="config-form-modal" class="modal hidden">
                <div class="modal-box">
                    <h3 id="config-form-title">新增配置</h3>
                    <div class="form-row">
                        <label>配置名称<span class="req">*</span></label>
                        <input id="cf-name" placeholder="如：公司主账号" autocomplete="off">
                    </div>
                    <div class="form-row">
                        <label>Issuer ID
                            <span class="hint-wrap">
                                <button type="button" class="hint-icon" aria-label="Issuer ID 说明"><svg width="14"
                                        height="14" viewBox="0 0 16 16" fill="none">
                                        <circle cx="8" cy="8" r="6.5" stroke="currentColor" stroke-width="1.3" />
                                        <circle cx="8" cy="4.9" r="0.95" fill="currentColor" />
                                        <path d="M8 7.4v3.9" stroke="currentColor" stroke-width="1.3"
                                            stroke-linecap="round" />
                                    </svg></button>
                                <span class="hint-tip">标识创建认证令牌（JWT）的发放者，即你的 App Store Connect 组织。在 API 密钥页面顶部查看。<a
                                        href="https://developer.apple.com/go/?id=api-issuer-id"
                                        target="_blank">了解更多</a></span>
                            </span>
                            <span class="req">*</span>
                        </label>
                        <input id="cf-issuer" placeholder="App Store Connect 页面顶部的 UUID" autocomplete="off">
                    </div>
                    <div class="form-row">
                        <label>密钥ID<span class="req">*</span></label>
                        <input id="cf-keyid" placeholder="10 位密钥ID（密钥列表中查看）" autocomplete="off">
                    </div>
                    <div class="form-row">
                        <label id="cf-p8-label">.p8 私钥内容<span class="req">*</span></label>
                        <textarea id="cf-p8" rows="6"
                            placeholder="-----BEGIN PRIVATE KEY-----&#10;...&#10;-----END PRIVATE KEY-----"></textarea>
                    </div>
                    <div class="form-row">
                        <label class="file-label"><span id="cf-p8-file-name">或选择 .p8 文件</span><input type="file"
                                id="cf-p8-file" accept=".p8" hidden></label>
                    </div>
                    <p id="config-form-error" class="error hidden"></p>
                    <div class="form-actions">
                        <button id="cf-save" class="primary">保存</button>
                        <button id="cf-cancel">取消</button>
                    </div>
                </div>
            </div>
        </section>`;

/** 配置管理状态 */
const configState = { list: [], editingId: null };

/**
 * 填充配置下拉框（重建 options 后恢复之前选中的配置，避免配置列表刷新时选择被重置）
 * @param {HTMLSelectElement} select 下拉框
 * @param {string} placeholder 占位文案
 * @returns {void}
 */
function fillConfigSelect(select, placeholder) {
  const prevValue = select.value;
  fillSelect(select, placeholder, configState.list.map((c) => ({ value: c.id, label: c.name })));
  if (prevValue && configState.list.some((c) => c.id === prevValue)) {
    select.value = prevValue;
  }
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
  try {
    await api(`/api/configs/${config.id}`, { method: 'DELETE' });
    await loadConfigs();
    toast('已删除');
  } catch (err) {
    toast(err.message, true);
  }
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

/**
 * 加载配置列表并刷新相关下拉框与上传页联动状态
 * @returns {Promise<void>}
 */
export async function loadConfigs() {
  const data = await api('/api/configs');
  configState.list = data.configs;
  renderConfigList();
  fillConfigSelect($('upload-config'), '请选择配置');
  fillConfigSelect($('builds-config'), '选择配置');
  // 通知上传页同步红字显隐与提交按钮状态
  onConfigsChanged(configState.list);
}

/**
 * 加载代理设置与数据目录
 * @returns {Promise<void>}
 */
export async function loadSettings() {
  const data = await api('/api/settings');
  $('setting-proxy').value = data.proxyUrl || '';
  $('data-dir').textContent = data.dataDir || '-';
}

/**
 * 保存代理设置
 * @returns {Promise<void>}
 */
async function saveSettings() {
  try {
    await api('/api/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ proxyUrl: $('setting-proxy').value }),
    });
    toast('代理设置已保存');
  } catch (err) {
    toast(err.message, true);
  }
}

/**
 * 清理未被进行中任务引用的 IPA 缓存
 * @returns {Promise<void>}
 */
async function clearIpaCache() {
  try {
    const data = await api('/api/ipa/cache', { method: 'DELETE' });
    toast(data.removedRegistry + data.removedFiles > 0
      ? `已清理 ${data.removedRegistry} 个缓存记录、${data.removedFiles} 个遗留文件`
      : '没有可清理的 IPA 缓存');
  } catch (err) {
    toast(err.message, true);
  }
}

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

/**
 * 清空代理设置并立即保存（恢复直连），并联动刷新连通性页出口显示
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
    loadConnectivityInfo();
  } catch (err) {
    toast(err.message, true);
  }
}

/**
 * 绑定本组件全部事件（模板注入后由注册器调用一次）
 * @returns {void}
 */
export function init() {
  $('btn-new-config').onclick = () => openConfigForm(null);
  $('cf-cancel').onclick = () => $('config-form-modal').classList.add('hidden');
  $('cf-save').onclick = () => withLoading($('cf-save'), '保存中...', saveConfigForm);

  $('cf-p8-file').addEventListener('change', async (event) => {
    const file = event.target.files[0];
    if (!file) {
      return;
    }
    $('cf-p8').value = (await file.text()).trim();
    $('cf-p8-file-name').textContent = `已选 ${file.name}（${fmtSize(file.size)}）`;
    toast(`已读取 ${file.name}`);
  });

  $('btn-save-proxy').onclick = () => withLoading($('btn-save-proxy'), '保存中...', saveSettings);
  $('btn-clear-ipa-cache').onclick = () => {
    if (confirm('确定清理本地 IPA 缓存吗？进行中任务引用的文件会被保留。')) {
      withLoading($('btn-clear-ipa-cache'), '清理中...', clearIpaCache);
    }
  };
  $('btn-detect-proxy').onclick = () => withLoading($('btn-detect-proxy'), '检测中...', detectProxy);
  $('btn-clear-proxy').onclick = () => withLoading($('btn-clear-proxy'), '清空中...', clearProxy);

  // 回车提交统一走 withLoading：防止输入过程中连按回车造成重复提交
  bindEnter('cf-name', () => withLoading($('cf-save'), '保存中...', saveConfigForm));
  bindEnter('cf-issuer', () => withLoading($('cf-save'), '保存中...', saveConfigForm));
  bindEnter('cf-keyid', () => withLoading($('cf-save'), '保存中...', saveConfigForm));
  bindEnter('setting-proxy', () => withLoading($('btn-save-proxy'), '保存中...', saveSettings));
}
