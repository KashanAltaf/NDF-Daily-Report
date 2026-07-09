'use strict';

require('dotenv').config();
var ado = require('../server/ado-client');
var cfg = require('../server/ado-config');

(async function () {
  try {
    var bugs = await ado.fetchReportBugs();
    console.log('ADO bug sync (same pattern as Jira)');
    console.log('  openBugsSince:', bugs.openBugsSince);
    console.log('  today:', bugs.todayTotal);
    console.log('  open (New):', bugs.openTotal);
    console.log('  defect log merge:', bugs.defectLogTotal);
    console.log('  active tracker pool:', bugs.activeTotal);
    console.log('\nQueries:');
    console.log('  today:', bugs.todayWiql);
    console.log('  open:', bugs.openBugsWiql);
    console.log('  defect today:', bugs.todayDefectLogWiql);
    console.log('  active:', bugs.activeBugsWiql);
    console.log('\nStatus map:', cfg.STATUS);

    if (process.argv[2]) {
      var summary = await ado.fetchTestSummary(process.argv[2], process.argv[3]);
      console.log('\nTest summary', summary.startDate, 'to', summary.endDate);
      console.log('In scope:', summary.summary.totalInScope);
      console.log('Executed today:', summary.summary.executedToday);
      console.log('Cumulative:', summary.summary.cumulativeExecuted, 'Not yet:', summary.summary.notYetExecuted);
    }
  } catch (e) {
    console.error(e.message || e);
    process.exit(1);
  }
})();
