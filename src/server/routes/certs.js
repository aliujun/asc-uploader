'use strict';

const express = require('express');
const certs = require('../../core/certs');
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
 * GET /api/certs/keys/:keyId/refs 查询私钥的引用情况：
 * 遍历全部 ASC 配置拉取证书列表，按公钥配对找出由该私钥签发的证书
 * （ASC 配置存有独立的 p8 内容副本，不依赖本地私钥条目；真正的依赖是签发出来的证书）
 * @returns {void}
 */
router.get('/keys/:keyId/refs', async (req, res) => {
  const { keyId } = req.params;
  if (!keyId) {
    sendError(res, 400, '缺少私钥条目 ID');
    return;
  }
  let privateKeyPem;
  try {
    privateKeyPem = await certs.readPrivateKeyPem(keyId);
  } catch {
    sendError(res, 404, '私钥条目不存在');
    return;
  }
  let configs = [];
  try {
    const data = await store.listSafe();
    configs = data.configs || [];
  } catch (err) {
    sendError(res, 500, err.message);
    return;
  }
  // 逐配置拉取证书列表，按公钥配对找出该私钥签发的证书（serialNumber 去重，多配置同账号场景）
  const certRefs = [];
  const seenSerials = new Set();
  const errors = [];
  for (const cfg of configs) {
    try {
      const data = await createClient(cfg.id).listCertificates();
      for (const item of data.data || []) {
        const serial = item.attributes.serialNumber || item.id;
        if (seenSerials.has(serial)) {
          continue;
        }
        if (certs.isKeyMatched(privateKeyPem, item.attributes.certificateContent || '')) {
          seenSerials.add(serial);
          certRefs.push({
            configName: cfg.name,
            displayName: item.attributes.displayName || '',
            certificateType: item.attributes.certificateType || '',
            serialNumber: serial,
            expirationDate: item.attributes.expirationDate || '',
          });
        }
      }
    } catch (err) {
      errors.push(`${cfg.name}：${err.message}`);
    }
  }
  res.json({ configs: configs.length, certs: certRefs, errors });
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
