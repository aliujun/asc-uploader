'use strict';

const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');
const { getDir, ensureDirs } = require('../config/paths');
const { runUploadPipeline } = require('./upload-pipeline');
const { findIpa, setProtectedIpaResolver } = require('../server/routes/ipa');
const c = require('../core/term');

/** 任务文件路径 */
function tasksFile() {
  return path.join(getDir(), 'tasks.json');
}

/** 所有任务的内存列表（新任务在前） */
const tasks = [];

/** 等待执行的任务 ID 队列（FIFO） */
const queue = [];

/** SSE 订阅者集合：{taskId: Set<res>} */
const subscribers = new Map();

/** 当前是否已有任务在执行 */
let running = false;

/** 任务文件读写互斥状态 */
let isPersisting = false;
let hasPendingPersist = false;

/**
 * 任务运行期允许的 stage 集合
 */
const ACTIVE_STAGES = new Set([
  'QUEUED',
  'PREPARING',
  'PUSHING_CHUNKS',
  'COMMITTING',
  'VALIDATING',
  'WAITING_PROCESS',
  'DISTRIBUTING',
]);

/**
 * 允许用户中断的阶段（提交校验之前）。
 * 文件一旦 commit 给 Apple，中断无法撤回也不再有意义，等待结果即可。
 */
const ABORTABLE_STAGES = new Set([
  'QUEUED',
  'PREPARING',
  'PUSHING_CHUNKS',
]);

// 注入 IPA 缓存清理保护名单：进行中任务引用的 IPA 不允许被清理接口删除
setProtectedIpaResolver(() => {
  const ids = new Set();
  for (const task of tasks) {
    if (isStageActive(task.stage)) {
      ids.add(task.ipaId);
    }
  }
  return ids;
});

/**
 * 任务对前端脱敏后的视图
 * @param {Object} task 任务对象
 * @returns {Object} 视图对象
 */
function toView(task) {
  return {
    id: task.id,
    configId: task.configId,
    configName: task.configName,
    ipaId: task.ipaId,
    filename: task.filename,
    sizeBytes: task.sizeBytes,
    bundleId: task.bundleId,
    shortVersion: task.shortVersion,
    buildVersion: task.buildVersion,
    autoTestflight: task.autoTestflight,
    betaGroupIds: task.betaGroupIds,
    attemptCount: task.attemptCount || 1,
    stage: task.stage,
    progress: task.progress,
    uploadedBytes: task.uploadedBytes,
    message: task.message,
    logs: task.logs,
    buildId: task.buildId,
    /** 本地 IPA 缓存是否仍可用（注册表为内存态，服务重启后即失效） */
    ipaAvailable: Boolean(findIpa(task.ipaId)),
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
  };
}

/**
 * 加载历史任务；进行中的任务因服务重启标记为 FAILED
 * @returns {Promise<void>}
 */
async function loadTasks() {
  await ensureDirs();
  try {
    const raw = await fs.readFile(tasksFile(), 'utf8');
    const parsed = JSON.parse(raw);
    const list = Array.isArray(parsed.tasks) ? parsed.tasks : [];
    for (const item of list) {
      if (ACTIVE_STAGES.has(item.stage)) {
        item.stage = 'FAILED';
        item.message = '服务重启导致任务中断（若本地 IPA 缓存仍保留可点击重试）';
        addLog(item, '服务重启，任务中断');
      }
      tasks.push(item);
    }
  } catch (err) {
    if (err.code !== 'ENOENT') {
      throw err;
    }
  }
}

/** 任务文件持久化上限（只保留最近 100 条，防止 tasks.json 无限膨胀） */
const PERSIST_TASK_LIMIT = 100;

/**
 * 持久化任务到 tasks.json（串行化写，避免并发损坏）
 * @returns {Promise<void>}
 */
async function persist() {
  if (isPersisting) {
    hasPendingPersist = true;
    return;
  }
  isPersisting = true;
  try {
    await ensureDirs();
    const body = JSON.stringify({ tasks: tasks.slice(0, PERSIST_TASK_LIMIT).map(toView) }, null, 2);
    await fs.writeFile(tasksFile(), body, 'utf8');
  } catch (err) {
    console.error(`${c.red('[任务]')} tasks.json 持久化失败：${err.message}`);
  } finally {
    isPersisting = false;
    if (hasPendingPersist) {
      hasPendingPersist = false;
      await persist();
    }
  }
}

/**
 * 追加任务日志（同时输出到终端便于调试）
 * @param {Object} task 任务对象
 * @param {string} message 日志内容
 * @param {'info'|'ok'|'warn'|'error'} [level] 终端着色级别
 * @returns {void}
 */
function addLog(task, message, level) {
  task.logs.push({ time: new Date().toISOString(), message });
  if (task.logs.length > 200) {
    task.logs.splice(0, task.logs.length - 200);
  }
  const time = new Date().toLocaleTimeString();
  const head = `${c.cyan(`[任务 ${String(task.id).slice(0, 8)}]`)}${c.gray(`[${time}]`)}`;
  let body = message;
  if (level === 'ok') {
    body = c.green(message);
  } else if (level === 'warn') {
    body = c.yellow(message);
  } else if (level === 'error') {
    body = c.red(message);
  }
  console.log(`${head} ${body}`);
}

/**
 * 广播任务最新状态给订阅者
 * @param {string} taskId 任务 ID
 * @returns {void}
 */
function broadcast(taskId) {
  const set = subscribers.get(taskId);
  if (!set || set.size === 0) {
    return;
  }
  const task = findTask(taskId);
  if (!task) {
    return;
  }
  const payload = `data: ${JSON.stringify(toView(task))}\n\n`;
  for (const res of set) {
    res.write(payload);
  }
}

/**
 * 更新任务字段并广播
 * @param {Object} task 任务对象
 * @param {Object} patch 字段补丁
 * @returns {void}
 */
function updateTask(task, patch) {
  Object.assign(task, patch, { updatedAt: new Date().toISOString() });
  broadcast(task.id);
}

/**
 * 查找任务
 * @param {string} taskId 任务 ID
 * @returns {Object|null} 任务对象
 */
function findTask(taskId) {
  return tasks.find((t) => t.id === taskId) || null;
}

/**
 * 创建任务并入队
 * @param {Object} meta 任务元数据 {configId, configName, ipaId, filename, sizeBytes, bundleId,
 *   shortVersion, buildVersion, autoTestflight, betaGroupIds}
 * @returns {Object} 新任务对象
 */
function enqueue(meta) {
  const task = {
    id: crypto.randomUUID(),
    stage: 'QUEUED',
    progress: 0,
    uploadedBytes: 0,
    message: '排队等待中',
    logs: [],
    buildId: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...meta,
  };
  addLog(task, '任务已创建，等待执行');
  tasks.unshift(task);
  queue.push(task.id);
  broadcast(task.id);
  persist();
  processQueue();
  return task;
}

/**
 * 处理任务队列（并发 = 1）
 * @returns {Promise<void>}
 */
async function processQueue() {
  if (running) {
    return;
  }
  const nextId = queue.shift();
  if (!nextId) {
    return;
  }
  running = true;
  const task = findTask(nextId);
  if (!task) {
    running = false;
    processQueue();
    return;
  }
  if (task.stage === 'CANCELLED') {
    running = false;
    processQueue();
    return;
  }
  try {
    // 每次执行（含重试）创建新的中断控制器，供用户中途取消
    task.abortController = new AbortController();
    await runUploadPipeline(task, {
      update: (patch) => updateTask(task, patch),
      log: (message, level) => {
        addLog(task, message, level);
        updateTask(task, {});
      },
    });
  } catch (err) {
    if (err && err.isAbort) {
      addLog(task, '任务已被用户中断', 'warn');
      updateTask(task, { stage: 'CANCELLED', message: '已中断' });
    } else {
      // 完整错误只进日志，顶部状态行仅显示简短总结
      addLog(task, `任务失败：${err.message}`, 'error');
      updateTask(task, { stage: 'FAILED', message: '上传失败，具体原因请查看下方日志' });
    }
  } finally {
    task.abortController = null;
    running = false;
    persist();
    processQueue();
  }
}

/**
 * 取消排队中的任务
 * @param {string} taskId 任务 ID
 * @returns {boolean} 是否取消成功（仅 QUEUED 可取消）
 */
function cancel(taskId) {
  const task = findTask(taskId);
  if (!task || task.stage !== 'QUEUED') {
    return false;
  }
  const queueIndex = queue.indexOf(taskId);
  if (queueIndex >= 0) {
    queue.splice(queueIndex, 1);
  }
  addLog(task, '任务已取消');
  updateTask(task, { stage: 'CANCELLED', message: '已取消' });
  persist();
  return true;
}

/**
 * 中断任务：排队中的任务直接取消；运行中的任务触发中断信号，
 * 流水线在最近的检查点停止并标记为已取消（已提交给 Apple 的上传无法撤回）
 * @param {string} taskId 任务 ID
 * @returns {boolean} 是否成功触发中断
 */
function abort(taskId) {
  const task = findTask(taskId);
  if (!task) {
    return false;
  }
  if (task.stage === 'QUEUED') {
    return cancel(taskId);
  }
  // 仅提交校验前允许中断；commit 之后文件已在 Apple 手里，等待结果即可
  if (!ABORTABLE_STAGES.has(task.stage) || !task.abortController) {
    return false;
  }
  console.log(`[任务 ${String(taskId).slice(0, 8)}] 收到中断请求，当前阶段：${task.stage}`);
  task.abortController.abort();
  return true;
}

/**
 * 重试失败或已取消的任务（复用本地缓存的 IPA，Apple 流程从头执行）
 * @param {string} taskId 任务 ID
 * @returns {boolean} 是否入队成功
 */
function retry(taskId) {
  const task = findTask(taskId);
  if (!task || (task.stage !== 'FAILED' && task.stage !== 'CANCELLED')) {
    return false;
  }
  task.stage = 'QUEUED';
  task.progress = 0;
  task.uploadedBytes = 0;
  task.message = '重新排队等待中';
  task.attemptCount = (task.attemptCount || 1) + 1;
  // 重试是全新一次上传，清空上次日志避免新旧混杂干扰排查
  task.logs = [];
  addLog(task, `第 ${task.attemptCount} 次尝试，已重新入队`);
  queue.push(task.id);
  broadcast(task.id);
  persist();
  processQueue();
  return true;
}

/**
 * 删除任务记录
 * @param {string} taskId 任务 ID
 * @param {(ipaId: string) => Promise<void>} cleanupIpa IPA 缓存清理回调
 * @returns {Promise<boolean>} 是否删除成功
 */
async function removeTask(taskId, cleanupIpa) {
  const index = tasks.findIndex((t) => t.id === taskId);
  if (index < 0) {
    return false;
  }
  const [removed] = tasks.splice(index, 1);
  const queueIndex = queue.indexOf(taskId);
  if (queueIndex >= 0) {
    queue.splice(queueIndex, 1);
  }
  if (cleanupIpa && removed.ipaId) {
    await cleanupIpa(removed.ipaId);
  }
  persist();
  return true;
}

/**
 * 订阅任务 SSE
 * @param {string} taskId 任务 ID
 * @param {import('express').Response} res SSE 响应对象
 * @returns {() => void} 取消订阅函数
 */
function subscribe(taskId, res) {
  let set = subscribers.get(taskId);
  if (!set) {
    set = new Set();
    subscribers.set(taskId, set);
  }
  set.add(res);
  return () => {
    set.delete(res);
    if (set.size === 0) {
      subscribers.delete(taskId);
    }
  };
}

/**
 * 判断任务是否处于进行中（排队或运行各阶段）
 * @param {string} stage 阶段英文标识
 * @returns {boolean} 进行中返回 true
 */
function isStageActive(stage) {
  return ACTIVE_STAGES.has(stage);
}

/**
 * 判断任务是否处于可中断阶段（提交校验之前）。
 * 供路由层校验与前端按钮显隐共用同一份阶段定义（routes/tasks.js 不再维护黑名单）
 * @param {string} stage 阶段英文标识
 * @returns {boolean} 可中断返回 true
 */
function isStageAbortable(stage) {
  return ABORTABLE_STAGES.has(stage);
}

/**
 * 获取任务列表视图
 * @returns {Array<Object>} 任务视图列表
 */
function listTasks() {
  return tasks.map(toView);
}

module.exports = {
  loadTasks,
  enqueue,
  cancel,
  abort,
  retry,
  removeTask,
  subscribe,
  listTasks,
  findTask,
  toView,
  broadcast,
  isStageActive,
  isStageAbortable,
};
