'use strict';

var httpUtil = require('../../server/vercel-http');
var auth = require('../../server/auth');

module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') return httpUtil.handleOptions(res, 'POST, OPTIONS');
  if (req.method !== 'POST') return httpUtil.sendJson(res, 405, { ok: false, error: 'Method not allowed' }, 'POST, OPTIONS');
  try {
    await auth.sendOtp(req, res, httpUtil);
  } catch (e) {
    httpUtil.sendJson(res, e.code === 'CONFIG' ? 503 : 502, { ok: false, error: e.message || String(e) }, 'POST, OPTIONS');
  }
};
