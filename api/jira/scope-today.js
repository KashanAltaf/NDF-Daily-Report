'use strict';

var guard = require('../../server/api-guard');
var httpUtil = require('../../server/vercel-http');
var api = require('../../server/report-api');

module.exports = guard(async function handler(req, res) {
  if (req.method !== 'GET') return httpUtil.sendJson(res, 405, { ok: false, error: 'Method not allowed' });
  try {
    var issues = await api.fetchScopeVerifiedToday();
    var titles = [];
    var seen = {};
    (issues || []).forEach(function (issue) {
      var title = String((issue && (issue.summary || issue.rawSummary)) || '').replace(/\s+/g, ' ').trim();
      if (!title || seen[title]) return;
      seen[title] = true;
      titles.push(title);
    });
    httpUtil.sendJson(res, 200, {
      ok: true,
      scopeVerifiedTodayIssues: issues || [],
      scopeText: titles.map(function (t) { return '\u2022 ' + t; }).join('\n'),
      total: titles.length
    });
  } catch (e) {
    httpUtil.sendJson(res, e.code === 'CONFIG' ? 503 : 502, { ok: false, error: e.message || String(e) });
  }
});
