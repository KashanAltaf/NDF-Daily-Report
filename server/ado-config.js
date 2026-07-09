'use strict';

require('dotenv').config();

const ADO_ORG = (process.env.ADO_ORG || 'verokeinc').trim();
const ADO_PROJECT = (process.env.ADO_PROJECT || 'Nami-POSWorker-1.0').trim();
const ADO_PAT = (process.env.ADO_PAT || '').trim();
const ADO_API_VERSION = process.env.ADO_API_VERSION || '7.1';
const ADO_TEST_PLAN_IDS = (process.env.ADO_TEST_PLAN_IDS || '14617,14359,13962,13960')
  .split(',')
  .map(function (s) { return s.trim(); })
  .filter(Boolean);
const OPEN_BUGS_SINCE = (process.env.ADO_OPEN_BUGS_SINCE || process.env.JIRA_OPEN_BUGS_SINCE || '2026-06-30').trim();

/**
 * ADO Bug workflow mapped to the same report roles as Jira:
 *   New            -> Open          (Jira To Do)
 *   Resolved/Closed -> Fixed         (Jira Create-PRD-PR; defect log only if created today)
 *   Active/Reopened -> In retest     (Jira UAT-Testing)
 *   Rejected       -> excluded       (Jira UAT-PR-Approval)
 */
const STATUS = {
  OPEN: 'New',
  FIXED: 'Closed',
  RETEST: 'Active',
  CLOSED: 'Rejected'
};

const CLOSED_STATUSES = [STATUS.CLOSED];

function baseWiqlParts() {
  return [
    "[System.TeamProject] = '" + ADO_PROJECT.replace(/'/g, "''") + "'",
    "[System.WorkItemType] = 'Bug'"
  ];
}

function wiqlStateNotIn(states) {
  return states.map(function (state) {
    return "[System.State] <> '" + String(state).replace(/'/g, "''") + "'";
  }).join(' AND ');
}

/** All bugs created today (tracker: "New bugs raised today") */
function todayWiql() {
  return 'SELECT [System.Id] FROM WorkItems WHERE ' + baseWiqlParts().join(' AND ') +
    ' AND [System.CreatedDate] >= @Today ORDER BY [System.CreatedDate] DESC';
}

/** Open bugs since cutoff — New only (same role as Jira To Do) */
function openBugsWiql() {
  return 'SELECT [System.Id] FROM WorkItems WHERE ' + baseWiqlParts().join(' AND ') +
    " AND [System.CreatedDate] >= '" + OPEN_BUGS_SINCE + "'" +
    " AND [System.State] = '" + STATUS.OPEN.replace(/'/g, "''") + "' ORDER BY [System.CreatedDate] DESC";
}

/** Today's bugs for defect log — New or Fixed states (same role as Jira To Do + Create-PRD-PR) */
function todayDefectLogWiql() {
  return 'SELECT [System.Id] FROM WorkItems WHERE ' + baseWiqlParts().join(' AND ') +
    ' AND [System.CreatedDate] >= @Today' +
    " AND [System.State] IN ('" + STATUS.OPEN.replace(/'/g, "''") + "', '" +
    STATUS.FIXED.replace(/'/g, "''") + "', 'Resolved') ORDER BY [System.CreatedDate] DESC";
}

/** Active bugs for tracker buckets (excludes fully closed Rejected, same role as Jira != UAT-PR-Approval) */
function activeBugsWiql() {
  return 'SELECT [System.Id] FROM WorkItems WHERE ' + baseWiqlParts().join(' AND ') +
    " AND [System.CreatedDate] >= '" + OPEN_BUGS_SINCE + "'" +
    ' AND ' + wiqlStateNotIn(CLOSED_STATUSES) + ' ORDER BY [System.CreatedDate] DESC';
}

function projectBaseUrl() {
  return 'https://dev.azure.com/' + encodeURIComponent(ADO_ORG) + '/' + encodeURIComponent(ADO_PROJECT);
}

function workItemUrl(id) {
  return projectBaseUrl() + '/_workitems/edit/' + id;
}

function localDateString(d) {
  d = d || new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

function parseLocalDate(dateStr) {
  var parts = String(dateStr || '').trim().split('-').map(Number);
  if (parts.length < 3 || parts.some(function (n) { return isNaN(n); })) return null;
  return new Date(parts[0], parts[1] - 1, parts[2]);
}

function dateRange(startDateStr, endDateStr) {
  var start = parseLocalDate(startDateStr);
  if (!start || isNaN(start.getTime())) return null;
  start.setHours(0, 0, 0, 0);
  var endBase = endDateStr ? parseLocalDate(endDateStr) : new Date();
  if (!endBase || isNaN(endBase.getTime())) endBase = new Date();
  endBase.setHours(0, 0, 0, 0);
  var end = new Date(endBase);
  end.setDate(end.getDate() + 1);
  return { start: start, end: end, endDate: endBase };
}

function todayRange() {
  return dateRange(localDateString(), localDateString());
}

module.exports = {
  ADO_ORG,
  ADO_PROJECT,
  ADO_PAT,
  ADO_API_VERSION,
  ADO_TEST_PLAN_IDS,
  OPEN_BUGS_SINCE,
  STATUS,
  CLOSED_STATUSES,
  todayWiql,
  openBugsWiql,
  todayDefectLogWiql,
  activeBugsWiql,
  projectBaseUrl,
  workItemUrl,
  parseLocalDate,
  dateRange,
  todayRange,
  localDateString
};
