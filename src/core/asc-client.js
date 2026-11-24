'use strict';

const { exec } = require('child_process');
const { promisify } = require('util');

const store = require('../config/store');
const jwt = require('./jwt');
const c = require('./term');

const execAsync = promisify(exec);

/** App Store Connect API 基础地址（官方文档：https://api.appstoreconnect.apple.com） */
const API_BASE = 'https://api.appstoreconnect.apple.com';

/** 视为瞬时故障、可自动重试的 HTTP 状态码（Apple 服务端偶发 5xx） */
const RETRYABLE_STATUS = new Set([500, 502, 503, 504]);

/** GET 请求对瞬时故障（5xx/网络抖动）的最大自动重试次数，退避 1s/2s/4s */
const MAX_TRANSIENT_RETRY = 3;

/** @type {{agent: Object, proxyUrl: string}|null} 代理 Agent 缓存 */
let proxyAgentCache = null;

/** Windows 系统代理所在的注册表键路径（各代理软件的"系统代理"开关写入的就是这里） */
const WIN_PROXY_REG_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings';

/** Windows 系统代理读取结果的缓存有效期（毫秒），避免每次请求都查询注册表 */
const WIN_PROXY_CACHE_TTL_MS = 10000;

/** @type {{value: string, readAt: number}|null} Windows 系统代理缓存 */
let winProxyCache = null;

/**
 * 解析当前生效的代理地址
 * 优先级：settings.json > 环境变量 > Windows 系统代理（注册表）
 * @returns {Promise<string>} 代理地址，空字符串表示直连
 */
async function resolveActiveProxyUrl() {
  const settings = await store.loadSettings();
  return settings.proxyUrl
    || process.env.HTTPS_PROXY
    || process.env.https_proxy
    || await readWindowsSystemProxy();
}

/**
 * 读取 Windows 系统代理设置（注册表 Internet Settings），带短 TTL 缓存。
 * 非 Windows 平台、未开启系统代理或读取失败时均返回空字符串（按直连处理）。
 * @returns {Promise<string>} 形如 http://127.0.0.1:7890 的代理地址，空字符串表示无
 */
async function readWindowsSystemProxy() {
  if (process.platform !== 'win32') {
    return '';
  }
  const now = Date.now();
  if (winProxyCache && now - winProxyCache.readAt < WIN_PROXY_CACHE_TTL_MS) {
    return winProxyCache.value;
  }
  let value = '';
  try {
    const enableOutput = (await execAsync(`reg query "${WIN_PROXY_REG_KEY}" /v ProxyEnable`, { timeout: 3000 })).stdout;
    if (/ProxyEnable\s+REG_DWORD\s+0x1/i.test(enableOutput)) {
      const valueOutput = (await execAsync(`reg query "${WIN_PROXY_REG_KEY}" /v ProxyServer`, { timeout: 3000 })).stdout;
      value = parseProxyServer(valueOutput);
    }
  } catch {
    // 注册表读取失败（键不存在等）按无代理处理，不打断请求
  }
  winProxyCache = { value, readAt: now };
  return value;
}

/**
 * 从 reg query 输出中解析 ProxyServer 的值
 * 兼容两种格式：简单格式 "127.0.0.1:7890"、分协议格式 "http=...;https=...;socks=..."
 * @param {string} output reg query 命令的 stdout
 * @returns {string} 形如 http://host:port 的代理地址，仅 SOCKS 或解析失败时返回空
 */
function parseProxyServer(output) {
  const match = output.match(/ProxyServer\s+REG_SZ\s+(\S+)/);
  if (!match) {
    return '';
  }
  const raw = match[1];
  // 分协议格式：优先取 https，其次 http；仅 socks 时不处理（undici ProxyAgent 只支持 HTTP 代理）
  if (raw.includes('=')) {
    const entries = new Map(raw.split(';').map((segment) => segment.split('=')));
    const target = entries.get('https') || entries.get('http');
    return target ? `http://${target}` : '';
  }
  return `http://${raw}`;
}

/**
 * 获取代理 Agent（按 resolveActiveProxyUrl 的结果），代理配置变化时重建
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
      const requestUrl = path.startsWith('http') ? path : `${API_BASE}${path}`;
      try {
        response = await doFetch(requestUrl, { method, headers, body, signal: opts.signal || this.signal });
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
   * 自动沿着 links.next 抓取并合并多页数据（利用 Apple 官方游标）
   * @param {string} initialPath 初始相对路径或绝对 URL
   * @param {number} [maxPages=15] 安全拉取最大页数保护
   * @returns {Promise<{data: Array<Object>, included?: Array<Object>}>} 聚合后的完整响应数据
   */
  async requestAll(initialPath, maxPages = 15) {
    let nextUrl = initialPath;
    let pageCount = 0;
    const allData = [];
    const allIncluded = [];

    while (nextUrl && pageCount < maxPages) {
      pageCount += 1;
      const res = await this.request('GET', nextUrl);
      if (!res) {
        break;
      }
      if (Array.isArray(res.data)) {
        allData.push(...res.data);
      }
      if (Array.isArray(res.included)) {
        allIncluded.push(...res.included);
      }
      const next = res.links && res.links.next;
      if (!next) {
        break;
      }
      nextUrl = next;
    }

    return { data: allData, included: allIncluded };
  }

  /**
   * 获取 app 列表（默认自动聚合全部分页）
   * @param {number} [limit=200] 单页数量上限
   * @param {string} [cursor=''] 指定游标，不传且无 cursor 时自动拉取全量
   * @returns {Promise<Object>} ASC apps 响应
   */
  async listApps(limit = 200, cursor = '') {
    if (cursor) {
      return this.request('GET', `/v1/apps?${pagingQuery(limit, cursor)}`);
    }
    return this.requestAll(`/v1/apps?limit=${Math.min(limit, 200)}`);
  }

  /**
   * 获取指定 app 的 build 列表（按上传时间倒序，附带 preReleaseVersion 用于取短版本号）
   * @param {string} appId app ID
   * @param {number} [limit=50] 单页数量上限
   * @param {string} [cursor=''] 游标
   * @returns {Promise<Object>} ASC builds 响应
   */
  async listBuilds(appId, limit = 50, cursor = '') {
    return this.request('GET', `/v1/builds?filter[app]=${appId}&${pagingQuery(limit, cursor)}&sort=-uploadedDate&include=preReleaseVersion`);
  }

  /**
   * 获取指定 app 的 App Store 版本列表（含审核状态 appStoreState）
   * @param {string} appId app ID
   * @param {number} [limit=50] 单页数量上限
   * @param {string} [cursor=''] 游标
   * @returns {Promise<Object>} ASC appStoreVersions 响应
   */
  async listAppStoreVersions(appId, limit = 50, cursor = '') {
    return this.request('GET', `/v1/apps/${appId}/appStoreVersions?${pagingQuery(limit, cursor)}`);
  }

  /**
   * 获取 beta 测试组列表（默认自动聚合全部）
   * @param {number} [limit=200] 单页数量上限
   * @param {string} [cursor=''] 游标
   * @returns {Promise<Object>} ASC betaGroups 响应
   */
  async listBetaGroups(limit = 200, cursor = '') {
    if (cursor) {
      return this.request('GET', `/v1/betaGroups?${pagingQuery(limit, cursor)}`);
    }
    return this.requestAll(`/v1/betaGroups?limit=${Math.min(limit, 200)}`);
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
   * 获取证书列表（默认自动聚合全部）
   * @param {number} [limit=200] 单页数量上限
   * @param {string} [cursor=''] 游标
   * @returns {Promise<Object>} ASC certificates 响应
   */
  async listCertificates(limit = 200, cursor = '') {
    if (cursor) {
      return this.request('GET', `/v1/certificates?${pagingQuery(limit, cursor)}`);
    }
    return this.requestAll(`/v1/certificates?limit=${Math.min(limit, 200)}`);
  }

  /**
   * 用 CSR 向 Apple 签发证书
   * @param {string} csrContent CSR PEM 文本
   * @param {string} certificateType 证书类型（如 IOS_DISTRIBUTION / IOS_DEVELOPMENT）
   * @returns {Promise<Object>} ASC certificates 响应（attributes 含 certificateContent、expirationDate 等）
   */
  async createCertificate(csrContent, certificateType) {
    const body = {
      data: {
        type: 'certificates',
        attributes: { csrContent, certificateType },
      },
    };
    return this.request('POST', '/v1/certificates', { body });
  }

  /**
   * 吊销证书
   * @param {string} certId 证书 ID
   * @returns {Promise<null>} 成功返回 null（204）
   */
  async revokeCertificate(certId) {
    return this.request('DELETE', `/v1/certificates/${certId}`);
  }

  /**
   * 获取描述文件列表（默认自动聚合全部，关联 App ID 与证书用于展示）
   * @param {number} [limit=200] 单页数量上限
   * @param {string} [cursor=''] 游标
   * @returns {Promise<Object>} ASC profiles 响应（data + included 关联数据）
   */
  async listProfiles(limit = 200, cursor = '') {
    if (cursor) {
      return this.request('GET', `/v1/profiles?${pagingQuery(limit, cursor)}&include=bundleId,certificates`);
    }
    return this.requestAll(`/v1/profiles?limit=${Math.min(limit, 200)}&include=bundleId,certificates`);
  }

  /**
   * 获取 App ID（Bundle ID）列表（默认自动聚合全部）
   * @param {number} [limit=200] 单页数量上限
   * @param {string} [cursor=''] 游标
   * @returns {Promise<Object>} ASC bundleIds 响应
   */
  async listBundleIds(limit = 200, cursor = '') {
    if (cursor) {
      return this.request('GET', `/v1/bundleIds?${pagingQuery(limit, cursor)}`);
    }
    return this.requestAll(`/v1/bundleIds?limit=${Math.min(limit, 200)}`);
  }

  /**
   * 创建 App ID（显式 Bundle ID，不支持通配符）
   * @param {string} name 名称
   * @param {string} identifier Bundle ID 标识（如 com.example.app）
   * @param {string} platform 平台（IOS / MAC_OS / SERVICES / UNIVERSAL）
   * @returns {Promise<Object>} ASC bundleIds 响应
   */
  async createBundleId(name, identifier, platform) {
    const body = {
      data: {
        type: 'bundleIds',
        attributes: { name, identifier, platform },
      },
    };
    return this.request('POST', '/v1/bundleIds', { body });
  }

  /**
   * 删除 App ID（会连带使其关联描述文件失效，不可恢复）
   * @param {string} bundleIdResourceId App ID 资源 ID
   * @returns {Promise<null>} 成功返回 null（204）
   */
  async deleteBundleId(bundleIdResourceId) {
    return this.request('DELETE', `/v1/bundleIds/${bundleIdResourceId}`);
  }

  /**
   * 获取指定 App ID 已启用的能力列表（官方嵌套子资源端点；
   * 老式 /v1/bundleIdCapabilities?filter[bundleId]= 集合端点已不被允许 GET）
   * @param {string} bundleIdResourceId App ID 资源 ID
   * @returns {Promise<Object>} ASC bundleIdCapabilities 响应
   */
  async listBundleIdCapabilities(bundleIdResourceId) {
    return this.request('GET', `/v1/bundleIds/${encodeURIComponent(bundleIdResourceId)}/bundleIdCapabilities`);
  }

  /**
   * 为 App ID 启用一项能力（部分能力需要 options，如 APPLE_ID_AUTH 需 isPrimaryAppId）
   * @param {string} bundleIdResourceId App ID 资源 ID
   * @param {string} capabilityType 能力类型（如 PUSH_NOTIFICATIONS / APP_GROUPS）
   * @param {Object} [options] 能力附加选项
   * @returns {Promise<Object>} ASC bundleIdCapabilities 响应
   */
  async enableCapability(bundleIdResourceId, capabilityType, options) {
    const attributes = { capabilityType };
    if (options && Object.keys(options).length > 0) {
      attributes.options = options;
    }
    const body = {
      data: {
        type: 'bundleIdCapabilities',
        attributes,
        relationships: {
          bundleId: { data: { type: 'bundleIds', id: bundleIdResourceId } },
        },
      },
    };
    return this.request('POST', '/v1/bundleIdCapabilities', { body });
  }

  /**
   * 创建描述文件
   * @param {string} bundleIdResourceId App ID 资源 ID
   * @param {string[]} certificateIds 证书资源 ID 列表
   * @param {string} name 描述文件名称
   * @param {string} profileType 描述文件类型（IOS_APP_STORE / IOS_APP_ADHOC / IOS_APP_DEVELOPMENT）
   * @param {string[]} [deviceIds=[]] 设备资源 ID 列表（仅 Ad Hoc / 开发类型需要，App Store 类型不携带）
   * @returns {Promise<Object>} ASC profiles 响应
   */
  async createProfile(bundleIdResourceId, certificateIds, name, profileType, deviceIds = []) {
    const body = {
      data: {
        type: 'profiles',
        attributes: { name, profileType },
        relationships: {
          bundleId: { data: { type: 'bundleIds', id: bundleIdResourceId } },
          certificates: { data: certificateIds.map((id) => ({ type: 'certificates', id })) },
        },
      },
    };
    if (deviceIds.length > 0) {
      body.data.relationships.devices = { data: deviceIds.map((id) => ({ type: 'devices', id })) };
    }
    return this.request('POST', '/v1/profiles', { body });
  }

  /**
   * 删除描述文件
   * @param {string} profileId 描述文件 ID
   * @returns {Promise<null>} 成功返回 null（204）
   */
  async deleteProfile(profileId) {
    return this.request('DELETE', `/v1/profiles/${profileId}`);
  }

  /**
   * 下载描述文件内容（.mobileprovision 二进制）。
   * Apple 不提供独立的 profileContent 关系端点，而是通过 GET /v1/profiles/{id}?fields[profiles]=profileContent
   * 在响应 attributes 中内联返回 base64 编码的 .mobileprovision 内容（官方文档 "Read and download profile information"）
   * @param {string} profileId 描述文件 ID
   * @returns {Promise<Buffer>} .mobileprovision 二进制内容
   * @throws {Error} Apple API 错误或响应缺少内容字段时抛出
   */
  async getProfileContent(profileId) {
    const data = await this.request('GET', `/v1/profiles/${profileId}?fields%5Bprofiles%5D=profileContent`);
    const content = data && data.data && data.data.attributes && data.data.attributes.profileContent;
    if (!content) {
      throw new Error('Apple 未返回描述文件内容（profileContent 为空），无法下载');
    }
    return Buffer.from(content, 'base64');
  }

  /**
   * 获取注册到团队的设备列表（默认自动聚合全部）
   * @param {number} [limit=200] 单页数量上限（API 最大 200）
   * @param {string} [cursor=''] 游标
   * @returns {Promise<Object>} ASC devices 响应
   */
  async listDevices(limit = 200, cursor = '') {
    if (cursor) {
      return this.request('GET', `/v1/devices?${pagingQuery(limit, cursor)}`);
    }
    return this.requestAll(`/v1/devices?limit=${Math.min(limit, 200)}`);
  }

  /**
   * 注册新设备（每年新增设备数量受 Apple 配额限制，超限由 Apple 返回错误）
   * @param {string} name 设备名称
   * @param {string} platform 平台（IOS / MAC_OS / UNIVERSAL）
   * @param {string} udid 设备 UDID
   * @returns {Promise<Object>} ASC devices 响应
   */
  async createDevice(name, platform, udid) {
    const body = {
      data: {
        type: 'devices',
        attributes: { name, platform, udid },
      },
    };
    return this.request('POST', '/v1/devices', { body });
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
 * 构造分页 query 参数（符合 Apple 官方规范：支持 limit 与 cursor）
 * @param {number} limit 单页数量上限
 * @param {string} [cursor=''] 游标
 * @returns {string} query 片段（不含开头的 ?）
 */
function pagingQuery(limit, cursor = '') {
  const safeLimit = Math.min(Math.max(Number(limit) || 50, 1), 200);
  if (!cursor) {
    return `limit=${safeLimit}`;
  }
  return `limit=${safeLimit}&cursor=${encodeURIComponent(cursor)}`;
}

/**
 * 解析列表接口的分页参数（query 中 cursor/limit 可选）
 * @param {Object} query express 的 req.query 对象
 * @param {number} defaultLimit 默认单页数量上限
 * @returns {{limit: number, cursor: string}} 分页参数
 */
function parsePaging(query, defaultLimit) {
  const limitRaw = Number.parseInt(query && query.limit, 10);
  const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 200) : defaultLimit;
  const cursor = (query && typeof query.cursor === 'string') ? query.cursor.trim() : '';
  return { limit, cursor };
}

/**
 * 从 Apple API 响应的 links.next 或直接 URL 中提取 cursor 字符串
 * @param {Object|string} data Apple API 响应对象或直接的 URL 字符串
 * @returns {string|null} cursor 字符串，无下一页时返回 null
 */
function extractNextCursor(data) {
  const next = typeof data === 'string' ? data : (data && data.links && data.links.next);
  if (!next) {
    return null;
  }
  try {
    const parsedUrl = new URL(next);
    return parsedUrl.searchParams.get('cursor') || null;
  } catch {
    return null;
  }
}

/**
 * 根据配置 ID 创建 ASC 客户端
 * @param {string} configId 配置 ID
 * @param {AbortSignal} [signal] 可选中断信号，触发时中断进行中的请求
 * @returns {AscClient} 客户端实例
 */
function createClient(configId, signal) {
  return new AscClient(configId, signal);
}

module.exports = {
  createClient,
  AscClient,
  API_BASE,
  doFetch,
  resolveActiveProxyUrl,
  pagingQuery,
  parsePaging,
  extractNextCursor,
};
