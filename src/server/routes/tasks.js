'use strict';

const express = require('express');
const manager = require('../../tasks/task-manager');
const provision = require('../../core/provision');
const store = require('../../config/store');
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
 * 格式化日期为本地日期文本
 * @param {string} iso ISO 时间字符串
 * @returns {string} 本地日期，无效时返回 '-'
 */
function formatDate(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return '-';
  }
  return date.toLocaleDateString('zh-CN');
}

/**
 * 预检 IPA 签名描述文件（描述文件解析失败时跳过校验，避免误伤正常上传）
 * @param {Object} ipa IPA 元数据（含 profile 字段）
 * @returns {string|null} 校验失败原因，通过或无法预检时返回 null
 */
function validateIpaProfile(ipa) {
  const profile = ipa.profile;
  if (!profile) {
    return null;
  }
  if (profile.expirationDate) {
    const left = Math.ceil((new Date(profile.expirationDate).getTime() - Date.now()) / 86400000);
    if (Number.isFinite(left) && left < 0) {
      return `IPA 内描述文件「${profile.name || '未命名'}」已于 ${formatDate(profile.expirationDate)} 过期，上传会被 Apple 拒绝，请重新打包后再上传`;
    }
  }
  if (profile.type === 'IOS_APP_DEVELOPMENT') {
    return 'IPA 使用开发签名的描述文件，无法上传 TestFlight / App Store，请用发布证书重新打包';
  }
  if (profile.bundleId && ipa.bundleId && !matchBundleId(profile.bundleId, ipa.bundleId)) {
    return `IPA bundleId（${ipa.bundleId}）与描述文件签名的 App ID（${profile.bundleId}）不匹配，请确认打包配置`;
  }
  return null;
}

/**
 * 通配符 App ID 匹配（描述文件 App ID 以 * 结尾时按前缀匹配）
 * @param {string} profileBundleId 描述文件签名的 App ID（可能含通配符）
 * @param {string} ipaBundleId IPA 实际 bundleId
 * @returns {boolean} 是否匹配
 */
function matchBundleId(profileBundleId, ipaBundleId) {
  if (profileBundleId === ipaBundleId) {
    return true;
  }
  if (profileBundleId.endsWith('*')) {
    return ipaBundleId.startsWith(profileBundleId.slice(0, -1));
  }
  return false;
}

/**
 * 生成预检通过后的摘要文案（写入任务 meta，任务开始时输出到日志）
 * @param {Object} profile 描述文件解析结果
 * @returns {string} 摘要文案
 */
function buildPrecheckSummary(profile) {
  const expiry = profile.expirationDate ? formatDate(profile.expirationDate) : '未知';
  return `描述文件「${profile.name || '未命名'}」（${provision.typeLabel(profile.type)}），到期 ${expiry}`;
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
  const storeConfig = await store.findById(body.configId);
  if (!storeConfig) {
    sendError(res, 404, '配置不存在');
    return;
  }
  const profileError = validateIpaProfile(ipa);
  if (profileError) {
    sendError(res, 400, profileError);
    return;
  }
  const task = manager.enqueue({
    configId: body.configId,
    configName: storeConfig.name,
    ipaId: ipa.ipaId,
    filename: ipa.filename,
    sizeBytes: ipa.sizeBytes,
    bundleId: ipa.bundleId,
    shortVersion: ipa.shortVersion,
    buildVersion: ipa.buildVersion,
    autoTestflight,
    betaGroupIds,
    precheckSummary: ipa.profile ? buildPrecheckSummary(ipa.profile) : '',
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
 * POST /api/tasks/:id/abort 中断任务（仅提交校验之前允许；排队中直接取消）。
 * 可中断阶段定义统一由 task-manager 的 ABORTABLE_STAGES 提供，路由不再维护重复名单
 * @returns {void}
 */
router.post('/:id/abort', (req, res) => {
  const task = manager.findTask(req.params.id);
  if (task && manager.isStageActive(task.stage) && !manager.isStageAbortable(task.stage)) {
    sendError(res, 400, '当前阶段文件已提交给 Apple，中断也无法撤回，请等待结果');
    return;
  }
  const ok = manager.abort(req.params.id);
  if (!ok) {
    sendError(res, 400, '仅排队中或进行中的任务可以中断');
    return;
  }
  res.json({ ok: true });
});

/**
 * POST /api/tasks/:id/retry 重试失败或已取消的任务
 * @returns {void}
 */
router.post('/:id/retry', (req, res) => {
  const task = manager.findTask(req.params.id);
  if (task && !findIpa(task.ipaId)) {
    sendError(res, 400, '本地 IPA 缓存已不存在（服务重启或缓存被清理），请重新上传 IPA 创建新任务');
    return;
  }
  const ok = manager.retry(req.params.id);
  if (!ok) {
    sendError(res, 400, '仅失败或已取消的任务可以重试');
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
  // 进行中的任务删除会连带清掉正在上传的 IPA 缓存文件，导致流水线中断异常，禁止删除
  if (manager.isStageActive(task.stage)) {
    sendError(res, 400, '任务进行中不允许删除，请等待任务完成/失败，或先中断后再删除');
    return;
  }
  try {
    // 同一 IPA 可能被多个任务（重试产生的历史记录）引用，仅在没有其它任务引用时才删除缓存文件
    const ipaInUse = manager.listTasks().some((t) => t.id !== task.id && t.ipaId === task.ipaId);
    await manager.removeTask(task.id, ipaInUse ? null : (ipaId) => removeIpa(ipaId));
    res.json({ ok: true });
  } catch (err) {
    sendError(res, 500, err.message);
  }
});

module.exports = router;
