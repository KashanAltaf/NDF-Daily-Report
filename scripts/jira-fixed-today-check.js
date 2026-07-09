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
    body: JSON.stringify({ jql: jql, maxResults: 100, fields: ['status', 'created', 'updated', 'summary'] })
  });
  var data = await res.json();
  if (!res.ok) throw new Error((data.errorMessages || []).join('; ') || JSON.stringify(data));
  return data.issues || [];
}

(async function () {
  var jqls = [
    ['created today + Create-PRD-PR', cfg.BASE_JQL + ' AND created >= startOfDay() AND status = "Create-PRD-PR"'],
    ['status changed to Create-PRD-PR today', cfg.BASE_JQL + ' AND status changed to "Create-PRD-PR" during (startOfDay(), now())'],
    ['Create-PRD-PR updated today', cfg.BASE_JQL + ' AND status = "Create-PRD-PR" AND updated >= startOfDay()']
  ];
  for (var i = 0; i < jqls.length; i++) {
    var issues = await jiraSearch(jqls[i][1] + ' ORDER BY updated DESC');
    console.log('\n' + jqls[i][0] + ': ' + issues.length);
    issues.slice(0, 8).forEach(function (issue) {
      var f = issue.fields || {};
      console.log(' ', issue.key, '| created', (f.created || '').slice(0, 10), '| updated', (f.updated || '').slice(0, 10), '|', f.status && f.status.name);
    });
  }
})().catch(function (e) {
  console.error(e.message || e);
  process.exit(1);
});
