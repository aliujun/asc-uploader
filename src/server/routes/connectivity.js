'use strict';

const express = require('express');
const { doFetch, resolveActiveProxyUrl } = require('../../core/asc-client');

const router = express.Router();

/** 单个探测目标的超时时间（毫秒） */
const PROBE_TIMEOUT_MS = 8000;

/** 待探测的 Apple 关键服务列表 */
const TARGETS = [
  {
    name: 'App Store Connect API',
    url: 'https://api.appstoreconnect.apple.com/v1/apps',
    note: '上传 / Build 查询 / TestFlight 分发的核心接口',
  },
  {
    name: 'App Store Connect 网页',
    url: 'https://appstoreconnect.apple.com/',
    note: '网页后台（生成 API 密钥等）',
  },
  {
    name: 'Apple Developer',
    url: 'https://developer.apple.com/',
    note: '开发者后台（证书签发）',
  },
];

/**
 * GET /api/connectivity/info 返回当前生效的代理（含环境变量兜底）
 * @returns {void}
 */
router.get('/info', async (req, res) => {
  try {
    const proxyUrl = await resolveActiveProxyUrl();
    res.json({ proxyUrl });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/connectivity/test 从服务进程内探测 Apple 各关键服务
 * 注意：收到任意 HTTP 状态码（含 401/302）均代表网络连通正常
 * @returns {void}
 */
router.post('/test', async (req, res) => {
  try {
    const proxyUrl = await resolveActiveProxyUrl();
    const exit = proxyUrl || '直连（未配置代理）';
    console.log(`[连通性测试] 开始，网络出口：${exit}`);
    const results = [];
    for (const target of TARGETS) {
      results.push(await probe(target, exit));
    }
    const okCount = results.filter((r) => r.ok).length;
    console.log(`[连通性测试] 完成：${okCount}/${results.length} 项连通`);
    res.json({ proxyUrl, results });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * 探测单个目标：返回延迟与连通状态，并在终端输出调试日志
 * @param {Object} target 目标 {name, url, note}
 * @param {string} exitDesc 网络出口描述（直连或代理地址）
 * @returns {Promise<{name: string, url: string, note: string, ok: boolean,
 *   httpStatus: number|null, latencyMs: number, error: string}>}
 */
async function probe(target, exitDesc) {
  const startAt = Date.now();
  try {
    const response = await doFetch(target.url, {
      method: 'GET',
      redirect: 'manual',
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    // 读取并丢弃 body，避免连接悬挂
    await response.arrayBuffer().catch(() => {});
    const latencyMs = Date.now() - startAt;
    console.log(`[连通性测试] ✓ ${target.url}（${exitDesc}）HTTP ${response.status}，${latencyMs}ms`);
    return {
      name: target.name,
      url: target.url,
      note: target.note,
      ok: true,
      httpStatus: response.status,
      latencyMs,
      error: '',
    };
  } catch (err) {
    const latencyMs = Date.now() - startAt;
    const detail = describeError(err);
    console.log(`[连通性测试] ✗ ${target.url}（${exitDesc}）失败，${latencyMs}ms，原因：${detail}`);
    return {
      name: target.name,
      url: target.url,
      note: target.note,
      ok: false,
      httpStatus: null,
      latencyMs,
      error: detail,
    };
  }
}

/**
 * 展开错误的底层原因链（undici 的真实原因藏在 err.cause 中，仅取 message 会丢失关键信息）
 * @param {Error} err 捕获的错误
 * @returns {string} 形如 "ECONNRESET ← fetch failed" 的原因链
 */
function describeError(err) {
  const parts = [];
  let current = err;
  while (current) {
    const segment = current.code ? `${current.code}: ${current.message}` : current.message;
    if (segment && !parts.includes(segment)) {
      parts.push(segment);
    }
    current = current.cause;
  }
  return parts.join(' ← ') || '未知错误';
}

module.exports = router;
