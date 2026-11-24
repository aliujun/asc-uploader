'use strict';

const express = require('express');
const { createClient, parsePaging } = require('../../core/asc-client');
const certs = require('../../core/certs');

const router = express.Router();

/** 支持的证书类型集合（官网创建页「Apple Distribution / Apple Development」对应的 API 枚举） */
const SUPPORTED_CERT_TYPES = new Set(['DISTRIBUTION', 'DEVELOPMENT']);

/** 新枚举签发失败时的旧枚举兜底映射（个别账号可能仅支持合并前的类型） */
const FALLBACK_CERT_TYPES = {
  DISTRIBUTION: 'IOS_DISTRIBUTION',
  DEVELOPMENT: 'IOS_DEVELOPMENT',
};

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
      platform: item.attributes.platform || '',
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
    sendError(res, 400, '证书类型仅支持 DISTRIBUTION / DEVELOPMENT');
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

  res.setHeader('Content-Type', 'application/x-pkcs12');
  res.setHeader('Content-Disposition', 'attachment; filename="certificate-issued.p12"');
  res.send(p12Buffer);
});

/**
 * GET /api/asc-certs/:certId/refs?configId= 查询证书的引用情况：
 * 拉取描述文件列表（含 certificates 关联），找出使用该证书签名的描述文件清单
 * @returns {void}
 */
router.get('/:certId/refs', async (req, res) => {
  const { configId } = req.query;
  const { certId } = req.params;
  if (!configId) {
    sendError(res, 400, '缺少 configId 参数');
    return;
  }
  try {
    const data = await createClient(configId).listProfiles();
    const includedMap = new Map();
    (data.included || []).forEach((item) => {
      includedMap.set(`${item.type}/${item.id}`, item.attributes || {});
    });
    const refs = (data.data || [])
      .filter((item) => {
        const rel = item.relationships || {};
        const certRefs = (rel.certificates && rel.certificates.data) || [];
        return certRefs.some((ref) => ref.id === certId);
      })
      .map((item) => {
        const attributes = item.attributes || {};
        const rel = item.relationships || {};
        const bundleIdRef = rel.bundleId && rel.bundleId.data && rel.bundleId.data.id;
        const bundleAttrs = bundleIdRef ? (includedMap.get(`bundleIds/${bundleIdRef}`) || {}) : {};
        return {
          name: attributes.name || '',
          profileType: attributes.profileType || '',
          expirationDate: attributes.expirationDate || '',
          bundleId: bundleAttrs.identifier || '',
        };
      });
    res.json({ profiles: refs });
  } catch (err) {
    sendError(res, err.status || 500, err.message);
  }
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

/**
 * GET /api/asc-certs/:certId/match-key?configId= 按公钥配对自动匹配签发该证书的本地私钥
 * @returns {void}
 */
router.get('/:certId/match-key', async (req, res) => {
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
    const data = await createClient(configId).listCertificates();
    const target = (data.data || []).find((item) => item.id === certId);
    if (!target) {
      sendError(res, 404, '证书不存在（可能已被吊销或删除）');
      return;
    }
    const keys = await certs.listKeys();
    const keyId = await certs.matchKeyForCertificate(target.attributes.certificateContent, keys);
    res.json({ keyId });
  } catch (err) {
    sendError(res, 502, err.message);
  }
});

/**
 * POST /api/asc-certs/:certId/p12 重新合成并下载指定证书的 .p12。
 * 流程：从 ASC 拉取证书内容 → 未指定私钥时按公钥自动匹配 → 与本地私钥合成 p12 返回二进制。
 * @returns {void}
 */
router.post('/:certId/p12', async (req, res) => {
  const { configId, keyId, password } = req.body || {};
  const { certId } = req.params;
  if (!configId) {
    sendError(res, 400, '缺少 ASC 配置');
    return;
  }
  const p12Password = password || '123456';
  if (p12Password.length < 6) {
    sendError(res, 400, 'p12 导出密码至少 6 位');
    return;
  }

  let certificateContent = '';
  try {
    const data = await createClient(configId).listCertificates();
    const target = (data.data || []).find((item) => item.id === certId);
    if (!target) {
      sendError(res, 404, '证书不存在（可能已被吊销或删除）');
      return;
    }
    certificateContent = target.attributes.certificateContent || '';
  } catch (err) {
    sendError(res, 502, err.message);
    return;
  }
  if (!certificateContent) {
    sendError(res, 502, '未能获取证书内容，请稍后重试');
    return;
  }

  // 未指定私钥时按公钥配对自动匹配；仍无法确定时要求前端弹框手动指定
  let effectiveKeyId = keyId || '';
  if (!effectiveKeyId) {
    try {
      effectiveKeyId = await certs.matchKeyForCertificate(certificateContent, await certs.listKeys());
    } catch (err) {
      sendError(res, 500, `自动匹配私钥失败：${err.message}`);
      return;
    }
  }
  if (!effectiveKeyId) {
    sendError(res, 422, '未找到与该证书配对的本地私钥，请手动选择签发该证书时使用的私钥');
    return;
  }

  try {
    const p12Buffer = await certs.buildP12(effectiveKeyId, certificateContent, p12Password);
    res.setHeader('Content-Type', 'application/x-pkcs12');
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(`certificate-${certId}.p12`)}"`);
    res.send(p12Buffer);
  } catch (err) {
    sendError(res, 400, err.message);
  }
});

module.exports = router;
