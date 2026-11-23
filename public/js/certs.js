/* 证书工具组件：CSR 生成、p12 导入提取、.cer 合成 p12、本地私钥管理 */
import { gotoIssue } from './asc-certs.js';
import {
  $, api, bindEnter, downloadFile, escapeHtml, fmtSize, toast, withLoading,
} from './common.js';

/** 组件标题（导航按钮文案唯一事实源） */
export const title = '证书工具';

/** 页面模板（原 index.html 证书工具区块整体搬运，active 类由注册器注入） */
export const template = `<section id="tab-certs" class="tab-panel">
            <div class="card" style="border-left: 4px solid var(--primary, #0071e3);">
                <p style="margin:0;"><b>💡 提示：</b>若您已在「配置管理」中配置了 API 密钥，推荐直接前往 <a href="javascript:void(0)" id="link-certs-to-asc" style="color:var(--primary);font-weight:bold;text-decoration:underline;">证书管理</a> 进行<b>一键在线签发并自动合成 .p12</b>，完全无需手动上传 CSR 和下载 .cer 文件。</p>
            </div>
            <div class="card">
                <h2>第 1 步：生成私钥与 CSR</h2>
                <p class="muted">生成 RSA 2048 私钥（自动保存在本地）与证书签名请求（.csr）。</p>
                <div class="form-row inline">
                    <input id="cert-remark" placeholder="所属项目（必填，如：商城App）">
                </div>
                <div class="form-row inline">
                    <input id="cert-cn" placeholder="通用名称（一般填邮箱，如 dev@example.com）">
                    <button id="btn-random-cn">随机生成</button>
                    <button id="btn-gen-csr" class="primary">生成 CSR</button>
                </div>
                <div id="csr-result" class="hidden">
                    <textarea id="csr-text" rows="6" readonly></textarea>
                    <div class="form-row inline">
                        <button id="btn-download-csr">下载 .csr 文件</button>
                        <button id="btn-goto-issue" class="primary">去证书管理页签发 .p12 →</button>
                    </div>
                </div>

                <details class="help" style="margin-top:14px">
                    <summary>导入已有私钥（之前在别处生成的）</summary>
                    <p class="muted">从 <b>.p12 文件</b>中提取私钥（蛋壳、Mac 钥匙串等导出的 p12）。提取的私钥与本地生成的统一管理，
                        可分别配合开发/发布 .cer 合成不同用途的 p12。</p>
                    <div class="form-row inline">
                        <label class="file-label"><span id="import-p12-file-name">选择 .p12 文件</span><input type="file"
                                id="import-p12-file" accept=".p12" hidden></label>
                        <input id="import-p12-password" type="password" placeholder="该 .p12 的密码（不填默认 123456）">
                    </div>
                    <div class="form-row inline">
                        <input id="import-p12-remark" placeholder="所属项目（必填，如：商城App）">
                        <button id="btn-import-p12" class="primary" disabled>从 .p12 提取</button>
                    </div>
                </details>
            </div>

            <div class="card">
                <h2>第 2 步：到 Apple 后台换取 .cer 证书</h2>
                <p class="muted"><b>推荐：</b>配置好 ASC 后可跳过此步，直接用 Apple API 签发并自动下载 .p12
                    <button id="btn-goto-issue-step2" class="small" style="margin-left:6px">一键签发 →</button></p>
                <ol class="steps">
                    <li>登录 <a href="https://developer.apple.com/account/resources/certificates/list"
                            target="_blank">Apple Developer - Certificates</a>；</li>
                    <li>点击 <b>+</b> 新建证书，选择 <b>Apple Distribution</b>（或 iOS Distribution）；</li>
                    <li>上传第 1 步下载的 .csr 文件；</li>
                    <li>下载生成的 <b>.cer 证书文件</b> 回来。</li>
                </ol>
            </div>

            <div class="card">
                <h2>第 3 步：合成 .p12</h2>
                <div class="form-row">
                    <label>选择本地私钥</label>
                    <div class="form-row inline" style="margin:0">
                        <select id="cert-key">
                            <option value="">请选择私钥</option>
                        </select>
                        <button id="btn-del-key" disabled title="取消当前选择">清除选择</button>
                    </div>
                </div>
                <div class="form-row">
                    <label>.cer 证书内容</label>
                    <label class="file-label"><span id="cert-cer-file-name">选择 .cer 文件</span><input type="file"
                            id="cert-cer-file" accept=".cer,.pem" hidden></label>
                    <textarea id="cert-cer" rows="4"
                        placeholder="选择 .cer 文件后自动填充（-----BEGIN CERTIFICATE----- ...），也可以直接粘贴 DER Base64"></textarea>
                </div>
                <div class="form-row inline">
                    <input id="cert-password" type="password" placeholder="设置 .p12 导出密码（不填默认 123456）">
                    <button id="btn-toggle-password" title="显示/隐藏密码" style="flex:0 0 auto">显示</button>
                    <button id="btn-clear-password" title="清空密码输入框" style="flex:0 0 auto">清空</button>
                    <button id="btn-gen-p12" class="primary" disabled title="请先选择本地私钥">合成并下载 .p12</button>
                </div>
                <p class="muted">提示：发布 App Store / Ad Hoc 版本需要 .p12 外，还需要在 <a
                        href="https://developer.apple.com/account/resources/profiles/list" target="_blank">Apple
                        描述文件页面</a>下载对应的 .mobileprovision 描述文件。</p>
            </div>

            <div class="card">
                <h2>本地私钥列表</h2>
                <div id="cert-keys" class="config-list"></div>
            </div>
        </section>`;

/** 私钥列表数据缓存（供合成 p12 时按 keyId 反查所属项目） */
const certKeysCache = { list: [] };

/** p12 导入状态 */
const importP12State = { base64: '' };

/** 最近一次生成的私钥条目 ID（供跳转证书管理页签发时预选） */
let lastGeneratedKeyId = '';

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
    lastGeneratedKeyId = result.keyId;
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

/**
 * 加载本地私钥列表
 * @returns {Promise<void>}
 */
export async function loadCertKeys() {
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
      row.querySelector('[data-key]').onclick = (event) => {
        const label = k.remark || k.commonName;
        if (!confirm(`确定删除私钥「${label}」？删除后无法再为它合成 p12。`)) {
          return;
        }
        withLoading(event.currentTarget, '删除中...', async () => {
          try {
            await api(`/api/certs/keys/${k.keyId}`, { method: 'DELETE' });
            loadCertKeys();
          } catch (err) {
            toast(err.message, true);
          }
        });
      };
      wrap.appendChild(row);
    });
    updateGenP12Button();
  } catch (err) {
    wrap.innerHTML = `<span class="error">${escapeHtml(err.message)}</span>`;
  }
}

/**
 * 同步"合成并下载 .p12"与"清除选择"按钮可用状态：未选择本地私钥时置灰
 * @returns {void}
 */
function updateGenP12Button() {
  const hasKey = Boolean($('cert-key').value);
  $('btn-gen-p12').disabled = !hasKey;
  $('btn-del-key').disabled = !hasKey;
}

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
 * 清除"选择本地私钥"下拉框的当前选择（不删除私钥本身）
 * @returns {void}
 */
function clearKeySelection() {
  $('cert-key').value = '';
  updateGenP12Button();
}

/**
 * 同步"从 .p12 提取"按钮状态：已选文件且填写所属项目才可点击（密码可不填，默认 123456）
 * @returns {void}
 */
function updateImportP12Button() {
  $('btn-import-p12').disabled = !importP12State.base64
    || !$('import-p12-remark').value.trim();
}

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

/** 切到本页签时刷新本地私钥列表（内部已自吞异常，直调即可） */
export function onShown() {
  loadCertKeys();
}

/**
 * 绑定本组件全部事件（模板注入后由注册器调用一次）
 * @returns {void}
 */
export function init() {
  $('btn-random-cn').onclick = () => randomCommonName();
  $('btn-gen-csr').onclick = () => withLoading($('btn-gen-csr'), '生成中...', generateCsr);
  $('btn-download-csr').onclick = () => downloadFile('certificate signing request.csr', $('csr-text').value);
  $('btn-goto-issue').onclick = () => gotoIssue(lastGeneratedKeyId);
  $('btn-goto-issue-step2').onclick = () => gotoIssue();
  const linkToAsc = $('link-certs-to-asc');
  if (linkToAsc) {
    linkToAsc.onclick = () => gotoIssue();
  }

  // 读取证书文件：PEM 文本直接填充；DER 二进制（Apple 下载的 .cer）转 Base64 后填充
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

  $('btn-toggle-password').onclick = () => {
    const input = $('cert-password');
    const hidden = input.type === 'password';
    input.type = hidden ? 'text' : 'password';
    $('btn-toggle-password').textContent = hidden ? '隐藏' : '显示';
  };

  $('btn-clear-password').onclick = () => {
    $('cert-password').value = '';
    $('cert-password').focus();
  };

  $('cert-key').addEventListener('change', updateGenP12Button);
  $('btn-del-key').onclick = () => clearKeySelection();
  $('btn-gen-p12').onclick = () => withLoading($('btn-gen-p12'), '合成中...', async () => {
    await generateP12();
    updateGenP12Button();
  });

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
  $('btn-import-p12').onclick = () => withLoading($('btn-import-p12'), '提取中...', importP12Key);

  // 回车提交统一走 withLoading：与按钮点击同源防重复
  bindEnter('cert-remark', () => withLoading($('btn-gen-csr'), '生成中...', generateCsr));
  bindEnter('cert-cn', () => withLoading($('btn-gen-csr'), '生成中...', generateCsr));
  bindEnter('cert-password', () => withLoading($('btn-gen-p12'), '合成中...', generateP12));
}
