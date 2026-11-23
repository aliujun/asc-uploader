'use strict';

const express = require('express');
const { createClient, parsePaging } = require('../../core/asc-client');

const router = express.Router();

/** 支持注册的设备平台白名单 */
const SUPPORTED_PLATFORMS = new Set(['IOS', 'MAC_OS', 'UNIVERSAL']);

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
 * GET /api/devices?configId= 设备列表（注册到团队的设备，含状态与型号）
 * @returns {void}
 */
router.get('/', async (req, res) => {
  const { configId } = req.query;
  if (!configId) {
    sendError(res, 400, '缺少 configId 参数');
    return;
  }
  try {
    const data = await createClient(configId).listDevices();
    const list = (data.data || []).map((item) => {
      const attributes = item.attributes || {};
      return {
        id: item.id,
        name: attributes.name || '',
        platform: attributes.platform || '',
        udid: attributes.udid || '',
        deviceClass: attributes.deviceClass || '',
        status: attributes.status || '',
        model: attributes.model || '',
        addedDate: attributes.addedDate || '',
      };
    });
    res.json({ devices: list });
  } catch (err) {
    sendError(res, 502, err.message);
  }
});

/**
 * POST /api/devices 注册新设备（支持单台注册与批量多台注册）
 * @returns {void}
 */
router.post('/', async (req, res) => {
  const { configId, name, platform, udid, devices } = req.body || {};
  if (!configId) {
    sendError(res, 400, '缺少 ASC 配置');
    return;
  }

  // 批量注册分支
  if (Array.isArray(devices) && devices.length > 0) {
    const client = createClient(configId);
    const results = [];
    for (const item of devices) {
      const devName = (item.name || '').trim();
      const devPlatform = item.platform || 'IOS';
      const devUdid = (item.udid || '').trim();
      if (!devName || !devUdid || !SUPPORTED_PLATFORMS.has(devPlatform)) {
        results.push({ name: devName || devUdid, ok: false, error: '参数不完整或平台不支持' });
        continue;
      }
      try {
        const data = await client.createDevice(devName, devPlatform, devUdid);
        results.push({ name: devName, ok: true, id: (data.data && data.data.id) || '' });
      } catch (err) {
        results.push({ name: devName, ok: false, error: err.message });
      }
    }
    res.json({ ok: true, batch: true, results });
    return;
  }

  // 单台设备注册分支
  const deviceName = (name || '').trim();
  if (!deviceName) {
    sendError(res, 400, '设备名称不能为空');
    return;
  }
  if (!SUPPORTED_PLATFORMS.has(platform)) {
    sendError(res, 400, '平台仅支持 IOS / MAC_OS / UNIVERSAL');
    return;
  }
  const deviceUdid = (udid || '').trim();
  if (!deviceUdid) {
    sendError(res, 400, 'UDID 不能为空');
    return;
  }
  try {
    const data = await createClient(configId).createDevice(deviceName, platform, deviceUdid);
    const attributes = (data.data && data.data.attributes) || {};
    res.json({
      device: {
        id: (data.data && data.data.id) || '',
        name: attributes.name || deviceName,
        platform: attributes.platform || platform,
        udid: attributes.udid || deviceUdid,
        deviceClass: attributes.deviceClass || '',
        status: attributes.status || '',
        model: attributes.model || '',
        addedDate: attributes.addedDate || '',
      },
    });
  } catch (err) {
    sendError(res, 502, err.message);
  }
});

module.exports = router;
