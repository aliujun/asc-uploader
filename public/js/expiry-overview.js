/* 到期总览组件：聚合全部 ASC 配置的证书/描述文件临期统计卡片与分组明细看板 */
import {
  $, daysLeft, escapeHtml, expiryBadgeHtml, formatDate, platformText, typeLabel, withLoading,
} from './common.js';
import { getOverview, refreshOverview } from './expiry-banner.js';
import { stateBadgeHtml } from './profiles.js';

/** 组件标题（导航按钮文案唯一事实源） */
export const title = '到期总览';

/** 明细筛选模式：all=全部条目，expiring=仅临期 */
let filterMode = 'all';

/** 最近一次拉取的数据缓存（切换筛选时免重复请求） */
let latestItems = null;

/** 页面模板 */
export const template = `<section id="tab-expiry-overview" class="tab-panel">
            <div class="card">
                <h2>临期统计 <button id="btn-expiry-refresh" class="small">刷新</button></h2>
                <p class="muted">聚合全部 ASC 配置的证书与描述文件，剩余有效期 ≤60 天或状态异常时计入临期统计，数据实时从 Apple 拉取。</p>
                <div id="expiry-stats" class="stats hidden"></div>
            </div>
            <div class="card">
                <h2>条目明细 <span class="expiry-filter">
                    <button id="btn-filter-all" class="small active">全部</button>
                    <button id="btn-filter-expiring" class="small">仅临期</button>
                </span></h2>
                <div id="expiry-detail" class="config-list"><span class="muted">正在加载...</span></div>
            </div>
        </section>`;

/**
 * 组件初始化：绑定刷新按钮与明细筛选按钮
 * @returns {void}
 */
export function init() {
  $('btn-expiry-refresh').addEventListener('click', (event) => {
    withLoading(event.currentTarget, '刷新中...', async () => {
      latestItems = await refreshOverview();
      renderStats(latestItems);
      renderDetail(latestItems);
    });
  });
  $('btn-filter-all').addEventListener('click', () => setFilter('all'));
  $('btn-filter-expiring').addEventListener('click', () => setFilter('expiring'));
}

/**
 * 切换明细筛选模式并重渲染明细区
 * @param {'all'|'expiring'} mode 筛选模式
 * @returns {void}
 */
function setFilter(mode) {
  filterMode = mode;
  $('btn-filter-all').classList.toggle('active', mode === 'all');
  $('btn-filter-expiring').classList.toggle('active', mode === 'expiring');
  if (latestItems) {
    renderDetail(latestItems);
  }
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
    latestItems = items;
    renderStats(items);
    renderDetail(items);
  } catch (err) {
    $('expiry-stats').classList.add('hidden');
    $('expiry-detail').innerHTML = `<span class="error">${escapeHtml(err.message)}</span>`;
  }
}

/**
 * 统计临期条目落入过期 / 30 天 / 60 天区间（描述文件状态异常但日期无效时计入过期）
 * @param {Object} entry 证书或描述文件条目
 * @param {{expired: number, within30: number, within60: number}} buckets 区间计数器
 * @returns {void}
 */
function countBucket(entry, buckets) {
  const left = daysLeft(entry.expirationDate);
  if (left === null) {
    if (entry.profileState && entry.profileState !== 'ACTIVE') {
      buckets.expired += 1;
    }
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
 * 渲染统计卡片（已过期 / 30 天内 / 60 天内 / 读取失败，仅统计临期条目）
 * @param {Array} items 配置维度的全量数据
 * @returns {void}
 */
function renderStats(items) {
  const buckets = { expired: 0, within30: 0, within60: 0 };
  let failed = 0;
  items.forEach((item) => {
    if (item.error) {
      failed += 1;
    }
    (item.certs || []).forEach((cert) => {
      if (cert.expiring) {
        countBucket(cert, buckets);
      }
    });
    (item.profiles || []).forEach((profile) => {
      if (profile.expiring) {
        countBucket(profile, buckets);
      }
    });
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
 * 按当前筛选模式取出可见条目
 * @param {Object} item 配置维度的全量数据
 * @returns {{certs: Array, profiles: Array}} 过滤后的证书与描述文件
 */
function visibleEntries(item) {
  const keep = (entry) => filterMode === 'all' || entry.expiring;
  return {
    certs: (item.certs || []).filter(keep),
    profiles: (item.profiles || []).filter(keep),
  };
}

/**
 * 渲染分组明细：按筛选模式展示各配置的条目（含读取失败的配置）
 * @param {Array} items 配置维度的全量数据
 * @returns {void}
 */
function renderDetail(items) {
  const groups = items.filter((item) => {
    if (item.error) {
      return true;
    }
    const { certs, profiles } = visibleEntries(item);
    return certs.length > 0 || profiles.length > 0;
  });
  if (groups.length === 0) {
    const tip = filterMode === 'all'
      ? '暂无证书与描述文件，先在「证书工具」签发或在 Apple 后台创建。'
      : '所有条目均在有效期内，暂无临期项。';
    $('expiry-detail').innerHTML = `<span class="muted">${tip}</span>`;
    return;
  }
  $('expiry-detail').innerHTML = groups.map(renderGroup).join('');
}

/**
 * 渲染单个配置的分组块（组标题 + 可见条目行）
 * @param {Object} item 配置维度的全量数据
 * @returns {string} 分组 HTML
 */
function renderGroup(item) {
  const { certs, profiles } = visibleEntries(item);
  const rows = [];
  certs.forEach((cert) => rows.push(certRow(cert)));
  profiles.forEach((profile) => rows.push(profileRow(profile)));
  const errorBadge = item.error ? `<span class="badge err">读取失败</span>` : '';
  return `<div class="expiry-group">
            <div class="expiry-group-title">${escapeHtml(item.configName || '未命名配置')} ${errorBadge}</div>
            ${rows.join('')}
        </div>`;
}

/**
 * 渲染单张证书条目行（临期时整行高亮）
 * @param {Object} cert 证书条目 {displayName, certificateType, platform, expirationDate, expiring}
 * @returns {string} 条目 HTML
 */
function certRow(cert) {
  // 全平台类型（DISTRIBUTION/DEVELOPMENT）在 API 中不返回 platform 字段，按官网行为兜底显示「All」
  const platformName = cert.platform
    ? platformText(cert.platform)
    : ((cert.certificateType === 'DISTRIBUTION' || cert.certificateType === 'DEVELOPMENT') ? 'All' : '');
  const platformBadge = platformName ? `<span class="badge">${escapeHtml(platformName)}</span>` : '';
  return `<div class="config-item${cert.expiring ? ' expiring' : ''}">
            <div>
                <span class="name">${escapeHtml(cert.displayName || '未命名')}</span>
                <span class="badge">证书</span>
                <span class="badge">${escapeHtml(typeLabel(cert.certificateType))}</span>
                ${platformBadge}
                ${expiryBadgeHtml(cert.expirationDate)}
                <div class="meta">到期 ${formatDate(cert.expirationDate)}</div>
            </div>
        </div>`;
}

/**
 * 渲染单个描述文件条目行（临期或状态异常时整行高亮）
 * @param {Object} profile 描述文件条目 {name, profileType, profileState, expirationDate, expiring}
 * @returns {string} 条目 HTML
 */
function profileRow(profile) {
  return `<div class="config-item${profile.expiring ? ' expiring' : ''}">
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
