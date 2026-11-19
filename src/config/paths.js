'use strict';

const path = require('path');
const os = require('os');
const fs = require('fs').promises;

/** 数据目录下的子目录名 */
const SUB_DIRS = {
  keys: 'keys',
  certs: 'certs',
  ipaCache: 'ipa-cache',
  backups: 'backups',
};

/**
 * 解析运行期数据根目录。
 * 优先读取环境变量 ASC_UPLOADER_HOME（绿色便携模式），默认 %USERPROFILE%\.asc-uploader
 * @returns {string} 数据根目录绝对路径
 */
function resolveHomeDir() {
  const custom = process.env.ASC_UPLOADER_HOME;
  if (custom && custom.trim() !== '') {
    return path.resolve(custom.trim());
  }
  return path.join(os.homedir(), '.asc-uploader');
}

/**
 * 获取数据根目录下的某个子目录绝对路径
 * @param {keyof typeof SUB_DIRS} [name] 子目录名，不传则返回根目录
 * @returns {string} 目录绝对路径
 */
function getDir(name) {
  const home = resolveHomeDir();
  if (!name) {
    return home;
  }
  const sub = SUB_DIRS[name];
  if (!sub) {
    throw new Error(`未知的子目录类型: ${name}`);
  }
  return path.join(home, sub);
}

/**
 * 确保数据目录及子目录存在
 * @returns {Promise<void>}
 */
async function ensureDirs() {
  const targets = [getDir(), getDir('keys'), getDir('certs'), getDir('ipaCache'), getDir('backups')];
  await Promise.all(targets.map((dir) => fs.mkdir(dir, { recursive: true })));
}

module.exports = { getDir, ensureDirs };
