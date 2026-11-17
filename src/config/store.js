'use strict';

const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');
const { getDir, ensureDirs } = require('./paths');

/** config.json 文件路径 */
function configFile() {
  return path.join(getDir(), 'config.json');
}

/** config.json 在内存中的缓存，结构为 { configs: [], activeId: null }，避免每次请求都读盘 */
let cache = null;

/**
 * 读取缓存对象（带懒加载），文件不存在时返回初始结构
 * @returns {Promise<{configs: Array<Object>, activeId: string|null}>}
 */
async function load() {
  if (cache) {
    return cache;
  }
  await ensureDirs();
  try {
    const raw = await fs.readFile(configFile(), 'utf8');
    const parsed = JSON.parse(raw);
    cache = {
      configs: Array.isArray(parsed.configs) ? parsed.configs : [],
      activeId: parsed.activeId || null,
    };
  } catch (err) {
    if (err.code !== 'ENOENT') {
      throw err;
    }
    cache = { configs: [], activeId: null };
  }
  return cache;
}

/**
 * 持久化缓存对象到 config.json
 * @returns {Promise<void>}
 */
async function save() {
  await ensureDirs();
  const body = JSON.stringify(cache, null, 2);
  await fs.writeFile(configFile(), body, 'utf8');
}

/**
 * 生成新配置 ID
 * @returns {string} 随机 ID
 */
function newId() {
  return crypto.randomUUID();
}

/**
 * 校验配置入参
 * @param {Object} body 请求体
 * @param {boolean} [requireP8=true] 是否必须提供 p8 内容
 * @returns {string|null} 错误信息，null 表示通过
 */
function validate(body, requireP8 = true) {
  if (!body || typeof body !== 'object') {
    return '请求体不能为空';
  }
  if (!body.name || typeof body.name !== 'string') {
    return '配置名称不能为空';
  }
  if (!body.issuerId || typeof body.issuerId !== 'string') {
    return 'Issuer ID 不能为空';
  }
  if (!body.keyId || typeof body.keyId !== 'string') {
    return 'Key ID 不能为空';
  }
  if (requireP8 && (!body.p8Content || typeof body.p8Content !== 'string')) {
    return 'p8 私钥内容不能为空';
  }
  return null;
}

/**
 * 将 p8 私钥内容写入 keys/ 目录
 * @param {string} p8Content p8 私钥 PEM 文本
 * @returns {Promise<string>} 落盘后的文件名
 */
async function writeP8(p8Content) {
  await ensureDirs();
  const fileName = `${crypto.randomUUID()}.p8`;
  await fs.writeFile(path.join(getDir('keys'), fileName), p8Content, 'utf8');
  return fileName;
}

/**
 * 删除 keys/ 目录下的 p8 文件（不存在则忽略）
 * @param {string} fileName p8 文件名
 * @returns {Promise<void>}
 */
async function removeP8(fileName) {
  if (!fileName) {
    return;
  }
  try {
    await fs.unlink(path.join(getDir('keys'), fileName));
  } catch (err) {
    if (err.code !== 'ENOENT') {
      throw err;
    }
  }
}

/**
 * 读取 p8 私钥内容
 * @param {string} fileName p8 文件名
 * @returns {Promise<string>} p8 私钥 PEM 文本
 */
async function readP8(fileName) {
  return fs.readFile(path.join(getDir('keys'), fileName), 'utf8');
}

/**
 * 新增一条配置
 * @param {Object} body {name, issuerId, keyId, p8Content}
 * @returns {Promise<Object>} 新建后的配置（不含 p8 内容）
 */
async function create(body) {
  const data = await load();
  const keyFile = await writeP8(body.p8Content);
  const item = {
    id: newId(),
    name: body.name,
    issuerId: body.issuerId,
    keyId: body.keyId,
    keyFile,
    createdAt: new Date().toISOString(),
  };
  data.configs.push(item);
  await save();
  return item;
}

/**
 * 更新配置（p8Content 可选，不传则保留旧密钥文件）
 * @param {string} id 配置 ID
 * @param {Object} body {name, issuerId, keyId, p8Content?}
 * @returns {Promise<Object|null>} 更新后的配置，未找到返回 null
 */
async function update(id, body) {
  const data = await load();
  const item = data.configs.find((c) => c.id === id);
  if (!item) {
    return null;
  }
  item.name = body.name || item.name;
  item.issuerId = body.issuerId || item.issuerId;
  item.keyId = body.keyId || item.keyId;
  if (body.p8Content) {
    const oldFile = item.keyFile;
    item.keyFile = await writeP8(body.p8Content);
    await removeP8(oldFile);
  }
  await save();
  return item;
}

/**
 * 删除配置及其 p8 文件
 * @param {string} id 配置 ID
 * @returns {Promise<boolean>} 是否删除成功（未找到返回 false）
 */
async function remove(id) {
  const data = await load();
  const index = data.configs.findIndex((c) => c.id === id);
  if (index < 0) {
    return false;
  }
  const [removed] = data.configs.splice(index, 1);
  if (data.activeId === id) {
    data.activeId = null;
  }
  await removeP8(removed.keyFile);
  await save();
  return true;
}

/**
 * 按 ID 查找配置
 * @param {string} id 配置 ID
 * @returns {Promise<Object|null>} 配置项（不含 p8 内容）
 */
async function findById(id) {
  const data = await load();
  return data.configs.find((c) => c.id === id) || null;
}

/**
 * 设置激活的配置（单选激活）
 * @param {string} id 配置 ID
 * @returns {Promise<boolean>} 是否设置成功
 */
async function setActive(id) {
  const data = await load();
  if (!data.configs.some((c) => c.id === id)) {
    return false;
  }
  data.activeId = id;
  await save();
  return true;
}

/**
 * 获取当前激活的配置 ID
 * @returns {Promise<string|null>} 激活配置 ID
 */
async function getActiveId() {
  const data = await load();
  return data.activeId;
}

/**
 * 获取脱敏后的配置列表（不含密钥内容）
 * @returns {Promise<{configs: Array<Object>, activeId: string|null}>}
 */
async function listSafe() {
  const data = await load();
  return {
    activeId: data.activeId,
    configs: data.configs.map((c) => ({
      id: c.id,
      name: c.name,
      issuerId: c.issuerId,
      keyId: c.keyId,
      createdAt: c.createdAt,
    })),
  };
}

/** settings.json 文件路径 */
function settingsFile() {
  return path.join(getDir(), 'settings.json');
}

/** settings.json 缓存 {proxyUrl} */
let settingsCache = null;

/**
 * 读取全局设置（代理等），文件不存在时返回默认值
 * @returns {Promise<{proxyUrl: string}>} 设置对象
 */
async function loadSettings() {
  if (settingsCache) {
    return settingsCache;
  }
  try {
    const raw = await fs.readFile(settingsFile(), 'utf8');
    const parsed = JSON.parse(raw);
    settingsCache = { proxyUrl: parsed.proxyUrl || '' };
  } catch (err) {
    if (err.code !== 'ENOENT') {
      throw err;
    }
    settingsCache = { proxyUrl: '' };
  }
  return settingsCache;
}

/**
 * 保存全局设置
 * @param {{proxyUrl?: string}} patch 设置补丁
 * @returns {Promise<{proxyUrl: string}>} 保存后的设置
 */
async function saveSettings(patch) {
  const current = await loadSettings();
  if (patch && typeof patch.proxyUrl === 'string') {
    current.proxyUrl = patch.proxyUrl.trim();
  }
  await ensureDirs();
  await fs.writeFile(settingsFile(), JSON.stringify(current, null, 2), 'utf8');
  return current;
}

module.exports = { create, update, remove, findById, setActive, getActiveId, listSafe, readP8, validate, loadSettings, saveSettings };
