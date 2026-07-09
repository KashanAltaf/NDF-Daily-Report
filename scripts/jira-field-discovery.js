'use strict';

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
var cfg = require('../server/jira-config');

function authHeader() {
  return 'Basic ' + Buffer.from(process.env.JIRA_EMAIL + ':' + process.env.JIRA_API_TOKEN).toString('base64');
}

(async function () {
  var res = await fetch(cfg.JIRA_BASE_URL + '/rest/api/3/field', {
    headers: { Authorization: authHeader(), Accept: 'application/json' }
  });
  var fields = await res.json();
  fields.filter(function (f) {
    return /github|pr|uat/i.test(f.name || '') || /github|pr|uat/i.test(f.id || '');
  }).forEach(function (f) {
    console.log(f.id, '|', f.name, '|', f.schema && f.schema.custom);
  });

  var issueRes = await fetch(cfg.JIRA_BASE_URL + '/rest/api/3/search/jql', {
    method: 'POST',
    headers: { Authorization: authHeader(), Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jql: cfg.BASE_JQL + ' AND status = "Create-PRD-PR" ORDER BY updated DESC',
      maxResults: 3,
      fields: ['status', 'summary', '*all']
    })
  });
  var data = await issueRes.json();
  (data.issues || []).slice(0, 2).forEach(function (issue) {
    console.log('\nIssue', issue.key);
    Object.keys(issue.fields || {}).filter(function (k) {
      return /github|pr|uat|customfield/i.test(k);
    }).forEach(function (k) {
      var v = issue.fields[k];
      if (v && typeof v === 'object') v = JSON.stringify(v);
      console.log(' ', k, '=', String(v || '').slice(0, 120));
    });
  });
})().catch(function (e) {
  console.error(e.message || e);
  process.exit(1);
});
