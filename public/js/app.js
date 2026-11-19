/* 注册器：按 TABS 顺序加载组件模块，装配导航与面板，统一启动时序 */
import { $, enhanceSelect, bindModalBackdropClose, toast } from './common.js';
import * as expiryBanner from './expiry-banner.js';

/** 页签注册表：顺序即导航顺序，每个值对应 js/ 下的同名组件文件 */
const TABS = ['upload', 'configs', 'builds', 'certs', 'asc-certs', 'devices', 'profiles', 'connectivity'];

/** 已加载组件模块缓存（name → module） */
const modules = new Map();

/**
 * 切换到指定页签
 * @param {string} tabName 页签标识（data-tab 值）
 * @returns {void}
 */
function switchTab(tabName) {
  document.querySelectorAll('.tab').forEach((b) => b.classList.remove('active'));
  document.querySelectorAll('.tab-panel').forEach((p) => p.classList.remove('active'));
  const target = document.querySelector(`.tab[data-tab="${tabName}"]`);
  if (!target) {
    return;
  }
  target.classList.add('active');
  $(`tab-${tabName}`).classList.add('active');
  localStorage.setItem('asc-active-tab', tabName);
  const mod = modules.get(tabName);
  if (mod && typeof mod.onShown === 'function') {
    mod.onShown();
  }
}

/**
 * 执行异步初始化任务并按策略处理错误
 * @param {() => Promise<void>} task 异步任务
 * @param {(err: Error) => void} onError 错误处理策略
 * @returns {Promise<void>}
 */
async function runInit(task, onError) {
  try {
    await task();
  } catch (err) {
    onError(err);
  }
}

/**
 * 启动应用：加载组件 → 装配导航与面板 → 增强下拉 → 绑定组件 → 初始化加载 → 恢复页签
 * @returns {Promise<void>}
 */
async function boot() {
  // 1. 按 TABS 动态加载全部组件模块
  for (const name of TABS) {
    modules.set(name, await import(`./${name}.js`));
  }

  // 2. 生成导航按钮（首个补 active）
  const tabsNav = $('tabs');
  TABS.forEach((name, index) => {
    const mod = modules.get(name);
    const button = document.createElement('button');
    button.className = 'tab';
    button.dataset.tab = name;
    button.textContent = mod.title;
    if (index === 0) {
      button.classList.add('active');
    }
    button.addEventListener('click', () => switchTab(name));
    tabsNav.appendChild(button);
  });

  // 3. 按 TABS 顺序注入面板模板（首个补 active；模板字符串本身不含 active）
  const panels = $('panels');
  TABS.forEach((name) => {
    panels.insertAdjacentHTML('beforeend', modules.get(name).template);
  });
  panels.querySelector('.tab-panel').classList.add('active');

  // 4. 增强所有下拉框（时序铁律：必须先于任何 fillConfigSelect 等重建 options 的操作）
  document.querySelectorAll('select').forEach(enhanceSelect);
  // 5. 弹窗遮罩点击关闭（modal 此时已在 DOM）
  bindModalBackdropClose();

  // 6. 逐组件绑定事件
  TABS.forEach((name) => modules.get(name).init());

  // 7. 并发初始化数据加载（错误策略与原版一致：configs/私钥列表失败弹提示，其余静默）
  runInit(() => modules.get('configs').loadConfigs(), (err) => toast(`初始化失败：${err.message}`, true));
  runInit(() => modules.get('configs').loadSettings(), () => {});
  runInit(() => modules.get('upload').loadTaskHistory(), () => {});
  runInit(() => modules.get('certs').loadCertKeys(), (err) => toast(`私钥列表加载失败：${err.message}`, true));
  runInit(() => modules.get('connectivity').loadConnectivityInfo(), () => {});
  runInit(() => expiryBanner.loadOverview(), () => {});

  // 8. 恢复上次所在的页签（默认停留上传页；迁移期只校验已注册页签，避免无 active 状态）
  const savedTab = localStorage.getItem('asc-active-tab');
  if (savedTab && savedTab !== 'upload' && TABS.includes(savedTab)) {
    switchTab(savedTab);
  }
}

boot();
