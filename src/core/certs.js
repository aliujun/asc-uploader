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
 * 将本地私钥与 Apple 签发的 .cer 证书合成为 PKCS#12（.p12）
 * @param {string} keyId 私钥条目 ID
 * @param {string} cerPem .cer 证书 PEM（或 DER 的 Buffer 前已转 PEM）
 * @param {string} password p12 导出密码
 * @returns {Promise<Buffer>} .p12 二进制内容
 * @throws {Error} 证书无法解析或密码为空时抛出
 */
async function buildP12(keyId, cerPem, password) {
  if (!password || typeof password !== 'string') {
    throw new Error('p12 导出密码不能为空');
  }
  const cert = parseCer(cerPem);
  const privateKeyPem = await readPrivateKeyPem(keyId);
  const privateKey = forge.pki.privateKeyFromPem(privateKeyPem);
  const p12Asn1 = forge.pkcs12.toPkcs12Asn1(privateKey, [cert], password, {
    generateLocalKeyId: true,
    friendlyName: 'Apple Distribution',
  });
  const der = forge.asn1.toDer(p12Asn1).getBytes();
  return Buffer.from(der, 'binary');
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
 * 解析证书摘要信息（用于前端展示确认），并识别是否为开发证书
 * @param {string} cerContent 证书文本（PEM 或 DER 的 Base64）
 * @returns {{subject: string, issuer: string, validNotAfter: string, isDevelopmentCert: boolean}}
 * @throws {Error} 无法解析时抛出
 */
function describeCer(cerContent) {
  const cert = parseCer(cerContent);
  const cnAttr = cert.subject.attributes.find(
    (a) => a.name === 'commonName' || a.name === 'CN' || a.shortName === 'CN'
  );
  const cn = cnAttr ? String(cnAttr.value) : '';
  const isDevelopmentCert = /iPhone Developer|Apple Development/i.test(cn);
  return {
    subject: cert.subject.attributes.map((a) => `${a.name}=${a.value}`).join(', '),
    issuer: cert.issuer.attributes.map((a) => `${a.name}=${a.value}`).join(', '),
    validNotAfter: cert.validity.notAfter.toISOString(),
    isDevelopmentCert,
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

module.exports = { createKeyPairAndCsr, listKeys, buildP12, describeCer, removeKey };
