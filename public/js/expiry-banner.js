/* 全局到期摘要 + 总览数据共享层：启动时聚合所有 ASC 配置临期项，
   头部右侧显示摘要胶囊（点击跳转「到期总览」页，可手动关闭），30 天内项弹桌面通知（一次会话仅一次） */
import { $, api, daysLeft, escapeHtml } from './common.js';

/** 紧急阈值（天）：剩余天数不超过该值时计入摘要中的紧急数量并触发桌面通知 */
const URGENT_DAYS = 30;

/** 模块级通知标记：一次页面会话只弹一次桌面通知 */
let notified = false;

/** 模块级关闭标记：用户点「×」后本次会话不再显示摘要胶囊 */
let dismissed = false;

/** 最近一次总览数据缓存（getOverview 复用，避免摘要条与总览页重复请求） */
let cachedItems = null;

/** 最近一次响应的临期阈值（天），摘要文案使用 */
let cachedWindowDays = 60;

/**
 * 启动加载总览数据（失败静默，不打扰页面主流程）
 * @returns {Promise<void>}
 */
export async function loadOverview() {
  try {
    await fetchOverview();
  } catch {
    // 拉取失败（如网络异常）时保持横幅隐藏，总览页内再展示具体错误
  }
}

/**
 * 获取总览数据：优先返回缓存，未加载过则拉取一次
 * @returns {Promise<Array>} 配置维度的临期数据
 * @throws {Error} 拉取失败时抛出
 */
export async function getOverview() {
  if (cachedItems) {
    return cachedItems;
  }
  return fetchOverview();
}

/**
 * 强制重新拉取总览数据（刷新摘要条并更新缓存）
 * @returns {Promise<Array>} 最新数据
 */
export async function refreshOverview() {
  return fetchOverview();
}

/**
 * 拉取总览数据并渲染摘要条、触发桌面通知
 * @returns {Promise<Array>} 配置维度的临期数据
 * @throws {Error} 接口失败时抛出
 */
async function fetchOverview() {
  const data = await api('/api/expiry-overview');
  cachedItems = data.items || [];
  if (Number.isFinite(data.windowDays)) {
    cachedWindowDays = data.windowDays;
  }
  renderSummary(cachedItems);
  notifyUrgent(cachedItems);
  return cachedItems;
}

/**
 * 渲染头部右侧摘要胶囊：无临期项或已手动关闭时隐藏。
 * 胶囊文案为汇总数字（悬停 title 显示明细），点击跳转「到期总览」页；「×」本次会话关闭。
 * @param {Array} items 配置维度的临期数据
 * @returns {void}
 */
function renderSummary(items) {
  const banner = $('expiry-banner');
  let certCount = 0;
  let profileCount = 0;
  let urgent = 0;
  let failed = 0;
  items.forEach((item) => {
    if (item.error) {
      failed += 1;
    }
    (item.certs || []).forEach((cert) => {
      certCount += 1;
      if (isUrgent(cert)) {
        urgent += 1;
      }
    });
    (item.profiles || []).forEach((profile) => {
      profileCount += 1;
      if (isUrgent(profile) || isProfileInvalid(profile)) {
        urgent += 1;
      }
    });
  });
  const total = certCount + profileCount;
  if (total + failed === 0 || dismissed) {
    banner.classList.add('hidden');
    banner.innerHTML = '';
    return;
  }
  const tooltipParts = [];
  if (failed > 0) {
    tooltipParts.push(`${failed} 个配置读取失败`);
  }
  tooltipParts.push(`${certCount} 张证书、${profileCount} 个描述文件临期（剩余 ≤${cachedWindowDays} 天）`);
  if (urgent > 0) {
    tooltipParts.push(`${urgent} 项 ${URGENT_DAYS} 天内到期或已失效`);
  }
  const label = total > 0 ? `${total} 项临期${urgent > 0 ? ` · ${urgent} 项紧急` : ''}` : `${failed} 个配置读取失败`;
  banner.classList.remove('hidden');
  banner.innerHTML = `
    <button id="btn-expiry-goto" class="expiry-pill" title="${escapeHtml(tooltipParts.join('，'))}">${escapeHtml(label)}</button>
    <button id="btn-expiry-close" class="expiry-close" title="本次不再显示">×</button>`;
  $('btn-expiry-goto').addEventListener('click', () => {
    const tab = document.querySelector('.tab[data-tab="expiry-overview"]');
    if (tab) {
      tab.click();
    }
  });
  $('btn-expiry-close').addEventListener('click', () => {
    dismissed = true;
    banner.classList.add('hidden');
    banner.innerHTML = '';
  });
}

/**
 * 判断条目是否紧急（剩余天数 ≤ URGENT_DAYS，含已过期）
 * @param {Object} entry 证书或描述文件条目
 * @returns {boolean} 是否紧急
 */
function isUrgent(entry) {
  const left = daysLeft(entry.expirationDate);
  return left !== null && left <= URGENT_DAYS;
}

/**
 * 判断描述文件是否状态异常（无有效日期且状态非 ACTIVE，如已失效）
 * @param {Object} profile 描述文件条目
 * @returns {boolean} 是否状态异常
 */
function isProfileInvalid(profile) {
  const left = daysLeft(profile.expirationDate);
  return left === null && Boolean(profile.profileState) && profile.profileState !== 'ACTIVE';
}

/**
 * 30 天内（或已失效）项弹一次桌面通知；权限未授权时先请求
 * @param {Array} items 配置维度的临期数据
 * @returns {void}
 */
function notifyUrgent(items) {
  if (notified) {
    return;
  }
  let count = 0;
  items.forEach((item) => {
    (item.certs || []).forEach((cert) => {
      if (isUrgent(cert)) {
        count += 1;
      }
    });
    (item.profiles || []).forEach((profile) => {
      if (isUrgent(profile) || isProfileInvalid(profile)) {
        count += 1;
      }
    });
  });
  if (count === 0) {
    return;
  }
  if (typeof Notification === 'undefined' || Notification.permission === 'denied') {
    return;
  }
  const show = () => {
    notified = true;
    new Notification('App Store 上架助手：到期提醒', {
      body: `有 ${count} 项证书/描述文件将在 ${URGENT_DAYS} 天内到期或已失效，请及时处理`,
    });
  };
  if (Notification.permission === 'granted') {
    show();
  } else {
    Notification.requestPermission().then((permission) => {
      if (permission === 'granted') {
        show();
      }
    }).catch(() => {});
  }
}
