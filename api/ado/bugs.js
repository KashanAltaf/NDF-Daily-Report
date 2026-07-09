'use strict';

var guard = require('../../server/api-guard');
var httpUtil = require('../../server/vercel-http');
var adoClient = require('../../server/ado-client');

module.exports = guard(async function handler(req, res) {
  if (req.method !== 'GET') return httpUtil.sendJson(res, 405, { ok: false, error: 'Method not allowed' });
  try {
    httpUtil.sendJson(res, 200, await adoClient.fetchReportBugs());
  } catch (e) {
    httpUtil.sendJson(res, e.code === 'CONFIG' ? 503 : 502, { ok: false, error: e.message || String(e) });
  }
});
