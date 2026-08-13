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
  var rawSummary = f.summary || '';
  var parsed = jiraParse.parseSummaryModule(rawSummary);
  var githubPrUrl = jiraParse.extractPrUrl(f, cfg.GITHUB_PR_URL_UAT_FIELD);
  var issueType = f.issuetype && f.issuetype.name ? f.issuetype.name : '';
  var projectKey = (f.project && f.project.key) || String(issue.key || '').split('-')[0] || '';
  var moduleName = parsed.module || '';
  if (projectKey !== 'PB') moduleName = moduleName || cfg.defaultModuleForProject(projectKey) || '';
  return {
    key: issue.key,
    id: issue.id || '',
    url: cfg.browseUrl(issue.key),
    summary: parsed.summary || rawSummary,
    rawSummary: rawSummary,
    module: moduleName,
    project: projectKey,
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
  if (s === 'todo' || s === 'bugissue' || s === 'inprogress' || s === 'uatdeployment' || s === 'uatmergeissue') return 'open';
  if (s === 'createprdpr' || s === 'done') return 'fixed';
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

function isDoneStatus(statusName) {
  return normalizeStatusName(statusName) === 'done';
}

/** Done must be from today (status change or created today); Create-PRD-PR uses the same fixedToday key set */
function isEligibleFixedIssue(issue, fixedTodayKeys) {
  if (!issue || !isFixedStatus(issue.status)) return false;
  return !!(fixedTodayKeys && fixedTodayKeys[issue.key]);
}

async function jiraSearch(jql) {
  var auth = jiraAuthHeader();
  if (!auth) {
    var err = new Error('Jira credentials missing. Set JIRA_EMAIL and JIRA_API_TOKEN in environment variables.');
    err.code = 'CONFIG';
    throw err;
  }

  var fields = ['summary', 'status', 'priority', 'description', 'issuelinks', 'assignee', 'reporter', 'created', 'updated', 'issuetype', 'project', cfg.GITHUB_PR_URL_UAT_FIELD];
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

var prUrlCache = {};

function applyPrUrl(issue, url) {
  if (!issue || !url) return;
  issue.githubPrUrl = url;
  issue.prUrl = url;
  issue.prLabel = jiraParse.formatPrLinkLabel(url, issue.key);
}

async function fetchRemotePrUrl(issueKey) {
  var auth = jiraAuthHeader();
  if (!auth || !issueKey) return '';
  var res = await fetch(cfg.JIRA_BASE_URL + '/rest/api/3/issue/' + encodeURIComponent(issueKey) + '/remotelink', {
    headers: { Authorization: auth, Accept: 'application/json' }
  });
  if (!res.ok) return '';
  var links = await res.json();
  if (!Array.isArray(links)) return '';
  for (var i = 0; i < links.length; i++) {
    var obj = links[i] && links[i].object ? links[i].object : links[i];
    var url = (obj && (obj.url || obj.href)) || '';
    if (jiraParse.isPullRequestUrl(url)) return url;
  }
  return '';
}

async function fetchDevStatusPrUrl(issueId) {
  var auth = jiraAuthHeader();
  if (!auth || !issueId) return '';
  var urls = [
    cfg.JIRA_BASE_URL + '/rest/dev-status/latest/issue/detail?issueId=' + encodeURIComponent(issueId) + '&applicationType=GitHub&dataType=pullrequest',
    cfg.JIRA_BASE_URL + '/rest/dev-status/1.0/issue/detail?issueId=' + encodeURIComponent(issueId) + '&applicationType=GitHub&dataType=pullrequest'
  ];
  for (var i = 0; i < urls.length; i++) {
    try {
      var res = await fetch(urls[i], {
        headers: { Authorization: auth, Accept: 'application/json' }
      });
      if (!res.ok) continue;
      var data = await res.json();
      var details = data && data.detail ? data.detail : [];
      for (var d = 0; d < details.length; d++) {
        var prs = (details[d] && details[d].pullRequests) || [];
        for (var p = 0; p < prs.length; p++) {
          var url = prs[p] && (prs[p].url || prs[p].href);
          if (jiraParse.isPullRequestUrl(url)) return url;
        }
      }
    } catch (e) {}
  }
  return '';
}

async function enrichIssueWithPrUrl(issue) {
  if (!issue || issue.prUrl) return issue;
  if (Object.prototype.hasOwnProperty.call(prUrlCache, issue.key)) {
    applyPrUrl(issue, prUrlCache[issue.key]);
    return issue;
  }
  var url = '';
  try { url = await fetchRemotePrUrl(issue.key); } catch (e) { url = ''; }
  if (!url) {
    try { url = await fetchDevStatusPrUrl(issue.id); } catch (e) { url = ''; }
  }
  prUrlCache[issue.key] = url || '';
  applyPrUrl(issue, url);
  return issue;
}

async function enrichIssuesWithPrUrls(issues) {
  var list = issues || [];
  var pending = [];
  for (var i = 0; i < list.length; i++) {
    if (list[i] && !list[i].prUrl) pending.push(enrichIssueWithPrUrl(list[i]));
  }
  if (pending.length) await Promise.all(pending);
  return list;
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
  prUrlCache = {};
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
  // Sales Portal / KYC titles that start with "Enhancement" belong in enhancement tables even if Jira status is still open.
  function isSalesPortalEnhancementIssue(issue) {
    if (!issue || String(issue.project || '').toUpperCase() !== 'PB') return false;
    var raw = String(issue.rawSummary || issue.summary || '').toLowerCase();
    var moduleName = String(issue.module || '').toLowerCase();
    var title = String(issue.summary || '').replace(/^\[[^\]]+\]\s*[-–—]?\s*/, '').trim().toLowerCase();
    if (!/^enhancement\b/.test(title) && raw.indexOf('enhancement') < 0) return false;
    return /sales\s*portal/.test(moduleName + ' ' + raw) || /\bkyc\b/.test(moduleName + ' ' + raw);
  }
  function mergeSalesPortalEnhancementsFrom(list) {
    (list || []).forEach(function (issue) {
      if (isSalesPortalEnhancementIssue(issue)) enhancementIssues = mergeIssuesByKey(enhancementIssues, [issue]);
    });
  }
  mergeSalesPortalEnhancementsFrom(todayIssues);
  mergeSalesPortalEnhancementsFrom(openToDoIssues);
  mergeSalesPortalEnhancementsFrom(todayDefectIssues);
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
  // Historical Done must never enter the tracker/defect pipeline; only today's Done (fixedTodayKeys)
  trackerIssues = trackerIssues.filter(function (issue) {
    if (!isDoneStatus(issue.status)) return true;
    return !!fixedTodayKeys[issue.key];
  });
  var buckets = bucketIssues(trackerIssues);
  var defectLogIssues = mergeIssuesByKey(openToDoIssues, mergeIssuesByKey(todayDefectIssues, mergeIssuesByKey(fixedTodayIssues, mergeIssuesByKey(canceledTodayIssues, mergeIssuesByKey(todayIssues, buckets.retest || [])))));
  defectLogIssues = defectLogIssues.filter(function (issue) {
    if (isFixedStatus(issue.status)) return isEligibleFixedIssue(issue, fixedTodayKeys);
    var s = normalizeStatusName(issue.status);
    if (s === 'canceled' || s === 'cancelled') return !!canceledTodayKeys[issue.key];
    return true;
  });
  mergeSalesPortalEnhancementsFrom(trackerIssues);
  mergeSalesPortalEnhancementsFrom(defectLogIssues);
  // Drop any non-today Done tasks from enhancements
  enhancementIssues = enhancementIssues.filter(function (issue) {
    if (!isDoneStatus(issue.status)) return true;
    return !!enhancementFixedTodayKeys[issue.key];
  });

  try {
    await enrichIssuesWithPrUrls(todayIssues);
    await enrichIssuesWithPrUrls(openToDoIssues);
    await enrichIssuesWithPrUrls(todayDefectIssues);
    await enrichIssuesWithPrUrls(fixedTodayIssues);
    await enrichIssuesWithPrUrls(canceledTodayIssues);
    await enrichIssuesWithPrUrls(enhancementIssues);
    await enrichIssuesWithPrUrls(regressionIssues);
    await enrichIssuesWithPrUrls(trackerIssues);
    await enrichIssuesWithPrUrls(defectLogIssues);
  } catch (e) {}

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
    project: cfg.JIRA_PROJECT,
    projects: cfg.JIRA_PROJECTS
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
