'use strict';

const express = require('express');
const store = require('../../config/store');
const { getDir } = require('../../config/paths');
const c = require('../../core/term');

const router = express.Router();

/**
 * GET /api/settings 读取全局设置（代理、数据目录）
 * @returns {void}
 */
router.get('/', async (req, res) => {
  try {
    const settings = await store.loadSettings();
    res.json({ ...settings, dataDir: getDir() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * PUT /api/settings 保存全局设置
 * @returns {void}
 */
router.put('/', async (req, res) => {
  const body = req.body || {};
  if (body.proxyUrl !== undefined && typeof body.proxyUrl !== 'string') {
    res.status(400).json({ error: 'proxyUrl 必须是字符串' });
    return;
  }
  try {
    res.json(await store.saveSettings(body));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** 常见本地代理软件的默认 HTTP 代理端口 */
const COMMON_PROXY_PORTS = [
  7890, // Clash for Windows / Clash Verge
  7897, // Clash Verge Rev 新默认
  10809, // v2rayN HTTP
  1080, // 通用 SOCKS / v2rayN
  8118, // Privoxy
  8888, // Fiddler
];

/** 单个候选端口的探测超时（毫秒） */
const PROBE_TIMEOUT_MS = 2000;

/**
 * 通过候选端口代理访问 Apple API，任何 HTTP 响应（含 401）都说明该端口是可用代理
 * @param {number} port 候选端口
 * @returns {Promise<{port: number, ok: boolean}>} 探测结果
 */
async function probeProxyPort(port) {
  const { ProxyAgent, fetch: undiciFetch } = require('undici');
  const agent = new ProxyAgent(`http://127.0.0.1:${port}`);
  try {
    await undiciFetch('https://api.appstoreconnect.apple.com', {
      method: 'GET',
      dispatcher: agent,
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    return { port, ok: true };
  } catch {
    return { port, ok: false };
  }
}

/**
 * POST /api/settings/detect-proxy 并行探测常见代理端口，
 * 返回第一个能通过其访问 Apple API 的端口
 * @returns {void}
 */
router.post('/detect-proxy', async (req, res) => {
  const results = await Promise.all(COMMON_PROXY_PORTS.map((port) => probeProxyPort(port)));
  const detail = results
    .map((r) => (r.ok ? c.green(`${r.port}:可用`) : c.gray(`${r.port}:无`)))
    .join('、');
  console.log(`${c.cyan('[代理检测]')} ${detail}`);
  const hit = results.find((r) => r.ok);
  if (!hit) {
    res.json({ found: false });
    return;
  }
  res.json({ found: true, proxyUrl: `http://127.0.0.1:${hit.port}` });
});

module.exports = router;
