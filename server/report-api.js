'use strict';

var cfg = require('./jira-config');
var jiraParse = require('./jira-parse');
var adoCfg = require('./ado-config');
var adoClient = require('./ado-client');
var playwrightParser = require('./playwright-report-parser');

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
    var err = new Error('Jira credentials missing. Set JIRA_EMAIL and JIRA_API_TOKEN in environment variables.');
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
  var buckets = bucketIssues(trackerIssues);
  var defectLogIssues = mergeIssuesByKey(openToDoIssues, mergeIssuesByKey(todayDefectIssues, mergeIssuesByKey(fixedTodayIssues, mergeIssuesByKey(canceledTodayIssues, mergeIssuesByKey(todayIssues, buckets.retest || [])))));
  defectLogIssues = defectLogIssues.filter(function (issue) {
    if (isFixedStatus(issue.status)) return !!fixedTodayKeys[issue.key];
    var s = normalizeStatusName(issue.status);
    if (s === 'canceled' || s === 'cancelled') return !!canceledTodayKeys[issue.key];
    return true;
  });

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
    enhancementsSince: cfg.ENHANCEMENTS_SINCE,
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

function getJiraHealth() {
  return {
    ok: true,
    configured: !!(cfg.JIRA_EMAIL && cfg.JIRA_API_TOKEN),
    baseUrl: cfg.JIRA_BASE_URL,
    project: cfg.JIRA_PROJECT
  };
}

function getAdoHealth() {
  return {
    ok: true,
    configured: !!adoCfg.ADO_PAT,
    org: adoCfg.ADO_ORG,
    project: adoCfg.ADO_PROJECT
  };
}

async function importPlaywrightReport(payload) {
  var parsed = playwrightParser.parsePlaywrightUpload(payload.report || payload.json || payload.html || payload);
  if (!parsed.rows || !parsed.rows.length) {
    var err = new Error(parsed.error || 'No test results found in Playwright report. Upload playwright-report/index.html or report.json.');
    err.status = 400;
    throw err;
  }
  return { ok: true, rows: parsed.rows, total: parsed.rows.length };
}

module.exports = {
  fetchReportIssues: fetchReportIssues,
  getJiraHealth: getJiraHealth,
  getAdoHealth: getAdoHealth,
  importPlaywrightReport: importPlaywrightReport,
  bucketForStatus: bucketForStatus,
  isFixedStatus: isFixedStatus,
  isClosedStatus: isClosedStatus,
  mapIssue: mapIssue
};
