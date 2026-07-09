'use strict';

var httpUtil = require('../../server/vercel-http');
var api = require('../../server/report-api');

module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') return httpUtil.handleOptions(res, 'POST, OPTIONS');
  if (req.method !== 'POST') return httpUtil.sendJson(res, 405, { ok: false, error: 'Method not allowed' }, 'POST, OPTIONS');
  try {
    var raw = await httpUtil.readRequestBody(req);
    var payload = raw ? JSON.parse(raw) : (req.body || {});
    httpUtil.sendJson(res, 200, await api.importPlaywrightReport(payload), 'POST, OPTIONS');
  } catch (e) {
    httpUtil.sendJson(res, e.status || 400, { ok: false, error: e.message || String(e) }, 'POST, OPTIONS');
  }
};
