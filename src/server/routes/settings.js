'use strict';

const express = require('express');
const store = require('../../config/store');

const router = express.Router();

/**
 * GET /api/settings 读取全局设置（代理等）
 * @returns {void}
 */
router.get('/', async (req, res) => {
  try {
    res.json(await store.loadSettings());
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

module.exports = router;
