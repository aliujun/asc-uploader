'use strict';

const express = require('express');
const { createClient } = require('../../core/asc-client');

const router = express.Router();

/** App ID 支持的平台白名单（ASC 官方 BundleId platform 枚举） */
const SUPPORTED_PLATFORMS = new Set(['IOS', 'MAC_OS', 'SERVICES', 'UNIVERSAL']);

/** 能力查询的并发分批大小（App ID 较多时逐个查能力，分批避免触发 Apple 限流） */
const CAPABILITY_BATCH_SIZE = 8;

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
 * 校验显式 Bundle ID 格式：域名式至少两段、每段字母数字开头结尾可含中划线、不允许通配符
 * @param {string} identifier 待校验的 Bundle ID
 * @returns {string|null} 不通过时返回原因描述，通过返回 null
 */
function validateIdentifier(identifier) {
  if (identifier.includes('*')) {
    return '不支持通配符，本工具仅支持创建显式 App ID';
  }
  const segment = /^[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?$/;
  const parts = identifier.split('.');
  if (parts.length < 2) {
    return 'Bundle ID 需为域名式写法，至少两段，如 com.example.app';
  }
  if (!parts.every((p) => segment.test(p))) {
    return 'Bundle ID 仅允许字母、数字、点号与段内中划线，且每段以字母或数字开头结尾';
  }
  return null;
}

/**
 * 分批并发执行能力查询（保持结果与输入顺序一致）
 * @param {Array<Object>} items App ID 条目列表
 * @param {(item: Object) => Promise<Object>} fn 单条查询函数，失败时抛出
 * @returns {Promise<Map<string, Object>>} id → 查询结果（ok 或 error）
 */
async function fetchCapabilitiesInBatches(items, fn) {
  const resultMap = new Map();
  for (let i = 0; i < items.length; i += CAPABILITY_BATCH_SIZE) {
    const batch = items.slice(i, i + CAPABILITY_BATCH_SIZE);
    const settled = await Promise.allSettled(batch.map((item) => fn(item)));
    batch.forEach((item, index) => {
      const outcome = settled[index];
      resultMap.set(item.id, outcome.status === 'fulfilled' ? { ok: true, value: outcome.value } : { ok: false, error: outcome.reason });
    });
  }
  return resultMap;
}

/**
 * GET /api/identifiers?configId= App ID 列表（聚合全部分页，附带各 App ID 已启用的能力）
 * Apple 对部分账号/密钥禁用 bundleIdCapabilities 的列表读取（403，仅允许增删改），
 * 此时先探测第一个条目确认不可读后全局降级，不再逐个发注定失败的请求。
 * @returns {void}
 */
router.get('/', async (req, res) => {
  const { configId } = req.query;
  if (!configId) {
    sendError(res, 400, '缺少 configId 参数');
    return;
  }
  try {
    const client = createClient(configId);
    const data = await client.listBundleIds();
    const list = (data.data || []).map((item) => {
      const attributes = item.attributes || {};
      return {
        id: item.id,
        name: attributes.name || '',
        identifier: attributes.identifier || '',
        platform: attributes.platform || '',
        capabilities: [],
      };
    });
    let capabilitiesSupported = true;
    let capabilitiesError = '';
    if (list.length > 0) {
      const extractTypes = (capData) => (capData.data || [])
        .map((cap) => (cap.attributes || {}).capabilityType || '')
        .filter(Boolean);
      try {
        list[0].capabilities = extractTypes(await client.listBundleIdCapabilities(list[0].id));
      } catch (err) {
        capabilitiesSupported = false;
        capabilitiesError = err.message;
      }
    }
    if (capabilitiesSupported && list.length > 1) {
      const rest = list.slice(1);
      const capabilityMap = await fetchCapabilitiesInBatches(rest, async (item) => {
        const capData = await client.listBundleIdCapabilities(item.id);
        return extractTypes(capData);
      });
      rest.forEach((item) => {
        const outcome = capabilityMap.get(item.id);
        if (outcome && outcome.ok) {
          item.capabilities = outcome.value;
        }
      });
    }
    res.json({ identifiers: list, capabilitiesSupported, capabilitiesError });
  } catch (err) {
    sendError(res, 502, err.message);
  }
});

/**
 * POST /api/identifiers 创建 App ID 并启用勾选的能力
 * 请求体：{ configId, name, identifier, platform, capabilities: string[] }
 * @returns {void}
 */
router.post('/', async (req, res) => {
  const { configId, name, identifier, platform, capabilities } = req.body || {};
  const cleanName = (name || '').trim();
  const cleanIdentifier = (identifier || '').trim();
  if (!configId) {
    sendError(res, 400, '缺少 ASC 配置');
    return;
  }
  if (!cleanName) {
    sendError(res, 400, '名称不能为空');
    return;
  }
  if (!cleanIdentifier) {
    sendError(res, 400, 'Bundle ID 不能为空');
    return;
  }
  const identifierError = validateIdentifier(cleanIdentifier);
  if (identifierError) {
    sendError(res, 400, identifierError);
    return;
  }
  const cleanPlatform = platform || 'IOS';
  if (!SUPPORTED_PLATFORMS.has(cleanPlatform)) {
    sendError(res, 400, '平台仅支持 IOS / MAC_OS / SERVICES / UNIVERSAL');
    return;
  }
  const capabilityTypes = Array.isArray(capabilities) ? capabilities.filter(Boolean) : [];
  try {
    const created = await createClient(configId).createBundleId(cleanName, cleanIdentifier, cleanPlatform);
    const resource = created.data || {};
    const resourceId = resource.id || '';

    // App ID 已创建，逐个启用能力；单项失败不回滚（App ID 保留），收集结果反馈
    const client = createClient(configId);
    const results = [];
    for (const capabilityType of capabilityTypes) {
      // Sign in with Apple 必须携带 options，否则 Apple 拒绝；默认非主 App ID
      const options = capabilityType === 'APPLE_ID_AUTH' ? { isPrimaryAppId: false } : undefined;
      try {
        await client.enableCapability(resourceId, capabilityType, options);
        results.push({ capabilityType, ok: true });
      } catch (err) {
        results.push({ capabilityType, ok: false, error: err.message });
      }
    }
    const attributes = resource.attributes || {};
    res.json({
      identifier: {
        id: resourceId,
        name: attributes.name || cleanName,
        identifier: attributes.identifier || cleanIdentifier,
        platform: attributes.platform || cleanPlatform,
        capabilities: results.filter((r) => r.ok).map((r) => r.capabilityType),
      },
      results,
    });
  } catch (err) {
    sendError(res, 502, err.message);
  }
});

/**
 * PATCH /api/identifiers/:id 编辑 App ID：改名与能力增量同步
 * 请求体：{ configId, name?, add?: string[], remove?: string[] }
 * 名称变更走改名接口；add 逐项启用；remove 先查能力列表换取资源 ID 后逐项关闭。
 * @returns {void}
 */
router.patch('/:id', async (req, res) => {
  const { configId, name, add, remove } = req.body || {};
  const cleanName = (name || '').trim();
  const addTypes = Array.isArray(add) ? add.filter(Boolean) : [];
  const removeTypes = Array.isArray(remove) ? remove.filter(Boolean) : [];
  if (!configId) {
    sendError(res, 400, '缺少 ASC 配置');
    return;
  }
  if (!cleanName && addTypes.length === 0 && removeTypes.length === 0) {
    sendError(res, 400, '没有需要保存的修改');
    return;
  }
  try {
    const client = createClient(configId);
    const results = [];
    if (cleanName) {
      await client.updateBundleName(req.params.id, cleanName);
      results.push({ action: 'name', ok: true });
    }
    if (removeTypes.length > 0) {
      // 关闭能力需要能力资源 ID：拉取当前能力列表建立 type → 资源 ID 映射
      const capData = await client.listBundleIdCapabilities(req.params.id);
      const typeToResourceId = new Map((capData.data || []).map((cap) => [(cap.attributes || {}).capabilityType, cap.id]));
      for (const capabilityType of removeTypes) {
        const capResourceId = typeToResourceId.get(capabilityType);
        if (!capResourceId) {
          results.push({ action: 'remove', capabilityType, ok: true, note: '该能力未启用，无需关闭' });
          continue;
        }
        try {
          await client.disableCapability(capResourceId);
          results.push({ action: 'remove', capabilityType, ok: true });
        } catch (err) {
          results.push({ action: 'remove', capabilityType, ok: false, error: err.message });
        }
      }
    }
    for (const capabilityType of addTypes) {
      // Sign in with Apple 必须携带 options，否则 Apple 拒绝；默认非主 App ID
      const options = capabilityType === 'APPLE_ID_AUTH' ? { isPrimaryAppId: false } : undefined;
      try {
        await client.enableCapability(req.params.id, capabilityType, options);
        results.push({ action: 'add', capabilityType, ok: true });
      } catch (err) {
        results.push({ action: 'add', capabilityType, ok: false, error: err.message });
      }
    }
    res.json({ results });
  } catch (err) {
    sendError(res, 502, err.message);
  }
});

/**
 * GET /api/identifiers/:id/refs?configId= 查询 App ID 的引用情况：使用它的描述文件清单
 * @returns {void}
 */
router.get('/:id/refs', async (req, res) => {
  const { configId } = req.query;
  const { id } = req.params;
  if (!configId) {
    sendError(res, 400, '缺少 configId 参数');
    return;
  }
  try {
    // 走官方关系端点按 App ID 服务端过滤，替代拉全量 profiles 后本地匹配
    const data = await createClient(configId).listProfilesForBundleId(id);
    const refs = (data.data || [])
      .map((item) => {
        const attributes = item.attributes || {};
        return {
          name: attributes.name || '',
          profileType: attributes.profileType || '',
          expirationDate: attributes.expirationDate || '',
        };
      });
    res.json({ profiles: refs });
  } catch (err) {
    sendError(res, err.status || 500, err.message);
  }
});

/**
 * DELETE /api/identifiers/:id?configId= 删除 App ID（连带使关联描述文件失效，不可恢复）
 * @returns {void}
 */
router.delete('/:id', async (req, res) => {
  const { configId } = req.query;
  if (!configId) {
    sendError(res, 400, '缺少 configId 参数');
    return;
  }
  try {
    await createClient(configId).deleteBundleId(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    sendError(res, 502, err.message);
  }
});

module.exports = router;
