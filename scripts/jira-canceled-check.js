'use strict';

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
var cfg = require('../server/jira-config');

function authHeader() {
  return 'Basic ' + Buffer.from(process.env.JIRA_EMAIL + ':' + process.env.JIRA_API_TOKEN).toString('base64');
}

async function search(jql) {
  var res = await fetch(cfg.JIRA_BASE_URL + '/rest/api/3/search/jql', {
    method: 'POST',
    headers: { Authorization: authHeader(), Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ jql: jql, maxResults: 20, fields: ['status', 'created'] })
  });
  var data = await res.json();
  if (!res.ok) throw new Error((data.errorMessages || []).join('; ') || res.statusText);
  return (data.issues || []).map(function (i) {
    return { key: i.key, status: i.fields.status && i.fields.status.name };
  });
}

(async function () {
  for (var st of ['Canceled', 'CANCELED', 'Cancelled']) {
    var list = await search(cfg.BASE_JQL + ' AND status = "' + st + '" ORDER BY updated DESC');
    console.log('status=' + st + ':', list.length, list.map(function (i) { return i.key + '(' + i.status + ')'; }).join(', '));
  }
  var active = await search(cfg.activeBugsJql());
  console.log('activeBugsJql:', active.length);
  var canceledInActive = active.filter(function (i) {
    return String(i.status || '').replace(/[\s_\-\/]+/g, '').toLowerCase().indexOf('cancel') >= 0;
  });
  console.log('canceled-like in active:', canceledInActive);
})().catch(function (e) { console.error(e); process.exit(1); });
