'use strict';

const store = require('../config/store');
const jwt = require('./jwt');
const c = require('./term');

/** App Store Connect API 基础地址（官方文档：https://api.appstoreconnect.apple.com） */
const API_BASE = 'https://api.appstoreconnect.apple.com';

/** 视为瞬时故障、可自动重试的 HTTP 状态码（Apple 服务端偶发 5xx） */
const RETRYABLE_STATUS = new Set([500, 502, 503, 504]);

/** GET 请求对瞬时故障（5xx/网络抖动）的最大自动重试次数，退避 1s/2s/4s */
const MAX_TRANSIENT_RETRY = 3;

/** @type {{agent: Object, proxyUrl: string}|null} 代理 Agent 缓存 */
let proxyAgentCache = null;

/**
 * 解析当前生效的代理地址（settings.json 优先，其次环境变量）
 * @returns {Promise<string>} 代理地址，空字符串表示直连
 */
async function resolveActiveProxyUrl() {
  const settings = await store.loadSettings();
  return settings.proxyUrl
    || process.env.HTTPS_PROXY
    || process.env.https_proxy
    || '';
}

/**
 * 获取代理 Agent（按 settings.json 的 proxyUrl），配置变化时重建
 * @returns {Promise<Object|null>} undici ProxyAgent 或 null（直连）
 */
async function getProxyAgent() {
  const proxyUrl = await resolveActiveProxyUrl();
  if (!proxyUrl) {
    proxyAgentCache = null;
    return null;
  }
  if (proxyAgentCache && proxyAgentCache.proxyUrl === proxyUrl) {
    return proxyAgentCache.agent;
  }
  const { ProxyAgent } = require('undici');
  const agent = new ProxyAgent(proxyUrl);
  proxyAgentCache = { agent, proxyUrl };
  return agent;
}

/**
 * 统一的 HTTP 请求入口：直连时用全局 fetch，配置代理时走 undici ProxyAgent
 * @param {string} url 目标地址
 * @param {Object} options fetch 配置
 * @returns {Promise<Response>} 响应对象
 */
async function doFetch(url, options = {}) {
  const agent = await getProxyAgent();
  const fetchFn = agent ? require('undici').fetch : globalThis.fetch;
  const finalOptions = agent ? { ...options, dispatcher: agent } : options;
  return fetchFn(url, finalOptions);
}

/**
 * 面向单个 ASC 配置的 API 客户端。
 * 内部维护 JWT 的签发与自动续签，以及 429 限流退避。
 */
class AscClient {
  /**
   * @param {string} configId 配置 ID（对应 config.json 中的一条）
   * @param {AbortSignal} [signal] 可选中断信号，触发时中断进行中的请求
   */
  constructor(configId, signal) {
    this.configId = configId;
    /** @type {AbortSignal|null} 中断信号 */
    this.signal = signal || null;
    /** @type {{token: string, expiresAt: number}|null} 当前 token 信息 */
    this.tokenInfo = null;
  }

  /**
   * 签发或续签 JWT（剩余有效期不足时重新签名）
   * @returns {Promise<string>} JWT 字符串
   * @throws {Error} 配置不存在或私钥无效时抛出
   */
  async getToken() {
    if (!jwt.needsRenew(this.tokenInfo)) {
      return this.tokenInfo.token;
    }
    const config = await store.findById(this.configId);
    if (!config) {
      throw new Error('配置不存在，可能已被删除');
    }
    const p8Content = await store.readP8(config.keyFile);
    this.tokenInfo = jwt.sign({ issuerId: config.issuerId, keyId: config.keyId }, p8Content);
    console.log(`${c.cyan('[ASC]')} JWT 已签发：配置「${config.name}」，keyId=${c.gray(config.keyId)}`);
    return this.tokenInfo.token;
  }

  /**
   * 强制重签 JWT（收到 401 时使用）
   * @returns {Promise<string>} 新 JWT
   */
  async forceRenewToken() {
    this.tokenInfo = null;
    return this.getToken();
  }

  /**
   * 发送 ASC API 请求，自动携带 JWT、处理 401 重签与 429 退避
   * @param {string} method HTTP 方法
   * @param {string} path 接口路径（如 /v1/apps）
   * @param {Object} [opts] 可选项
   * @param {Object} [opts.body] JSON 请求体
   * @param {number} [opts.maxRetry=2] 401/429 的最大重试次数
   * @returns {Promise<Object>} 响应 JSON（204 时返回 null）
   * @throws {Error} Apple 返回错误或网络失败时抛出（message 携带 Apple 错误详情）
   */
  async request(method, path, opts = {}) {
    const maxRetry = opts.maxRetry ?? 2;
    let retried = 0;
    /** 5xx/网络错误重试计数（仅幂等的 GET 请求自动重试，避免 POST/PATCH 重复执行副作用） */
    let retriedTransient = 0;
    for (;;) {
      const token = await this.getToken();
      const headers = { Authorization: `Bearer ${token}` };
      let body;
      if (opts.body !== undefined) {
        headers['Content-Type'] = 'application/json';
        body = JSON.stringify(opts.body);
      }
      console.log(`${c.cyan('[ASC]')} ${c.gray(`${method} ${path}`)}${body ? c.gray(` 请求体：${body.slice(0, 500)}`) : ''}`);
      const startedAt = Date.now();
      let response;
      try {
        response = await doFetch(`${API_BASE}${path}`, { method, headers, body, signal: opts.signal || this.signal });
      } catch (err) {
        if (err && (err.name === 'AbortError' || err.code === 'ABORT_ERR')) {
          const abortErr = new Error('任务已中断');
          abortErr.isAbort = true;
          throw abortErr;
        }
        // GET 请求遇网络抖动（代理不稳定/ECONNRESET 等）自动退避重试
        if (method === 'GET' && retriedTransient < MAX_TRANSIENT_RETRY) {
          retriedTransient += 1;
          const backoffMs = 1000 * 2 ** (retriedTransient - 1);
          console.warn(`${c.cyan('[ASC]')} ${c.yellow(`${method} ${path} 网络失败：${err.message}，${backoffMs / 1000}s 后重试（第 ${retriedTransient} 次）`)}`);
          await sleep(backoffMs);
          continue;
        }
        console.error(`${c.cyan('[ASC]')} ${c.red(`${method} ${path} 网络失败：${err.message}`)}`);
        throw new Error(`网络请求失败：${err.message}（若在国内网络环境，请在“配置管理”页设置代理）`);
      }
      const cost = Date.now() - startedAt;
      if (response.status === 401 && retried < maxRetry) {
        retried += 1;
        console.warn(`${c.cyan('[ASC]')} ${c.yellow(`${method} ${path} -> 401 鉴权过期，重签 JWT 后重试（${cost}ms，第 ${retried} 次）`)}`);
        await this.forceRenewToken();
        continue;
      }
      if (response.status === 429 && retried < maxRetry) {
        retried += 1;
        const retryAfter = Number(response.headers.get('retry-after')) || 5;
        console.warn(`${c.cyan('[ASC]')} ${c.yellow(`${method} ${path} -> 429 限流，${retryAfter}s 后重试（${cost}ms，第 ${retried} 次）`)}`);
        await sleep(retryAfter * 1000);
        continue;
      }
      // Apple 服务端偶发 5xx（UNEXPECTED_ERROR 等），GET 请求自动退避重试
      if (method === 'GET' && RETRYABLE_STATUS.has(response.status) && retriedTransient < MAX_TRANSIENT_RETRY) {
        retriedTransient += 1;
        const backoffMs = 1000 * 2 ** (retriedTransient - 1);
        console.warn(`${c.cyan('[ASC]')} ${c.yellow(`${method} ${path} -> HTTP ${response.status} 服务端错误（${cost}ms），${backoffMs / 1000}s 后重试（第 ${retriedTransient} 次）`)}`);
        await sleep(backoffMs);
        continue;
      }
      if (response.status === 204) {
        console.log(`${c.cyan('[ASC]')} ${c.gray(`${method} ${path}`)} ${c.green(`-> 204 成功（${cost}ms）`)}`);
        return null;
      }
      const text = await response.text();
      let data = null;
      try {
        data = text ? JSON.parse(text) : null;
      } catch {
        // 非 JSON 响应按原文抛出
      }
      if (!response.ok) {
        console.error(`${c.cyan('[ASC]')} ${c.red(`${method} ${path} -> HTTP ${response.status} 失败（${cost}ms）：${text.slice(0, 300)}`)}`);
        throw new Error(buildAppleErrorMessage(response.status, data, text));
      }
      console.log(`${c.cyan('[ASC]')} ${c.gray(`${method} ${path}`)} ${c.green(`-> HTTP ${response.status} 成功（${cost}ms，返回 ${(text || '').length} 字符）`)}`);
      return data;
    }
  }

  /**
   * 获取 app 列表
   * @param {number} [limit=200] 单页数量上限
   * @returns {Promise<Object>} ASC apps 响应
   */
  async listApps(limit = 200) {
    return this.request('GET', `/v1/apps?limit=${limit}`);
  }

  /**
   * 获取指定 app 的 build 列表（按上传时间倒序，附带 preReleaseVersion 用于取短版本号）
   * @param {string} appId app ID
   * @param {number} [limit=50] 单页数量上限
   * @returns {Promise<Object>} ASC builds 响应
   */
  async listBuilds(appId, limit = 50) {
    return this.request('GET', `/v1/builds?filter[app]=${appId}&limit=${limit}&sort=-uploadedDate&include=preReleaseVersion`);
  }

  /**
   * 获取 beta 测试组列表
   * @returns {Promise<Object>} ASC betaGroups 响应
   */
  async listBetaGroups() {
    return this.request('GET', '/v1/betaGroups?limit=200');
  }

  /**
   * 把 build 加入若干测试组（TestFlight 分发）
   * @param {string} buildId build ID
   * @param {string[]} betaGroupIds 测试组 ID 列表
   * @returns {Promise<null>} 成功返回 null（204）
   */
  async distributeBuild(buildId, betaGroupIds) {
    const body = {
      data: betaGroupIds.map((id) => ({ type: 'betaGroups', id })),
    };
    return this.request('POST', `/v1/builds/${buildId}/relationships/betaGroups`, { body });
  }

  /**
   * 创建 build 上传
   * @param {Object} body BuildUploadCreateRequest 请求体
   * @returns {Promise<Object>} ASC buildUploads 响应
   */
  async createBuildUpload(body) {
    return this.request('POST', '/v1/buildUploads', { body });
  }

  /**
   * 查询 build 上传详情
   * @param {string} uploadId buildUpload ID
   * @returns {Promise<Object>} ASC buildUpload 响应
   */
  async getBuildUpload(uploadId) {
    return this.request('GET', `/v1/buildUploads/${uploadId}`);
  }

  /**
   * 预约 build 上传文件（获取分块上传指令）
   * @param {Object} body BuildUploadFileCreateRequest 请求体
   * @returns {Promise<Object>} ASC buildUploadFiles 响应
   */
  async createBuildUploadFile(body) {
    return this.request('POST', '/v1/buildUploadFiles', { body });
  }

  /**
   * 提交（commit）build 上传文件
   * @param {string} fileId buildUploadFile ID
   * @param {Object} body BuildUploadFileUpdateRequest 请求体（含 uploaded 与 checksum）
   * @returns {Promise<Object>} ASC buildUploadFile 响应
   */
  async commitBuildUploadFile(fileId, body) {
    return this.request('PATCH', `/v1/buildUploadFiles/${fileId}`, { body });
  }

  /**
   * 上传单个分块到 Apple 提供的预签名 URL（该 URL 不需要 JWT）
   * @param {string} uploadUrl 预签名上传地址
   * @param {Buffer} chunkBuffer 分块二进制
   * @param {Object} [extraHeaders] Apple 指令要求的额外请求头
   * @returns {Promise<void>} 非 2xx 时抛出
   */
  async uploadChunk(uploadUrl, chunkBuffer, extraHeaders = {}) {
    let response;
    try {
      response = await doFetch(uploadUrl, {
        method: 'PUT',
        headers: extraHeaders,
        body: chunkBuffer,
        signal: this.signal,
      });
    } catch (err) {
      if (err && (err.name === 'AbortError' || err.code === 'ABORT_ERR')) {
        const abortErr = new Error('任务已中断');
        abortErr.isAbort = true;
        throw abortErr;
      }
      throw err;
    }
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`分块上传失败（HTTP ${response.status}）：${text.slice(0, 300)}`);
    }
  }

  /**
   * 校验配置连通性（获取 app 列表）
   * @returns {Promise<{ok: true, appCount: number}|{ok: false, message: string}>}
   */
  async verify() {
    try {
      const data = await this.listApps();
      return { ok: true, appCount: data.data ? data.data.length : 0 };
    } catch (err) {
      return { ok: false, message: err.message };
    }
  }
}

/**
 * 构造 Apple 错误的可读信息
 * @param {number} status HTTP 状态码
 * @param {Object|null} data 解析出的 JSON（可能含 errors 数组）
 * @param {string} rawText 原始响应文本
 * @returns {string} 可读错误信息
 */
function buildAppleErrorMessage(status, data, rawText) {
  if (Array.isArray(data?.errors) && data.errors.length > 0) {
    const first = data.errors[0];
    const code = first.code ? `[${first.code}] ` : '';
    const detail = first.detail || first.title || '';
    return `Apple API 错误（HTTP ${status}）：${code}${detail}`;
  }
  return `Apple API 错误（HTTP ${status}）：${(rawText || '').slice(0, 300)}`;
}

/**
 * 睡眠指定毫秒
 * @param {number} ms 毫秒数
 * @returns {Promise<void>}
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 根据配置 ID 创建 ASC 客户端
 * @param {string} configId 配置 ID
 * @returns {AscClient} 客户端实例
 */
function createClient(configId) {
  return new AscClient(configId);
}

module.exports = { createClient, AscClient, API_BASE, doFetch, resolveActiveProxyUrl };
