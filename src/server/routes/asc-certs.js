'use strict';

const express = require('express');
const { createClient } = require('../../core/asc-client');
const certs = require('../../core/certs');

const router = express.Router();

/** 一期支持的证书类型集合 */
const SUPPORTED_CERT_TYPES = new Set(['IOS_DISTRIBUTION', 'IOS_DEVELOPMENT']);

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
 * GET /api/asc-certs?configId= 通过 ASC API 获取账号下的证书列表
 * @returns {void}
 */
router.get('/', async (req, res) => {
  const { configId } = req.query;
  if (!configId) {
    sendError(res, 400, '缺少 configId 参数');
    return;
  }
  try {
    const data = await createClient(configId).listCertificates();
    const list = (data.data || []).map((item) => ({
      id: item.id,
      displayName: item.attributes.displayName || '',
      certificateType: item.attributes.certificateType || '',
      serialNumber: item.attributes.serialNumber || '',
      createdDate: item.attributes.createdDate || '',
      expirationDate: item.attributes.expirationDate || '',
    }));
    res.json({ certs: list });
  } catch (err) {
    sendError(res, 502, err.message);
  }
});

/**
 * POST /api/asc-certs 用本地私钥签发证书并自动合成 p12 返回二进制。
 * 流程：私钥生成 CSR → ASC API 签发 → 与同一把私钥合成 p12。
 * 签发成功但 p12 合成失败时降级返回 JSON（证书已签发无法回滚）。
 * @returns {void}
 */
router.post('/', async (req, res) => {
  const { configId, keyId, certificateType, commonName, password } = req.body || {};
  if (!configId) {
    sendError(res, 400, '缺少 ASC 配置');
    return;
  }
  if (!keyId) {
    sendError(res, 400, '缺少本地私钥');
    return;
  }
  if (!SUPPORTED_CERT_TYPES.has(certificateType)) {
    sendError(res, 400, '证书类型仅支持 IOS_DISTRIBUTION / IOS_DEVELOPMENT');
    return;
  }
  const p12Password = password || '123456';
  if (p12Password.length < 6) {
    sendError(res, 400, 'p12 导出密码至少 6 位');
    return;
  }

  let csrPem;
  try {
    const csrResult = await certs.createCsrFromExistingKey(keyId, commonName);
    csrPem = csrResult.csrPem;
  } catch (err) {
    sendError(res, 400, err.message);
    return;
  }

  let issued;
  try {
    issued = await createClient(configId).createCertificate(csrPem, certificateType);
  } catch (err) {
    sendError(res, 502, err.message);
    return;
  }

  const data = (issued && issued.data) || {};
  const attributes = data.attributes || {};
  const certInfo = {
    id: data.id || '',
    displayName: attributes.displayName || '',
    certificateType: attributes.certificateType || certificateType,
    serialNumber: attributes.serialNumber || '',
    expirationDate: attributes.expirationDate || '',
  };

  let p12Buffer;
  try {
    p12Buffer = await certs.buildP12(keyId, attributes.certificateContent, p12Password);
  } catch (err) {
    // 证书已在 Apple 签发、无法回滚：以 200 JSON 降级提示，引导用户到列表确认
    res.json({
      p12Failed: true,
      error: `证书已在 Apple 签发成功（序列号 ${certInfo.serialNumber || '-'}），但 p12 合成失败：${err.message}。可在下方证书列表确认该证书`,
      cert: certInfo,
    });
    return;
  }

  res.setHeader('Content-Type', 'application/x-pkcs12');
  res.setHeader('Content-Disposition', 'attachment; filename="certificate-issued.p12"');
  res.send(p12Buffer);
});

/**
 * DELETE /api/asc-certs/:certId?configId= 吊销证书（立即生效，不可恢复）
 * @returns {void}
 */
router.delete('/:certId', async (req, res) => {
  const { configId } = req.query;
  const { certId } = req.params;
  if (!configId) {
    sendError(res, 400, '缺少 configId 参数');
    return;
  }
  if (!certId) {
    sendError(res, 400, '缺少证书 ID');
    return;
  }
  try {
    await createClient(configId).revokeCertificate(certId);
    res.json({ ok: true });
  } catch (err) {
    sendError(res, 502, err.message);
  }
});

module.exports = router;
