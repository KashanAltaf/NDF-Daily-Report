'use strict';

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
var cfg = require('../server/jira-config');

function authHeader() {
  return 'Basic ' + Buffer.from(process.env.JIRA_EMAIL + ':' + process.env.JIRA_API_TOKEN).toString('base64');
}

async function jiraSearch(jql) {
  var res = await fetch(cfg.JIRA_BASE_URL + '/rest/api/3/search/jql', {
    method: 'POST',
    headers: { Authorization: authHeader(), Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ jql: jql, maxResults: 100, fields: ['status', 'created', 'summary'] })
  });
  var data = await res.json();
  if (!res.ok) throw new Error((data.errorMessages || []).join('; ') || JSON.stringify(data));
  return data.issues || [];
}

(async function () {
  var queries = [
    ['todayDefectLogJql', cfg.todayDefectLogJql()],
    ['today Create-PRD-PR only', cfg.BASE_JQL + ' AND created >= startOfDay() AND status = "Create-PRD-PR" ORDER BY created DESC'],
    ['since cutoff Create-PRD-PR', cfg.BASE_JQL + ' AND created >= "' + cfg.OPEN_BUGS_SINCE + '" AND status = "Create-PRD-PR" ORDER BY created DESC'],
    ['since cutoff UAT-Testing', cfg.BASE_JQL + ' AND created >= "' + cfg.OPEN_BUGS_SINCE + '" AND status = "UAT-Testing" ORDER BY created DESC'],
    ['all statuses sample', cfg.BASE_JQL + ' AND created >= "' + cfg.OPEN_BUGS_SINCE + '" ORDER BY created DESC']
  ];

  for (var i = 0; i < queries.length; i++) {
    var label = queries[i][0];
    var jql = queries[i][1];
    var issues = await jiraSearch(jql);
    console.log('\n' + label + ' (' + issues.length + ')');
    issues.slice(0, 10).forEach(function (issue) {
      var f = issue.fields || {};
      console.log(' ', issue.key, '|', (f.status && f.status.name) || '?', '|', (f.created || '').slice(0, 10), '|', String(f.summary || '').slice(0, 45));
    });
  }
})().catch(function (e) {
  console.error(e.message || e);
  process.exit(1);
});
