'use strict';

require('dotenv').config({ path: require('path').resolve(__dirname, '..', '.env') });

const JIRA_BASE_URL = (process.env.JIRA_BASE_URL || 'https://namipay-team.atlassian.net').replace(/\/$/, '');
const JIRA_EMAILS = (process.env.JIRA_EMAIL || '')
  .split(',')
  .map(function (s) { return s.trim(); })
  .filter(Boolean);
const JIRA_EMAIL = JIRA_EMAILS[0] || '';
const JIRA_API_TOKEN = (process.env.JIRA_API_TOKEN || '').split(',')[0].trim();
const JIRA_API_TOKENS = (process.env.JIRA_API_TOKEN || '')
  .split(',')
  .map(function (s) { return s.trim(); })
  .filter(Boolean);
const JIRA_API_TOKEN_NAMIPAY = (process.env.JIRA_API_TOKEN_NAMIPAY || '').trim();

function tokenForEmail(email, index) {
  var addr = String(email || '').trim().toLowerCase();
  if (addr.indexOf('@namipay.com.sa') >= 0 && JIRA_API_TOKEN_NAMIPAY) return JIRA_API_TOKEN_NAMIPAY;
  if (JIRA_API_TOKENS[index]) return JIRA_API_TOKENS[index];
  if (addr.indexOf('@veroke.com') >= 0 && JIRA_API_TOKENS[0]) return JIRA_API_TOKENS[0];
  return '';
}

function jiraAuthAccounts() {
  return JIRA_EMAILS.map(function (email, index) {
    return { email: email, token: tokenForEmail(email, index) };
  }).filter(function (account) {
    return account.email && account.token;
  });
}
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

function reportersInJql() {
  return 'reporter in (' + REPORTERS.map(function (n) { return '"' + n + '"'; }).join(', ') + ')';
}

const TEXT_FILTER = (process.env.JIRA_TEXT_FILTER || '').trim();

/** Jira workflow statuses used by this report */
const STATUS = {
  OPEN: 'To Do',
  OPEN_BUG_ISSUE: 'Bug/Issue',
  FIXED: 'Create-PRD-PR',
  DONE: 'Done',
  RETEST: 'UAT-Testing',
  DEPLOYMENT: 'UAT-Deployment',
  MERGE: 'UAT-MERGE-ISSUE',
  CLOSED: 'UAT-PR-Approval',
  CANCELED: 'CANCELED',
  IMPROVEMENT: 'IMPROVEMENT'
};

const OPEN_STATUSES = [STATUS.OPEN, STATUS.OPEN_BUG_ISSUE];
/** Sub-task default workflow uses In Progress; treat like open (pending) */
const SUBTASK_OPEN_STATUSES = [STATUS.OPEN, STATUS.OPEN_BUG_ISSUE, 'In Progress'];
/** Create-PRD-PR and Done both display as Fixed in the report */
const FIXED_STATUSES = [STATUS.FIXED, STATUS.DONE];

const CLOSED_STATUSES = [];
/** Only Canceled is fully excluded; UAT-PR-Approval maps to Awaiting PR Approval */
const EXCLUDED_STATUSES = [STATUS.CANCELED];

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

function enhancementsProjectJql() {
  return 'project = PB';
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
    reportersInJql(),
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

function awaitingPrDeploymentStatusesInJql() {
  return '"' + STATUS.DEPLOYMENT + '", "' + STATUS.MERGE + '", "' + STATUS.CLOSED + '"';
}

/** Today's bugs for defect log — open statuses created today, Awaiting PR Deployment statuses, Fixed/Done today, or Canceled today */
function todayDefectLogJql(extra) {
  var jql = BASE_JQL + ' AND (' +
    '(created >= startOfDay() AND status in (' + defectOpenStatusesInJql() + ', ' + fixedStatusesInJql() + ', "' + STATUS.CANCELED + '"))' +
    ' OR status in (' + awaitingPrDeploymentStatusesInJql() + ')' +
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

/** Enhancements — PB only. Task in To Do, or Bug/Task in IMPROVEMENT. No defect-log text filter. */
function enhancementsJql(extra) {
  var jql = enhancementsProjectJql() +
    ' AND ' + reportersInJql() +
    ' AND created >= "' + ENHANCEMENTS_SINCE + '"' +
    ' AND ((issuetype = Task AND status = "' + STATUS.OPEN + '") OR (issuetype in (Bug, Task) AND status = "' + STATUS.IMPROVEMENT + '"))';
  if (extra) jql += ' AND ' + extra;
  return jql + ' ORDER BY created DESC';
}

/** Enhancement tasks fixed today — PB Task moved to Create-PRD-PR or Done today */
function enhancementsFixedTodayJql(extra) {
  var jql = enhancementsProjectJql() +
    ' AND issuetype = Task' +
    ' AND ' + reportersInJql() +
    ' AND status in (' + fixedStatusesInJql() + ')' +
    ' AND (status changed to "' + STATUS.FIXED + '" during (startOfDay(), now()) OR status changed to "' + STATUS.DONE + '" during (startOfDay(), now()) OR created >= startOfDay())';
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

/** Active bugs for tracker buckets (excludes Canceled and historical Done) */
function activeBugsJql(extra) {
  var jql = BASE_JQL +
    ' AND created >= "' + OPEN_BUGS_SINCE + '"' +
    ' AND status not in (' + excludedStatusesInJql() + ', "' + STATUS.DONE + '")';
  if (extra) jql += ' AND ' + extra;
  return jql + ' ORDER BY created DESC';
}

/** Bugs/Sub-tasks currently in UAT-Testing (for Verified on UAT comment check) */
function uatTestingBugsJql(extra) {
  var jql = BASE_JQL +
    ' AND created >= "' + OPEN_BUGS_SINCE + '"' +
    ' AND status = "' + STATUS.RETEST + '"';
  if (extra) jql += ' AND ' + extra;
  return jql + ' ORDER BY updated DESC';
}

/**
 * UAT-Testing issues whose comments mention Verified on UAT (Jira text search).
 * Primary stay-out signal when per-issue comment fetch is flaky in production.
 */
function verifiedOnUatCommentJql(extra) {
  var jql = BASE_JQL +
    ' AND created >= "' + OPEN_BUGS_SINCE + '"' +
    ' AND status = "' + STATUS.RETEST + '"' +
    ' AND comment ~ "\\"Verified on UAT\\""';
  if (extra) jql += ' AND ' + extra;
  return jql + ' ORDER BY updated DESC';
}

module.exports = {
  JIRA_BASE_URL,
  JIRA_EMAIL,
  JIRA_EMAILS,
  JIRA_API_TOKEN,
  JIRA_API_TOKEN_NAMIPAY,
  tokenForEmail,
  jiraAuthAccounts,
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
  uatTestingBugsJql,
  verifiedOnUatCommentJql,
  browseUrl: function (key) {
    return JIRA_BASE_URL + '/browse/' + key;
  }
};
