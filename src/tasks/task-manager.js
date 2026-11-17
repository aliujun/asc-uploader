'use strict';

const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');
const { getDir, ensureDirs } = require('../config/paths');
const { runUploadPipeline } = require('./upload-pipeline');

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

/** 任务文件读写互斥锁（避免并发写坏 tasks.json） */
let persistChain = Promise.resolve();

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
    stage: task.stage,
    progress: task.progress,
    uploadedBytes: task.uploadedBytes,
    message: task.message,
    logs: task.logs,
    buildId: task.buildId,
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
        item.message = '服务重启导致任务中断，可重试';
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

/**
 * 持久化任务到 tasks.json（串行化写，避免并发损坏）
 * @returns {Promise<void>}
 */
function persist() {
  persistChain = persistChain.then(async () => {
    await ensureDirs();
    const body = JSON.stringify({ tasks: tasks.map(toView) }, null, 2);
    await fs.writeFile(tasksFile(), body, 'utf8');
  });
  return persistChain;
}

/**
 * 追加任务日志
 * @param {Object} task 任务对象
 * @param {string} message 日志内容
 * @returns {void}
 */
function addLog(task, message) {
  task.logs.push({ time: new Date().toISOString(), message });
  if (task.logs.length > 200) {
    task.logs.splice(0, task.logs.length - 200);
  }
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
    await runUploadPipeline(task, {
      update: (patch) => updateTask(task, patch),
      log: (message) => {
        addLog(task, message);
        updateTask(task, {});
      },
    });
  } catch (err) {
    addLog(task, `任务失败：${err.message}`);
    updateTask(task, { stage: 'FAILED', message: err.message });
  } finally {
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
 * 重试失败的任务（复用本地缓存的 IPA，Apple 流程从头执行）
 * @param {string} taskId 任务 ID
 * @returns {boolean} 是否入队成功
 */
function retry(taskId) {
  const task = findTask(taskId);
  if (!task || task.stage !== 'FAILED') {
    return false;
  }
  task.stage = 'QUEUED';
  task.progress = 0;
  task.uploadedBytes = 0;
  task.message = '重新排队等待中';
  addLog(task, '任务已重新入队');
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
  retry,
  removeTask,
  subscribe,
  listTasks,
  findTask,
  toView,
  broadcast,
};
