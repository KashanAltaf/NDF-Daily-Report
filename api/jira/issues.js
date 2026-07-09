'use strict';

var httpUtil = require('../../server/vercel-http');
var api = require('../../server/report-api');

module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') return httpUtil.handleOptions(res);
  if (req.method !== 'GET') return httpUtil.sendJson(res, 405, { ok: false, error: 'Method not allowed' });
  try {
    httpUtil.sendJson(res, 200, await api.fetchReportIssues());
  } catch (e) {
    httpUtil.sendJson(res, e.code === 'CONFIG' ? 503 : 502, { ok: false, error: e.message || String(e) });
  }
};
