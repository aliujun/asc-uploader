'use strict';

const express = require('express');
const { createClient, parsePaging } = require('../../core/asc-client');
const c = require('../../core/term');

const router = express.Router();

/**
 * 从请求 query/body 中解析 configId
 * @param {import('express').Request} req 请求对象
 * @returns {string|null} 配置 ID
 */
function resolveConfigId(req) {
  const id = (req.query && req.query.configId) || (req.body && req.body.configId);
  return id ? String(id) : null;
}

/**
 * GET /api/apps?configId=xx 获取 app 列表
 * @returns {void}
 */
router.get('/', async (req, res) => {
  const configId = resolveConfigId(req);
  if (!configId) {
    res.status(400).json({ error: '缺少 configId 参数' });
    return;
  }
  try {
    const { limit, offset } = parsePaging(req.query, 200);
    const data = await createClient(configId).listApps(limit, offset);
    const apps = (data.data || []).map((app) => ({
      id: app.id,
      name: app.attributes.name,
      bundleId: app.attributes.bundleId,
      sku: app.attributes.sku,
    }));
    res.json({ apps });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

/**
 * GET /api/apps/:id/builds?configId=xx 获取 build 列表
 * @returns {void}
 */
router.get('/:id/builds', async (req, res) => {
  const configId = resolveConfigId(req);
  if (!configId) {
    res.status(400).json({ error: '缺少 configId 参数' });
    return;
  }
  try {
    const { limit, offset } = parsePaging(req.query, 50);
    const data = await createClient(configId).listBuilds(req.params.id, limit, offset);
    // 短版本号（CFBundleShortVersionString）不在 builds 资源上，需从 included 的 preReleaseVersion 中取
    const preReleaseVersions = {};
    (data.included || []).forEach((inc) => {
      if (inc.type === 'preReleaseVersions' && inc.id) {
        preReleaseVersions[inc.id] = inc.attributes || {};
      }
    });
    const builds = (data.data || []).map((build) => {
      const attrs = build.attributes || {};
      const preRel = build.relationships && build.relationships.preReleaseVersion;
      const preId = preRel && preRel.data && preRel.data.id;
      const pre = preId ? preReleaseVersions[preId] : null;
      return {
        id: build.id,
        version: attrs.version,
        shortVersion: pre ? pre.version : null,
        processingState: attrs.processingState,
        uploadedDate: attrs.uploadedDate,
        usesNonExemptEncryption: attrs.usesNonExemptEncryption,
      };
    });
    console.log(`${c.cyan('[Build列表]')} appId=${req.params.id} ${c.green(`获取成功，共 ${builds.length} 条`)}`);
    res.json({ builds });
  } catch (err) {
    console.error(`${c.cyan('[Build列表]')} appId=${req.params.id} ${c.red(`获取失败：${err.message}`)}`);
    res.status(502).json({ error: err.message });
  }
});

/**
 * POST /api/apps/:id/distribute {configId, betaGroupIds} 把 build 加入测试组
 * @returns {void}
 */
router.post('/:id/distribute', async (req, res) => {
  const { configId } = req.body || {};
  const betaGroupIds = Array.isArray(req.body && req.body.betaGroupIds) ? req.body.betaGroupIds : [];
  if (!configId) {
    res.status(400).json({ error: '缺少 configId' });
    return;
  }
  if (betaGroupIds.length === 0) {
    res.status(400).json({ error: '至少选择一个测试组' });
    return;
  }
  try {
    await createClient(configId).distributeBuild(req.params.id, betaGroupIds);
    res.json({ ok: true });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

module.exports = router;
