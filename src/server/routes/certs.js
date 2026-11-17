'use strict';

const express = require('express');
const certs = require('../../core/certs');

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
 * POST /api/certs/keypair 生成 RSA 密钥对与 CSR
 * @returns {void}
 */
router.post('/keypair', async (req, res) => {
  const { commonName, remark } = req.body || {};
  if (!commonName) {
    sendError(res, 400, '通用名称不能为空');
    return;
  }
  try {
    const result = await certs.createKeyPairAndCsr(commonName, remark);
    res.json(result);
  } catch (err) {
    sendError(res, 500, err.message);
  }
});

/**
 * GET /api/certs/keys 私钥条目列表（不含私钥内容）
 * @returns {void}
 */
router.get('/keys', async (req, res) => {
  try {
    res.json({ keys: await certs.listKeys() });
  } catch (err) {
    sendError(res, 500, err.message);
  }
});

/**
 * POST /api/certs/keys/import-p12 从 .p12 文件提取私钥并导入
 * @returns {void}
 */
router.post('/keys/import-p12', async (req, res) => {
  const { p12Base64, password, remark } = req.body || {};
  try {
    const entry = await certs.importP12(p12Base64, password || '123456', remark);
    res.json(entry);
  } catch (err) {
    sendError(res, 400, err.message);
  }
});

/**
 * POST /api/certs/keys/:keyId/describe 解析 .cer 证书信息（合成前预览）
 * @returns {void}
 */
router.post('/keys/:keyId/describe', async (req, res) => {
  const { keyId } = req.params;
  const { cerContent } = req.body || {};
  if (!keyId) {
    sendError(res, 400, '缺少私钥条目 ID');
    return;
  }
  if (!cerContent) {
    sendError(res, 400, '证书内容不能为空');
    return;
  }
  try {
    res.json(certs.describeCer(cerContent));
  } catch (err) {
    sendError(res, 400, `证书解析失败：${err.message}`);
  }
});

/**
 * POST /api/certs/keys/:keyId/p12 合成 .p12 并返回二进制
 * @returns {void}
 */
router.post('/keys/:keyId/p12', async (req, res) => {
  const { keyId } = req.params;
  const { cerContent, password } = req.body || {};
  if (!keyId) {
    sendError(res, 400, '缺少私钥条目 ID');
    return;
  }
  if (!cerContent) {
    sendError(res, 400, '证书内容不能为空');
    return;
  }
  if (!password || password.length < 6) {
    sendError(res, 400, 'p12 导出密码至少 6 位');
    return;
  }
  try {
    const p12Buffer = await certs.buildP12(keyId, cerContent, password);
    res.setHeader('Content-Type', 'application/x-pkcs12');
    res.setHeader('Content-Disposition', 'attachment; filename="certificate.p12"');
    res.send(p12Buffer);
  } catch (err) {
    const status = err.message.includes('不存在') ? 404 : 400;
    sendError(res, status, err.message);
  }
});

/**
 * DELETE /api/certs/keys/:keyId 删除私钥条目
 * @returns {void}
 */
router.delete('/keys/:keyId', async (req, res) => {
  const { keyId } = req.params;
  if (!keyId) {
    sendError(res, 400, '缺少私钥条目 ID');
    return;
  }
  try {
    const removed = await certs.removeKey(keyId);
    if (!removed) {
      sendError(res, 404, '私钥条目不存在');
      return;
    }
    res.json({ ok: true });
  } catch (err) {
    sendError(res, 500, err.message);
  }
});

module.exports = router;
