'use strict';

const fs = require('fs');
const { createClient } = require('../core/asc-client');
const { findIpa, getIpaPath } = require('../server/routes/ipa');
const c = require('../core/term');

/** 校验轮询起始间隔（毫秒） */
const POLL_START_MS = 5000;

/** 校验轮询最大间隔（毫秒） */
const POLL_MAX_MS = 15000;

/** 校验轮询总超时（毫秒） */
const VALIDATE_TIMEOUT_MS = 60 * 60 * 1000;

/** build 处理轮询总超时（毫秒） */
const PROCESS_TIMEOUT_MS = 90 * 60 * 1000;

/** buildUpload 校验状态英文名 → 中文名映射（官方枚举） */
const UPLOAD_STATE_TEXT = {
  AWAITING_UPLOAD: '等待上传',
  PROCESSING: '校验处理中',
  FAILED: '校验失败',
  COMPLETE: '校验完成',
};

/** build 处理状态英文名 → 中文名映射（官方枚举） */
const BUILD_STATE_TEXT = {
  PROCESSING: '处理中',
  FAILED: '失败',
  INVALID: '无效',
  VALID: '可用',
};

/**
 * buildUpload 校验状态的中文文案
 * @param {string} state 状态英文标识
 * @returns {string} 中文名，未知时原样返回
 */
function uploadStateText(state) {
  return UPLOAD_STATE_TEXT[state] || state || '未知';
}

/**
 * build 处理状态的中文文案
 * @param {string} state 状态英文标识
 * @returns {string} 中文名，未知时原样返回
 */
function buildStateText(state) {
  return BUILD_STATE_TEXT[state] || state || '未知';
}

/**
 * 执行单个上传任务的完整流水线：
 * 创建 buildUpload → 预约文件 → 分块上传 → commit → 轮询校验 →（可选）TestFlight 分发。
 * 任一步失败都会抛出异常，由 task-manager 捕获并标记 FAILED。
 * @param {Object} task 任务对象（task-manager 内部结构）
 * @param {Object} hooks 回调
 * @param {(patch: Object) => void} hooks.update 更新任务字段并广播
 * @param {(message: string) => void} hooks.log 追加日志
 * @returns {Promise<void>}
 */
async function runUploadPipeline(task, hooks) {
  const ipa = findIpa(task.ipaId);
  if (!ipa) {
    throw new Error('本地 IPA 缓存不存在，请重新上传 IPA 后再创建任务');
  }
  // 中断信号由 task-manager 注入，触发后各阶段停止并标记任务为已取消
  const signal = task.abortController ? task.abortController.signal : null;
  throwIfAborted(signal);
  const client = createClient(task.configId, signal);
  const ipaPath = getIpaPath(task.ipaId);

  console.log(`${c.cyan('[任务]')} 开始执行：文件 ${c.bold(ipa.filename)}（${ipa.sizeBytes} 字节，MD5 ${c.gray(ipa.md5)}），配置「${task.configName}」`);
  hooks.update({ stage: 'PREPARING', message: '正在创建上传任务' });
  hooks.log('正在通过 App Store Connect API 查询 App 信息');
  const appId = await resolveAppId(client, ipa.bundleId);
  throwIfAborted(signal);
  console.log(`[任务] 已匹配 App：appId=${appId}（bundleId=${ipa.bundleId}）`);

  hooks.log(`正在创建 buildUpload（版本 ${ipa.buildVersion || '未知'}）`);
  const uploadResponse = await client.createBuildUpload({
    data: {
      type: 'buildUploads',
      attributes: {
        cfBundleVersion: ipa.buildVersion,
        cfBundleShortVersionString: ipa.shortVersion,
        platform: ipa.platform,
      },
      relationships: {
        app: { data: { type: 'apps', id: appId } },
      },
    },
  });
  const uploadId = uploadResponse.data.id;
  hooks.log(`buildUpload 已创建：${uploadId}`);

  hooks.log('正在预约文件上传');
  const fileResponse = await client.createBuildUploadFile({
    data: {
      type: 'buildUploadFiles',
      attributes: {
        fileName: ipa.filename,
        fileSize: ipa.sizeBytes,
        assetType: 'ASSET',
        uti: 'com.apple.ipa',
      },
      relationships: {
        buildUpload: { data: { type: 'buildUploads', id: uploadId } },
      },
    },
  });
  const fileId = fileResponse.data.id;
  const operations = extractUploadOperations(fileResponse);
  throwIfAborted(signal);
  console.log(`[任务] 文件预约成功：fileId=${fileId}，Apple 下发 ${operations.length} 个分块上传指令`);

  hooks.update({ stage: 'PUSHING_CHUNKS', message: '正在上传文件到 Apple', progress: 0, uploadedBytes: 0 });
  await pushChunks(client, ipaPath, operations, ipa.sizeBytes, (uploadedBytes, total) => {
    const progress = total > 0 ? Math.min(100, Math.round((uploadedBytes / total) * 100)) : 0;
    hooks.update({ uploadedBytes, progress, message: `上传中 ${progress}%` });
  }, signal);
  hooks.log('全部分块上传完成');
  throwIfAborted(signal);

  hooks.update({ stage: 'COMMITTING', message: '正在提交文件校验信息' });
  await client.commitBuildUploadFile(fileId, {
    data: {
      type: 'buildUploadFiles',
      id: fileId,
      attributes: {
        uploaded: true,
        sourceFileChecksums: {
          file: {
            algorithm: 'MD5',
            hash: ipa.md5,
          },
        },
      },
    },
  });
  hooks.log('文件已提交，等待 Apple 校验');

  hooks.update({ stage: 'VALIDATING', message: 'Apple 校验中' });
  await pollUploadState(client, uploadId, hooks, signal);

  hooks.update({ stage: 'WAITING_PROCESS', message: '等待 build 处理完成' });
  const buildId = await pollBuildReady(client, appId, ipa, hooks, signal);
  updateBuildId(task, hooks, buildId);
  throwIfAborted(signal);

  if (task.autoTestflight && Array.isArray(task.betaGroupIds) && task.betaGroupIds.length > 0) {
    hooks.update({ stage: 'DISTRIBUTING', message: '正在加入 TestFlight 测试组' });
    await client.distributeBuild(buildId, task.betaGroupIds);
    hooks.log(`已把 build 加入 ${task.betaGroupIds.length} 个测试组`);
  } else {
    hooks.log('未启用自动 TestFlight 分发，跳过分发步骤');
  }

  hooks.update({ stage: 'DONE', progress: 100, message: '上传完成' });
  hooks.log('任务全部完成', 'ok');
}

/**
 * 根据 bundleId 查找 app ID
 * @param {Object} client ASC 客户端
 * @param {string|null} bundleId 包名
 * @returns {Promise<string>} app ID
 * @throws {Error} bundleId 缺失或找不到对应 app 时抛出
 */
async function resolveAppId(client, bundleId) {
  if (!bundleId) {
    throw new Error('无法从 IPA 中解析 bundleId，请在 UI 中手动确认 IPA 是否有效');
  }
  const data = await client.listApps();
  const matched = (data.data || []).find((app) => app.attributes.bundleId === bundleId);
  if (!matched) {
    throw new Error(`当前账号下未找到 bundleId 为 ${bundleId} 的 App，请确认配置与 IPA 是否匹配`);
  }
  return matched.id;
}

/**
 * 从 buildUploadFile 响应中提取上传操作指令（兼容多种字段命名）
 * @param {Object} fileResponse buildUploadFiles 响应
 * @returns {Array<{method: string, url: string, offset: number, length: number, headers: Object}>}
 * @throws {Error} 响应中不含上传指令时抛出
 */
function extractUploadOperations(fileResponse) {
  const attrs = fileResponse.data.attributes || {};
  const candidates = attrs.uploadOperations
    || attrs.deliveryFileUploadOperations
    || attrs.operations
    || [];
  const operations = candidates.map((op) => ({
    method: op.method || 'PUT',
    url: op.url,
    offset: Number(op.offset ?? op.fileOffset ?? 0),
    length: Number(op.length ?? op.fileLength ?? 0),
    headers: normalizeHeaders(op.requestHeaders || op.headers),
  }));
  if (operations.length === 0 || operations.some((op) => !op.url)) {
    throw new Error('Apple 返回的文件预约响应中缺少上传指令，无法继续（API 结构可能已变化）');
  }
  return operations;
}

/**
 * 规范化上传指令的请求头：官方文档为 [{name, value}] 数组，同时兼容普通对象
 * @param {Array<Object>|Object|null} raw 原始请求头
 * @returns {Object} 普通对象形式的请求头
 */
function normalizeHeaders(raw) {
  if (!raw) {
    return {};
  }
  if (!Array.isArray(raw)) {
    return raw;
  }
  const result = {};
  for (const item of raw) {
    if (item && item.name) {
      result[item.name] = item.value;
    }
  }
  return result;
}

/**
 * 按指令分块读取文件并上传，带网络错误自动重试
 * @param {Object} client ASC 客户端
 * @param {string} ipaPath IPA 文件路径
 * @param {Array<Object>} operations 上传指令列表
 * @param {number} totalSize 文件总字节数（进度计算用）
 * @param {(uploadedBytes: number, totalSize: number) => void} onProgress 进度回调
 * @returns {Promise<void>}
 */
async function pushChunks(client, ipaPath, operations, totalSize, onProgress, signal) {
  let uploadedBytes = 0;
  for (let i = 0; i < operations.length; i++) {
    throwIfAborted(signal);
    const op = operations[i];
    await withRetry(3, async () => {
      const buffer = await readSlice(ipaPath, op.offset, op.length);
      await client.uploadChunk(op.url, buffer, op.headers);
    });
    uploadedBytes += op.length;
    console.log(`${c.cyan('[任务]')} ${c.gray(`分块 ${i + 1}/${operations.length} 上传完成（offset=${op.offset}，${op.length} 字节）`)}`);
    onProgress(Math.min(uploadedBytes, totalSize), totalSize);
  }
}

/**
 * 读取文件的指定字节区间
 * @param {string} filePath 文件路径
 * @param {number} offset 起始偏移
 * @param {number} length 长度
 * @returns {Promise<Buffer>} 区间内容
 */
function readSlice(filePath, offset, length) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    const stream = fs.createReadStream(filePath, { start: offset, end: offset + length - 1 });
    stream.on('data', (chunk) => chunks.push(chunk));
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', reject);
  });
}

/**
 * 轮询 buildUpload 校验状态，5s 起步指数退避至 15s。
 * 官方结构（BuildUpload.Attributes.State）：state 为对象
 * { state: 'AWAITING_UPLOAD'|'PROCESSING'|'FAILED'|'COMPLETE', errors, warnings, infos }
 * @param {Object} client ASC 客户端
 * @param {string} uploadId buildUpload ID
 * @param {Object} hooks 任务回调
 * @returns {Promise<void>} 校验成功返回
 * @throws {Error} 校验失败或超时抛出（errors 明细透传）
 */
async function pollUploadState(client, uploadId, hooks, signal) {
  const startedAt = Date.now();
  let interval = POLL_START_MS;
  for (;;) {
    if (Date.now() - startedAt > VALIDATE_TIMEOUT_MS) {
      throw new Error('Apple 校验超时（超过 60 分钟），请稍后在 Builds 页确认结果');
    }
    await sleep(interval);
    throwIfAborted(signal);
    interval = Math.min(POLL_MAX_MS, interval * 1.5);
    const data = await client.getBuildUpload(uploadId);
    const attrs = (data.data && data.data.attributes) || {};
    const stateObj = attrs.state || {};
    // 兼容 state 为对象（官方 4.1+）与字符串两种形态
    const state = typeof stateObj === 'string' ? stateObj : stateObj.state;
    console.log(`${c.cyan('[校验轮询]')} ${c.gray(`buildUpload=${uploadId} state=${state}，原始响应：${JSON.stringify(stateObj).slice(0, 600)}`)}`);
    const warnCount = Array.isArray(stateObj.warnings) ? stateObj.warnings.length : 0;
    hooks.log(`Apple 校验状态：${uploadStateText(state)}${warnCount > 0 ? `（含 ${warnCount} 条警告）` : ''}`);
    if (state === 'FAILED') {
      throw new Error(buildValidationErrorMessage(stateObj.errors));
    }
    // 官方枚举：AWAITING_UPLOAD / PROCESSING / FAILED / COMPLETE
    if (state === 'COMPLETE') {
      return;
    }
  }
}

/**
 * 构造校验失败的错误信息（透传 Apple 的具体原因）
 * 官方 StateDetail 结构：{ code: string, description: string }
 * @param {Array<Object>|Object|null} errors state.errors 明细
 * @returns {string} 可读错误
 */
function buildValidationErrorMessage(errors) {
  let detail = '';
  if (Array.isArray(errors)) {
    detail = errors
      .map((item) => `${item.code ? `[${item.code}] ` : ''}${item.description || item.message || ''}`)
      .filter(Boolean)
      .join('；');
  } else if (errors && typeof errors === 'object') {
    detail = JSON.stringify(errors);
  }
  return `Apple 校验失败：${detail || '未知原因，请到 App Store Connect 后台查看详情'}`;
}

/**
 * 轮询并定位处理完成的 build。
 * 官方枚举（Build.processingState）：PROCESSING / FAILED / INVALID / VALID
 * @param {Object} client ASC 客户端
 * @param {string} appId app ID
 * @param {Object} ipa IPA 元数据
 * @param {Object} hooks 任务回调
 * @returns {Promise<string>} build ID
 * @throws {Error} 超时或处理失败时抛出
 */
async function pollBuildReady(client, appId, ipa, hooks, signal) {
  const startedAt = Date.now();
  for (;;) {
    if (Date.now() - startedAt > PROCESS_TIMEOUT_MS) {
      throw new Error('等待 build 处理超时（超过 90 分钟），请稍后在 Builds 页确认结果');
    }
    await sleep(POLL_START_MS);
    throwIfAborted(signal);
    const data = await client.listBuilds(appId, 100);
    // 短版本号在关联的 preReleaseVersion 资源上（builds 自身没有该字段）
    const preVersions = {};
    (data.included || []).forEach((inc) => {
      if (inc.type === 'preReleaseVersions' && inc.id) {
        preVersions[inc.id] = (inc.attributes && inc.attributes.version) || '';
      }
    });
    // 官方 version 为字符串，统一按字符串比较，避免类型不同永远匹配不上
    const candidates = (data.data || []).filter((build) => {
      const attrs = build.attributes || {};
      if (String(attrs.version) !== String(ipa.buildVersion)) {
        return false;
      }
      const rel = build.relationships && build.relationships.preReleaseVersion;
      const preId = rel && rel.data && rel.data.id;
      const preVersion = preId ? preVersions[preId] : '';
      // 短版本号可获取时用于精确匹配；取不到时不拦截（避免 include 失效导致永远找不到）
      if (ipa.shortVersion && preVersion && preVersion !== ipa.shortVersion) {
        return false;
      }
      return true;
    });
    const ready = candidates.find((build) => {
      const state = build.attributes.processingState;
      return state === 'VALID' || state === 'FAILED' || state === 'INVALID';
    });
    if (ready) {
      const state = ready.attributes.processingState;
      if (state === 'FAILED' || state === 'INVALID') {
        throw new Error(`build 处理失败（${state}），请到 App Store Connect 后台查看详情`);
      }
      console.log(`${c.cyan('[任务]')} ${c.green(`build 已就绪：buildId=${ready.id}，状态=${state}`)}`);
      return ready.id;
    }
    if (candidates.length > 0) {
      hooks.log(`build 处理中（${buildStateText(candidates[0].attributes.processingState)}）`);
    }
  }
}

/**
 * 更新任务上的 buildId（存在则更新并广播）
 * @param {Object} task 任务对象
 * @param {Object} hooks 任务回调
 * @param {string} buildId build ID
 * @returns {void}
 */
function updateBuildId(task, hooks, buildId) {
  task.buildId = buildId;
  hooks.update({ buildId });
}

/**
 * 带重试的执行（指数退避 1s/2s/4s），429 由 AscClient 自行处理
 * @param {number} maxRetry 最大重试次数
 * @param {() => Promise<void>} fn 执行函数
 * @returns {Promise<void>} 重试耗尽后抛出最后一次错误
 */
async function withRetry(maxRetry, fn) {
  let lastErr = null;
  for (let attempt = 0; attempt <= maxRetry; attempt++) {
    try {
      await fn();
      return;
    } catch (err) {
      lastErr = err;
      // 用户主动中断不重试，立即抛出
      if (err && err.isAbort) {
        throw err;
      }
      if (attempt < maxRetry) {
        await sleep(1000 * 2 ** attempt);
      }
    }
  }
  throw lastErr;
}

/**
 * 任务已被用户中断时抛出带 isAbort 标记的异常
 * @param {AbortSignal|null} signal 中断信号
 * @returns {void}
 * @throws {Error} signal 已触发时抛出 isAbort 标记异常
 */
function throwIfAborted(signal) {
  if (!signal || !signal.aborted) {
    return;
  }
  const err = new Error('任务已被用户中断');
  err.isAbort = true;
  throw err;
}

/**
 * 睡眠指定毫秒
 * @param {number} ms 毫秒
 * @returns {Promise<void>}
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = { runUploadPipeline };
