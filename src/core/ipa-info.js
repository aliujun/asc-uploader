'use strict';

const yauzl = require('yauzl');
const bplist = require('bplist-parser');

/**
 * 从 IPA 中解析 Info.plist 关键信息（bundleId 与版本号）。
 * 只读取 zip 中的单个条目，不整包解压。
 * @param {string} ipaPath IPA 文件绝对路径
 * @returns {Promise<{bundleId: string|null, shortVersion: string|null, buildVersion: string|null}>}
 * @throws {Error} 文件无法打开或不是有效 zip 时抛出
 */
async function parseIpaInfo(ipaPath) {
  const zipfile = await openZip(ipaPath);
  try {
    const entry = await findInfoPlistEntry(zipfile);
    if (!entry) {
      return { bundleId: null, shortVersion: null, buildVersion: null };
    }
    const buffer = await readEntry(zipfile, entry);
    return extractInfo(buffer);
  } finally {
    closeZip(zipfile);
  }
}

/**
 * 打开 zip 文件（Promise 包装）
 * @param {string} ipaPath IPA 路径
 * @returns {Promise<yauzl.ZipFile>} yauzl zip 对象
 * @throws {Error} 打开失败时抛出
 */
function openZip(ipaPath) {
  return new Promise((resolve, reject) => {
    yauzl.open(ipaPath, { lazyEntries: true, autoClose: false }, (err, zipfile) => {
      if (err) {
        reject(new Error(`无法打开 IPA 文件：${err.message}`));
        return;
      }
      resolve(zipfile);
    });
  });
}

/**
 * 关闭 zip 文件（忽略关闭错误）
 * @param {yauzl.ZipFile} zipfile yauzl zip 对象
 * @returns {void}
 */
function closeZip(zipfile) {
  try {
    zipfile.close();
  } catch {
    // 关闭失败可忽略
  }
}

/**
 * 遍历 zip 条目，定位 Payload/*.app/Info.plist
 * @param {yauzl.ZipFile} zipfile yauzl zip 对象
 * @returns {Promise<yauzl.Entry|null>} 匹配的条目，未找到返回 null
 */
function findInfoPlistEntry(zipfile) {
  return new Promise((resolve, reject) => {
    const entries = [];
    zipfile.on('entry', (entry) => {
      entries.push(entry);
      // lazyEntries 模式下必须主动继续读取下一条目
      zipfile.readEntry();
    });
    zipfile.on('end', () => {
      const matched = entries.find(
        (e) => !e.fileName.endsWith('/') && /^Payload\/[^/]+\.app\/Info\.plist$/.test(e.fileName)
      );
      resolve(matched || null);
    });
    zipfile.on('error', (err) => reject(err));
    zipfile.readEntry();
  });
}

/**
 * 读取 zip 条目内容为 Buffer（Promise 包装）
 * @param {yauzl.ZipFile} zipfile yauzl zip 对象
 * @param {yauzl.Entry} entry zip 条目
 * @returns {Promise<Buffer>} 条目内容
 * @throws {Error} 读取失败时抛出
 */
function readEntry(zipfile, entry) {
  return new Promise((resolve, reject) => {
    zipfile.openReadStream(entry, (err, stream) => {
      if (err) {
        reject(err);
        return;
      }
      const chunks = [];
      stream.on('data', (chunk) => chunks.push(chunk));
      stream.on('end', () => resolve(Buffer.concat(chunks)));
      stream.on('error', (err2) => reject(err2));
    });
  });
}

/**
 * 从 Info.plist 内容提取 bundleId 与版本号，兼容 binary 与 XML 两种格式
 * @param {Buffer} buffer plist 文件内容
 * @returns {{bundleId: string|null, shortVersion: string|null, buildVersion: string|null}}
 */
function extractInfo(buffer) {
  const isBinary = buffer.length > 6 && buffer.subarray(0, 6).toString('ascii') === 'bplist';
  if (isBinary) {
    return extractFromBinary(buffer);
  }
  return extractFromXml(buffer.toString('utf8'));
}

/**
 * 解析 binary plist
 * @param {Buffer} buffer plist 内容
 * @returns {{bundleId: string|null, shortVersion: string|null, buildVersion: string|null}}
 */
function extractFromBinary(buffer) {
  try {
    const [parsed] = bplist.parseBuffer(buffer);
    return {
      bundleId: parsed.CFBundleIdentifier || null,
      shortVersion: parsed.CFBundleShortVersionString || null,
      buildVersion: parsed.CFBundleVersion || null,
    };
  } catch {
    return { bundleId: null, shortVersion: null, buildVersion: null };
  }
}

/**
 * 解析 XML plist（结构固定，用正则提取）
 * @param {string} xml plist 文本
 * @returns {{bundleId: string|null, shortVersion: string|null, buildVersion: string|null}}
 */
function extractFromXml(xml) {
  const pick = (key) => {
    const pattern = new RegExp(`<key>${key}</key>\\s*<string>([^<]*)</string>`);
    const matched = xml.match(pattern);
    return matched ? matched[1] : null;
  };
  return {
    bundleId: pick('CFBundleIdentifier'),
    shortVersion: pick('CFBundleShortVersionString'),
    buildVersion: pick('CFBundleVersion'),
  };
}

module.exports = { parseIpaInfo };
