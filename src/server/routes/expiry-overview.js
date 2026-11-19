'use strict';

const express = require('express');
const { createClient } = require('../../core/asc-client');
const store = require('../../config/store');

const router = express.Router();

/** 临期阈值（天）：剩余天数 ≤ 该值时纳入总览 */
const EXPIRY_WINDOW_DAYS = 60;

/** 聚合请求的最大并发数（控制对 ASC API 的瞬时压力，避免触发限流） */
const MAX_CONCURRENCY = 2;

/**
 * 计算剩余有效天数
 * @param {string} expirationDate 到期时间（ISO 字符串）
 * @returns {number|null} 剩余天数（负数表示已过期），无效日期返回 null
 */
function daysLeft(expirationDate) {
  if (!expirationDate) {
    return null;
  }
  const diff = Math.ceil((new Date(expirationDate).getTime() - Date.now()) / 86400000);
  return Number.isFinite(diff) ? diff : null;
}

/**
 * 判断证书是否临期（剩余天数 ≤ 阈值）
 * @param {{expirationDate: string}} cert 证书属性
 * @returns {boolean} 是否临期
 */
function isCertExpiring(cert) {
  const left = daysLeft(cert.expirationDate);
  return left !== null && left <= EXPIRY_WINDOW_DAYS;
}

/**
 * 判断描述文件是否临期（剩余天数 ≤ 阈值或状态非生效中）
 * @param {{expirationDate: string, profileState: string}} profile 描述文件属性
 * @returns {boolean} 是否临期
 */
function isProfileExpiring(profile) {
  const left = daysLeft(profile.expirationDate);
  return (left !== null && left <= EXPIRY_WINDOW_DAYS) || (profile.profileState && profile.profileState !== 'ACTIVE');
}

/**
 * 拉取单个配置的临期证书与描述文件（ASC API 实时读取）
 * @param {{id: string, name: string}} config 配置项（listSafe 脱敏结构）
 * @returns {Promise<Object>} { configId, configName, certs, profiles } 或 { configId, configName, error }
 */
async function fetchConfigExpiry(config) {
  try {
    const client = createClient(config.id);
    const [certsData, profilesData] = await Promise.all([client.listCertificates(), client.listProfiles()]);
    const certs = (certsData.data || [])
      .map((item) => item.attributes || {})
      .filter(isCertExpiring)
      .map((attributes) => ({
        displayName: attributes.displayName || '',
        certificateType: attributes.certificateType || '',
        expirationDate: attributes.expirationDate || '',
      }));
    const profiles = (profilesData.data || [])
      .map((item) => item.attributes || {})
      .filter(isProfileExpiring)
      .map((attributes) => ({
        name: attributes.name || '',
        profileType: attributes.profileType || '',
        profileState: attributes.profileState || '',
        expirationDate: attributes.expirationDate || '',
      }));
    return { configId: config.id, configName: config.name, certs, profiles };
  } catch (err) {
    return { configId: config.id, configName: config.name, error: err.message };
  }
}

/**
 * 以固定并发数执行任务池
 * @template T
 * @param {Array<T>} items 任务入参列表
 * @param {number} limit 最大并发数
 * @param {(item: T) => Promise<Object>} worker 单任务执行函数
 * @returns {Promise<Array<Object>>} 全部执行结果（顺序与入参一致）
 */
async function runPool(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  async function runOne() {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await worker(items[index]);
    }
  }
  await Promise.all(items.slice(0, limit).map(() => runOne()));
  return results;
}

/**
 * GET /api/expiry-overview 聚合全部配置的临期证书与描述文件（每次实时读取 Apple，数据量已过滤）
 * @returns {void}
 */
router.get('/', async (req, res) => {
  try {
    const { configs } = await store.listSafe();
    const items = await runPool(configs, MAX_CONCURRENCY, fetchConfigExpiry);
    res.json({ items, windowDays: EXPIRY_WINDOW_DAYS });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

module.exports = router;
