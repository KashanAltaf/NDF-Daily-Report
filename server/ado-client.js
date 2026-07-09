'use strict';

var cfg = require('./ado-config');
var jiraParse = require('./jira-parse');

function authHeader() {
  if (!cfg.ADO_PAT) return null;
  return 'Basic ' + Buffer.from(':' + cfg.ADO_PAT).toString('base64');
}

async function adoFetch(path, options) {
  var auth = authHeader();
  if (!auth) {
    var err = new Error('Azure DevOps credentials missing. Set ADO_PAT in .env');
    err.code = 'CONFIG';
    throw err;
  }
  var url = cfg.projectBaseUrl() + path;
  var res = await fetch(url, Object.assign({}, options || {}, {
    headers: Object.assign({
      Authorization: auth,
      Accept: 'application/json'
    }, (options && options.headers) || {})
  }));
  var text = await res.text();
  var data;
  try { data = JSON.parse(text); } catch (e) { data = { raw: text }; }
  if (!res.ok) {
    var msg = (data.message || data.value || text || res.statusText);
    throw new Error(typeof msg === 'string' ? msg : JSON.stringify(msg));
  }
  return data;
}

async function adoFetchWithHeaders(path, options) {
  var auth = authHeader();
  if (!auth) {
    var err = new Error('Azure DevOps credentials missing. Set ADO_PAT in .env');
    err.code = 'CONFIG';
    throw err;
  }
  var url = cfg.projectBaseUrl() + path;
  var res = await fetch(url, Object.assign({}, options || {}, {
    headers: Object.assign({
      Authorization: auth,
      Accept: 'application/json'
    }, (options && options.headers) || {})
  }));
  var text = await res.text();
  var data;
  try { data = JSON.parse(text); } catch (e) { data = { raw: text }; }
  if (!res.ok) {
    var msg = (data.message || data.value || text || res.statusText);
    throw new Error(typeof msg === 'string' ? msg : JSON.stringify(msg));
  }
  return { data: data, continuationToken: res.headers.get('x-ms-continuationtoken') };
}

function priorityLabel(value) {
  var n = Number(value);
  if (n === 1) return 'Critical';
  if (n === 2) return 'High';
  if (n === 3) return 'Medium';
  if (n === 4) return 'Low';
  return String(value || '');
}

function priorityToSeverity(priority) {
  var p = String(priority || '').toLowerCase().trim();
  if (/critical|blocker/.test(p) || p === '1') return '1';
  if (/^high$|major/.test(p) || p === '2') return '2';
  if (/medium/.test(p) || p === '3') return '3';
  if (/^low$/.test(p) || p === '4') return '4';
  if (/lowest|minor|trivial/.test(p) || p === '5') return '5';
  return '\u2014';
}

function formatIssueDate(iso) {
  if (!iso) return '';
  try {
    var d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    var months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    return String(d.getDate()).padStart(2, '0') + '-' + months[d.getMonth()] + '-' + d.getFullYear();
  } catch (e) {
    return '';
  }
}

function stripHtml(text) {
  return String(text || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractAdoReproSteps(fields) {
  var reproHtml = fields['Microsoft.VSTS.TCM.ReproSteps'] || '';
  var descriptionHtml = fields['System.Description'] || '';
  var sources = [stripHtml(reproHtml), stripHtml(descriptionHtml)].filter(Boolean);
  for (var i = 0; i < sources.length; i++) {
    var steps = jiraParse.extractReproSteps(sources[i]);
    if (steps) return steps;
  }
  return '';
}

function mapWorkItem(item) {
  var f = item.fields || {};
  var priority = priorityLabel(f['Microsoft.VSTS.Common.Priority']);
  var assignee = f['System.AssignedTo'];
  if (assignee && typeof assignee === 'object') assignee = assignee.displayName || '';
  return {
    key: String(item.id),
    id: item.id,
    url: cfg.workItemUrl(item.id),
    summary: f['System.Title'] || '',
    status: f['System.State'] || '',
    priority: priority,
    severity: priorityToSeverity(priority),
    reproSteps: extractAdoReproSteps(f),
    assignee: assignee || '',
    reporter: '',
    created: f['System.CreatedDate'] || '',
    updated: f['System.ChangedDate'] || '',
    timestamp: formatIssueDate(f['System.CreatedDate'] || f['System.ChangedDate']),
    source: 'ado'
  };
}

async function runWiql(query) {
  var data = await adoFetch('/_apis/wit/wiql?api-version=' + cfg.ADO_API_VERSION, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: query })
  });
  return (data.workItems || []).map(function (w) { return w.id; });
}

async function fetchWorkItemsByIds(ids) {
  if (!ids.length) return [];
  var all = [];
  for (var offset = 0; offset < ids.length; offset += 200) {
    var chunk = ids.slice(offset, offset + 200);
    var data = await adoFetch('/_apis/wit/workitemsbatch?api-version=' + cfg.ADO_API_VERSION, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ids: chunk,
        fields: [
          'System.Id',
          'System.Title',
          'System.State',
          'System.WorkItemType',
          'System.CreatedDate',
          'System.ChangedDate',
          'System.AssignedTo',
          'System.Description',
          'Microsoft.VSTS.TCM.ReproSteps',
          'Microsoft.VSTS.Common.Priority'
        ]
      })
    });
    all = all.concat((data.value || []).map(mapWorkItem));
  }
  return all;
}

async function fetchBugsByWiql(query) {
  var ids = await runWiql(query);
  return fetchWorkItemsByIds(ids);
}

function mergeIssuesByKey(primary, secondary) {
  var map = {};
  (primary || []).forEach(function (issue) { map[issue.key] = issue; });
  (secondary || []).forEach(function (issue) { map[issue.key] = issue; });
  return Object.keys(map).map(function (key) { return map[key]; });
}

async function fetchReportBugs() {
  var todayIssues = await fetchBugsByWiql(cfg.todayWiql());
  var openNewIssues = await fetchBugsByWiql(cfg.openBugsWiql());
  var todayDefectIssues = await fetchBugsByWiql(cfg.todayDefectLogWiql());
  var trackerIssues = await fetchBugsByWiql(cfg.activeBugsWiql());
  var defectLogIssues = mergeIssuesByKey(openNewIssues, todayDefectIssues);
  var buckets = bucketIssues(trackerIssues);

  return {
    fetchedAt: new Date().toISOString(),
    date: cfg.localDateString(),
    openBugsSince: cfg.OPEN_BUGS_SINCE,
    todayWiql: cfg.todayWiql(),
    openBugsWiql: cfg.openBugsWiql(),
    todayDefectLogWiql: cfg.todayDefectLogWiql(),
    activeBugsWiql: cfg.activeBugsWiql(),
    total: todayIssues.length,
    todayTotal: todayIssues.length,
    openTotal: openNewIssues.length,
    defectLogTotal: defectLogIssues.length,
    activeTotal: trackerIssues.length,
    todayIssues: todayIssues,
    openNewIssues: openNewIssues,
    openIssues: openNewIssues,
    todayDefectIssues: todayDefectIssues,
    defectLogIssues: defectLogIssues,
    trackerIssues: trackerIssues,
    bugs: todayIssues,
    issues: defectLogIssues,
    activeIssues: trackerIssues,
    buckets: buckets,
    statusMap: cfg.STATUS,
    closedStatuses: cfg.CLOSED_STATUSES
  };
}

function bucketIssues(issues) {
  var buckets = { open: [], fixed: [], retest: [], closed: [], other: [] };
  (issues || []).forEach(function (issue) {
    var bucket = bucketAdoStatus(issue.status);
    if (buckets[bucket]) buckets[bucket].push(issue);
    else buckets.other.push(issue);
  });
  return buckets;
}

async function fetchTodayBugs() {
  return fetchReportBugs();
}

function bucketAdoStatus(state) {
  var s = String(state || '').trim().toLowerCase();
  if (s === 'new') return 'open';
  if (s === 'closed' || s === 'resolved') return 'fixed';
  if (s === 'active' || s === 'reopened') return 'retest';
  if (s === 'rejected') return 'closed';
  if (s === 'open' || /^to[\s-]?do$/.test(s) || s === 'proposed') return 'open';
  if (s === 'fixed' || s === 'done' || s === 'completed') return 'fixed';
  if (/test|retest|verify|verification|uat/.test(s)) return 'retest';
  return 'other';
}

function normalizeOutcome(outcome) {
  var o = String(outcome || '').toLowerCase();
  if (o === 'passed') return 'passed';
  if (o === 'failed') return 'failed';
  if (o === 'blocked') return 'blocked';
  if (o === 'notexecuted' || o === 'paused' || o === 'warning' || o === 'error') return 'notExecuted';
  if (o === 'notapplicable') return 'notApplicable';
  return 'other';
}

function emptyCounts() {
  return { executed: 0, passed: 0, failed: 0, blocked: 0, notApplicable: 0, notExecuted: 0, other: 0 };
}

function addResultToCounts(counts, bucket) {
  counts.executed += 1;
  if (counts[bucket] !== undefined) counts[bucket] += 1;
  else counts.other += 1;
}

async function fetchRunResults(runId) {
  var data = await adoFetch('/_apis/test/Runs/' + runId + '/results?api-version=' + cfg.ADO_API_VERSION + '&$top=10000');
  return data.value || [];
}

function runStartedInRange(startedIso, range) {
  if (!startedIso || !range) return false;
  var started = new Date(startedIso);
  if (isNaN(started.getTime())) return false;
  return started >= range.start && started < range.end;
}

function resultExecutedInRange(result, range) {
  if (!result || !range) return false;
  var iso = result.completedDate || result.startedDate || result.lastUpdatedDate;
  if (!iso) return false;
  var executed = new Date(iso);
  if (isNaN(executed.getTime())) return false;
  return executed >= range.start && executed < range.end;
}

function getResultTestCaseId(result) {
  if (!result) return '';
  if (result.testCase && result.testCase.id != null) return String(result.testCase.id);
  if (result.testCaseReference && result.testCaseReference.id != null) {
    return String(result.testCaseReference.id);
  }
  if (result.testCaseReferenceId != null) return String(result.testCaseReferenceId);
  if (result.testCaseId != null) return String(result.testCaseId);
  return '';
}

async function fetchTestPlans() {
  var data = await adoFetch('/_apis/testplan/plans?api-version=' + cfg.ADO_API_VERSION);
  var plans = data.value || [];
  if (cfg.ADO_TEST_PLAN_IDS.length) {
    var allowed = {};
    cfg.ADO_TEST_PLAN_IDS.forEach(function (id) { allowed[String(id)] = true; });
    plans = plans.filter(function (plan) { return allowed[String(plan.id)]; });
  }
  return plans;
}

async function fetchPlanRootSuiteId(planId) {
  var data = await adoFetch('/_apis/testplan/plans/' + planId + '?api-version=' + cfg.ADO_API_VERSION);
  return (data.rootSuite && data.rootSuite.id) || (data.rootSuiteId != null ? data.rootSuiteId : null);
}

async function fetchSuiteTestCaseIds(planId, suiteId) {
  var ids = {};
  var continuationToken = null;
  do {
    var path = '/_apis/testplan/Plans/' + planId + '/Suites/' + suiteId +
      '/TestCase?isRecursive=true&api-version=' + cfg.ADO_API_VERSION;
    if (continuationToken) {
      path += '&continuationToken=' + encodeURIComponent(continuationToken);
    }
    var page = await adoFetchWithHeaders(path);
    (page.data.value || []).forEach(function (entry) {
      var id = (entry.workItem && entry.workItem.id) ||
        (entry.testCaseReference && entry.testCaseReference.id) ||
        (entry.pointAssignments && entry.pointAssignments[0] &&
          entry.pointAssignments[0].testCaseReference &&
          entry.pointAssignments[0].testCaseReference.id);
      if (id != null) ids[String(id)] = true;
    });
    continuationToken = page.continuationToken;
  } while (continuationToken);
  return ids;
}

async function fetchScopeTestCases() {
  var plans = await fetchTestPlans();
  var testCaseIds = {};
  var planNames = [];

  for (var i = 0; i < plans.length; i++) {
    var plan = plans[i];
    var planName = plan.name || ('Plan ' + plan.id);
    var suiteId = (plan.rootSuite && plan.rootSuite.id) || plan.rootSuiteId;
    if (!suiteId) suiteId = await fetchPlanRootSuiteId(plan.id);
    if (!suiteId) continue;
    var ids = await fetchSuiteTestCaseIds(plan.id, suiteId);
    var count = Object.keys(ids).length;
    if (count) {
      planNames.push(planName + ' (' + count + ')');
      Object.keys(ids).forEach(function (id) { testCaseIds[id] = true; });
    }
  }

  return {
    totalInScope: Object.keys(testCaseIds).length,
    planNames: planNames,
    testCaseIds: testCaseIds
  };
}

function getRunPlanId(run) {
  if (!run) return '';
  if (run.plan && run.plan.id != null) return String(run.plan.id);
  if (run.planId != null) return String(run.planId);
  if (run.testPlan && run.testPlan.id != null) return String(run.testPlan.id);
  return '';
}

function isAllowedTestPlanRun(run) {
  if (!cfg.ADO_TEST_PLAN_IDS.length) return true;
  var planId = getRunPlanId(run);
  if (!planId) return true;
  return cfg.ADO_TEST_PLAN_IDS.indexOf(planId) >= 0;
}

async function fetchRunsForRange(range) {
  var lookbackStart = new Date(range.start);
  lookbackStart.setDate(lookbackStart.getDate() - 14);
  var minStarted = lookbackStart.toISOString();
  var maxStarted = new Date(range.end.getTime() - 1).toISOString();
  var query = '?minStartedDate=' + encodeURIComponent(minStarted) +
    '&maxStartedDate=' + encodeURIComponent(maxStarted) +
    '&includeRunDetails=true&api-version=' + cfg.ADO_API_VERSION;
  var runsData;
  try {
    runsData = await adoFetch('/_apis/test/runs' + query);
  } catch (e) {
    if (/unauthorized|401/i.test(String(e.message || e))) {
      var err = new Error('Azure DevOps test API unauthorized. Regenerate ADO_PAT with Test Management (Read) scope.');
      err.code = 'CONFIG';
      throw err;
    }
    throw e;
  }
  return (runsData.value || []).filter(function (run) {
    if (!run) return false;
    if (!(run.plan || run.planId || run.testPlan)) return false;
    if (!isAllowedTestPlanRun(run)) return false;
    if (!run.startedDate) return false;
    return new Date(run.startedDate) < range.end;
  });
}

function trackLatestOutcome(map, testCaseId, result, range) {
  if (!testCaseId || !resultExecutedInRange(result, range)) return;
  var iso = result.completedDate || result.startedDate || result.lastUpdatedDate;
  if (!iso) return;
  var when = new Date(iso).getTime();
  if (isNaN(when)) return;
  var prev = map[testCaseId];
  if (!prev || when >= prev.when) {
    map[testCaseId] = { bucket: normalizeOutcome(result.outcome), when: when };
  }
}

function countsFromLatestOutcomes(latestMap) {
  var counts = emptyCounts();
  Object.keys(latestMap).forEach(function (id) {
    addResultToCounts(counts, latestMap[id].bucket);
  });
  return counts;
}

async function fetchTestSummary(startDate, endDate) {
  var endDateStr = endDate || cfg.localDateString();
  var cycleRange = cfg.dateRange(startDate, endDateStr);
  if (!cycleRange) {
    var err = new Error('Invalid start date. Use YYYY-MM-DD.');
    err.code = 'CONFIG';
    throw err;
  }
  if (cycleRange.start > cycleRange.endDate) {
    var rangeErr = new Error('Start date cannot be after today.');
    rangeErr.code = 'CONFIG';
    throw rangeErr;
  }

  var todayRange = cfg.todayRange();
  var runFetchRange = {
    start: new Date(cycleRange.start),
    end: cycleRange.end
  };
  runFetchRange.start.setDate(runFetchRange.start.getDate() - 14);

  var scope = await fetchScopeTestCases();
  var totalInScope = scope.totalInScope;
  var runs = await fetchRunsForRange(runFetchRange);
  var cycleCounts = emptyCounts();
  var todayCounts = emptyCounts();
  var cycleExecutedIds = {};
  var todayExecutedIds = {};
  var cycleLatestOutcome = {};
  var runSummaries = [];

  var runResultSets = await Promise.all(runs.map(function (run) {
    return fetchRunResults(run.id).then(function (results) {
      return { run: run, results: results };
    });
  }));

  runResultSets.forEach(function (entry) {
    var run = entry.run;
    var results = entry.results;
    var planName = (run.plan && run.plan.name) || run.name || ('Run ' + run.id);
    var runCounts = emptyCounts();
    var runHadCycleActivity = false;
    var runHadTodayActivity = false;

    results.forEach(function (result) {
      var bucket = normalizeOutcome(result.outcome);
      var testCaseId = getResultTestCaseId(result);
      if (resultExecutedInRange(result, cycleRange)) {
        if (testCaseId) {
          cycleExecutedIds[testCaseId] = true;
          trackLatestOutcome(cycleLatestOutcome, testCaseId, result, cycleRange);
        }
        addResultToCounts(runCounts, bucket);
        runHadCycleActivity = true;
      }
      if (resultExecutedInRange(result, todayRange)) {
        if (testCaseId) todayExecutedIds[testCaseId] = true;
        addResultToCounts(todayCounts, bucket);
        runHadTodayActivity = true;
      }
    });

    if (runHadCycleActivity || runHadTodayActivity) {
      runSummaries.push({
        id: run.id,
        name: run.name,
        plan: planName,
        state: run.state,
        started: run.startedDate,
        completed: run.completedDate,
        totalResults: results.length,
        counts: runCounts
      });
    }
  });

  var executedToday = Object.keys(todayExecutedIds).length;
  var cumulativeExecuted = Object.keys(cycleExecutedIds).length;
  cycleCounts = countsFromLatestOutcomes(cycleLatestOutcome);
  var notYetExecuted = Math.max(0, totalInScope - cumulativeExecuted);
  var passRate = cumulativeExecuted ? Math.round((cycleCounts.passed / cumulativeExecuted) * 100) : 0;
  var coveragePercent = totalInScope ? Math.round((cumulativeExecuted / totalInScope) * 100) : 0;
  var scopeLines = scope.planNames.map(function (name) {
    return '\u2022 ' + name;
  });

  return {
    fetchedAt: new Date().toISOString(),
    startDate: cfg.localDateString(cycleRange.start),
    endDate: endDateStr,
    date: endDateStr,
    runs: runSummaries,
    runCount: runSummaries.length,
    plansInScope: scope.planNames.length,
    summary: {
      totalInScope: totalInScope,
      executedToday: executedToday,
      cumulativeExecuted: cumulativeExecuted,
      passed: cycleCounts.passed,
      failed: cycleCounts.failed,
      blocked: cycleCounts.blocked,
      notApplicable: cycleCounts.notApplicable,
      notYetExecuted: notYetExecuted,
      coveragePercent: coveragePercent,
      passRatePercent: passRate,
      scopeText: scopeLines.join('\n')
    }
  };
}

async function fetchTodayTestSummary() {
  return fetchTestSummary(cfg.localDateString(), cfg.localDateString());
}

module.exports = {
  fetchTodayBugs,
  fetchReportBugs,
  fetchTestSummary,
  fetchTodayTestSummary,
  bucketAdoStatus,
  mapWorkItem
};
