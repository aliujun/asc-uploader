'use strict';

const { exec } = require('child_process');
const http = require('http');
const { createApp } = require('./server/app');
const { loadTasks } = require('./tasks/task-manager');

/** 起始端口 */
const START_PORT = 8380;

/** 端口探测最大尝试次数 */
const MAX_PORT_TRIES = 10;

/**
 * 打开系统默认浏览器
 * @param {string} url 目标地址
 * @returns {void}
 */
function openBrowser(url) {
  if (process.platform === 'win32') {
    exec(`start "" "${url}"`);
    return;
  }
  if (process.platform === 'darwin') {
    exec(`open "${url}"`);
    return;
  }
  exec(`xdg-open "${url}"`);
}

/**
 * 探测端口并启动服务
 * @returns {Promise<void>}
 */
async function main() {
  await loadTasks();
  const app = createApp();

  for (let i = 0; i < MAX_PORT_TRIES; i++) {
    const port = START_PORT + i;
    const ok = await tryListen(app, port);
    if (!ok) {
      continue;
    }
    const url = `http://localhost:${port}`;
    console.log(`应用上架助手 已启动：${url}`);
    console.log('按 Ctrl+C 停止服务');
    openBrowser(url);
    return;
  }
  console.error(`端口 ${START_PORT}-${START_PORT + MAX_PORT_TRIES - 1} 均被占用，启动失败`);
  process.exit(1);
}

/**
 * 尝试在指定端口监听，成功后保持监听状态
 * @param {import('express').Express} app express 应用
 * @param {number} port 端口
 * @returns {Promise<boolean>} 是否成功
 */
function tryListen(app, port) {
  return new Promise((resolve) => {
    const server = http.createServer(app);
    server.once('error', () => resolve(false));
    server.once('listening', () => resolve(true));
    server.listen(port);
  });
}

main().catch((err) => {
  console.error('启动失败：', err.message);
  process.exit(1);
});
