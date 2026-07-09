'use strict';

require('dotenv').config();
var cfg = require('../server/ado-config');

async function adoFetch(path, options) {
  var auth = 'Basic ' + Buffer.from(':' + cfg.ADO_PAT).toString('base64');
  var url = cfg.projectBaseUrl() + path;
  var res = await fetch(url, Object.assign({}, options || {}, {
    headers: Object.assign({ Authorization: auth, Accept: 'application/json' }, (options && options.headers) || {})
  }));
  var data = await res.json();
  if (!res.ok) throw new Error(JSON.stringify(data));
  return data;
}

(async function () {
  var data = await adoFetch('/_apis/wit/workitemtypes/Bug/states?api-version=' + cfg.ADO_API_VERSION);
  console.log('Bug states in ADO:');
  (data.value || []).forEach(function (s) {
    console.log(' ', s.name, '| category:', s.category);
  });
})().catch(function (e) {
  console.error(e.message || e);
  process.exit(1);
});
