#!/usr/bin/env node
'use strict';

const { exec } = require('child_process');
const http = require('http');
const { createApp } = require('./server/app');
const { loadTasks } = require('./tasks/task-manager');
const term = require('./core/term');
const { getDir } = require('./config/paths');
const { version } = require('../package.json');

// 运行时进程/终端窗口标题（pkg 打包后 exe 文件名为 AppStore应用上架助手.exe）
process.title = 'App Store应用上架助手';

/** 起始端口 */
const START_PORT = 8380;

/** 端口探测最大尝试次数 */
const MAX_PORT_TRIES = 10;

/**
 * 打印命令行帮助
 * @returns {void}
 */
function printHelp() {
	console.log(term.bold(`App Store应用上架助手 v${version}`));
	console.log('');
	console.log('用法：asc-uploader [选项]');
	console.log('');
	console.log('选项：');
	console.log('  --port <n>     指定起始端口（默认 8380，被占自动顺延）');
	console.log('  --no-open      启动后不自动打开浏览器');
	console.log('  -h, --help     显示帮助');
	console.log('  -v, --version  显示版本号');
	console.log('');
	console.log('启动后所有操作在浏览器界面中完成（上传 / 配置管理 / Build / 证书工具 / 连通性）。');
	console.log(`数据目录：${getDir()}（可用环境变量 ASC_UPLOADER_HOME 自定义）`);
}

/**
 * 解析命令行参数（--help/--version 时打印后直接退出）
 * @param {string[]} argv process.argv.slice(2)
 * @returns {{port: number, noOpen: boolean}} 运行选项
 */
function parseArgs(argv) {
	const opts = { port: START_PORT, noOpen: false };
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === '-h' || arg === '--help') {
			printHelp();
			process.exit(0);
		}
		if (arg === '-v' || arg === '--version') {
			console.log(version);
			process.exit(0);
		}
		if (arg === '--port') {
			const port = Number(argv[i + 1]);
			if (!Number.isInteger(port) || port < 1 || port > 65535) {
				console.error(`--port 需要一个 1-65535 的端口号，收到：${argv[i + 1] ?? '(无)'}`);
				process.exit(1);
			}
			opts.port = port;
			i += 1;
			continue;
		}
		if (arg === '--no-open') {
			opts.noOpen = true;
			continue;
		}
		console.error(`未知参数：${arg}`);
		printHelp();
		process.exit(1);
	}
	return opts;
}

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
 * 打印启动横幅（青色圆角框 + 居中标题 + 服务信息）
 * @param {string} url 本地服务地址
 * @returns {void}
 */
function printBanner(url) {
	const inner = `App Store应用上架助手  v${version}`;
	const width = term.displayWidth(inner) + 10;
	const pad = Math.floor((width - term.displayWidth(inner)) / 2);
	console.log(term.cyan(`╭${'─'.repeat(width)}╮`));
	console.log(`${term.cyan('│')}${' '.repeat(pad)}${term.bold(term.cyan(inner))}${' '.repeat(width - pad - term.displayWidth(inner))}${term.cyan('│')}`);
	console.log(term.cyan(`╰${'─'.repeat(width)}╯`));
	console.log(`  ${term.green('➜')} 本地服务  ${term.blue(url)}`);
	console.log(`  ${term.green('➜')} 数据目录  ${term.gray(getDir())}`);
	console.log(term.gray('─'.repeat(width + 2)));
}

/**
 * 探测端口并启动服务
 * @returns {Promise<void>}
 */
async function main() {
	const opts = parseArgs(process.argv.slice(2));
	await loadTasks();
	const app = createApp();

	for (let i = 0; i < MAX_PORT_TRIES; i++) {
		const port = opts.port + i;
		const ok = await tryListen(app, port);
		if (!ok) {
			continue;
		}
		const url = `http://localhost:${port}`;
		printBanner(url);
		if (!opts.noOpen) {
			openBrowser(url);
		}
		return;
	}
	console.error(`端口 ${opts.port}-${opts.port + MAX_PORT_TRIES - 1} 均被占用，启动失败`);
	process.exit(1);
}

/**
 * 尝试在指定端口监听，成功后保持监听状态
 * @param {import('express').Express} app express 应用
 * @param {number} port 端口
 * @returns {Promise<boolean>} 是否成功
 */
function tryListen(app, port) {
	return new Promise(resolve => {
		const server = http.createServer(app);
		server.once('error', () => resolve(false));
		server.once('listening', () => resolve(true));
		server.listen(port);
	});
}

main().catch(err => {
	console.error('启动失败：', err.message);
	process.exit(1);
});
