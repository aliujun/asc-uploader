'use strict';

/**
 * 终端 ANSI 样式工具。
 * 输出重定向到文件等非 TTY 场景自动降级为纯文本，避免日志文件出现乱码。
 */
const enabled = Boolean(process.stdout.isTTY);

/**
 * 用 ANSI 颜色码包装文本
 * @param {string} text 文本
 * @param {string} code ANSI 颜色码
 * @returns {string} 着色后的文本
 */
function wrap(text, code) {
  return enabled ? `\x1b[${code}m${text}\x1b[0m` : String(text);
}

module.exports = {
  /** 红色（错误/失败） */
  red: (t) => wrap(t, '31'),
  /** 绿色（成功） */
  green: (t) => wrap(t, '32'),
  /** 黄色（警告/重试/中断） */
  yellow: (t) => wrap(t, '33'),
  /** 蓝色（链接/流程） */
  blue: (t) => wrap(t, '34'),
  /** 青色（模块标记/标题） */
  cyan: (t) => wrap(t, '36'),
  /** 灰色（次要信息/高频日志） */
  gray: (t) => wrap(t, '90'),
  /** 粗体（标题） */
  bold: (t) => wrap(t, '1'),
  /**
   * 计算字符串在终端中的显示宽度（中文等全宽字符占 2 列）
   * @param {string} text 文本
   * @returns {number} 显示宽度
   */
  displayWidth(text) {
    let width = 0;
    for (const ch of String(text)) {
      width += ch.charCodeAt(0) > 0xff ? 2 : 1;
    }
    return width;
  },
};
