'use strict';

const express = require('express');
const manager = require('../../tasks/task-manager');
const { findIpa, removeIpa } = require('./ipa');

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
 * POST /api/tasks 创建上传任务
 * @returns {void}
 */
router.post('/', async (req, res) => {
  const body = req.body || {};
  if (!body.configId) {
    sendError(res, 400, '缺少 configId');
    return;
  }
  if (!body.ipaId) {
    sendError(res, 400, '缺少 ipaId');
    return;
  }
  const ipa = findIpa(body.ipaId);
  if (!ipa) {
    sendError(res, 404, 'IPA 缓存不存在或已过期，请重新上传');
    return;
  }
  const autoTestflight = Boolean(body.autoTestflight);
  const betaGroupIds = Array.isArray(body.betaGroupIds) ? body.betaGroupIds : [];
  if (autoTestflight && betaGroupIds.length === 0) {
    sendError(res, 400, '启用自动 TestFlight 分发时必须至少选择一个测试组');
    return;
  }
  const store = require('../../config/store');
  const config = await store.findById(body.configId);
  if (!config) {
    sendError(res, 404, '配置不存在');
    return;
  }
  const task = manager.enqueue({
    configId: body.configId,
    configName: config.name,
    ipaId: ipa.ipaId,
    filename: ipa.filename,
    sizeBytes: ipa.sizeBytes,
    bundleId: ipa.bundleId,
    shortVersion: ipa.shortVersion,
    buildVersion: ipa.buildVersion,
    autoTestflight,
    betaGroupIds,
  });
  res.json(manager.toView(task));
});

/**
 * GET /api/tasks 任务列表
 * @returns {void}
 */
router.get('/', (req, res) => {
  res.json({ tasks: manager.listTasks() });
});

/**
 * GET /api/tasks/:id 任务详情
 * @returns {void}
 */
router.get('/:id', (req, res) => {
  const task = manager.findTask(req.params.id);
  if (!task) {
    sendError(res, 404, '任务不存在');
    return;
  }
  res.json(manager.toView(task));
});

/**
 * GET /api/tasks/:id/events SSE 实时推送任务状态（心跳 15s）
 * @returns {void}
 */
router.get('/:id/events', (req, res) => {
  const task = manager.findTask(req.params.id);
  if (!task) {
    sendError(res, 404, '任务不存在');
    return;
  }
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  res.write(`data: ${JSON.stringify(manager.toView(task))}\n\n`);
  const unsubscribe = manager.subscribe(task.id, res);
  const heartbeat = setInterval(() => {
    res.write(': heartbeat\n\n');
  }, 15000);
  req.on('close', () => {
    clearInterval(heartbeat);
    unsubscribe();
  });
});

/**
 * POST /api/tasks/:id/cancel 取消排队中的任务
 * @returns {void}
 */
router.post('/:id/cancel', (req, res) => {
  const ok = manager.cancel(req.params.id);
  if (!ok) {
    sendError(res, 400, '仅排队中的任务可以取消');
    return;
  }
  res.json({ ok: true });
});

/**
 * POST /api/tasks/:id/retry 重试失败任务
 * @returns {void}
 */
router.post('/:id/retry', (req, res) => {
  const ok = manager.retry(req.params.id);
  if (!ok) {
    sendError(res, 400, '仅失败的任务可以重试');
    return;
  }
  res.json({ ok: true });
});

/**
 * DELETE /api/tasks/:id 删除任务及本地 IPA 缓存
 * @returns {void}
 */
router.delete('/:id', async (req, res) => {
  const task = manager.findTask(req.params.id);
  if (!task) {
    sendError(res, 404, '任务不存在');
    return;
  }
  try {
    await manager.removeTask(task.id, (ipaId) => removeIpa(ipaId));
    res.json({ ok: true });
  } catch (err) {
    sendError(res, 500, err.message);
  }
});

module.exports = router;
