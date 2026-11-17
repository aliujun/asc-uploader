'use strict';

const crypto = require('crypto');

/** JWT 有效期（秒），Apple 要求最长 20 分钟 */
const TOKEN_TTL_SECONDS = 19 * 60;

/** 剩余有效期低于该值时建议重新签发（秒） */
const RENEW_THRESHOLD_SECONDS = 60;

/**
 * Base64URL 编码
 * @param {Buffer|string} input 待编码内容
 * @returns {string} Base64URL 字符串
 */
function b64url(input) {
  return Buffer.from(input).toString('base64url');
}

/**
 * 将 DER 编码的 ECDSA 签名转换为 JWT 要求的 r||s 原始格式（各 32 字节）
 * @param {Buffer} derSig crypto.sign 输出的 DER 签名
 * @returns {Buffer} 64 字节的 r||s 签名
 * @throws {Error} DER 结构不符合预期时抛出
 */
function derToRaw(derSig) {
  if (derSig[0] !== 0x30) {
    throw new Error('ECDSA 签名格式错误：缺少 SEQUENCE 头');
  }
  let offset = 2;
  if (derSig[1] & 0x80) {
    offset += derSig[1] & 0x7f;
  }
  const readInteger = (start) => {
    if (derSig[start] !== 0x02) {
      throw new Error('ECDSA 签名格式错误：缺少 INTEGER 头');
    }
    const len = derSig[start + 1];
    const valueStart = start + 2;
    let value = derSig.subarray(valueStart, valueStart + len);
    // 去掉表示正数的前导 0x00（长度可能为 33 字节）
    if (value.length > 32 && value[0] === 0x00) {
      value = value.subarray(1);
    }
    // 统一右侧对齐取后 32 字节
    const result = Buffer.alloc(32);
    value.copy(result, 32 - value.length);
    return result;
  };
  const r = readInteger(offset);
  const s = readInteger(offset + 2 + derSig[offset + 1]);
  return Buffer.concat([r, s]);
}

/**
 * 生成 App Store Connect API 使用的 ES256 JWT
 * @param {Object} opts 签发参数
 * @param {string} opts.issuerId Issuer ID（UUID）
 * @param {string} opts.keyId Key ID（10 位）
 * @param {string} p8Content .p8 私钥 PEM 文本
 * @returns {{token: string, expiresAt: number}} token 与过期时间戳（毫秒）
 * @throws {Error} 私钥无效或签名失败时抛出
 */
function sign(opts, p8Content) {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'ES256', kid: opts.keyId, typ: 'JWT' };
  const payload = {
    iss: opts.issuerId,
    iat: now,
    exp: now + TOKEN_TTL_SECONDS,
    aud: 'appstoreconnect-v1',
  };
  const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
  try {
    const derSig = crypto.sign('sha256', Buffer.from(signingInput), {
      key: p8Content,
      dsaEncoding: 'der',
    });
    const rawSig = derToRaw(derSig);
    return {
      token: `${signingInput}.${rawSig.toString('base64url')}`,
      expiresAt: (now + TOKEN_TTL_SECONDS) * 1000,
    };
  } catch (err) {
    throw new Error(`JWT 签名失败，请检查 .p8 私钥是否有效：${err.message}`);
  }
}

/**
 * 判断 token 是否临近过期需要重签
 * @param {{expiresAt: number}|null} tokenInfo 已签发 token 信息
 * @returns {boolean} 是否需要重签
 */
function needsRenew(tokenInfo) {
  if (!tokenInfo || typeof tokenInfo.expiresAt !== 'number') {
    return true;
  }
  return tokenInfo.expiresAt - Date.now() < RENEW_THRESHOLD_SECONDS * 1000;
}

module.exports = { sign, needsRenew };
