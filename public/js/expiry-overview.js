/* 到期总览组件：聚合全部 ASC 配置的证书/描述文件临期统计卡片与分组明细看板 */
import {
  $, daysLeft, escapeHtml, expiryBadgeHtml, formatDate, typeLabel, withLoading,
} from './common.js';
import { getOverview, refreshOverview } from './expiry-banner.js';
import { stateBadgeHtml } from './profiles.js';

/** 组件标题（导航按钮文案唯一事实源） */
export const title = '到期总览';

/** 页面模板 */
export const template = `<section id="tab-expiry-overview" class="tab-panel">
            <div class="card">
                <h2>临期统计 <button id="btn-expiry-refresh" class="small">刷新</button></h2>
                <p class="muted">聚合全部 ASC 配置的证书与描述文件，剩余有效期 ≤60 天或状态异常时纳入统计，数据实时从 Apple 拉取。</p>
                <div id="expiry-stats" class="stats hidden"></div>
            </div>
            <div class="card">
                <h2>临期明细</h2>
                <div id="expiry-detail" class="config-list"><span class="muted">正在加载...</span></div>
            </div>
        </section>`;

/**
 * 组件初始化：绑定刷新按钮
 * @returns {void}
 */
export function init() {
  $('btn-expiry-refresh').addEventListener('click', (event) => {
    withLoading(event.currentTarget, '刷新中...', async () => {
      const items = await refreshOverview();
      renderStats(items);
      renderDetail(items);
    });
  });
}

/**
 * 面板每次展示时重新渲染（有缓存时直接复用，不重复请求）
 * @returns {void}
 */
export function onShown() {
  render();
}

/**
 * 拉取数据并渲染统计与明细
 * @returns {Promise<void>}
 */
async function render() {
  try {
    const items = await getOverview();
    renderStats(items);
    renderDetail(items);
  } catch (err) {
    $('expiry-stats').classList.add('hidden');
    $('expiry-detail').innerHTML = `<span class="error">${escapeHtml(err.message)}</span>`;
  }
}

/**
 * 统计临期条目落入过期 / 30 天 / 60 天区间
 * @param {Object} entry 证书或描述文件条目
 * @param {{expired: number, within30: number, within60: number}} buckets 区间计数器
 * @returns {void}
 */
function countBucket(entry, buckets) {
  const left = daysLeft(entry.expirationDate);
  if (left === null) {
    return;
  }
  if (left < 0) {
    buckets.expired += 1;
  } else if (left <= 30) {
    buckets.within30 += 1;
  } else if (left <= 60) {
    buckets.within60 += 1;
  }
}

/**
 * 渲染统计卡片（已过期 / 30 天内 / 60 天内 / 读取失败）
 * @param {Array} items 配置维度的临期数据
 * @returns {void}
 */
function renderStats(items) {
  const buckets = { expired: 0, within30: 0, within60: 0 };
  let failed = 0;
  items.forEach((item) => {
    if (item.error) {
      failed += 1;
    }
    (item.certs || []).forEach((cert) => countBucket(cert, buckets));
    (item.profiles || []).forEach((profile) => countBucket(profile, buckets));
  });
  const stats = $('expiry-stats');
  stats.innerHTML = `
    <div class="stat${buckets.expired > 0 ? ' warn' : ''}">
      <div class="stat-num">${buckets.expired}</div>
      <div class="stat-label">已过期</div>
    </div>
    <div class="stat${buckets.within30 > 0 ? ' warn' : ''}">
      <div class="stat-num">${buckets.within30}</div>
      <div class="stat-label">30 天内到期</div>
    </div>
    <div class="stat${buckets.within60 > 0 ? ' warn' : ''}">
      <div class="stat-num">${buckets.within60}</div>
      <div class="stat-label">60 天内到期</div>
    </div>
    <div class="stat${failed > 0 ? ' warn' : ''}">
      <div class="stat-num">${failed}</div>
      <div class="stat-label">读取失败配置</div>
    </div>`;
  stats.classList.remove('hidden');
}

/**
 * 渲染分组明细：有临期项或读取失败的配置各占一组
 * @param {Array} items 配置维度的临期数据
 * @returns {void}
 */
function renderDetail(items) {
  const groups = items.filter((item) => item.error
    || (item.certs && item.certs.length > 0)
    || (item.profiles && item.profiles.length > 0));
  if (groups.length === 0) {
    $('expiry-detail').innerHTML = '<span class="muted">所有配置的证书与描述文件均在有效期内，暂无临期项。</span>';
    return;
  }
  $('expiry-detail').innerHTML = groups.map(renderGroup).join('');
}

/**
 * 渲染单个配置的分组块（组标题 + 全部临期条目行）
 * @param {Object} item 配置维度的临期数据
 * @returns {string} 分组 HTML
 */
function renderGroup(item) {
  const rows = [];
  (item.certs || []).forEach((cert) => rows.push(certRow(cert)));
  (item.profiles || []).forEach((profile) => rows.push(profileRow(profile)));
  const errorBadge = item.error ? `<span class="badge err">读取失败</span>` : '';
  return `<div class="expiry-group">
            <div class="expiry-group-title">${escapeHtml(item.configName || '未命名配置')} ${errorBadge}</div>
            ${rows.join('')}
        </div>`;
}

/**
 * 渲染单张证书条目行
 * @param {Object} cert 证书条目 {displayName, certificateType, expirationDate}
 * @returns {string} 条目 HTML
 */
function certRow(cert) {
  return `<div class="config-item">
            <div>
                <span class="name">${escapeHtml(cert.displayName || '未命名')}</span>
                <span class="badge">证书</span>
                <span class="badge">${escapeHtml(typeLabel(cert.certificateType))}</span>
                ${expiryBadgeHtml(cert.expirationDate)}
                <div class="meta">到期 ${formatDate(cert.expirationDate)}</div>
            </div>
        </div>`;
}

/**
 * 渲染单个描述文件条目行
 * @param {Object} profile 描述文件条目 {name, profileType, profileState, expirationDate}
 * @returns {string} 条目 HTML
 */
function profileRow(profile) {
  return `<div class="config-item">
            <div>
                <span class="name">${escapeHtml(profile.name || '未命名')}</span>
                <span class="badge">描述文件</span>
                <span class="badge">${escapeHtml(typeLabel(profile.profileType))}</span>
                ${stateBadgeHtml(profile.profileState)}
                ${expiryBadgeHtml(profile.expirationDate)}
                <div class="meta">到期 ${formatDate(profile.expirationDate)}</div>
            </div>
        </div>`;
}
