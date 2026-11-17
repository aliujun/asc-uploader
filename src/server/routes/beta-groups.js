'use strict';

const express = require('express');
const { createClient } = require('../../core/asc-client');

const router = express.Router();

/**
 * GET /api/beta-groups?configId=xx 获取测试组列表
 * @returns {void}
 */
router.get('/', async (req, res) => {
  const configId = req.query.configId;
  if (!configId) {
    res.status(400).json({ error: '缺少 configId 参数' });
    return;
  }
  try {
    const data = await createClient(String(configId)).listBetaGroups();
    const groups = (data.data || []).map((group) => ({
      id: group.id,
      name: group.attributes.name,
      isInternalGroup: group.attributes.isInternalGroup,
    }));
    res.json({ groups });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

module.exports = router;
