'use strict';

var http = require('http');
var fs = require('fs');
var path = require('path');
var api = require('./report-api');
var cfg = require('./jira-config');
var adoCfg = require('./ado-config');
var adoClient = require('./ado-client');
var httpUtil = require('./vercel-http');
var auth = require('./auth');

var ROOT = path.resolve(__dirname, '..');
var PORT = Number(process.env.REPORT_PORT || 8768);

var MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.ico': 'image/x-icon'
};

function serveStatic(req, res, urlPath) {
  var filePath = path.join(ROOT, decodeURIComponent(urlPath === '/' ? '/NDF-Daily-QA-Report.html' : urlPath));
  if (!filePath.startsWith(ROOT)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }
  fs.readFile(filePath, function (err, data) {
    if (err) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }
    var ext = path.extname(filePath).toLowerCase();
    var headers = { 'Content-Type': MIME[ext] || 'application/octet-stream' };
    if (ext === '.html') {
      headers['Cache-Control'] = 'no-cache, no-store, must-revalidate';
      headers['Pragma'] = 'no-cache';
      headers['Expires'] = '0';
    }
    res.writeHead(200, headers);
    res.end(data);
  });
}

var server = http.createServer(async function (req, res) {
  var url = new URL(req.url, 'http://localhost');

  if (req.method === 'OPTIONS') {
    httpUtil.handleOptions(res);
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/auth/session') {
    httpUtil.sendJson(res, 200, auth.getSessionInfo(req));
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/auth/verify-otp') {
    try {
      var otpRaw = await httpUtil.readRequestBody(req);
      var otpBody = otpRaw ? JSON.parse(otpRaw) : {};
      await auth.verifyOtp(req, res, httpUtil, otpBody);
    } catch (e) {
      httpUtil.sendJson(res, 400, { ok: false, error: e.message || String(e) });
    }
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/auth/logout') {
    auth.logout(req, res, httpUtil);
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/playwright/import') {
    if (!auth.requireAuth(req, res, httpUtil)) return;
    try {
      var raw = await httpUtil.readRequestBody(req);
      var payload = raw ? JSON.parse(raw) : {};
      httpUtil.sendJson(res, 200, await api.importPlaywrightReport(payload));
    } catch (e) {
      httpUtil.sendJson(res, e.status || 400, { ok: false, error: e.message || String(e) });
    }
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/jira/health') {
    if (!auth.requireAuth(req, res, httpUtil)) return;
    httpUtil.sendJson(res, 200, api.getJiraHealth());
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/ado/health') {
    if (!auth.requireAuth(req, res, httpUtil)) return;
    httpUtil.sendJson(res, 200, api.getAdoHealth());
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/jira/issues') {
    if (!auth.requireAuth(req, res, httpUtil)) return;
    try {
      httpUtil.sendJson(res, 200, await api.fetchReportIssues());
    } catch (e) {
      httpUtil.sendJson(res, e.code === 'CONFIG' ? 503 : 502, { ok: false, error: e.message || String(e) });
    }
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/ado/bugs') {
    if (!auth.requireAuth(req, res, httpUtil)) return;
    try {
      httpUtil.sendJson(res, 200, await adoClient.fetchReportBugs());
    } catch (e) {
      httpUtil.sendJson(res, e.code === 'CONFIG' ? 503 : 502, { ok: false, error: e.message || String(e) });
    }
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/ado/test-summary') {
    if (!auth.requireAuth(req, res, httpUtil)) return;
    try {
      var startDate = url.searchParams.get('startDate') || adoCfg.localDateString();
      var endDate = url.searchParams.get('endDate') || adoCfg.localDateString();
      httpUtil.sendJson(res, 200, await adoClient.fetchTestSummary(startDate, endDate));
    } catch (e) {
      httpUtil.sendJson(res, e.code === 'CONFIG' ? 503 : 502, { ok: false, error: e.message || String(e) });
    }
    return;
  }

  if (req.method === 'GET') {
    serveStatic(req, res, url.pathname);
    return;
  }

  res.writeHead(405);
  res.end('Method not allowed');
});

server.listen(PORT, function () {
  console.log('NDF QA report server: http://localhost:' + PORT + '/NDF-Daily-QA-Report.html');
  console.log('Jira API: GET http://localhost:' + PORT + '/api/jira/issues');
  console.log('ADO bugs: GET http://localhost:' + PORT + '/api/ado/bugs');
  console.log('ADO tests: GET http://localhost:' + PORT + '/api/ado/test-summary');
  console.log('Playwright: POST http://localhost:' + PORT + '/api/playwright/import');
  if (auth.isAuthEnabled()) {
    console.log('Auth: Microsoft Authenticator enabled for ' + auth.maskEmail(process.env.AUTH_EMAIL || cfg.JIRA_EMAIL));
    console.log('Login: http://localhost:' + PORT + '/login.html');
  } else {
    console.log('Auth: disabled (set AUTH_SECRET + AUTH_TOTP_SECRET to enable)');
  }
  if (!cfg.JIRA_EMAIL || !cfg.JIRA_API_TOKEN) {
    console.warn('Warning: JIRA_EMAIL / JIRA_API_TOKEN not set — Jira sync will fail until .env is configured.');
  }
  if (!adoCfg.ADO_PAT) {
    console.warn('Warning: ADO_PAT not set — Azure DevOps sync will fail until .env is configured.');
  }
});

server.on('error', function (err) {
  if (err && err.code === 'EADDRINUSE') {
    console.error('Port ' + PORT + ' is already in use. Stop the other process first, then run npm run report:serve again.');
    process.exit(1);
  }
  throw err;
});

module.exports = api;
