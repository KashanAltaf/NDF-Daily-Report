'use strict';

var zlib = require('zlib');

function formatDuration(ms) {
  var n = Number(ms) || 0;
  if (n <= 0) return '0s';
  if (n < 1000) return Math.round(n) + 'ms';
  var sec = n / 1000;
  if (sec < 60) return (Math.round(sec * 10) / 10) + 's';
  var min = Math.floor(sec / 60);
  var rem = Math.round(sec % 60);
  return min + 'm ' + rem + 's';
}

function formatBrowserName(projectName) {
  var n = String(projectName || '').toLowerCase();
  if (n.indexOf('chromium') >= 0 || n.indexOf('chrome') >= 0) return 'Chrome';
  if (n.indexOf('firefox') >= 0) return 'Firefox';
  if (n.indexOf('webkit') >= 0 || n.indexOf('safari') >= 0) return 'Safari';
  if (n.indexOf('edge') >= 0) return 'Edge';
  return projectName || '\u2014';
}

function capitalizeAutomationDescription(str) {
  var s = String(str || '').trim();
  if (!s) return '';
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function automationModuleFromPath(pathValue) {
  if (Array.isArray(pathValue)) return String(pathValue[0] || '').trim() || '\u2014';
  var s = String(pathValue || '').trim();
  if (!s) return '\u2014';
  var sep = s.indexOf('\u203a');
  if (sep < 0) sep = s.indexOf('>');
  if (sep >= 0) return s.slice(0, sep).trim() || '\u2014';
  return s || '\u2014';
}

function splitAutomationTitle(title) {
  var t = String(title || '').trim();
  if (!t) return { tcNo: '\u2014', testCase: '\u2014' };
  var colon = t.indexOf(':');
  if (colon >= 0) {
    return {
      tcNo: t.slice(0, colon).trim() || '\u2014',
      testCase: capitalizeAutomationDescription(t.slice(colon + 1)) || '\u2014'
    };
  }
  return { tcNo: '\u2014', testCase: capitalizeAutomationDescription(t) || '\u2014' };
}

function parseCombinedAutomationLabel(full) {
  var text = String(full || '').trim();
  if (!text) return { module: '\u2014', tcNo: '\u2014', testCase: '\u2014' };
  var sep = text.indexOf('\u203a');
  if (sep < 0) sep = text.indexOf('>');
  if (sep >= 0) {
    var module = text.slice(0, sep).trim() || '\u2014';
    var parts = splitAutomationTitle(text.slice(sep + 1).trim());
    return { module: module, tcNo: parts.tcNo, testCase: parts.testCase };
  }
  var parts = splitAutomationTitle(text);
  return { module: '\u2014', tcNo: parts.tcNo, testCase: parts.testCase };
}

function normalizeAutomationRow(row) {
  var base = row || {};
  if (base.module && base.tcNo && base.testCase) {
    return {
      module: base.module,
      tcNo: base.tcNo,
      testCase: capitalizeAutomationDescription(base.testCase) || base.testCase,
      browser: base.browser,
      passed: base.passed,
      failed: base.failed,
      flaky: base.flaky,
      skipped: base.skipped,
      runTime: base.runTime
    };
  }
  if (base.testCase && (String(base.testCase).indexOf('\u203a') >= 0 || String(base.testCase).indexOf('>') >= 0 || String(base.testCase).indexOf(':') >= 0)) {
    var parsed = parseCombinedAutomationLabel(base.testCase);
    return {
      module: parsed.module,
      tcNo: parsed.tcNo,
      testCase: parsed.testCase,
      browser: base.browser,
      passed: base.passed,
      failed: base.failed,
      flaky: base.flaky,
      skipped: base.skipped,
      runTime: base.runTime
    };
  }
  var titleParts = splitAutomationTitle(base.testCase || base.title || base.name);
  return {
    module: base.module || '\u2014',
    tcNo: base.tcNo || titleParts.tcNo,
    testCase: titleParts.testCase,
    browser: base.browser,
    passed: base.passed,
    failed: base.failed,
    flaky: base.flaky,
    skipped: base.skipped,
    runTime: base.runTime
  };
}

function classifyTestResults(test) {
  var results = test && test.results ? test.results : [];
  var passed = 0;
  var failed = 0;
  var flaky = 0;
  var skipped = 0;
  var runTimeMs = 0;

  if (test && test.status === 'flaky') flaky = 1;

  if (!results.length) {
    return { passed: passed, failed: failed, flaky: flaky, skipped: skipped, runTimeMs: runTimeMs };
  }

  results.forEach(function (result) {
    runTimeMs += Number(result.duration) || 0;
    var status = String(result.status || '').toLowerCase();
    if (status === 'passed') passed += 1;
    else if (status === 'skipped') skipped += 1;
    else if (status === 'failed' || status === 'timedout' || status === 'interrupted') failed += 1;
  });

  if (results.length > 1 && results[results.length - 1].status === 'passed' && failed > 0) {
    flaky = Math.max(flaky, 1);
  }

  if (results.length === 1) {
    passed = failed = skipped = 0;
    var only = String(results[0].status || '').toLowerCase();
    if (only === 'passed') passed = 1;
    else if (only === 'skipped') skipped = 1;
    else failed = 1;
  }

  return { passed: passed, failed: failed, flaky: flaky, skipped: skipped, runTimeMs: runTimeMs };
}

function classifyHtmlTest(test) {
  if (test && test.results && test.results.length && test.results[0].status) {
    return classifyTestResults(test);
  }
  var passed = 0;
  var failed = 0;
  var flaky = 0;
  var skipped = 0;
  var runTimeMs = Number(test.duration) || 0;
  var outcome = String(test.outcome || test.status || '').toLowerCase();
  if (outcome === 'flaky') flaky = 1;
  else if (outcome === 'skipped') skipped = 1;
  else if (test.ok === true || outcome === 'expected') passed = 1;
  else if (test.ok === false || outcome === 'unexpected') failed = 1;
  return { passed: passed, failed: failed, flaky: flaky, skipped: skipped, runTimeMs: runTimeMs };
}

function walkSuites(suites, prefix, rows) {
  (suites || []).forEach(function (suite) {
    var suiteTitle = String(suite.title || '').trim();
    var nextPrefix = prefix ? (suiteTitle ? prefix + ' \u203a ' + suiteTitle : prefix) : suiteTitle;

    (suite.specs || []).forEach(function (spec) {
      var specTitle = String(spec.title || '').trim();
      var titleParts = splitAutomationTitle(specTitle);

      (spec.tests || []).forEach(function (test) {
        var counts = classifyTestResults(test);
        rows.push({
          module: automationModuleFromPath(nextPrefix),
          tcNo: titleParts.tcNo,
          testCase: titleParts.testCase,
          browser: formatBrowserName(test.projectName),
          passed: counts.passed,
          failed: counts.failed,
          flaky: counts.flaky,
          skipped: counts.skipped,
          runTime: formatDuration(counts.runTimeMs)
        });
      });
    });

    if (suite.suites && suite.suites.length) walkSuites(suite.suites, nextPrefix, rows);
  });
}

function walkHtmlReportFiles(files, rows) {
  (files || []).forEach(function (file) {
    (file.tests || []).forEach(function (test) {
      var titleParts = splitAutomationTitle(test.title);
      var counts = classifyHtmlTest(test);
      rows.push({
        module: automationModuleFromPath(test.path),
        tcNo: titleParts.tcNo,
        testCase: titleParts.testCase,
        browser: formatBrowserName(test.projectName),
        passed: counts.passed,
        failed: counts.failed,
        flaky: counts.flaky,
        skipped: counts.skipped,
        runTime: formatDuration(counts.runTimeMs)
      });
    });
  });
}

function parsePlaywrightReport(data) {
  if (!data) return [];

  if (Array.isArray(data)) {
    return data.map(function (item) {
      return normalizeAutomationRow({
        module: item.module,
        tcNo: item.tcNo,
        testCase: item.testCase || item.title || item.name,
        browser: formatBrowserName(item.browser || item.projectName),
        passed: Number(item.passed) || 0,
        failed: Number(item.failed) || 0,
        flaky: Number(item.flaky) || 0,
        skipped: Number(item.skipped) || 0,
        runTime: item.runTime || formatDuration(item.duration || item.runTimeMs)
      });
    });
  }

  if (data.rows && Array.isArray(data.rows)) return parsePlaywrightReport(data.rows);

  var rows = [];
  if (data.suites && data.suites.length) {
    walkSuites(data.suites, '', rows);
    return rows;
  }

  if (data.files && Array.isArray(data.files)) {
    var hasHtmlTests = data.files.some(function (file) { return file.tests && file.tests.length; });
    if (hasHtmlTests) {
      walkHtmlReportFiles(data.files, rows);
      return rows;
    }
    data.files.forEach(function (file) {
      walkSuites(file.suites || [], file.fileName || file.file || '', rows);
    });
    return rows;
  }

  return rows;
}

function extractFileFromZip(zipBuf, targetName) {
  var off = 0;
  while (off < zipBuf.length - 30) {
    if (zipBuf.readUInt32LE(off) !== 0x04034b50) break;
    var method = zipBuf.readUInt16LE(off + 8);
    var csize = zipBuf.readUInt32LE(off + 18);
    var nlen = zipBuf.readUInt16LE(off + 26);
    var xlen = zipBuf.readUInt16LE(off + 28);
    var name = zipBuf.toString('utf8', off + 30, off + 30 + nlen);
    var dataStart = off + 30 + nlen + xlen;
    var raw = zipBuf.subarray(dataStart, dataStart + csize);
    if (method === 8) raw = zlib.inflateRawSync(raw);
    if (name === targetName) return raw;
    off = dataStart + csize;
  }
  return null;
}

function extractJsonFromHtml(html) {
  var text = String(html || '');
  var scriptMatch = text.match(/<script[^>]*id="playwrightReport"[^>]*>([\s\S]*?)<\/script>/i);
  if (scriptMatch) {
    try { return JSON.parse(scriptMatch[1]); } catch (e) { /* continue */ }
  }
  var jsonMatch = text.match(/<script[^>]*type="application\/json"[^>]*>([\s\S]*?)<\/script>/i);
  if (jsonMatch) {
    try { return JSON.parse(jsonMatch[1]); } catch (e) { /* continue */ }
  }
  var templateMatch = text.match(/<template id="playwrightReportBase64">data:application\/zip;base64,([\s\S]*?)<\/template>/i);
  if (templateMatch) {
    try {
      var zipBuf = Buffer.from(templateMatch[1].replace(/\s/g, ''), 'base64');
      var jsonBuf = extractFileFromZip(zipBuf, 'report.json');
      if (jsonBuf) return JSON.parse(jsonBuf.toString('utf8'));
    } catch (e) { /* continue */ }
  }
  return null;
}

function parsePlaywrightUpload(payload) {
  if (!payload) return { rows: [], error: 'Empty report payload' };

  if (typeof payload === 'string') {
    try {
      return { rows: parsePlaywrightReport(JSON.parse(payload)) };
    } catch (e) {
      var fromHtml = extractJsonFromHtml(payload);
      if (fromHtml) return { rows: parsePlaywrightReport(fromHtml) };
      return { rows: [], error: 'Could not parse report file. Upload playwright-report/index.html or report.json.' };
    }
  }

  if (payload.report) {
    if (typeof payload.report === 'string') {
      try {
        return { rows: parsePlaywrightReport(JSON.parse(payload.report)) };
      } catch (e) {
        return parsePlaywrightUpload(payload.report);
      }
    }
    return { rows: parsePlaywrightReport(payload.report) };
  }
  if (payload.json) return { rows: parsePlaywrightReport(payload.json) };
  if (payload.html) return parsePlaywrightUpload(payload.html);

  return { rows: parsePlaywrightReport(payload) };
}

module.exports = {
  parsePlaywrightReport: parsePlaywrightReport,
  parsePlaywrightUpload: parsePlaywrightUpload,
  formatDuration: formatDuration,
  formatBrowserName: formatBrowserName
};
