'use strict';

const express = require('express');
const { createClient } = require('../../core/asc-client');

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
 * GET /api/profiles?configId= 描述文件列表（关联 App ID 与证书信息）
 * @returns {void}
 */
router.get('/', async (req, res) => {
  const { configId } = req.query;
  if (!configId) {
    sendError(res, 400, '缺少 configId 参数');
    return;
  }
  try {
    const data = await createClient(configId).listProfiles();
    // included 关联数据建索引：bundleIds → App ID 信息，certificates → 证书信息
    const includedMap = new Map();
    (data.included || []).forEach((item) => {
      includedMap.set(`${item.type}/${item.id}`, item.attributes || {});
    });
    const list = (data.data || []).map((item) => {
      const attributes = item.attributes || {};
      const rel = item.relationships || {};
      const bundleIdRef = rel.bundleId && rel.bundleId.data && rel.bundleId.data.id;
      const bundleAttrs = bundleIdRef ? (includedMap.get(`bundleIds/${bundleIdRef}`) || {}) : {};
      const certRefs = (rel.certificates && rel.certificates.data) || [];
      const certs = certRefs.map((ref) => {
        const attrs = includedMap.get(`certificates/${ref.id}`) || {};
        return {
          displayName: attrs.displayName || '',
          certificateType: attrs.certificateType || '',
          expirationDate: attrs.expirationDate || '',
        };
      });
      return {
        id: item.id,
        name: attributes.name || '',
        profileType: attributes.profileType || '',
        profileState: attributes.profileState || '',
        createdDate: attributes.createdDate || '',
        expirationDate: attributes.expirationDate || '',
        bundleId: bundleAttrs.identifier || '',
        bundleName: bundleAttrs.name || '',
        certs,
      };
    });
    res.json({ profiles: list });
  } catch (err) {
    sendError(res, 502, err.message);
  }
});

/**
 * GET /api/profiles/bundle-ids?configId= App ID 列表（生成描述文件时选择）
 * @returns {void}
 */
router.get('/bundle-ids', async (req, res) => {
  const { configId } = req.query;
  if (!configId) {
    sendError(res, 400, '缺少 configId 参数');
    return;
  }
  try {
    const data = await createClient(configId).listBundleIds();
    const list = (data.data || []).map((item) => ({
      id: item.id,
      name: (item.attributes && item.attributes.name) || '',
      identifier: (item.attributes && item.attributes.identifier) || '',
    }));
    res.json({ bundleIds: list });
  } catch (err) {
    sendError(res, 502, err.message);
  }
});

/** 支持创建的描述文件类型白名单（企业类型 IOS_APP_INHOUSE 需企业账号，不支持） */
const SUPPORTED_PROFILE_TYPES = new Set(['IOS_APP_STORE', 'IOS_APP_ADHOC', 'IOS_APP_DEVELOPMENT']);

/** 需要 devices 关系的描述文件类型（Apple 要求这两类 profile 必须携带设备） */
const DEVICE_REQUIRED_TYPES = new Set(['IOS_APP_ADHOC', 'IOS_APP_DEVELOPMENT']);

/**
 * POST /api/profiles 创建描述文件（App Store / Ad Hoc / 开发类型）
 * @returns {void}
 */
router.post('/', async (req, res) => {
  const { configId, bundleIdResourceId, certificateIds, name, profileType, deviceIds } = req.body || {};
  if (!configId) {
    sendError(res, 400, '缺少 ASC 配置');
    return;
  }
  if (!bundleIdResourceId) {
    sendError(res, 400, '缺少 App ID');
    return;
  }
  if (!Array.isArray(certificateIds) || certificateIds.length === 0) {
    sendError(res, 400, '至少选择一个证书');
    return;
  }
  if (!SUPPORTED_PROFILE_TYPES.has(profileType)) {
    sendError(res, 400, '描述文件类型仅支持 IOS_APP_STORE / IOS_APP_ADHOC / IOS_APP_DEVELOPMENT');
    return;
  }
  const needDevices = DEVICE_REQUIRED_TYPES.has(profileType);
  const devices = Array.isArray(deviceIds) ? deviceIds : [];
  if (needDevices && devices.length === 0) {
    sendError(res, 400, 'Ad Hoc / 开发描述文件至少需要选择一台设备');
    return;
  }
  const profileName = (name || '').trim();
  if (!profileName) {
    sendError(res, 400, '描述文件名称不能为空');
    return;
  }
  try {
    const data = await createClient(configId).createProfile(bundleIdResourceId, certificateIds, profileName, profileType, devices);
    const attributes = (data.data && data.data.attributes) || {};
    res.json({
      profile: {
        id: (data.data && data.data.id) || '',
        name: attributes.name || profileName,
        profileType: attributes.profileType || profileType,
        expirationDate: attributes.expirationDate || '',
      },
    });
  } catch (err) {
    sendError(res, 502, err.message);
  }
});

/**
 * GET /api/profiles/:id/content?configId= 下载 .mobileprovision 二进制内容
 * @returns {void}
 */
router.get('/:id/content', async (req, res) => {
  const { configId } = req.query;
  const { id } = req.params;
  if (!configId) {
    sendError(res, 400, '缺少 configId 参数');
    return;
  }
  if (!id) {
    sendError(res, 400, '缺少描述文件 ID');
    return;
  }
  try {
    const buffer = await createClient(configId).getProfileContent(id);
    res.setHeader('Content-Type', 'application/octet-stream');
    res.send(buffer);
  } catch (err) {
    sendError(res, 502, err.message);
  }
});

/**
 * DELETE /api/profiles/:id?configId= 删除描述文件（立即生效，不可恢复）
 * @returns {void}
 */
router.delete('/:id', async (req, res) => {
  const { configId } = req.query;
  const { id } = req.params;
  if (!configId) {
    sendError(res, 400, '缺少 configId 参数');
    return;
  }
  if (!id) {
    sendError(res, 400, '缺少描述文件 ID');
    return;
  }
  try {
    await createClient(configId).deleteProfile(id);
    res.json({ ok: true });
  } catch (err) {
    sendError(res, 502, err.message);
  }
});

module.exports = router;
