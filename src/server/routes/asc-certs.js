'use strict';

const path = require('path');
const fs = require('fs').promises;

const express = require('express');
const { createClient } = require('../../core/asc-client');
const certs = require('../../core/certs');
const store = require('../../config/store');
const paths = require('../../config/paths');

const router = express.Router();

/** 支持的证书类型集合（官网主推的全平台新枚举） */
const SUPPORTED_CERT_TYPES = new Set(['APPLE_DISTRIBUTION', 'APPLE_DEVELOPMENT']);

/** 新枚举签发失败时的旧枚举兜底映射（部分账号可能仅支持合并前的类型） */
const FALLBACK_CERT_TYPES = {
  APPLE_DISTRIBUTION: 'IOS_DISTRIBUTION',
  APPLE_DEVELOPMENT: 'IOS_DEVELOPMENT',
};

/** 文件名非法字符清洗（Windows 保留字符），与前端命名规则一致 */
const UNSAFE_FILENAME_RE = /[\\/:*?"<>|]/g;

/**
 * 生成本地时间戳（yyyyMMdd-HHmmss），用于备份文件名
 * @returns {string} 形如 20260131-153001 的时间戳
 */
function timestamp() {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}

/**
 * 将签发合成的 p12 自动备份到数据目录 backups 子目录。
 * 备份失败只记录日志，不阻塞签发响应（证书已在 Apple 签发，响应必须先送达）。
 * @param {Buffer} p12Buffer p12 二进制内容
 * @param {string} configId 配置 ID（用于取配置名拼文件名）
 * @param {string} certificateType 证书类型枚举（dev/release 后缀）
 * @returns {Promise<void>}
 */
async function backupP12(p12Buffer, configId, certificateType) {
  try {
    const config = await store.findById(configId);
    const configName = ((config && config.name) || '未命名配置').replace(UNSAFE_FILENAME_RE, '');
    const typeSuffix = /_DEVELOPMENT$/.test(certificateType || '') ? 'dev' : 'release';
    const filename = `${configName}_${typeSuffix}_${timestamp()}.p12`;
    await paths.ensureDirs();
    await fs.writeFile(path.join(paths.getDir('backups'), filename), p12Buffer);
    console.log(`[p12 备份] 已存档：${filename}`);
  } catch (err) {
    console.log(`[p12 备份] 失败（不影响签发）：${err.message}`);
  }
}

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
    sendError(res, 400, '证书类型仅支持 APPLE_DISTRIBUTION / APPLE_DEVELOPMENT');
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
    const client = createClient(configId);
    try {
      issued = await client.createCertificate(csrPem, certificateType);
    } catch (err) {
      const fallback = FALLBACK_CERT_TYPES[certificateType];
      if (!fallback) {
        throw err;
      }
      console.warn(`[证书] ${certificateType} 签发失败，尝试回退 ${fallback}：${err.message}`);
      issued = await client.createCertificate(csrPem, fallback);
    }
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

  // 自动备份到本地备份目录（失败不影响响应）
  await backupP12(p12Buffer, configId, certificateType);

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
