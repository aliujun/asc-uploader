/* App Store 版本与审核状态组件：按配置/App 查看版本审核全流程状态 */
import { $, api, escapeHtml, fillSelect, toast, formatDate, withLoading } from './common.js';

export const title = '版本审核';

/** AppStoreVersion 状态英文标识 → 中文名映射（官方枚举，未列出的原样显示） */
const APP_STORE_STATE_TEXT = {
  READY_FOR_DISTRIBUTION: '已发布',
  READY_FOR_SALE: '已发布',
  PREORDER_READY_FOR_SALE: '预售中',
  PENDING_DEVELOPER_RELEASE: '待开发者发布',
  WAITING_FOR_REVIEW: '等待审核',
  IN_REVIEW: '审核中',
  REJECTED: '审核被拒',
  METADATA_REJECTED: '元数据被拒',
  DEVELOPER_REJECTED: '开发者撤回',
  INVALID: '无效',
  PREPARE_FOR_SUBMISSION: '准备提交',
  PREPARE_FOR_METADATA_SUBMISSION: '准备提交',
  DEVELOPER_REMOVED_FROM_SALE: '已下架',
  REPLACED_WITH_NEW_VERSION: '已被新版本替代',
};

/** 状态 → 徽章样式类（ok 绿 / err 红 / warn 黄，未映射默认灰） */
const APP_STORE_STATE_CLS = {
  READY_FOR_DISTRIBUTION: 'ok',
  READY_FOR_SALE: 'ok',
  PREORDER_READY_FOR_SALE: 'ok',
  PENDING_DEVELOPER_RELEASE: 'warn',
  WAITING_FOR_REVIEW: 'warn',
  IN_REVIEW: 'warn',
  REJECTED: 'err',
  METADATA_REJECTED: 'err',
  INVALID: 'err',
  DEVELOPER_REJECTED: 'err',
};

/** App 列表加载请求序号（防竞态） */
let appsReqSeq = 0;

/** 版本列表加载请求序号（防竞态） */
let versionsReqSeq = 0;

/** 组件内部状态：配置/App/版本列表与当前选中项 */
const state = {
  configs: [],
  apps: [],
  versions: [],
  configId: '',
  appId: '',
  nextCursor: null,
  resourcesLoaded: false,
};

export const template = `<section id="tab-app-versions" class="tab-panel">
    <div class="card">
        <h2>App Store 版本与审核状态</h2>
        <p class="muted">查看所选 App 各版本的审核进展（等待审核 / 审核中 / 通过 / 被拒 / 已发布），无需登录 App Store Connect 网页。数据仅在打开本页或点击刷新时拉取。</p>
        <div class="form-row inline">
            <select id="av-config"><option value="">选择 ASC 配置</option></select>
            <select id="av-app"><option value="">选择 App</option></select>
            <button id="btn-av-refresh">刷新</button>
            <button id="btn-open-asc-store" class="small hidden" style="margin-left:auto;" title="在浏览器中直接打开 App Store Connect 的版本页面">在 ASC 中打开 ↗</button>
        </div>
        <div id="av-stats" class="stats hidden"></div>
        <div id="av-list" class="config-list"></div>
    </div>
    <div class="card">
        <h2>说明</h2>
        <ol class="steps">
            <li>先选择 ASC 配置，再从账号下选择要查看的 App，版本列表按创建时间倒序排列。</li>
            <li>状态徽章含义：<span class="badge err">审核被拒 / 元数据被拒</span> 需要立即处理；<span class="badge warn">等待审核 / 审核中 / 待开发者发布</span> 表示流程进行中；<span class="badge ok">已发布 / 预售中</span> 表示已上线。</li>
            <li>「待开发者发布」表示审核已通过、等待你手动发布或到达自动发布时间。</li>
            <li>本工具只在打开页面或刷新时拉取最新状态，不做后台轮询推送；如需推送提醒，可使用手机端 App Store Connect 应用。</li>
        </ol>
    </div>
</section>`;

/**
 * 状态徽章 HTML（未知状态原样显示文本、默认灰底）
 * @param {string} appStoreState 状态英文标识
 * @returns {string} 徽章 HTML
 */
export function stateBadgeHtml(appStoreState) {
  const text = APP_STORE_STATE_TEXT[appStoreState] || appStoreState || '未知';
  const cls = APP_STORE_STATE_CLS[appStoreState] || '';
  return `<span class="badge ${cls}">${escapeHtml(text)}</span>`;
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
  fillSelect($('av-config'), '选择 ASC 配置', state.configs.map((c) => ({ value: c.id, label: c.name })));
  state.resourcesLoaded = true;
}

/**
 * 拉取所选配置下的 App 列表（默认选中第一个 App 并加载版本）
 * @returns {Promise<void>}
 */
async function loadApps() {
  if (!state.configId) {
    state.apps = [];
    fillSelect($('av-app'), '选择 App', []);
    return;
  }
  // 请求序号守卫：快速切换配置时丢弃过期响应
  const seq = ++appsReqSeq;
  const data = await api(`/api/apps?configId=${encodeURIComponent(state.configId)}`);
  if (seq !== appsReqSeq) {
    return;
  }
  state.apps = data.apps || [];
  fillSelect($('av-app'), '选择 App', state.apps.map((a) => ({ value: a.id, label: a.name })));
  const btnAsc = $('btn-open-asc-store');
  if (btnAsc) {
    btnAsc.classList.add('hidden');
  }
  // 默认选中第一个 App，直接展示版本列表
  if (state.apps.length > 0) {
    state.appId = state.apps[0].id;
    $('av-app').value = state.appId;
    await loadVersions();
  }
}

/**
 * 拉取所选 App 的版本与审核状态并渲染（支持游标追加）
 * @param {boolean} [isLoadMore=false] 是否为加载更多下一页
 * @returns {Promise<void>}
 */
async function loadVersions(isLoadMore = false) {
  const wrap = $('av-list');
  const btnAsc = $('btn-open-asc-store');
  if (!state.appId) {
    state.versions = [];
    state.nextCursor = null;
    if (btnAsc) {
      btnAsc.classList.add('hidden');
    }
    renderVersionList();
    return;
  }

  if (btnAsc) {
    btnAsc.classList.remove('hidden');
    btnAsc.onclick = () => window.open(`https://appstoreconnect.apple.com/apps/${encodeURIComponent(state.appId)}/appstore/ios`, '_blank', 'noopener');
  }

  // 请求序号守卫：快速切换 App 时丢弃过期响应
  const seq = ++versionsReqSeq;
  if (!isLoadMore) {
    wrap.innerHTML = '<span class="inline-loading">正在加载版本列表...</span>';
    state.versions = [];
    state.nextCursor = null;
  }

  try {
    const cursorQuery = isLoadMore && state.nextCursor ? `&cursor=${encodeURIComponent(state.nextCursor)}` : '';
    const data = await api(`/api/app-versions?configId=${encodeURIComponent(state.configId)}&appId=${encodeURIComponent(state.appId)}${cursorQuery}`);
    if (seq !== versionsReqSeq) {
      return;
    }
    const newItems = Array.isArray(data.versions) ? data.versions : [];
    if (isLoadMore) {
      state.versions.push(...newItems);
    } else {
      state.versions = newItems;
    }
    state.nextCursor = data.nextCursor || null;
    renderVersionList();
  } catch (err) {
    wrap.innerHTML = `<span class="error">${escapeHtml(err.message)}</span>`;
  }
}

/**
 * 渲染统计卡与版本列表
 * @returns {void}
 */
function renderVersionList() {
  const stats = $('av-stats');
  const wrap = $('av-list');
  const versions = state.versions;
  const currentApp = state.apps.find((a) => a.id === state.appId);
  if (versions.length === 0) {
    stats.classList.add('hidden');
    stats.innerHTML = '';
    wrap.innerHTML = `<span class="muted">${state.appId ? '该 App 暂无 App Store 版本（从未提审过版本）' : '请先选择 ASC 配置与 App'}</span>`;
    return;
  }
  const count = (s) => versions.filter((v) => v.appStoreState === s).length;
  const rejected = count('REJECTED') + count('METADATA_REJECTED');
  const reviewing = count('IN_REVIEW');
  const waiting = count('WAITING_FOR_REVIEW');
  const pendingRelease = count('PENDING_DEVELOPER_RELEASE');
  const released = count('READY_FOR_DISTRIBUTION') + count('READY_FOR_SALE') + count('PREORDER_READY_FOR_SALE');
  stats.innerHTML = `
                <div class="stat${rejected > 0 ? ' warn' : ''}">
                    <span class="stat-num">${rejected}</span>
                    <span class="stat-label">审核被拒</span>
                </div>
                <div class="stat">
                    <span class="stat-num">${reviewing}</span>
                    <span class="stat-label">审核中</span>
                </div>
                <div class="stat">
                    <span class="stat-num">${waiting}</span>
                    <span class="stat-label">等待审核</span>
                </div>
                <div class="stat">
                    <span class="stat-num">${pendingRelease}</span>
                    <span class="stat-label">待开发者发布</span>
                </div>
                <div class="stat">
                    <span class="stat-num">${released}</span>
                    <span class="stat-label">已发布</span>
                </div>
                <div class="stat">
                    <span class="stat-num">${versions.length}</span>
                    <span class="stat-label">版本总数</span>
                </div>`;
  stats.classList.remove('hidden');

  wrap.innerHTML = '';
  versions.forEach((v) => {
    const row = document.createElement('div');
    row.className = 'config-item';
    const times = [];
    if (v.createdDate) {
      times.push(`创建于 ${formatDate(v.createdDate)}`);
    }
    if (v.releasedDate) {
      times.push(`发布于 ${formatDate(v.releasedDate)}`);
    }
    row.innerHTML = `
      <div>
        <span class="name">v${escapeHtml(v.versionString || '-')}</span>
        ${stateBadgeHtml(v.appStoreState)}
        <div class="meta">${currentApp ? `${escapeHtml(currentApp.name)} · ` : ''}${escapeHtml(times.join(' · ') || '-')}</div>
      </div>`;
    wrap.appendChild(row);
  });

  if (state.nextCursor) {
    const moreWrap = document.createElement('div');
    moreWrap.style.textAlign = 'center';
    moreWrap.style.marginTop = '12px';
    const moreBtn = document.createElement('button');
    moreBtn.className = 'small';
    moreBtn.textContent = '加载更多版本...';
    moreBtn.onclick = () => withLoading(moreBtn, '加载中...', () => loadVersions(true));
    moreWrap.appendChild(moreBtn);
    wrap.appendChild(moreWrap);
  }
}

/**
 * 绑定下拉与刷新事件
 * @returns {void}
 */
export function init() {
  $('av-config').addEventListener('change', async () => {
    state.configId = $('av-config').value;
    state.appId = '';
    try {
      await loadApps();
    } catch (err) {
      toast(`获取 App 列表失败：${err.message}`, true);
    }
  });
  $('av-app').addEventListener('change', async () => {
    state.appId = $('av-app').value;
    try {
      await loadVersions();
    } catch (err) {
      toast(`获取版本列表失败：${err.message}`, true);
    }
  });
  $('btn-av-refresh').addEventListener('click', (event) => {
    if (!state.configId) {
      toast('请先选择 ASC 配置', true);
      return;
    }
    withLoading(event.currentTarget, '刷新中...', async () => {
      try {
        if (state.apps.length === 0) {
          await loadApps();
        } else {
          await loadVersions();
        }
        toast('已刷新');
      } catch (err) {
        toast(`刷新失败：${err.message}`, true);
      }
    });
  });
}

/**
 * 每次进入页签时初始化（首次加载配置并联动加载版本）
 * @returns {Promise<void>}
 */
export async function onShown() {
  try {
    await loadResources();
    if (!state.configId && state.configs.length > 0) {
      state.configId = state.configs[0].id;
      $('av-config').value = state.configId;
      await loadApps();
    }
  } catch (err) {
    toast(`初始化失败：${err.message}`, true);
  }
}
