'use strict';

const express = require('express');
const { createClient, parsePaging, extractNextCursor } = require('../../core/asc-client');

const router = express.Router();

/**
 * 统一错误响应
 * @param {import('express').Response} res 响应对象
 * @param {number} status HTTP 状态码
 * @param {string} message 错误信息
 * @returns {void}
 */
function sendError(res, status, message) {
  res.status(status).json({ error: message });
}

/**
 * GET /api/app-versions?configId=xx&appId=yy 指定 App 的 App Store 版本与审核状态列表
 * @returns {void}
 */
router.get('/', async (req, res) => {
  const { configId, appId } = req.query;
  if (!configId) {
    sendError(res, 400, '缺少 configId 参数');
    return;
  }
  if (!appId) {
    sendError(res, 400, '缺少 appId 参数');
    return;
  }
  try {
    const { limit, cursor } = parsePaging(req.query, 50);
    const data = await createClient(configId).listAppStoreVersions(appId, limit, cursor);
    const versions = (data.data || []).map((item) => {
      const attributes = item.attributes || {};
      return {
        id: item.id,
        versionString: attributes.versionString || '',
        // API v3.3 起旧字段 appStoreState 已废弃，新字段优先、旧字段兜底
        appStoreState: attributes.appVersionState || attributes.appStoreState || '',
        createdDate: attributes.createdDate || '',
        releasedDate: attributes.releasedDate || '',
      };
    });
    // 按创建时间倒序（最新版本在前）
    versions.sort((a, b) => new Date(b.createdDate) - new Date(a.createdDate));
    res.json({ versions, nextCursor: extractNextCursor(data) });
  } catch (err) {
    sendError(res, 502, err.message);
  }
});

module.exports = router;
