'use strict';

var http = require('http');
var fs = require('fs');
var path = require('path');
var cfg = require('./jira-config');
var jiraParse = require('./jira-parse');
var adoCfg = require('./ado-config');
var adoClient = require('./ado-client');
var playwrightParser = require('./playwright-report-parser');

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

function sendJson(res, status, body, methods) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': methods || 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  });
  res.end(JSON.stringify(body));
}

function readRequestBody(req) {
  return new Promise(function (resolve, reject) {
    var chunks = [];
    req.on('data', function (chunk) { chunks.push(chunk); });
    req.on('end', function () {
      resolve(Buffer.concat(chunks).toString('utf8'));
    });
    req.on('error', reject);
  });
}

function jiraAuthHeader() {
  if (!cfg.JIRA_EMAIL || !cfg.JIRA_API_TOKEN) return null;
  return 'Basic ' + Buffer.from(cfg.JIRA_EMAIL + ':' + cfg.JIRA_API_TOKEN).toString('base64');
}

function mapIssue(issue) {
  var f = issue.fields || {};
  var status = f.status && f.status.name ? f.status.name : '';
  var priority = f.priority && f.priority.name ? f.priority.name : '';
  var assignee = f.assignee && f.assignee.displayName ? f.assignee.displayName : '';
  var reporter = f.reporter && f.reporter.displayName ? f.reporter.displayName : '';
  var parsed = jiraParse.parseSummaryModule(f.summary || '');
  var githubPrUrl = jiraParse.extractUrlField(f[cfg.GITHUB_PR_URL_UAT_FIELD]);
  var issueType = f.issuetype && f.issuetype.name ? f.issuetype.name : '';
  return {
    key: issue.key,
    url: cfg.browseUrl(issue.key),
    summary: parsed.summary,
    module: parsed.module,
    status: status,
    issueType: issueType,
    priority: priority,
    severity: jiraParse.priorityToSeverity(priority),
    reproSteps: jiraParse.extractReproSteps(f.description),
    assignee: assignee,
    reporter: reporter,
    created: f.created || '',
    updated: f.updated || '',
    timestamp: jiraParse.formatIssueDate(f.created || f.updated),
    githubPrUrl: githubPrUrl,
    prUrl: githubPrUrl,
    prLabel: githubPrUrl ? jiraParse.formatPrLinkLabel(githubPrUrl, issue.key) : '',
    source: 'jira'
  };
}

function normalizeStatusName(name) {
  return String(name || '').replace(/[\s_\-\/]+/g, '').trim().toLowerCase();
}

function bucketForStatus(statusName) {
  var s = normalizeStatusName(statusName);
  if (s === 'todo' || s === 'bugissue') return 'open';
  if (s === 'createprdpr') return 'fixed';
  if (s === 'uattesting') return 'retest';
  if (s === 'uatprapproval' || s === 'canceled' || s === 'cancelled') return 'closed';
  return 'other';
}

function isExcludedStatus(statusName) {
  return bucketForStatus(statusName) === 'closed';
}

function filterReportIssues(issues) {
  return (issues || []).filter(function (issue) {
    return !isExcludedStatus(issue.status);
  });
}

function isClosedStatus(statusName) {
  return bucketForStatus(statusName) === 'closed';
}

function isFixedStatus(statusName) {
  return bucketForStatus(statusName) === 'fixed';
}

async function jiraSearch(jql) {
  var auth = jiraAuthHeader();
  if (!auth) {
    var err = new Error('Jira credentials missing. Set JIRA_EMAIL and JIRA_API_TOKEN in .env');
    err.code = 'CONFIG';
    throw err;
  }

  var fields = ['summary', 'status', 'priority', 'description', 'assignee', 'reporter', 'created', 'updated', 'issuetype', cfg.GITHUB_PR_URL_UAT_FIELD];
  var attempts = [
    {
      url: cfg.JIRA_BASE_URL + '/rest/api/3/search/jql',
      body: { jql: jql, maxResults: 100, fields: fields }
    },
    {
      url: cfg.JIRA_BASE_URL + '/rest/api/3/search',
      body: { jql: jql, maxResults: 100, fields: fields }
    }
  ];

  var lastErr = null;
  for (var i = 0; i < attempts.length; i++) {
    try {
      var res = await fetch(attempts[i].url, {
        method: 'POST',
        headers: {
          Authorization: auth,
          Accept: 'application/json',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(attempts[i].body)
      });
      var text = await res.text();
      var data;
      try { data = JSON.parse(text); } catch (e) { data = { raw: text }; }
      if (!res.ok) {
        lastErr = new Error((data.errorMessages && data.errorMessages.join('; ')) || data.message || text || res.statusText);
        continue;
      }
      return (data.issues || []).map(mapIssue);
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error('Jira search failed');
}

function mergeIssuesByKey(primary, secondary) {
  var map = {};
  (primary || []).forEach(function (issue) { map[issue.key] = issue; });
  (secondary || []).forEach(function (issue) { map[issue.key] = issue; });
  return Object.keys(map).map(function (key) { return map[key]; });
}

function bucketIssues(issues) {
  var buckets = { open: [], fixed: [], retest: [], closed: [], other: [] };
  (issues || []).forEach(function (issue) {
    var bucket = bucketForStatus(issue.status);
    if (buckets[bucket]) buckets[bucket].push(issue);
    else buckets.other.push(issue);
  });
  return buckets;
}

async function fetchReportIssues() {
  var todayJqlStr = cfg.todayJql();
  var openJqlStr = cfg.openBugsJql();
  var todayDefectJqlStr = cfg.todayDefectLogJql();
  var fixedTodayJqlStr = cfg.fixedTodayJql();
  var canceledTodayJqlStr = cfg.canceledTodayJql();
  var enhancementsJqlStr = cfg.enhancementsJql();
  var enhancementsFixedTodayJqlStr = cfg.enhancementsFixedTodayJql();
  var regressionJqlStr = cfg.regressionBugsJql();
  var activeJqlStr = cfg.activeBugsJql();

  var todayIssues = filterReportIssues(await jiraSearch(todayJqlStr));
  var openToDoIssues = filterReportIssues(await jiraSearch(openJqlStr));
  var todayDefectIssues = filterReportIssues(await jiraSearch(todayDefectJqlStr));
  var fixedTodayIssues = filterReportIssues(await jiraSearch(fixedTodayJqlStr));
  var canceledTodayIssues = await jiraSearch(canceledTodayJqlStr);
  var enhancementIssues = await jiraSearch(enhancementsJqlStr);
  var enhancementFixedTodayIssues = await jiraSearch(enhancementsFixedTodayJqlStr);
  enhancementFixedTodayIssues.forEach(function (issue) {
    issue.fixedToday = true;
    issue.timestamp = jiraParse.formatIssueDate(issue.updated || issue.created);
  });
  var enhancementFixedTodayKeys = {};
  enhancementFixedTodayIssues.forEach(function (issue) { enhancementFixedTodayKeys[issue.key] = true; });
  enhancementIssues = mergeIssuesByKey(enhancementIssues, enhancementFixedTodayIssues);
  enhancementIssues = enhancementIssues.filter(function (issue) {
    var type = String(issue.issueType || '').trim().toLowerCase();
    if (type !== 'task' || !isFixedStatus(issue.status)) return true;
    return !!enhancementFixedTodayKeys[issue.key];
  });
  var regressionIssues = filterReportIssues(await jiraSearch(regressionJqlStr));
  regressionIssues.forEach(function (issue) { issue.regression = true; });
  var trackerIssues = filterReportIssues(await jiraSearch(activeJqlStr));
  fixedTodayIssues.forEach(function (issue) {
    issue.fixedToday = true;
    issue.timestamp = jiraParse.formatIssueDate(issue.updated || issue.created);
  });
  canceledTodayIssues.forEach(function (issue) {
    issue.canceledToday = true;
    issue.timestamp = jiraParse.formatIssueDate(issue.updated || issue.created);
  });
  var fixedTodayKeys = {};
  fixedTodayIssues.forEach(function (issue) { fixedTodayKeys[issue.key] = true; });
  var canceledTodayKeys = {};
  canceledTodayIssues.forEach(function (issue) { canceledTodayKeys[issue.key] = true; });
  var defectLogIssues = mergeIssuesByKey(openToDoIssues, mergeIssuesByKey(todayDefectIssues, mergeIssuesByKey(fixedTodayIssues, mergeIssuesByKey(canceledTodayIssues, todayIssues))));
  defectLogIssues = defectLogIssues.filter(function (issue) {
    if (isFixedStatus(issue.status)) return !!fixedTodayKeys[issue.key];
    var s = normalizeStatusName(issue.status);
    if (s === 'canceled' || s === 'cancelled') return !!canceledTodayKeys[issue.key];
    return true;
  });
  var buckets = bucketIssues(trackerIssues);

  return {
    fetchedAt: new Date().toISOString(),
    jql: todayJqlStr,
    openBugsJql: openJqlStr,
    todayDefectLogJql: todayDefectJqlStr,
    fixedTodayJql: fixedTodayJqlStr,
    canceledTodayJql: canceledTodayJqlStr,
    enhancementsJql: enhancementsJqlStr,
    enhancementsFixedTodayJql: enhancementsFixedTodayJqlStr,
    regressionBugsJql: regressionJqlStr,
    activeBugsJql: activeJqlStr,
    openBugsSince: cfg.OPEN_BUGS_SINCE,
    total: todayIssues.length,
    todayTotal: todayIssues.length,
    openTotal: openToDoIssues.length,
    fixedTodayTotal: fixedTodayIssues.length,
    canceledTodayTotal: canceledTodayIssues.length,
    enhancementTotal: enhancementIssues.length,
    defectLogTotal: defectLogIssues.length,
    regressionTotal: regressionIssues.length,
    activeTotal: trackerIssues.length,
    todayIssues: todayIssues,
    openToDoIssues: openToDoIssues,
    openIssues: openToDoIssues,
    todayDefectIssues: todayDefectIssues,
    fixedTodayIssues: fixedTodayIssues,
    canceledTodayIssues: canceledTodayIssues,
    enhancementIssues: enhancementIssues,
    defectLogIssues: defectLogIssues,
    regressionIssues: regressionIssues,
    trackerIssues: trackerIssues,
    issues: defectLogIssues,
    activeIssues: trackerIssues,
    buckets: buckets,
    statusMap: cfg.STATUS,
    closedStatuses: cfg.EXCLUDED_STATUSES
  };
}

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
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    });
    res.end();
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/playwright/import') {
    try {
      var raw = await readRequestBody(req);
      var payload = raw ? JSON.parse(raw) : {};
      var parsed = playwrightParser.parsePlaywrightUpload(payload.report || payload.json || payload.html || payload);
      if (!parsed.rows || !parsed.rows.length) {
        sendJson(res, 400, {
          ok: false,
          error: parsed.error || 'No test results found in Playwright report. Upload playwright-report/index.html or report.json.'
        });
        return;
      }
      sendJson(res, 200, { ok: true, rows: parsed.rows, total: parsed.rows.length });
    } catch (e) {
      sendJson(res, 400, { ok: false, error: e.message || String(e) });
    }
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/jira/health') {
    sendJson(res, 200, {
      ok: true,
      configured: !!(cfg.JIRA_EMAIL && cfg.JIRA_API_TOKEN),
      baseUrl: cfg.JIRA_BASE_URL,
      project: cfg.JIRA_PROJECT
    });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/ado/health') {
    sendJson(res, 200, {
      ok: true,
      configured: !!adoCfg.ADO_PAT,
      org: adoCfg.ADO_ORG,
      project: adoCfg.ADO_PROJECT
    });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/jira/issues') {
    try {
      sendJson(res, 200, await fetchReportIssues());
    } catch (e) {
      sendJson(res, e.code === 'CONFIG' ? 503 : 502, { ok: false, error: e.message || String(e) });
    }
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/ado/bugs') {
    try {
      sendJson(res, 200, await adoClient.fetchReportBugs());
    } catch (e) {
      sendJson(res, e.code === 'CONFIG' ? 503 : 502, { ok: false, error: e.message || String(e) });
    }
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/ado/test-summary') {
    try {
      var startDate = url.searchParams.get('startDate') || adoCfg.localDateString();
      var endDate = url.searchParams.get('endDate') || adoCfg.localDateString();
      sendJson(res, 200, await adoClient.fetchTestSummary(startDate, endDate));
    } catch (e) {
      sendJson(res, e.code === 'CONFIG' ? 503 : 502, { ok: false, error: e.message || String(e) });
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

module.exports = { fetchReportIssues, bucketForStatus, isFixedStatus, isClosedStatus, mapIssue };
