'use strict';

const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');
const { promisify } = require('util');
const express = require('express');
const c = require('../../core/term');
const { doFetch } = require('../../core/asc-client');

const router = express.Router();

/** GitHub 仓库标识 */
const REPO = 'aliujun/asc-uploader';

/** 项目根目录（version.js 位于 src/server/routes/，向上三级） */
const REPO_DIR = path.resolve(__dirname, '..', '..', '..');

/** 检测结果缓存时长（毫秒），规避 GitHub 未认证 60 次/小时的限流 */
const CACHE_TTL_MS = 60 * 60 * 1000;

/** git 落后检测偶发失败时的短缓存时长（毫秒），到点自动重试 */
const RETRY_TTL_MS = 5 * 60 * 1000;

/** git 命令超时（毫秒） */
const GIT_TIMEOUT_MS = 20000;

/** 模块级缓存 { checkedAt: number, ttl: number, payload: Object } */
let cache = null;

const execFileAsync = promisify(execFile);

/**
 * 检测运行方式：pkg 打包的 exe 进程中存在 process.pkg；npm 全局安装在 node_modules 内；
 * git clone 源码目录存在 .git；其余归为源码方式
 * @returns {'exe'|'npm'|'git'|'source'} 运行方式
 */
function detectRunMode() {
  if (process.pkg) {
    return 'exe';
  }
  if (REPO_DIR.includes('node_modules')) {
    return 'npm';
  }
  if (fs.existsSync(path.join(REPO_DIR, '.git'))) {
    return 'git';
  }
  return 'source';
}

/** 运行方式英文标识 → 中文名映射 */
const RUN_MODE_TEXT = {
  exe: 'exe 安装包',
  npm: 'npm 全局安装',
  git: 'git 源码仓库',
  source: '源码目录',
};

/**
 * 读取本地版本号（package.json 在进程启动时被加载，进程生命周期内不变）
 * @returns {string} 当前版本号，如 1.0.1
 */
function localVersion() {
  try {
    // eslint-disable-next-line global-require
    return require('../../../package.json').version || '0.0.0';
  } catch {
    return '0.0.0';
  }
}

/**
 * 三段语义化版本比较
 * @param {string} a 版本 a
 * @param {string} b 版本 b
 * @returns {number} a>b 返回 1，a<b 返回 -1，相等返回 0
 */
function compareVersions(a, b) {
  const pa = String(a).split('.').map(Number);
  const pb = String(b).split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const diff = (pa[i] || 0) - (pb[i] || 0);
    if (diff !== 0) {
      return diff > 0 ? 1 : -1;
    }
  }
  return 0;
}

/**
 * 源码方式下检测本地仓库落后远程的提交数（git fetch 只更新远程引用，不改工作区）
 * @returns {Promise<number|null>} 落后提交数，git 不可用或非 git 仓库时返回 null
 */
async function gitBehindCount() {
  try {
    await execFileAsync('git', ['fetch', 'origin'], { cwd: REPO_DIR, timeout: GIT_TIMEOUT_MS });
    const { stdout: branchOut } = await execFileAsync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: REPO_DIR, timeout: 5000 });
    const branch = branchOut.trim();
    const { stdout: countOut } = await execFileAsync('git', ['rev-list', '--count', `HEAD..origin/${branch}`], { cwd: REPO_DIR, timeout: 5000 });
    const count = parseInt(countOut.trim(), 10);
    return Number.isFinite(count) ? count : null;
  } catch (err) {
    // 失败降级 null（git 未安装、网络异常等），打日志便于排查
    console.log(`${c.gray('[版本检测]')} git 落后提交数获取失败：${err.message}`);
    return null;
  }
}

/**
 * 请求 GitHub 最新 Release 信息
 * @returns {Promise<Object>} Release 接口原始返回
 * @throws {Error} 网络失败或接口异常时抛出
 */
async function fetchLatestRelease() {
  // 走统一的 doFetch：配置了代理时 GitHub 请求同样经过代理，避免直连超时
  const response = await doFetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
    headers: {
      // GitHub API 强制要求 User-Agent
      'User-Agent': 'asc-uploader-version-check',
      Accept: 'application/vnd.github+json',
    },
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) {
    throw new Error(`GitHub 接口返回 ${response.status}`);
  }
  return response.json();
}

/**
 * 按运行方式生成更新指引文案
 * @param {string} runMode 运行方式
 * @param {Object} result 当前检测结果（含 releaseUrl）
 * @returns {{hint: string, command: string|null}} 指引文案与可复制的更新命令（exe 方式无命令）
 */
function buildUpdateHint(runMode, result) {
  if (runMode === 'exe') {
    return { hint: '请到 GitHub Release 页下载新版 exe 替换', command: null };
  }
  if (runMode === 'npm') {
    return { hint: '在终端执行以下命令升级', command: 'npm install -g asc-uploader@latest' };
  }
  if (runMode === 'git') {
    return { hint: '在项目目录执行以下命令拉取最新代码并更新依赖，然后重启服务', command: 'git pull && npm install --production' };
  }
  return { hint: '请从 GitHub Release 页下载最新源码包替换', command: null };
}

/**
 * 汇总一次版本检测结果（缓存 1 小时）
 * @param {boolean} force 是否跳过缓存强制重新检测
 * @returns {Promise<Object>} 检测结果
 */
async function checkVersion(force) {
  if (!force && cache && Date.now() - cache.checkedAt < cache.ttl) {
    return cache.payload;
  }
  const current = localVersion();
  const runMode = detectRunMode();
  const payload = { current, runMode, runModeLabel: RUN_MODE_TEXT[runMode] || runMode, hasUpdate: false, latest: null, error: null };
  try {
    const release = await fetchLatestRelease();
    const latest = String(release.tag_name || '').replace(/^v/, '');
    payload.latest = latest;
    payload.hasUpdate = compareVersions(latest, current) > 0;
    payload.releaseUrl = release.html_url || `https://github.com/${REPO}/releases`;
    payload.notes = release.body || '';
    payload.publishedAt = release.published_at || null;
    const asset = (Array.isArray(release.assets) && release.assets.find((a) => String(a.name).toLowerCase().endsWith('.exe'))) || null;
    payload.downloadUrl = asset ? asset.browser_download_url : null;
    payload.assetName = asset ? asset.name : null;
    payload.assetSize = asset ? asset.size : null;
    Object.assign(payload, buildUpdateHint(runMode, payload));
  } catch (err) {
    payload.error = err.message;
  }
  // git 源码仓库附带落后远程的提交数（失败降级 null，不影响主结果）
  if (runMode === 'git') {
    payload.behindCount = await gitBehindCount();
  } else {
    payload.behindCount = null;
  }
  // git 检测偶发失败（网络抖动等）用短缓存，到点自动重试；其余（含 git 成功）正常缓存 1 小时
  const useRetryTtl = runMode === 'git' && payload.behindCount === null;
  cache = { checkedAt: Date.now(), ttl: useRetryTtl ? RETRY_TTL_MS : CACHE_TTL_MS, payload };
  return payload;
}

/**
 * GET /api/version/check 版本更新检测（?force=1 跳过缓存）
 * @returns {void}
 */
router.get('/check', async (req, res) => {
  try {
    res.json(await checkVersion(req.query.force === '1'));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * 服务启动时的控制台版本检测：发现新版本输出黄色警告（含更新指引），失败静默不阻塞启动
 * @returns {Promise<void>}
 */
async function warnIfOutdated() {
  try {
    const result = await checkVersion(false);
    if (!result.hasUpdate) {
      return;
    }
    console.log('');
    console.log(c.yellow(`  ⚠ 发现新版本 v${result.latest}（当前 v${result.current}），建议尽快更新`));
    if (result.command) {
      console.log(c.yellow(`    更新命令：${result.command}`));
    } else {
      console.log(c.yellow(`    下载地址：${result.releaseUrl}`));
    }
    console.log(c.yellow(`    更新详情：${result.releaseUrl}`));
  } catch {
    // 版本检测失败不影响启动（离线、限流等场景）
  }
}

module.exports = { router, warnIfOutdated };
