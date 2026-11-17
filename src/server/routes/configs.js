'use strict';

const express = require('express');
const store = require('../../config/store');
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
 * GET /api/configs 配置列表（脱敏）
 * @returns {void}
 */
router.get('/', async (req, res) => {
  try {
    res.json(await store.listSafe());
  } catch (err) {
    sendError(res, 500, err.message);
  }
});

/**
 * POST /api/configs 新增配置
 * @returns {void}
 */
router.post('/', async (req, res) => {
  const invalidMessage = store.validate(req.body, true);
  if (invalidMessage) {
    sendError(res, 400, invalidMessage);
    return;
  }
  try {
    const item = await store.create(req.body);
    res.json({ id: item.id });
  } catch (err) {
    sendError(res, 500, err.message);
  }
});

/**
 * PUT /api/configs/:id 更新配置
 * @returns {void}
 */
router.put('/:id', async (req, res) => {
  const invalidMessage = store.validate(req.body, false);
  if (invalidMessage) {
    sendError(res, 400, invalidMessage);
    return;
  }
  try {
    const updated = await store.update(req.params.id, req.body);
    if (!updated) {
      sendError(res, 404, '配置不存在');
      return;
    }
    res.json({ ok: true });
  } catch (err) {
    sendError(res, 500, err.message);
  }
});

/**
 * DELETE /api/configs/:id 删除配置
 * @returns {void}
 */
router.delete('/:id', async (req, res) => {
  try {
    const removed = await store.remove(req.params.id);
    if (!removed) {
      sendError(res, 404, '配置不存在');
      return;
    }
    res.json({ ok: true });
  } catch (err) {
    sendError(res, 500, err.message);
  }
});

/**
 * POST /api/configs/:id/verify 验证配置连通性
 * @returns {void}
 */
router.post('/:id/verify', async (req, res) => {
  try {
    const config = await store.findById(req.params.id);
    if (!config) {
      sendError(res, 404, '配置不存在');
      return;
    }
    const result = await createClient(config.id).verify();
    if (!result.ok) {
      res.status(502).json({ ok: false, message: result.message });
      return;
    }
    res.json(result);
  } catch (err) {
    res.status(502).json({ ok: false, message: err.message });
  }
});

/**
 * POST /api/configs/:id/activate 激活配置
 * @returns {void}
 */
router.post('/:id/activate', async (req, res) => {
  try {
    const ok = await store.setActive(req.params.id);
    if (!ok) {
      sendError(res, 404, '配置不存在');
      return;
    }
    res.json({ ok: true });
  } catch (err) {
    sendError(res, 500, err.message);
  }
});

module.exports = router;
