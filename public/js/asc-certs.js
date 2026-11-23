/* 证书管理组件：ASC API 证书列表、签发（自动合成 p12 下载）、吊销；到期监控统一在到期总览页 */
import {
  $, api, downloadFile, escapeHtml, expiryBadgeHtml, fillSelect, formatDate, fmtSize, platformText, toast, typeLabel, withLoading,
} from './common.js';

/** 组件标题（导航按钮文案唯一事实源） */
export const title = '证书管理';

/** 组件状态：configs/keys 供下拉与文件命名，certs 为当前配置下的证书列表 */
const state = {
  configs: [],
  keys: [],
  certs: [],
  configId: '',
  resourcesLoaded: false,
};

/** 页面模板 */
export const template = `<section id="tab-asc-certs" class="tab-panel">
            <div class="card">
                <h2>证书列表</h2>
                <p class="muted">读取所选配置下的全部证书，签发与吊销在这里操作；到期情况可在「到期总览」页统一查看。</p>
                <div class="form-row inline">
                    <select id="asc-cert-config">
                        <option value="">选择 ASC 配置</option>
                    </select>
                    <button id="btn-asc-refresh">刷新</button>
                    <button id="btn-asc-issue-open" class="primary">签发证书</button>
                </div>
                <div id="asc-cert-list" class="config-list"></div>
            </div>

            <div class="card">
                <h2>本地 p12 备份管理 <button id="btn-backup-refresh" class="small">刷新</button></h2>
                <p class="muted">通过本助手在线签发的 .p12 会自动在本地备份目录中存档，若浏览器未下载成功或更换打包环境，可随时在此重新下载。</p>
                <div id="asc-backup-list" class="config-list"><span class="muted">正在加载备份列表...</span></div>
            </div>

            <div class="card">
                <h2>说明</h2>
                <ol class="steps">
                    <li>签发需要：<b>ASC 配置</b>（配置管理页中已验证的）+ <b>本地私钥</b>（证书工具页生成或导入的）。</li>
                    <li>签发时工具会用所选私钥自动生成 CSR 并提交 Apple，签发成功后自动合成 .p12 供下载，无需手动上传 CSR、下载 .cer。</li>
                    <li>每种证书类型在 Apple 有数量上限（如 iOS Distribution 最多 3 个），到期或不再使用时请先吊销旧证书。</li>
                    <li>吊销立即生效且不可恢复，使用该证书签名的描述文件会随之失效。</li>
                    <li>如果没有 API 密钥（.p8），也可以前往「证书工具」页走传统手动 CSR / .cer 模式。</li>
                </ol>
            </div>

            <div id="asc-issue-modal" class="modal hidden">
                <div class="modal-box">
                    <h3>签发证书</h3>
                    <div class="form-row">
                        <label>ASC 配置<span class="req">*</span></label>
                        <select id="asc-issue-config">
                            <option value="">请选择配置</option>
                        </select>
                    </div>
                    <div class="form-row">
                        <label>本地私钥<span class="req">*</span></label>
                        <select id="asc-issue-key">
                            <option value="">请选择私钥</option>
                        </select>
                    </div>
                    <div class="form-row">
                        <label>证书类型<span class="req">*</span></label>
                        <select id="asc-issue-type">
                            <option value="DISTRIBUTION">Apple Distribution（发布 App Store / Ad Hoc）</option>
                            <option value="DEVELOPMENT">Apple Development（真机调试）</option>
                        </select>
                    </div>
                    <div class="form-row">
                        <label>通用名称（CN）</label>
                        <input id="asc-issue-cn" placeholder="一般填邮箱，选择私钥后自动预填" autocomplete="off">
                    </div>
                    <div class="form-row">
                        <label>.p12 导出密码</label>
                        <input id="asc-issue-password" type="password" placeholder="不填默认 123456" autocomplete="new-password">
                    </div>
                    <p id="asc-issue-error" class="error hidden"></p>
                    <div class="form-actions">
                        <button id="btn-asc-issue-submit" class="primary">签发并下载 .p12</button>
                        <button id="btn-asc-issue-cancel">取消</button>
                    </div>
                </div>
            </div>
        </section>`;

/**
 * 首次进入时加载 ASC 配置与本地私钥（供下拉选择）
 * @returns {Promise<void>}
 * @throws {Error} 接口请求失败时抛出
 */
async function loadResources() {
  if (state.resourcesLoaded) {
    return;
  }
  const [configsData, keysData] = await Promise.all([api('/api/configs'), api('/api/certs/keys')]);
  state.configs = configsData.configs || [];
  state.keys = keysData.keys || [];
  fillSelect($('asc-cert-config'), '选择 ASC 配置', state.configs.map((c) => ({ value: c.id, label: c.name })));
  state.resourcesLoaded = true;
}

/**
 * 渲染证书列表
 * @returns {void}
 */
function renderCertList() {
  const wrap = $('asc-cert-list');
  const certs = state.certs;
  if (certs.length === 0) {
    wrap.innerHTML = '<span class="muted">该配置下暂无证书</span>';
    return;
  }

  wrap.innerHTML = '';
  certs.forEach((cert) => {
    const row = document.createElement('div');
    row.className = 'config-item';
    // 全平台类型（DISTRIBUTION/DEVELOPMENT）在 API 中不返回 platform 字段，按官网行为兜底显示「All」
    const platformName = cert.platform
      ? platformText(cert.platform)
      : ((cert.certificateType === 'DISTRIBUTION' || cert.certificateType === 'DEVELOPMENT') ? 'All' : '');
    const platformBadge = platformName ? `<span class="badge">${escapeHtml(platformName)}</span>` : '';
    row.innerHTML = `
      <div>
        <span class="name">${escapeHtml(cert.displayName || '未命名证书')}</span>
        <span class="badge">${escapeHtml(typeLabel(cert.certificateType))}</span>
        ${platformBadge}
        ${expiryBadgeHtml(cert.expirationDate)}
        <div class="meta">序列号 ${escapeHtml(cert.serialNumber || '-')} · 到期 ${escapeHtml(formatDate(cert.expirationDate))}</div>
      </div>
      <div class="actions">
        <button class="small danger">吊销</button>
      </div>`;
    row.querySelector('.danger').onclick = (e) => revokeCert(cert, e.currentTarget);
    wrap.appendChild(row);
  });
}

/**
 * 加载当前配置下的证书列表并渲染
 * @returns {Promise<void>}
 */
async function loadCertList() {
  const wrap = $('asc-cert-list');
  try {
    const data = await api(`/api/asc-certs?configId=${encodeURIComponent(state.configId)}`);
    state.certs = data.certs || [];
    renderCertList();
  } catch (err) {
    state.certs = [];
    wrap.innerHTML = `<span class="error">${escapeHtml(err.message)}</span>`;
  }
}

/**
 * 打开签发弹窗（配置默认取列表卡当前选择，私钥变更时预填 CN）
 * @returns {Promise<void>}
 */
async function openIssueModal() {
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
  if (state.keys.length === 0) {
    toast('暂无本地私钥，请先到「证书工具」页生成或导入私钥', true);
    return;
  }
  fillSelect($('asc-issue-config'), '请选择配置', state.configs.map((c) => ({ value: c.id, label: c.name })));
  $('asc-issue-config').value = state.configId;
  fillSelect(
    $('asc-issue-key'),
    '请选择私钥',
    state.keys.map((k) => ({ value: k.keyId, label: k.remark ? `${k.remark} · ${k.commonName}` : k.commonName })),
  );
  $('asc-issue-cn').value = '';
  $('asc-issue-password').value = '';
  $('asc-issue-error').classList.add('hidden');
  $('asc-issue-modal').classList.remove('hidden');
}

/**
 * 关闭签发弹窗并清空错误提示
 * @returns {void}
 */
function closeIssueModal() {
  $('asc-issue-modal').classList.add('hidden');
  $('asc-issue-error').classList.add('hidden');
}

/**
 * 校验签发表单，通过后返回请求参数
 * @returns {Object|null} {configId, keyId, certificateType, commonName, password}，校验失败返回 null
 */
function validateIssueForm() {
  const configId = $('asc-issue-config').value;
  const keyId = $('asc-issue-key').value;
  const certificateType = $('asc-issue-type').value;
  const commonName = $('asc-issue-cn').value.trim();
  const password = $('asc-issue-password').value;
  if (!configId) {
    toast('请选择 ASC 配置', true);
    return null;
  }
  if (!keyId) {
    toast('请选择本地私钥', true);
    return null;
  }
  if (password && password.length < 6) {
    toast('p12 导出密码至少 6 位', true);
    $('asc-issue-password').focus();
    return null;
  }
  return { configId, keyId, certificateType, commonName, password };
}

/**
 * 提交签发请求并处理响应（p12 二进制 → 下载；JSON → 错误或 p12 合成失败降级提示）
 * @returns {Promise<void>}
 */
async function submitIssue() {
  const form = validateIssueForm();
  if (!form) {
    return;
  }
  const errorEl = $('asc-issue-error');
  try {
    await withLoading($('btn-asc-issue-submit'), '签发中…', async () => {
      const response = await fetch('/api/asc-certs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form),
      });
      const blob = await response.blob();
      if (blob.type.includes('application/json')) {
        const data = JSON.parse(await blob.text());
        // 证书已签发但 p12 合成失败：弹窗内持久展示详情，证书不可回滚
        errorEl.textContent = data.error || `签发失败（HTTP ${response.status}）`;
        errorEl.classList.remove('hidden');
        state.configId = form.configId;
        $('asc-cert-config').value = form.configId;
        loadCertList();
        return;
      }
      if (!response.ok) {
        throw new Error(`签发失败（HTTP ${response.status}）`);
      }
      const keyEntry = state.keys.find((k) => k.keyId === form.keyId);
      const safeRemark = ((keyEntry && keyEntry.remark) || '').replace(/[\\/:*?"<>|]/g, '');
      const typeLabelPart = /_DEVELOPMENT$/.test(form.certificateType) ? 'dev' : 'release';
      const nameParts = [safeRemark, typeLabelPart].filter(Boolean).join('-');
      await downloadFile(nameParts ? `certificate-${nameParts}.p12` : 'certificate-issued.p12', blob);
      closeIssueModal();
      toast('证书已签发，.p12 已合成并下载（同时已自动备份）');
      state.configId = form.configId;
      $('asc-cert-config').value = form.configId;
      loadCertList();
      loadBackupList();
    });
  } catch (err) {
    errorEl.textContent = err.message;
    errorEl.classList.remove('hidden');
  }
}

/**
 * 吊销证书（二次确认后调用 ASC API，成功后刷新列表；请求期间按钮进入加载态防重复点击）
 * @param {Object} cert 证书条目
 * @param {HTMLButtonElement} button 触发吊销的按钮元素
 * @returns {Promise<void>}
 */
async function revokeCert(cert, button) {
  const label = cert.displayName || cert.serialNumber || cert.id;
  const goOn = confirm(`确定吊销证书「${label}」（序列号 ${cert.serialNumber || '-'}）？\n`
    + '吊销后立即失效且不可恢复，使用该证书签名的描述文件将随之失效。');
  if (!goOn) {
    return;
  }
  try {
    await withLoading(button, '吊销中...', async () => {
      await api(`/api/asc-certs/${encodeURIComponent(cert.id)}?configId=${encodeURIComponent(state.configId)}`, {
        method: 'DELETE',
      });
      toast('证书已吊销');
      loadCertList();
    });
  } catch (err) {
    toast(err.message, true);
  }
}

/**
 * 跳转到本页签发证书（供证书工具页调用）：切换页签；传入 keyId 时强制刷新配置/私钥、
 * 打开签发弹窗并预选该私钥（触发 change 让 CN 自动预填）
 * @param {string} [keyId] 待预选的私钥条目 ID，缺省仅切换页签
 * @returns {Promise<void>}
 */
export async function gotoIssue(keyId) {
  const button = document.querySelector('.tab[data-tab="asc-certs"]');
  if (!button) {
    toast('证书管理页签尚未加载', true);
    return;
  }
  button.click();
  if (!keyId) {
    return;
  }
  state.resourcesLoaded = false; // 强制重拉配置/私钥，确保刚生成的私钥出现在下拉中
  try {
    await openIssueModal();
  } catch (err) {
    toast(err.message, true);
    return;
  }
  $('asc-issue-key').value = keyId;
  $('asc-issue-key').dispatchEvent(new Event('change', { bubbles: true }));
}

/**
 * 加载并渲染本地 p12 备份列表
 * @returns {Promise<void>}
 */
async function loadBackupList() {
  const wrap = $('asc-backup-list');
  try {
    const data = await api('/api/asc-certs/backups');
    const backups = Array.isArray(data.backups) ? data.backups : [];
    if (backups.length === 0) {
      wrap.innerHTML = '<span class="muted">暂无本地备份文件</span>';
      return;
    }
    wrap.innerHTML = '';
    backups.forEach((b) => {
      const row = document.createElement('div');
      row.className = 'config-item';
      row.innerHTML = `
        <div>
          <span class="name">${escapeHtml(b.filename)}</span>
          <span class="badge ok">${fmtSize(b.sizeBytes)}</span>
          <div class="meta">备份时间：${escapeHtml(new Date(b.createdAt).toLocaleString())}</div>
        </div>
        <div class="actions">
          <button class="small" data-act="download">重新下载</button>
          <button class="small danger" data-act="delete">删除</button>
        </div>`;
      row.querySelector('[data-act="download"]').onclick = () => downloadBackup(b.filename);
      row.querySelector('[data-act="delete"]').onclick = (e) => deleteBackup(b.filename, e.currentTarget);
      wrap.appendChild(row);
    });
  } catch (err) {
    wrap.innerHTML = `<span class="error">加载备份失败：${escapeHtml(err.message)}</span>`;
  }
}

/**
 * 下载已备份的 p12 文件
 * @param {string} filename 备份文件名
 * @returns {Promise<void>}
 */
async function downloadBackup(filename) {
  try {
    const response = await fetch(`/api/asc-certs/backups/${encodeURIComponent(filename)}`);
    if (!response.ok) {
      throw new Error(`下载失败（HTTP ${response.status}）`);
    }
    const blob = await response.blob();
    await downloadFile(filename, blob, 'application/x-pkcs12');
  } catch (err) {
    toast(err.message, true);
  }
}

/**
 * 删除本地已备份的 p12 文件
 * @param {string} filename 备份文件名
 * @param {HTMLButtonElement} button 触发按钮
 * @returns {Promise<void>}
 */
async function deleteBackup(filename, button) {
  const ok = confirm(`确定删除本地备份文件「${filename}」吗？删除后无法恢复。`);
  if (!ok) {
    return;
  }
  try {
    await withLoading(button, '删除中...', async () => {
      await api(`/api/asc-certs/backups/${encodeURIComponent(filename)}`, { method: 'DELETE' });
      toast('备份文件已删除');
      await loadBackupList();
    });
  } catch (err) {
    toast(err.message, true);
  }
}

/**
 * 绑定组件内事件
 * @returns {void}
 */
export function init() {
  $('asc-cert-config').addEventListener('change', () => {
    state.configId = $('asc-cert-config').value;
    if (!state.configId) {
      state.certs = [];
      renderCertList();
      return;
    }
    loadCertList();
  });
  $('btn-asc-refresh').addEventListener('click', (event) => {
    if (!state.configId) {
      toast('请先选择 ASC 配置', true);
      return;
    }
    withLoading(event.currentTarget, '刷新中...', loadCertList);
  });
  $('btn-backup-refresh').addEventListener('click', (event) => {
    withLoading(event.currentTarget, '刷新中...', loadBackupList);
  });
  $('btn-asc-issue-open').addEventListener('click', () => {
    openIssueModal();
  });
  $('asc-issue-key').addEventListener('change', () => {
    const entry = state.keys.find((k) => k.keyId === $('asc-issue-key').value);
    $('asc-issue-cn').value = entry && entry.commonName ? entry.commonName : '';
  });
  $('btn-asc-issue-submit').addEventListener('click', () => {
    submitIssue();
  });
  $('btn-asc-issue-cancel').addEventListener('click', closeIssueModal);
}

/**
 * 切换到本页时触发：首次加载配置/私钥资源并默认选中第一个配置，之后每次刷新列表与备份
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
    $('asc-cert-config').value = state.configId;
  }
  if (state.configId) {
    await loadCertList();
  }
  await loadBackupList();
}
