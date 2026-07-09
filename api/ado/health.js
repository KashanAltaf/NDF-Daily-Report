'use strict';

var guard = require('../../server/api-guard');
var httpUtil = require('../../server/vercel-http');
var api = require('../../server/report-api');

module.exports = guard(async function handler(req, res) {
  if (req.method !== 'GET') return httpUtil.sendJson(res, 405, { ok: false, error: 'Method not allowed' });
  httpUtil.sendJson(res, 200, api.getAdoHealth());
});
