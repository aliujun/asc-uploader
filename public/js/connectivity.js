/* 连通性组件：网络出口显示、Apple 服务器连通性测试 */
import { $, api, escapeHtml, toast, withLoading } from './common.js';

/** 组件标题（导航按钮文案唯一事实源） */
export const title = '连通性';

/** 页面模板（原 index.html 连通性区块整体搬运，active 类由注册器注入） */
export const template = `<section id="tab-connectivity" class="tab-panel">
            <div class="card">
                <h2>Apple 服务器连通性测试
                    <button id="btn-conn-test" class="primary small">开始测试</button>
                </h2>
                <p class="muted">
                    本测试从工具服务进程内发起（与上传 IPA 时完全相同的网络路径，含代理）。
                    Node.js 不使用系统代理，若测试失败，请到“配置管理”页设置代理地址后重测。
                    当前网络出口：<b id="conn-proxy">检测中...</b>
                </p>
                <p class="muted">说明：只要收到 Apple 返回的任意 HTTP 状态码（包括 401/302），即代表网络连通正常。</p>
                <div id="conn-results" class="muted">尚未测试，点击“开始测试”。</div>
            </div>
        </section>`;

/**
 * 加载当前生效的网络出口（直连或代理地址）
 * @returns {Promise<void>}
 */
export async function loadConnectivityInfo() {
  const el = $('conn-proxy');
  if (!el) {
    return; // 本页签模板尚未注入时（如仅被其它组件联动调用）跳过
  }
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
    loadConnectivityInfo();
  }
}

/** 切到本页签时刷新出口显示（内部已自吞异常，直调即可） */
export function onShown() {
  loadConnectivityInfo();
}

/**
 * 绑定本组件全部事件（模板注入后由注册器调用一次）
 * @returns {void}
 */
export function init() {
  $('btn-conn-test').onclick = () => withLoading($('btn-conn-test'), '测试中...', runConnectivityTest);
}
