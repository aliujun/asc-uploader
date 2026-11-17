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
  app.use('/api/connectivity', require('./routes/connectivity'));

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
