'use strict';

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
var cfg = require('../server/jira-config');
var jiraParse = require('../server/jira-parse');

function authHeader() {
  return 'Basic ' + Buffer.from(process.env.JIRA_EMAIL + ':' + process.env.JIRA_API_TOKEN).toString('base64');
}

function mapIssue(issue) {
  var f = issue.fields || {};
  return {
    key: issue.key,
    status: f.status && f.status.name ? f.status.name : '',
    created: f.created || ''
  };
}

async function jiraSearch(jql) {
  var res = await fetch(cfg.JIRA_BASE_URL + '/rest/api/3/search/jql', {
    method: 'POST',
    headers: { Authorization: authHeader(), Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ jql: jql, maxResults: 100, fields: ['status', 'created'] })
  });
  var data = await res.json();
  if (!res.ok) throw new Error((data.errorMessages || []).join('; ') || res.statusText);
  return (data.issues || []).map(mapIssue);
}

function merge(a, b) {
  var map = {};
  a.concat(b).forEach(function (i) { map[i.key] = i; });
  return Object.keys(map).map(function (k) { return map[k]; });
}

(async function () {
  var today = await jiraSearch(cfg.todayJql());
  var openToDo = await jiraSearch(cfg.openBugsJql());
  var todayDefect = await jiraSearch(cfg.todayDefectLogJql());
  var fixedToday = await jiraSearch(cfg.fixedTodayJql());
  var defectLog = merge(openToDo, merge(todayDefect, merge(fixedToday, today)));
  var enhancements = await jiraSearch(cfg.enhancementsJql());
  console.log('Today all:', today.length, today.map(function (i) { return i.key + '(' + i.status + ')'; }).join(', '));
  console.log('Open To Do since 01-Jan:', openToDo.length);
  console.log('Fixed today (Create-PRD-PR):', fixedToday.length, fixedToday.map(function (i) { return i.key + '(' + i.status + ')'; }).join(', '));
  console.log('Today defect log query:', todayDefect.length, todayDefect.map(function (i) { return i.key + '(' + i.status + ')'; }).join(', '));
  console.log('Defect log total:', defectLog.length);
  console.log('Enhancements (Task To Do + Bug/Task IMPROVEMENT, QA reporters since ' + cfg.ENHANCEMENTS_SINCE + '):', enhancements.length, enhancements.map(function (i) { return i.key + '(' + i.status + ')'; }).join(', '));
  defectLog.forEach(function (i) { console.log(' ', i.key, '|', i.status, '|', i.created.slice(0, 10)); });
})().catch(function (e) { console.error(e); process.exit(1); });
