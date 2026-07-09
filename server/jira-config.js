'use strict';

require('dotenv').config({ path: require('path').resolve(__dirname, '..', '.env') });

const JIRA_BASE_URL = (process.env.JIRA_BASE_URL || 'https://namipay-team.atlassian.net').replace(/\/$/, '');
const JIRA_EMAIL = process.env.JIRA_EMAIL || '';
const JIRA_API_TOKEN = process.env.JIRA_API_TOKEN || '';
const JIRA_PROJECT = process.env.JIRA_PROJECT || 'PB';

const REPORTERS = ['Munawar Gul', 'Kashan Altaf'];

const TEXT_FILTER = (process.env.JIRA_TEXT_FILTER || '').trim();

/** Jira workflow statuses used by this report */
const STATUS = {
  OPEN: 'To Do',
  OPEN_BUG_ISSUE: 'Bug/Issue',
  FIXED: 'Create-PRD-PR',
  RETEST: 'UAT-Testing',
  CLOSED: 'UAT-PR-Approval',
  CANCELED: 'CANCELED',
  IMPROVEMENT: 'IMPROVEMENT'
};

const OPEN_STATUSES = [STATUS.OPEN, STATUS.OPEN_BUG_ISSUE];

const CLOSED_STATUSES = [STATUS.CLOSED];
const EXCLUDED_STATUSES = [STATUS.CLOSED, STATUS.CANCELED];

function excludedStatusesInJql() {
  return EXCLUDED_STATUSES.map(function (s) { return '"' + s + '"'; }).join(', ');
}

function buildBaseJqlParts() {
  var parts = [
    'project = ' + JIRA_PROJECT,
    'issuetype = Bug',
    'reporter in (' + REPORTERS.map(function (n) { return '"' + n + '"'; }).join(', ') + ')'
  ];
  if (TEXT_FILTER) parts.push('(' + TEXT_FILTER + ')');
  return parts;
}

const BASE_JQL = buildBaseJqlParts().join(' AND ');
const OPEN_BUGS_SINCE = process.env.JIRA_OPEN_BUGS_SINCE || '2026-06-30';
const GITHUB_PR_URL_UAT_FIELD = process.env.JIRA_GITHUB_PR_URL_UAT_FIELD || 'customfield_10649';

/** New bugs raised today — To Do only, created today */
function todayJql(extra) {
  var jql = BASE_JQL +
    ' AND created >= startOfDay()' +
    ' AND status = "' + STATUS.OPEN + '"';
  if (extra) jql += ' AND ' + extra;
  return jql + ' ORDER BY created DESC';
}

function openStatusesInJql() {
  return OPEN_STATUSES.map(function (s) { return '"' + s + '"'; }).join(', ');
}

/** Open bugs since cutoff — To Do or Bug/Issue */
function openBugsJql(extra) {
  var jql = BASE_JQL +
    ' AND created >= "' + OPEN_BUGS_SINCE + '"' +
    ' AND status in (' + openStatusesInJql() + ')';
  if (extra) jql += ' AND ' + extra;
  return jql + ' ORDER BY created DESC';
}

/** Today's bugs for defect log — open statuses created today, Fixed today, or Canceled today */
function todayDefectLogJql(extra) {
  var jql = BASE_JQL + ' AND (' +
    '(created >= startOfDay() AND status in (' + openStatusesInJql() + ', "' + STATUS.FIXED + '", "' + STATUS.CANCELED + '"))' +
    ' OR status changed to "' + STATUS.FIXED + '" during (startOfDay(), now())' +
    ' OR status changed to "' + STATUS.CANCELED + '" during (startOfDay(), now())' +
    ')';
  if (extra) jql += ' AND ' + extra;
  return jql + ' ORDER BY created DESC';
}

/** Fixed today — currently Create-PRD-PR AND became fixed today (tracker: "Fixed verified in this session") */
function fixedTodayJql(extra) {
  var jql = BASE_JQL +
    ' AND status = "' + STATUS.FIXED + '"' +
    ' AND (' +
    'status changed to "' + STATUS.FIXED + '" during (startOfDay(), now())' +
    ' OR created >= startOfDay()' +
    ')';
  if (extra) jql += ' AND ' + extra;
  return jql + ' ORDER BY updated DESC';
}

/** Canceled today — moved to CANCELED today (tracker: "Parked / Deferred") */
function canceledTodayJql(extra) {
  var jql = BASE_JQL + ' AND (' +
    'status changed to "' + STATUS.CANCELED + '" during (startOfDay(), now())' +
    ' OR (created >= startOfDay() AND status = "' + STATUS.CANCELED + '")' +
    ')';
  if (extra) jql += ' AND ' + extra;
  return jql + ' ORDER BY updated DESC';
}

/** Enhancements — QA-reported Bug/Task in IMPROVEMENT, or Task in To Do, since cutoff */
function enhancementsJql(extra) {
  var parts = [
    'project = ' + JIRA_PROJECT,
    'reporter in (' + REPORTERS.map(function (n) { return '"' + n + '"'; }).join(', ') + ')',
    'created >= "' + OPEN_BUGS_SINCE + '"',
    '((issuetype = Task AND status = "' + STATUS.OPEN + '") OR (issuetype in (Bug, Task) AND status = "' + STATUS.IMPROVEMENT + '"))'
  ];
  if (TEXT_FILTER) parts.push('(' + TEXT_FILTER + ')');
  var jql = parts.join(' AND ');
  if (extra) jql += ' AND ' + extra;
  return jql + ' ORDER BY created DESC';
}

/** Enhancement tasks fixed today — Task moved to Create-PRD-PR today */
function enhancementsFixedTodayJql(extra) {
  var parts = [
    'project = ' + JIRA_PROJECT,
    'issuetype = Task',
    'reporter in (' + REPORTERS.map(function (n) { return '"' + n + '"'; }).join(', ') + ')',
    'status = "' + STATUS.FIXED + '"',
    '(status changed to "' + STATUS.FIXED + '" during (startOfDay(), now()) OR created >= startOfDay())'
  ];
  if (TEXT_FILTER) parts.push('(' + TEXT_FILTER + ')');
  var jql = parts.join(' AND ');
  if (extra) jql += ' AND ' + extra;
  return jql + ' ORDER BY updated DESC';
}

/** Regression bugs — currently Bug/Issue, previously moved from Create-PRD-PR back to Bug/Issue */
function regressionBugsJql(extra) {
  var jql = BASE_JQL +
    ' AND created >= "' + OPEN_BUGS_SINCE + '"' +
    ' AND status = "' + STATUS.OPEN_BUG_ISSUE + '"' +
    ' AND status changed from "' + STATUS.FIXED + '" to "' + STATUS.OPEN_BUG_ISSUE + '"';
  if (extra) jql += ' AND ' + extra;
  return jql + ' ORDER BY updated DESC';
}

/** Active bugs for tracker buckets (excludes closed UAT-PR-Approval and Canceled) */
function activeBugsJql(extra) {
  var jql = BASE_JQL +
    ' AND created >= "' + OPEN_BUGS_SINCE + '"' +
    ' AND status not in (' + excludedStatusesInJql() + ')';
  if (extra) jql += ' AND ' + extra;
  return jql + ' ORDER BY created DESC';
}

module.exports = {
  JIRA_BASE_URL,
  JIRA_EMAIL,
  JIRA_API_TOKEN,
  JIRA_PROJECT,
  REPORTERS,
  STATUS,
  OPEN_STATUSES,
  CLOSED_STATUSES,
  EXCLUDED_STATUSES,
  BASE_JQL,
  OPEN_BUGS_SINCE,
  GITHUB_PR_URL_UAT_FIELD,
  todayJql,
  openBugsJql,
  todayDefectLogJql,
  fixedTodayJql,
  canceledTodayJql,
  enhancementsJql,
  enhancementsFixedTodayJql,
  regressionBugsJql,
  activeBugsJql,
  browseUrl: function (key) {
    return JIRA_BASE_URL + '/browse/' + key;
  }
};
