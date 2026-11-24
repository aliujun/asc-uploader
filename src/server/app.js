'use strict';

const path = require('path');
const express = require('express');

/** 装配 express 应用：静态资源 + 各路由 + 错误兜底 */
function createApp() {
  const app = express();
  // /api/ipa 使用原始流式 body，必须先于 json parser 挂载
  const ipaRoute = require('./routes/ipa');
  app.use('/api/ipa', ipaRoute.router);

  app.use(express.json({ limit: '10mb' }));
  app.use(express.static(path.join(__dirname, '..', '..', 'public')));

  app.use('/api/configs', require('./routes/configs'));
  app.use('/api/settings', require('./routes/settings'));
  app.use('/api/tasks', require('./routes/tasks'));
  app.use('/api/apps', require('./routes/apps'));
  app.use('/api/beta-groups', require('./routes/beta-groups'));
  app.use('/api/certs', require('./routes/certs'));
  app.use('/api/asc-certs', require('./routes/asc-certs'));
  app.use('/api/profiles', require('./routes/profiles'));
  app.use('/api/devices', require('./routes/devices'));
  app.use('/api/identifiers', require('./routes/identifiers'));
  app.use('/api/connectivity', require('./routes/connectivity'));
  app.use('/api/expiry-overview', require('./routes/expiry-overview'));
  app.use('/api/app-versions', require('./routes/app-versions'));
  app.use('/api/version', require('./routes/version').router);

  // 未知 API 路径兜底：返回 JSON 404，避免前端 api() 把 HTML 错误页当 JSON 解析报错
  app.use('/api', (req, res) => {
    res.status(404).json({ error: `接口不存在：${req.method} ${req.originalUrl}` });
  });

  // JSON 解析错误兜底
  app.use((err, req, res, next) => {
    if (res.headersSent) {
      next(err);
      return;
    }
    if (err.type === 'entity.parse.failed') {
      res.status(400).json({ error: '请求体不是合法 JSON' });
      return;
    }
    res.status(500).json({ error: err.message || '服务器内部错误' });
  });

  return app;
}

module.exports = { createApp };
