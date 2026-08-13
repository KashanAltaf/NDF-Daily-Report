'use strict';

require('dotenv').config({ path: require('path').resolve(__dirname, '..', '.env') });

const JIRA_BASE_URL = (process.env.JIRA_BASE_URL || 'https://namipay-team.atlassian.net').replace(/\/$/, '');
const JIRA_EMAIL = process.env.JIRA_EMAIL || '';
const JIRA_API_TOKEN = process.env.JIRA_API_TOKEN || '';
/** Comma-separated Jira project keys (PB + Space Merchant Portal / POR) */
const JIRA_PROJECTS = (process.env.JIRA_PROJECT || 'PB,POR')
  .split(',')
  .map(function (s) { return s.trim(); })
  .filter(Boolean);
const JIRA_PROJECT = JIRA_PROJECTS[0] || 'PB';
/** Default report module when summary has no [Module] prefix */
const PROJECT_MODULE_DEFAULTS = {
  POR: 'Space Merchant Portal'
};

const REPORTERS = ['Munawar Gul', 'Kashan Altaf'];

const TEXT_FILTER = (process.env.JIRA_TEXT_FILTER || '').trim();

/** Jira workflow statuses used by this report */
const STATUS = {
  OPEN: 'To Do',
  OPEN_BUG_ISSUE: 'Bug/Issue',
  FIXED: 'Create-PRD-PR',
  DONE: 'Done',
  RETEST: 'UAT-Testing',
  CLOSED: 'UAT-PR-Approval',
  CANCELED: 'CANCELED',
  IMPROVEMENT: 'IMPROVEMENT'
};

const OPEN_STATUSES = [STATUS.OPEN, STATUS.OPEN_BUG_ISSUE];
/** Sub-task default workflow uses In Progress; treat like open (pending) */
const SUBTASK_OPEN_STATUSES = [STATUS.OPEN, STATUS.OPEN_BUG_ISSUE, 'In Progress'];
/** Create-PRD-PR and Done both display as Fixed in the report */
const FIXED_STATUSES = [STATUS.FIXED, STATUS.DONE];

const CLOSED_STATUSES = [STATUS.CLOSED];
const EXCLUDED_STATUSES = [STATUS.CLOSED, STATUS.CANCELED];

function excludedStatusesInJql() {
  return EXCLUDED_STATUSES.map(function (s) { return '"' + s + '"'; }).join(', ');
}

function fixedStatusesInJql() {
  return FIXED_STATUSES.map(function (s) { return '"' + s + '"'; }).join(', ');
}

function projectJql() {
  if (JIRA_PROJECTS.length <= 1) return 'project = ' + JIRA_PROJECT;
  return 'project in (' + JIRA_PROJECTS.join(', ') + ')';
}

function defaultModuleForProject(projectKey) {
  if (!projectKey) return '';
  return PROJECT_MODULE_DEFAULTS[String(projectKey).toUpperCase()] || '';
}

function fixedTodayClause() {
  return '(' +
    'status in (' + fixedStatusesInJql() + ')' +
    ' AND (' +
    'status changed to "' + STATUS.FIXED + '" during (startOfDay(), now())' +
    ' OR status changed to "' + STATUS.DONE + '" during (startOfDay(), now())' +
    ' OR created >= startOfDay()' +
    ')' +
    ')';
}

function buildBaseJqlParts() {
  var parts = [
    projectJql(),
    // Sub-task uses the same defect log + bug tracker pipeline as Bug
    'issuetype in (Bug, "Sub-task")',
    'reporter in (' + REPORTERS.map(function (n) { return '"' + n + '"'; }).join(', ') + ')'
  ];
  if (TEXT_FILTER) parts.push('(' + TEXT_FILTER + ')');
  return parts;
}

const BASE_JQL = buildBaseJqlParts().join(' AND ');
const OPEN_BUGS_SINCE = process.env.JIRA_OPEN_BUGS_SINCE || '2026-01-01';
/** Cutoff for Enhancements + Sales Portal Enhancements (defaults to 1 Jan 2026) */
const ENHANCEMENTS_SINCE = (process.env.JIRA_ENHANCEMENTS_SINCE || '2026-01-01').trim();
const GITHUB_PR_URL_UAT_FIELD = process.env.JIRA_GITHUB_PR_URL_UAT_FIELD || 'customfield_10649';

/** New bugs raised today — To Do or Sub-task In Progress, created today */
function todayJql(extra) {
  var jql = BASE_JQL +
    ' AND created >= startOfDay()' +
    ' AND status in ("' + STATUS.OPEN + '", "In Progress")';
  if (extra) jql += ' AND ' + extra;
  return jql + ' ORDER BY created DESC';
}

function defectOpenStatusesInJql() {
  return SUBTASK_OPEN_STATUSES.map(function (s) { return '"' + s + '"'; }).join(', ');
}

/** Open bugs since cutoff — To Do, Bug/Issue, or Sub-task In Progress */
function openBugsJql(extra) {
  var jql = BASE_JQL +
    ' AND created >= "' + OPEN_BUGS_SINCE + '"' +
    ' AND status in (' + defectOpenStatusesInJql() + ')';
  if (extra) jql += ' AND ' + extra;
  return jql + ' ORDER BY created DESC';
}

/** Today's bugs for defect log — open statuses created today, Fixed/Done today, or Canceled today */
function todayDefectLogJql(extra) {
  var jql = BASE_JQL + ' AND (' +
    '(created >= startOfDay() AND status in (' + defectOpenStatusesInJql() + ', ' + fixedStatusesInJql() + ', "' + STATUS.CANCELED + '"))' +
    ' OR status changed to "' + STATUS.FIXED + '" during (startOfDay(), now())' +
    ' OR status changed to "' + STATUS.DONE + '" during (startOfDay(), now())' +
    ' OR status changed to "' + STATUS.CANCELED + '" during (startOfDay(), now())' +
    ')';
  if (extra) jql += ' AND ' + extra;
  return jql + ' ORDER BY created DESC';
}

/** Fixed today — Create-PRD-PR or Done today (tracker: "Fixed verified in this session") */
function fixedTodayJql(extra) {
  var jql = BASE_JQL + ' AND ' + fixedTodayClause();
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
    projectJql(),
    'reporter in (' + REPORTERS.map(function (n) { return '"' + n + '"'; }).join(', ') + ')',
    'created >= "' + ENHANCEMENTS_SINCE + '"',
    '((issuetype = Task AND status = "' + STATUS.OPEN + '") OR (issuetype in (Bug, Task) AND status = "' + STATUS.IMPROVEMENT + '"))'
  ];
  if (TEXT_FILTER) parts.push('(' + TEXT_FILTER + ')');
  var jql = parts.join(' AND ');
  if (extra) jql += ' AND ' + extra;
  return jql + ' ORDER BY created DESC';
}

/** Enhancement tasks fixed today — Task moved to Create-PRD-PR or Done today */
function enhancementsFixedTodayJql(extra) {
  var parts = [
    projectJql(),
    'issuetype = Task',
    'reporter in (' + REPORTERS.map(function (n) { return '"' + n + '"'; }).join(', ') + ')',
    'status in (' + fixedStatusesInJql() + ')',
    '(status changed to "' + STATUS.FIXED + '" during (startOfDay(), now()) OR status changed to "' + STATUS.DONE + '" during (startOfDay(), now()) OR created >= startOfDay())'
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

/** Active bugs for tracker buckets (excludes closed UAT-PR-Approval, Canceled, and historical Done) */
function activeBugsJql(extra) {
  var jql = BASE_JQL +
    ' AND created >= "' + OPEN_BUGS_SINCE + '"' +
    ' AND status not in (' + excludedStatusesInJql() + ', "' + STATUS.DONE + '")';
  if (extra) jql += ' AND ' + extra;
  return jql + ' ORDER BY created DESC';
}

module.exports = {
  JIRA_BASE_URL,
  JIRA_EMAIL,
  JIRA_API_TOKEN,
  JIRA_PROJECT,
  JIRA_PROJECTS,
  PROJECT_MODULE_DEFAULTS,
  REPORTERS,
  STATUS,
  OPEN_STATUSES,
  FIXED_STATUSES,
  CLOSED_STATUSES,
  EXCLUDED_STATUSES,
  BASE_JQL,
  OPEN_BUGS_SINCE,
  ENHANCEMENTS_SINCE,
  GITHUB_PR_URL_UAT_FIELD,
  projectJql,
  defaultModuleForProject,
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
