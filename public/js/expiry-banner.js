/* 全局到期横幅：启动时聚合所有 ASC 配置的证书/描述文件临期项，页面顶部展示 + 可选桌面通知 */
import {
  $, api, daysLeft, escapeHtml, expiryBadgeHtml,
} from './common.js';

/** 桌面通知的紧急阈值（天）：剩余天数 ≤ 该值或已过期时通知 */
const URGENT_DAYS = 30;

/** 本次会话是否已弹过桌面通知（避免每次刷新重复打扰） */
let notified = false;

/**
 * 拉取到期总览并渲染横幅（boot 启动时与手动刷新共用）
 * 拉取失败时静默保持横幅隐藏，不打扰主流程
 * @returns {Promise<void>}
 */
export async function loadOverview() {
  try {
    const data = await api('/api/expiry-overview');
    const items = data.items || [];
    render(items);
    notifyUrgent(items);
  } catch {
    // 聚合接口失败不算关键错误，横幅保持隐藏即可
  }
}

/**
 * 渲染横幅（有临期项或读取失败时显示，全部健康时隐藏）
 * @param {Array<Object>} items 聚合接口返回的逐配置条目
 * @returns {void}
 */
function render(items) {
  const banner = $('expiry-banner');
  // 仅保留有临期内容或读取失败的配置
  const groups = items.filter((item) => (item.certs && item.certs.length > 0)
    || (item.profiles && item.profiles.length > 0)
    || item.error);
  if (groups.length === 0) {
    banner.classList.add('hidden');
    banner.innerHTML = '';
    return;
  }
  banner.classList.remove('hidden');
  banner.innerHTML = `
        <span class="expiry-title">到期提醒</span>
        <div class="expiry-list"></div>
        <button id="btn-expiry-refresh" class="small">刷新</button>`;
  const list = banner.querySelector('.expiry-list');
  groups.forEach((item) => {
    const parts = [];
    (item.certs || []).forEach((cert) => {
      const badge = expiryBadgeHtml(cert.expirationDate);
      const stateText = badge || '<span class="badge">到期时间未知</span>';
      parts.push(`证书「${escapeHtml(cert.displayName || '未命名')}」${stateText}`);
    });
    (item.profiles || []).forEach((profile) => {
      const badge = expiryBadgeHtml(profile.expirationDate);
      const stateText = badge || `<span class="badge err">已失效</span>`;
      parts.push(`描述文件「${escapeHtml(profile.name || '未命名')}」${stateText}`);
    });
    if (item.error) {
      parts.push(`<span class="badge err">读取失败</span>`);
    }
    const line = document.createElement('div');
    line.className = 'expiry-item';
    line.innerHTML = `<b>${escapeHtml(item.configName)}</b>${parts.join('')}`;
    list.appendChild(line);
  });
  $('btn-expiry-refresh').addEventListener('click', () => loadOverview());
}

/**
 * 存在紧急临期项（≤30 天或已过期）时弹一次桌面通知（用户拒绝权限或环境不支持则静默跳过）
 * @param {Array<Object>} items 聚合接口返回的逐配置条目
 * @returns {void}
 */
function notifyUrgent(items) {
  if (notified || typeof Notification === 'undefined') {
    return;
  }
  const count = items.reduce((sum, item) => {
    const all = [...(item.certs || []), ...(item.profiles || [])];
    return sum + all.filter((entry) => {
      const left = daysLeft(entry.expirationDate);
      return left !== null && left <= URGENT_DAYS;
    }).length;
  }, 0);
  if (count === 0) {
    return;
  }
  notified = true;
  const show = () => {
    try {
      new Notification('ASC 工具：到期提醒', {
        body: `有 ${count} 项证书/描述文件将于 ${URGENT_DAYS} 天内到期或已过期，请及时处理`,
      });
    } catch {
      // 通知构造失败（极端环境）静默忽略
    }
  };
  if (Notification.permission === 'granted') {
    show();
    return;
  }
  if (Notification.permission !== 'denied') {
    Notification.requestPermission()
      .then((permission) => {
        if (permission === 'granted') {
          show();
        }
      })
      .catch(() => {});
  }
}
