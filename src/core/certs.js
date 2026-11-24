'use strict';

const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');
const forge = require('node-forge');
const { getDir, ensureDirs } = require('../config/paths');

/** 证书私钥索引文件路径 */
function keysIndexFile() {
  return path.join(getDir('certs'), 'keys.json');
}

/** 私钥条目内存缓存 */
let indexCache = null;

/**
 * 读取私钥条目索引（带缓存）
 * @returns {Promise<Array<Object>>} 条目列表
 */
async function loadIndex() {
  if (indexCache) {
    return indexCache;
  }
  await ensureDirs();
  try {
    const raw = await fs.readFile(keysIndexFile(), 'utf8');
    const parsed = JSON.parse(raw);
    indexCache = Array.isArray(parsed.keys) ? parsed.keys : [];
  } catch (err) {
    if (err.code !== 'ENOENT') {
      throw err;
    }
    indexCache = [];
  }
  return indexCache;
}

/**
 * 持久化私钥条目索引
 * @param {Array<Object>} keys 条目列表
 * @returns {Promise<void>}
 */
async function saveIndex(keys) {
  indexCache = keys;
  await ensureDirs();
  await fs.writeFile(keysIndexFile(), JSON.stringify({ keys }, null, 2), 'utf8');
}

/**
 * 生成 RSA 2048 密钥对与 CSR，私钥落盘 certs/ 目录
 * @param {string} commonName 通用名称（如邮箱）
 * @param {string} [remark] 所属项目备注（仅存本地索引，用于区分各私钥对应的项目）
 * @returns {Promise<{keyId: string, commonName: string, remark: string, csrPem: string, createdAt: string}>}
 * @throws {Error} commonName 为空或生成失败时抛出
 */
async function createKeyPairAndCsr(commonName, remark = '') {
  if (!commonName || typeof commonName !== 'string') {
    throw new Error('通用名称（Common Name）不能为空');
  }
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const csr = forge.pki.createCertificationRequest();
  csr.publicKey = keys.publicKey;
  csr.setSubject([{ name: 'commonName', value: commonName }]);
  csr.sign(keys.privateKey, forge.md.sha256.create());
  if (!csr.verify()) {
    throw new Error('CSR 自校验失败');
  }
  const privateKeyPem = forge.pki.privateKeyToPem(keys.privateKey);
  const csrPem = forge.pki.certificationRequestToPem(csr);
  const keyId = crypto.randomUUID();
  const createdAt = new Date().toISOString();
  await ensureDirs();
  await fs.writeFile(path.join(getDir('certs'), `${keyId}.key.pem`), privateKeyPem, 'utf8');
  const keysIndex = await loadIndex();
  keysIndex.push({ keyId, commonName, remark: String(remark || ''), createdAt });
  await saveIndex(keysIndex);
  return { keyId, commonName, remark, csrPem, createdAt };
}

/**
 * 判断两把 RSA 私钥是否为同一把（按模数与指数比对，跨 PKCS#1/PKCS#8/p12 提取等格式）
 * @param {forge.pki.rsa.KeyPair['privateKey']|null} a 私钥对象
 * @param {forge.pki.rsa.KeyPair['privateKey']|null} b 私钥对象
 * @returns {boolean} 是否相同
 */
function sameRsaKey(a, b) {
  if (!a || !b || !a.n || !a.e || !b.n || !b.e) {
    return false;
  }
  return a.n.compareTo(b.n) === 0 && a.e.compareTo(b.e) === 0;
}

/**
 * 在已存条目中查找与指定私钥相同的条目
 * @param {forge.pki.rsa.KeyPair['privateKey']} privateKey 待比对的私钥对象
 * @param {Array<Object>} keys 已存条目索引
 * @returns {Promise<Object|null>} 相同的条目，无则返回 null
 */
async function findDuplicateKey(privateKey, keys) {
  for (const entry of keys) {
    let storedPem;
    try {
      storedPem = await fs.readFile(path.join(getDir('certs'), `${entry.keyId}.key.pem`), 'utf8');
    } catch {
      continue;
    }
    let storedKey;
    try {
      storedKey = forge.pki.privateKeyFromPem(storedPem);
    } catch {
      continue;
    }
    if (sameRsaKey(privateKey, storedKey)) {
      return entry;
    }
  }
  return null;
}

/**
 * 导入外部生成的私钥（如之前在 Mac 钥匙串/openssl 生成的 .key/.pem），
 * 与本地生成的私钥统一管理
 * @param {string} privateKeyPem 私钥 PEM 文本（PKCS#1 或 PKCS#8）
 * @param {string} remark 所属项目备注（必填）
 * @param {string} [commonName] 通用名称，缺省自动生成
 * @returns {Promise<{keyId: string, commonName: string, remark: string, createdAt: string}>}
 * @throws {Error} 备注为空、私钥无法解析、不支持的私钥格式，或本地已存在同一把私钥时抛出
 */
async function importPrivateKey(privateKeyPem, remark, commonName = '') {
  if (!remark || typeof remark !== 'string') {
    throw new Error('所属项目（备注）不能为空');
  }
  if (!privateKeyPem || typeof privateKeyPem !== 'string') {
    throw new Error('私钥内容不能为空');
  }
  let privateKey;
  try {
    privateKey = forge.pki.privateKeyFromPem(privateKeyPem);
  } catch {
    throw new Error('私钥无法解析：请确认选择的是私钥文件（以 -----BEGIN PRIVATE KEY----- 或 -----BEGIN RSA PRIVATE KEY----- 开头）。加密的私钥暂不支持导入');
  }
  const duplicate = await findDuplicateKey(privateKey, await loadIndex());
  if (duplicate) {
    const addedAt = new Date(duplicate.createdAt).toLocaleString('zh-CN');
    throw new Error(`本地已存在同一把私钥：「${duplicate.remark || duplicate.commonName}」（${duplicate.commonName}，添加于 ${addedAt}），无法重复导入`);
  }
  const keyId = crypto.randomUUID();
  const entry = {
    keyId,
    commonName: commonName || `imported-${crypto.randomBytes(3).toString('hex')}`,
    remark,
    createdAt: new Date().toISOString(),
  };
  await ensureDirs();
  await fs.writeFile(path.join(getDir('certs'), `${keyId}.key.pem`), privateKeyPem, 'utf8');
  const keysIndex = await loadIndex();
  keysIndex.push(entry);
  await saveIndex(keysIndex);
  return entry;
}

/**
 * 从 .p12 文件中提取私钥并导入（p12 是"私钥+证书"的加密容器，如蛋壳/Mac 钥匙串导出的）
 * @param {string} p12Base64 p12 文件内容的 Base64
 * @param {string} p12Password 该 p12 的密码
 * @param {string} remark 所属项目备注（必填）
 * @returns {Promise<{keyId: string, commonName: string, remark: string, createdAt: string,
 *   cert: {subject: string, validNotAfter: string}|null}>} 导入结果（附 p12 内证书摘要）
 * @throws {Error} 备注为空、密码缺失、p12 解析失败或其中无私钥时抛出
 */
async function importP12(p12Base64, p12Password, remark) {
  if (!remark || typeof remark !== 'string') {
    throw new Error('所属项目（备注）不能为空');
  }
  if (!p12Password || typeof p12Password !== 'string') {
    throw new Error('请填写该 .p12 文件的密码');
  }
  let p12;
  try {
    const der = Buffer.from(p12Base64, 'base64').toString('binary');
    const asn1 = forge.asn1.fromDer(der);
    p12 = forge.pkcs12.pkcs12FromAsn1(asn1, false, p12Password);
  } catch {
    throw new Error('p12 解析失败：密码错误或文件不是有效的 .p12');
  }
  let privateKey = null;
  let cert = null;
  for (const safeContents of p12.safeContents) {
    for (const bag of safeContents.safeBags) {
      if (!privateKey && bag.key
        && (bag.type === forge.pki.oids.keyBag || bag.type === forge.pki.oids.pkcs8ShroudedKeyBag)) {
        privateKey = bag.key;
      }
      if (!cert && bag.cert && bag.type === forge.pki.oids.certBag) {
        cert = bag.cert;
      }
    }
  }
  if (!privateKey) {
    throw new Error('该 .p12 中未找到私钥（可能只包含证书）');
  }
  const entry = await importPrivateKey(forge.pki.privateKeyToPem(privateKey), remark);
  let certInfo = null;
  if (cert) {
    certInfo = {
      subject: cert.subject.attributes.map((a) => `${a.name}=${a.value}`).join(', '),
      validNotAfter: cert.validity.notAfter.toISOString(),
    };
  }
  return { ...entry, cert: certInfo };
}

/**
 * 列出私钥条目（不含私钥内容）
 * @returns {Promise<Array<Object>>} 条目列表
 */
async function listKeys() {
  return loadIndex();
}

/**
 * 读取指定条目的私钥 PEM
 * @param {string} keyId 条目 ID
 * @returns {Promise<string>} 私钥 PEM 文本
 * @throws {Error} 条目不存在或私钥文件丢失时抛出
 */
async function readPrivateKeyPem(keyId) {
  const keys = await loadIndex();
  const entry = keys.find((k) => k.keyId === keyId);
  if (!entry) {
    throw new Error('私钥条目不存在');
  }
  return fs.readFile(path.join(getDir('certs'), `${keyId}.key.pem`), 'utf8');
}

/**
 * 用已有本地私钥生成 CSR（供 ASC API 签发证书使用），不落盘、不修改索引
 * @param {string} keyId 私钥条目 ID
 * @param {string} [commonName] 通用名称，缺省依次回退条目记录值与自动生成值
 * @returns {Promise<{keyId: string, commonName: string, csrPem: string}>}
 * @throws {Error} 条目不存在、私钥无法解析或 CSR 自校验失败时抛出
 */
async function createCsrFromExistingKey(keyId, commonName = '') {
  const keys = await loadIndex();
  const entry = keys.find((k) => k.keyId === keyId);
  if (!entry) {
    throw new Error('私钥条目不存在');
  }
  const privateKeyPem = await readPrivateKeyPem(keyId);
  const privateKey = forge.pki.privateKeyFromPem(privateKeyPem);
  const cn = (commonName && String(commonName).trim())
    || entry.commonName
    || `asc-csr-${keyId.slice(0, 8)}`;
  const publicKey = forge.pki.setRsaPublicKey(privateKey.n, privateKey.e);
  const csr = forge.pki.createCertificationRequest();
  csr.publicKey = publicKey;
  csr.setSubject([{ name: 'commonName', value: cn }]);
  csr.sign(privateKey, forge.md.sha256.create());
  if (!csr.verify()) {
    throw new Error('CSR 自校验失败');
  }
  return { keyId, commonName: cn, csrPem: forge.pki.certificationRequestToPem(csr) };
}

/**
 * 将本地私钥与 Apple 签发的 .cer 证书合成为 PKCS#12（.p12）
 * 合成前校验私钥与证书公钥配对，不配对直接抛错（避免产出无效 p12）
 * @param {string} keyId 私钥条目 ID
 * @param {string} cerPem .cer 证书 PEM（或 DER 的 Base64）
 * @param {string} password p12 导出密码
 * @returns {Promise<Buffer>} .p12 二进制内容
 * @throws {Error} 密码为空、证书无法解析或私钥与证书不配对时抛出
 */
async function buildP12(keyId, cerPem, password) {
  if (!password || typeof password !== 'string') {
    throw new Error('p12 导出密码不能为空');
  }
  const cert = parseCer(cerPem);
  const privateKeyPem = await readPrivateKeyPem(keyId);
  const privateKey = forge.pki.privateKeyFromPem(privateKeyPem);
  if (!isKeyPairMatched(privateKey, cert)) {
    throw new Error('私钥与证书不匹配：该 .cer 不是用此私钥对应的 CSR 签发的。'
      + '请确认第 2 步上传到 Apple 后台的 CSR 来自当前选择的私钥（第 1 步生成并下载的那份）；'
      + '若 .cer 是之前用其它方式申请的，请改用匹配的私钥，或用本工具的 CSR 重新向 Apple 申请证书');
  }
  const p12Asn1 = forge.pkcs12.toPkcs12Asn1(privateKey, [cert], password, {
    generateLocalKeyId: true,
    friendlyName: 'Apple Distribution',
    // 使用传统 PBE-SHA1-3DES 格式（与 macOS 钥匙串、openssl 1.x 导出一致）。
    // HBuilderX 云打包的解析器较旧：拒绝 openssl v3 式现代格式（PBES2/AES/SHA256），
    // 接受传统格式（参考 DCloud 官方问答 ask.dcloud.net.cn/question/221332）
    algorithm: '3des',
  });
  const der = forge.asn1.toDer(p12Asn1).getBytes();
  return Buffer.from(der, 'binary');
}

/**
 * 校验 RSA 私钥与证书公钥是否为同一密钥对（比较模数 n 与指数 e）
 * @param {forge.pki.rsa.PrivateKey} privateKey 私钥
 * @param {forge.pki.Certificate} cert 证书
 * @returns {boolean} 配对返回 true；证书非 RSA 公钥时返回 false（无法确认即视为不配对）
 */
function isKeyPairMatched(privateKey, cert) {
  const publicKey = cert.publicKey;
  if (!publicKey || !publicKey.n || !publicKey.e || !privateKey.n || !privateKey.e) {
    return false;
  }
  return publicKey.n.compareTo(privateKey.n) === 0
    && publicKey.e.compareTo(privateKey.e) === 0;
}

/**
 * 解析 .cer 证书内容，兼容 PEM 与 DER（Base64 裸证书）两种输入
 * @param {string} cerContent 证书文本
 * @returns {forge.pki.Certificate} forge 证书对象
 * @throws {Error} 无法解析时抛出
 */
function parseCer(cerContent) {
  if (!cerContent || typeof cerContent !== 'string') {
    throw new Error('证书内容不能为空');
  }
  if (cerContent.includes('-----BEGIN CERTIFICATE-----')) {
    return forge.pki.certificateFromPem(cerContent);
  }
  const der = Buffer.from(cerContent, 'base64').toString('binary');
  const asn1 = forge.asn1.fromDer(der);
  return forge.pki.certificateFromAsn1(asn1);
}

/**
 * 解析证书摘要信息（用于前端展示确认），并识别证书用途类型
 * @param {string} cerContent 证书文本（PEM 或 DER 的 Base64）
 * @returns {{subject: string, issuer: string, validNotAfter: string,
 *   isDevelopmentCert: boolean, certType: 'development'|'distribution'|'unknown'}}
 * @throws {Error} 无法解析时抛出
 */
function describeCer(cerContent) {
  const cert = parseCer(cerContent);
  const cnAttr = cert.subject.attributes.find(
    (a) => a.name === 'commonName' || a.name === 'CN' || a.shortName === 'CN'
  );
  const cn = cnAttr ? String(cnAttr.value) : '';
  const isDevelopmentCert = /iPhone Developer|Apple Development/i.test(cn);
  const isDistributionCert = /Distribution/i.test(cn);
  const certType = isDevelopmentCert ? 'development' : (isDistributionCert ? 'distribution' : 'unknown');
  return {
    subject: cert.subject.attributes.map((a) => `${a.name}=${a.value}`).join(', '),
    issuer: cert.issuer.attributes.map((a) => `${a.name}=${a.value}`).join(', '),
    validNotAfter: cert.validity.notAfter.toISOString(),
    isDevelopmentCert,
    certType,
  };
}

/**
 * 删除私钥条目及其落盘文件
 * @param {string} keyId 条目 ID
 * @returns {Promise<boolean>} 是否删除成功
 */
async function removeKey(keyId) {
  const keys = await loadIndex();
  const index = keys.findIndex((k) => k.keyId === keyId);
  if (index < 0) {
    return false;
  }
  keys.splice(index, 1);
  await saveIndex(keys);
  try {
    await fs.unlink(path.join(getDir('certs'), `${keyId}.key.pem`));
  } catch (err) {
    if (err.code !== 'ENOENT') {
      throw err;
    }
  }
  return true;
}

/**
 * 在本地私钥列表中查找与证书公钥配对的私钥（按模数与指数比对，即签发该证书时用的那把）
 * @param {string} cerContent 证书内容（PEM 或 DER Base64，ASC 的 certificateContent）
 * @param {Array<{keyId: string}>} keys 私钥条目列表
 * @returns {Promise<string|null>} 配对私钥的 keyId；证书无法解析或无配对私钥时返回 null
 */
async function matchKeyForCertificate(cerContent, keys) {
  let cert;
  try {
    cert = parseCer(cerContent);
  } catch {
    return null;
  }
  for (const entry of keys) {
    try {
      const privateKeyPem = await readPrivateKeyPem(entry.keyId);
      const privateKey = forge.pki.privateKeyFromPem(privateKeyPem);
      if (isKeyPairMatched(privateKey, cert)) {
        return entry.keyId;
      }
    } catch {
      // 单个私钥解析失败（文件损坏等）时跳过，继续匹配其它私钥
    }
  }
  return null;
}

/**
 * 判断私钥与证书是否配对（按模数与指数比对，即该证书是否由这把私钥签发）
 * @param {string} privateKeyPem 私钥 PEM 文本
 * @param {string} cerContent 证书内容（PEM 或 DER Base64）
 * @returns {boolean} 配对返回 true；任一方解析失败返回 false
 */
function isKeyMatched(privateKeyPem, cerContent) {
  let privateKey;
  let cert;
  try {
    privateKey = forge.pki.privateKeyFromPem(privateKeyPem);
    cert = parseCer(cerContent);
  } catch {
    return false;
  }
  return isKeyPairMatched(privateKey, cert);
}

module.exports = {
  createKeyPairAndCsr,
  createCsrFromExistingKey,
  importPrivateKey,
  importP12,
  listKeys,
  buildP12,
  matchKeyForCertificate,
  isKeyMatched,
  readPrivateKeyPem,
  describeCer,
  removeKey,
};
