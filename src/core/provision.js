'use strict';

const forge = require('node-forge');
const bplist = require('bplist-parser');
const { openZip, readEntry, closeZip } = require('./ipa-info');

/** 描述文件类型 → 展示文案（与生成描述文件弹窗下拉一致） */
const TYPE_LABELS = {
  IOS_APP_DEVELOPMENT: '开发',
  IOS_APP_ADHOC: 'Ad Hoc',
  IOS_APP_STORE: 'App Store',
};

/**
 * 解析 IPA 内的 embedded.mobileprovision（签名描述文件）。
 * 只读取 zip 中的单个条目；任何一步失败都返回 null（预检降级为跳过，不阻塞上传）。
 * @param {string} ipaPath IPA 文件绝对路径
 * @returns {Promise<{name: string, uuid: string, expirationDate: string, teamId: string, bundleId: string, type: string, typeLabel: string}|null>}
 *          解析结果；无描述文件条目或解析失败时返回 null
 */
async function parseEmbeddedProfile(ipaPath) {
  let zipfile = null;
  try {
    zipfile = await openZip(ipaPath);
    const entry = await findProfileEntry(zipfile);
    if (!entry) {
      return null;
    }
    const cmsBuffer = await readEntry(zipfile, entry);
    const plistBuffer = extractPlistBuffer(cmsBuffer);
    return extractProfileInfo(plistBuffer);
  } catch {
    // 描述文件缺失、格式异常等一律按"无法预检"处理
    return null;
  } finally {
    if (zipfile) {
      closeZip(zipfile);
    }
  }
}

/**
 * 遍历 zip 条目，定位 Payload/*.app/embedded.mobileprovision
 * @param {import('yauzl').ZipFile} zipfile yauzl zip 对象
 * @returns {Promise<import('yauzl').Entry|null>} 匹配的条目，未找到返回 null
 */
function findProfileEntry(zipfile) {
  return new Promise((resolve, reject) => {
    const entries = [];
    zipfile.on('entry', (entry) => {
      entries.push(entry);
      // lazyEntries 模式下必须主动继续读取下一条目
      zipfile.readEntry();
    });
    zipfile.on('end', () => {
      const matched = entries.find(
        (e) => !e.fileName.endsWith('/') && /^Payload\/[^/]+\.app\/embedded\.mobileprovision$/.test(e.fileName)
      );
      resolve(matched || null);
    });
    zipfile.on('error', (err) => reject(err));
    zipfile.readEntry();
  });
}

/**
 * 从 CMS/PKCS#7 签名外壳中提取内嵌的 plist 字节。
 * 优先用 node-forge 深搜第一个 primitive OCTET STRING（即 encapContentInfo 内容，
 * 它在证书与签名者信息之前出现）；失败时回退 XML 文本定位。
 * @param {Buffer} cmsBuffer 描述文件原始内容（CMS DER）
 * @returns {Buffer} plist 字节
 * @throws {Error} 两种方式都提取失败时抛出
 */
function extractPlistBuffer(cmsBuffer) {
  try {
    const asn1 = forge.asn1.fromDer(cmsBuffer.toString('binary'));
    const octet = findFirstPrimitiveOctet(asn1);
    if (octet && octet.value && octet.value.length > 0) {
      return Buffer.from(octet.value, 'binary');
    }
  } catch {
    // 结构化解析失败走文本定位
  }
  const text = cmsBuffer.toString('utf8');
  const start = text.indexOf('<?xml');
  const endTag = '</plist>';
  const end = text.lastIndexOf(endTag);
  if (start >= 0 && end > start) {
    return Buffer.from(text.slice(start, end + endTag.length), 'utf8');
  }
  throw new Error('无法从描述文件中提取 plist 内容');
}

/**
 * 深度优先搜索 ASN1 树中第一个 primitive 的 OCTET STRING 节点
 * @param {Object} node node-forge ASN1 节点
 * @returns {Object|null} OCTET STRING 节点，未找到返回 null
 */
function findFirstPrimitiveOctet(node) {
  if (!node || typeof node !== 'object') {
    return null;
  }
  if (node.tagClass === forge.asn1.Class.UNIVERSAL
    && node.type === forge.asn1.Type.OCTETSTRING
    && node.constructed === false) {
    return node;
  }
  if (!Array.isArray(node.value)) {
    return null;
  }
  for (const child of node.value) {
    const found = findFirstPrimitiveOctet(child);
    if (found) {
      return found;
    }
  }
  return null;
}

/**
 * 解析 plist 字节为描述文件结构化信息，兼容 binary 与 XML 两种格式
 * @param {Buffer} plistBuffer plist 字节
 * @returns {{name: string, uuid: string, expirationDate: string, teamId: string, bundleId: string, type: string, typeLabel: string}}
 * @throws {Error} plist 无法解析时抛出
 */
function extractProfileInfo(plistBuffer) {
  const isBinary = plistBuffer.length > 6 && plistBuffer.subarray(0, 6).toString('ascii') === 'bplist';
  const profile = isBinary ? parseBinaryPlist(plistBuffer) : parseXmlPlist(plistBuffer.toString('utf8'));
  const entitlements = profile.Entitlements || {};
  const appIdentifier = entitlements['application-identifier'] || '';
  const dotIndex = appIdentifier.indexOf('.');
  const teamId = dotIndex > 0 ? appIdentifier.slice(0, dotIndex) : '';
  const bundleId = dotIndex > 0 ? appIdentifier.slice(dotIndex + 1) : '';
  const type = detectProfileType(entitlements, profile);
  return {
    name: profile.Name || '',
    uuid: profile.UUID || '',
    expirationDate: normalizeDate(profile.ExpirationDate),
    teamId,
    bundleId,
    type,
    typeLabel: typeLabel(type),
  };
}

/**
 * 归一化到期时间：bplist-parser 会把 <date> 解析为 Date 对象，统一转 ISO 字符串
 * @param {Date|string|undefined} value plist 中的日期值
 * @returns {string} ISO 字符串，无效时返回空串
 */
function normalizeDate(value) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value.toISOString();
  }
  return typeof value === 'string' ? value : '';
}

/**
 * 解析 binary plist
 * @param {Buffer} buffer plist 字节
 * @returns {Object} plist 顶层字典
 * @throws {Error} 解析失败时抛出
 */
function parseBinaryPlist(buffer) {
  const [parsed] = bplist.parseBuffer(buffer);
  return parsed || {};
}

/**
 * 解析 XML plist（描述文件关键键名固定，用正则提取）
 * @param {string} xml plist 文本
 * @returns {Object} 扁平化的关键信息字典（与 binary 版所需键一致）
 */
function parseXmlPlist(xml) {
  const pickString = (key) => {
    const matched = xml.match(new RegExp(`<key>${key}</key>\\s*<string>([^<]*)</string>`));
    return matched ? matched[1] : '';
  };
  const dateMatched = xml.match(/<key>ExpirationDate<\/key>\s*<date>([^<]*)<\/date>/);
  return {
    Name: pickString('Name'),
    UUID: pickString('UUID'),
    ExpirationDate: dateMatched ? new Date(dateMatched[1]).toISOString() : '',
    Entitlements: {
      'application-identifier': pickString('application-identifier'),
      'get-task-allow': /<key>get-task-allow<\/key>\s*<true\/>/.test(xml),
    },
    ProvisionedDevices: /<key>ProvisionedDevices<\/key>/.test(xml) ? ['__present__'] : undefined,
  };
}

/**
 * 依据签名 entitlements 推断描述文件类型：
 * get-task-allow=true 为开发；带设备列表为 Ad Hoc；否则为 App Store（分发）
 * @param {Object} entitlements plist 的 Entitlements 字典
 * @param {Object} profile plist 顶层字典（读取 ProvisionedDevices）
 * @returns {string} 描述文件类型枚举
 */
function detectProfileType(entitlements, profile) {
  if (entitlements['get-task-allow'] === true) {
    return 'IOS_APP_DEVELOPMENT';
  }
  if (Array.isArray(profile.ProvisionedDevices) && profile.ProvisionedDevices.length > 0) {
    return 'IOS_APP_ADHOC';
  }
  return 'IOS_APP_STORE';
}

/**
 * 计算描述文件类型的展示文案
 * @param {string} type 描述文件类型枚举
 * @returns {string} 中文文案
 */
function typeLabel(type) {
  return TYPE_LABELS[type] || type || '未知类型';
}

module.exports = { parseEmbeddedProfile, typeLabel };
