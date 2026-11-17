'use strict';

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const { getDir, ensureDirs } = require('../../config/paths');
const { parseIpaInfo } = require('../../core/ipa-info');

const router = express.Router();

/** 内存中保存已上传 IPA 的元数据 {ipaId: {...}} */
const ipaRegistry = new Map();

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
 * PUT /api/ipa?filename=xx.ipa
 * 原始二进制 body 流式落盘 ipa-cache/，边写边算 MD5，完成后解析 Info.plist。
 * 该路由必须在全局 body parser 之前挂载。
 * @returns {void}
 */
router.put('/', async (req, res) => {
  const fileName = String(req.query.filename || '');
  if (!fileName.toLowerCase().endsWith('.ipa')) {
    sendError(res, 415, '仅支持 .ipa 文件');
    return;
  }
  const declaredSize = Number(req.headers['content-length']);
  if (!Number.isFinite(declaredSize) || declaredSize <= 0) {
    sendError(res, 411, '缺少 Content-Length 或值非法');
    return;
  }
  try {
    await ensureDirs();
    await checkDiskSpace(declaredSize);
  } catch (err) {
    sendError(res, 507, err.message);
    return;
  }

  const ipaId = crypto.randomUUID();
  const targetPath = path.join(getDir('ipaCache'), `${ipaId}.ipa`);
  const hash = crypto.createHash('md5');
  const writeStream = fs.createWriteStream(targetPath);
  let received = 0;
  let aborted = false;

  const fail = async (status, message) => {
    aborted = true;
    req.unpipe(writeStream);
    writeStream.destroy();
    await fsp.unlink(targetPath).catch(() => {});
    sendError(res, status, message);
  };

  req.on('data', (chunk) => {
    if (aborted) {
      return;
    }
    received += chunk.length;
    if (received > declaredSize) {
      fail(413, '接收数据超过声明大小');
      return;
    }
    hash.update(chunk);
    if (!writeStream.write(chunk)) {
      req.pause();
      writeStream.once('drain', () => req.resume());
    }
  });

  req.on('error', () => {
    if (!aborted) {
      aborted = true;
      writeStream.destroy();
      fsp.unlink(targetPath).catch(() => {});
    }
  });

  req.on('end', async () => {
    if (aborted) {
      return;
    }
    try {
      await new Promise((resolve, reject) => {
        writeStream.end(resolve);
        writeStream.on('error', reject);
      });
      const sizeBytes = received;
      const md5 = hash.digest('hex');
      const info = await parseIpaInfo(targetPath);
      const meta = {
        ipaId,
        filename: fileName,
        sizeBytes,
        md5,
        bundleId: info.bundleId,
        shortVersion: info.shortVersion,
        buildVersion: info.buildVersion,
        platform: 'IOS',
        createdAt: new Date().toISOString(),
      };
      ipaRegistry.set(ipaId, meta);
      res.json(meta);
    } catch (err) {
      fsp.unlink(targetPath).catch(() => {});
      sendError(res, 500, `IPA 处理失败：${err.message}`);
    }
  });

  req.on('aborted', () => {
    aborted = true;
    writeStream.destroy();
    fsp.unlink(targetPath).catch(() => {});
  });
});

/**
 * 按 ID 查询缓存的 IPA 元数据
 * @param {string} ipaId IPA ID
 * @returns {Object|null} 元数据
 */
function findIpa(ipaId) {
  return ipaRegistry.get(ipaId) || null;
}

/**
 * 获取缓存的 IPA 文件路径
 * @param {string} ipaId IPA ID
 * @returns {string} 文件绝对路径
 */
function getIpaPath(ipaId) {
  return path.join(getDir('ipaCache'), `${ipaId}.ipa`);
}

/**
 * 删除缓存的 IPA（文件与元数据）
 * @param {string} ipaId IPA ID
 * @returns {Promise<void>}
 */
async function removeIpa(ipaId) {
  ipaRegistry.delete(ipaId);
  try {
    await fsp.unlink(getIpaPath(ipaId));
  } catch (err) {
    if (err.code !== 'ENOENT') {
      throw err;
    }
  }
}

/**
 * 检查磁盘剩余空间是否足够
 * @param {number} needBytes 需要的字节数
 * @returns {Promise<void>} 不足时抛出
 * @throws {Error} 剩余空间不足时抛出
 */
async function checkDiskSpace(needBytes) {
  try {
    const stats = await fsp.statfs(getDir('ipaCache'));
    const freeBytes = stats.bsize * stats.bavail;
    if (freeBytes < needBytes * 1.2) {
      throw new Error(`磁盘剩余空间不足（需要约 ${(needBytes / 1024 ** 3).toFixed(2)} GB）`);
    }
  } catch (err) {
    if (err.message.includes('磁盘剩余空间不足')) {
      throw err;
    }
    // statfs 不可用时跳过检查，不阻断上传
  }
}

module.exports = { router, findIpa, getIpaPath, removeIpa };
