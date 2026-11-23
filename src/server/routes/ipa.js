'use strict';

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const { getDir, ensureDirs } = require('../../config/paths');
const { parseIpaInfo } = require('../../core/ipa-info');
const provision = require('../../core/provision');
const c = require('../../core/term');

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
  // end 事件处理完成（成功或已走 fail 流程）后置 true，供 close 判断是否为客户端中途断开
  let settled = false;

  const fail = async (status, message) => {
    aborted = true;
    settled = true;
    writeStream.destroy();
    sendError(res, status, message);
    // 主动断开客户端连接，停止接收后续数据（避免客户端继续推送撑爆缓冲）
    req.destroy();
    await fsp.unlink(targetPath).catch(() => {});
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
      // 预检：解析签名描述文件（失败返回 null，不影响上传主流程）
      const profile = await provision.parseEmbeddedProfile(targetPath);
      const meta = {
        ipaId,
        filename: fileName,
        sizeBytes,
        md5,
        bundleId: info.bundleId,
        shortVersion: info.shortVersion,
        buildVersion: info.buildVersion,
        platform: 'IOS',
        profile: profile || null,
        createdAt: new Date().toISOString(),
      };
      ipaRegistry.set(ipaId, meta);
      // 元数据落盘持久化，支持服务重启后历史失败/取消任务一键重试
      await fsp.writeFile(getMetaPath(ipaId), JSON.stringify(meta, null, 2), 'utf8').catch(() => {});
      settled = true;
      res.json(meta);
    } catch (err) {
      settled = true;
      fsp.unlink(targetPath).catch(() => {});
      sendError(res, 500, `IPA 处理失败：${err.message}`);
    }
  });

  // 'aborted' 事件已废弃：请求流关闭（含客户端中途断开）统一触发 'close'，
  // 已走完 end/fail 流程的忽略，仅客户端中途断开时清理半成品文件
  req.on('close', () => {
    if (aborted || settled) {
      return;
    }
    aborted = true;
    writeStream.destroy();
    fsp.unlink(targetPath).catch(() => {});
  });
});

/**
 * 构造缓存 IPA 的元数据 JSON 文件路径
 * @param {string} ipaId IPA ID
 * @returns {string} 文件绝对路径
 */
function getMetaPath(ipaId) {
  return path.join(getDir('ipaCache'), `${ipaId}.meta.json`);
}

/**
 * 启动时从磁盘加载未过期的 IPA 元数据到内存注册表
 * @returns {Promise<void>}
 */
async function initIpaRegistry() {
  const cacheDir = getDir('ipaCache');
  try {
    const files = await fsp.readdir(cacheDir);
    const metaFiles = files.filter((name) => name.toLowerCase().endsWith('.meta.json'));
    for (const name of metaFiles) {
      try {
        const raw = await fsp.readFile(path.join(cacheDir, name), 'utf8');
        const meta = JSON.parse(raw);
        if (!meta || !meta.ipaId) {
          continue;
        }
        const ipaExists = files.includes(`${meta.ipaId}.ipa`);
        if (ipaExists) {
          ipaRegistry.set(meta.ipaId, meta);
        }
      } catch {
        // 单个文件解析错误跳过
      }
    }
    if (ipaRegistry.size > 0) {
      console.log(`${c.gray('[IPA缓存]')} 已从本地恢复 ${ipaRegistry.size} 个历史 IPA 缓存记录`);
    }
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.error(`${c.gray('[IPA缓存]')} 恢复缓存记录失败：${err.message}`);
    }
  }
}

/**
 * 清扫磁盘上未被任何有效任务和注册表引用的孤儿 IPA 文件（服务启动时调用）
 * @returns {Promise<void>}
 */
async function sweepOrphanIpas() {
  const cacheDir = getDir('ipaCache');
  try {
    const files = await fsp.readdir(cacheDir);
    const ipaFiles = files.filter((name) => name.toLowerCase().endsWith('.ipa'));
    let swept = 0;
    for (const name of ipaFiles) {
      const ipaId = name.replace(/\.ipa$/i, '');
      if (ipaRegistry.has(ipaId)) {
        continue;
      }
      try {
        await fsp.unlink(path.join(cacheDir, name));
        await fsp.unlink(path.join(cacheDir, `${ipaId}.meta.json`)).catch(() => {});
        swept += 1;
      } catch {
        // 清理失败忽略
      }
    }
    if (swept > 0) {
      console.log(`${c.gray('[IPA缓存]')} 启动清扫：已删除 ${swept} 个无引用孤儿 IPA 缓存`);
    }
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.error(`${c.gray('[IPA缓存]')} 启动清扫失败：${err.message}`);
    }
  }
}

/**
 * 删除所有未被进行中任务引用的 IPA 缓存（registry 条目与磁盘文件）
 * @param {Set<string>} protectedIpaIds 需要保留的 IPA ID 集合（进行中任务引用的）
 * @returns {Promise<{removedRegistry: number, removedFiles: number}>} 清理数量
 */
async function clearUnusedIpaCache(protectedIpaIds) {
  let removedRegistry = 0;
  for (const [ipaId, meta] of ipaRegistry.entries()) {
    if (protectedIpaIds.has(ipaId)) {
      continue;
    }
    await removeIpa(ipaId);
    removedRegistry += 1;
    console.log(`${c.gray('[IPA缓存]')} 已清理 ${meta.filename || ipaId}`);
  }
  // registry 已删但磁盘遗留的孤儿文件（异常退出残留）一并清理
  let removedFiles = 0;
  const cacheDir = getDir('ipaCache');
  const files = await fsp.readdir(cacheDir).catch(() => []);
  for (const name of files) {
    const ipaId = name.replace(/\.ipa$/i, '');
    if (ipaRegistry.has(ipaId) || protectedIpaIds.has(ipaId)) {
      continue;
    }
    await fsp.unlink(path.join(cacheDir, name)).catch(() => {});
    removedFiles += 1;
  }
  return { removedRegistry, removedFiles };
}

/**
 * DELETE /api/ipa/cache 清理所有未被进行中任务引用的 IPA 缓存
 * @returns {void}
 */
router.delete('/cache', async (req, res) => {
  try {
    const result = await clearUnusedIpaCache(resolveProtectedIpaIds());
    res.json({ ok: true, ...result });
  } catch (err) {
    sendError(res, 500, `清理失败：${err.message}`);
  }
});

/**
 * 获取"清理保护名单"：由 task-manager 在装配时注入（避免 ipa.js 反向依赖 task-manager）
 * @type {() => Set<string>}
 */
let protectedIpaResolver = () => new Set();

/**
 * 注册清理保护名单回调（task-manager 启动时调用）
 * @param {() => Set<string>} resolver 返回进行中任务引用的 IPA ID 集合
 * @returns {void}
 */
function setProtectedIpaResolver(resolver) {
  protectedIpaResolver = resolver;
}

/**
 * 解析当前需要保护的 IPA ID 集合
 * @returns {Set<string>} 受保护的 IPA ID
 */
function resolveProtectedIpaIds() {
  try {
    const result = protectedIpaResolver();
    return result instanceof Set ? result : new Set();
  } catch {
    return new Set();
  }
}

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
 * 删除缓存的 IPA（文件、元数据文件与内存映射）
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
  try {
    await fsp.unlink(getMetaPath(ipaId));
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

module.exports = {
  router,
  findIpa,
  getIpaPath,
  getMetaPath,
  removeIpa,
  initIpaRegistry,
  sweepOrphanIpas,
  setProtectedIpaResolver,
};
