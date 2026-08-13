'use strict';

var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function adfToPlainText(node) {
  if (!node) return '';
  if (node.type === 'text') return node.text || '';
  if (node.type === 'hardBreak') return '\n';
  if (Array.isArray(node.content)) {
    return node.content.map(adfToPlainText).join('');
  }
  return '';
}

function isSectionHeading(text) {
  return /^(actual|expected)\s+result/i.test(String(text || '').trim());
}

function isReproHeading(text) {
  return /^steps\s+to\s+reproduce/i.test(String(text || '').trim().replace(/:$/, ''));
}

function listItemsFromBlock(block) {
  var items = [];
  if (!block || !Array.isArray(block.content)) return items;
  block.content.forEach(function (item) {
    var text = adfToPlainText(item).trim();
    if (text) items.push(text);
  });
  return items;
}

function capitalizeSentence(text) {
  text = String(text || '').trim();
  if (!text) return '';
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function normalizeStepText(step) {
  return capitalizeSentence(String(step || '').replace(/^[\s\u2022\-\*\d\.]+/, '').trim());
}

function splitReproFragments(text) {
  return String(text || '')
    .replace(/\s*(?:->|\u2192|→)\s*/gi, '\n')
    .split(/\r?\n/)
    .flatMap(function (line) {
      return line.split(/(?=\d+\.\s)/).map(function (part) {
        return part.trim();
      }).filter(Boolean);
    });
}

function formatReproSteps(steps) {
  if (!steps.length) return '';
  return steps.map(function (step, i) {
    return (i + 1) + '. ' + normalizeStepText(step);
  }).join('\n');
}

function extractReproStepsFromPlain(text) {
  var match = String(text || '').match(/steps\s+to\s+reproduce:?\s*([\s\S]*?)(?=actual\s+result|expected\s+result|$)/i);
  if (!match) return '';
  var body = match[1].trim();
  if (!body) return '';

  var lines = splitReproFragments(body);
  if (!lines.length) return '';

  return formatReproSteps(lines);
}

function extractReproSteps(description) {
  if (!description) return '';
  if (typeof description === 'string') {
    return extractReproStepsFromPlain(description);
  }
  if (description.type !== 'doc' || !Array.isArray(description.content)) {
    return extractReproStepsFromPlain(adfToPlainText(description));
  }

  var collecting = false;
  var steps = [];

  description.content.forEach(function (block) {
    var blockText = adfToPlainText(block).trim();
    if (isReproHeading(blockText)) {
      collecting = true;
      return;
    }
    if (collecting && isSectionHeading(blockText)) {
      collecting = false;
      return;
    }
    if (!collecting) return;

    if (block.type === 'bulletList' || block.type === 'orderedList') {
      steps = steps.concat(listItemsFromBlock(block));
    } else if (blockText) {
      splitReproFragments(blockText).forEach(function (part) { steps.push(part); });
    }
  });

  return formatReproSteps(steps);
}

function formatIssueDate(iso) {
  if (!iso) return '';
  try {
    var d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    var day = String(d.getDate()).padStart(2, '0');
    var month = MONTHS[d.getMonth()] || '';
    return day + '-' + month + '-' + d.getFullYear();
  } catch (e) {
    return '';
  }
}

function priorityToSeverity(priority) {
  var p = String(priority || '').toLowerCase();
  if (/highest|critical|blocker/.test(p)) return '1';
  if (/^high$|major/.test(p)) return '2';
  if (/medium/.test(p)) return '3';
  if (/^low$/.test(p)) return '4';
  if (/lowest|minor|trivial/.test(p)) return '5';
  return '\u2014';
}

function parseSummaryModule(summary) {
  var s = String(summary || '');
  var match = s.match(/^\[([^\]]+)\]\s*[-–—]?\s*/);
  if (!match) return { module: '', summary: s };
  return {
    module: match[1].trim(),
    summary: s.replace(/^\[[^\]]+\]\s*[-–—]?\s*/, '').trim() || s
  };
}

function extractUrlField(value) {
  if (!value) return '';
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'object' && value.url) return String(value.url).trim();
  return '';
}

function normalizePrUrl(url) {
  var raw = String(url || '').trim();
  if (!raw) return '';
  var match = raw.match(/https?:\/\/[^\s"'<>)]+/i);
  raw = match ? match[0] : raw;
  return raw.replace(/[.,;]+$/, '');
}

function isPullRequestUrl(url) {
  var u = String(url || '');
  return /\/pull\/\d+/i.test(u) || /\/merge_requests\/\d+/i.test(u) || /bitbucket\.org\/.*\/pull-requests\//i.test(u);
}

function extractPrUrlFromText(text) {
  var match = String(text || '').match(/https?:\/\/[^\s"'<>)]+(?:\/pull\/\d+|\/merge_requests\/\d+|\/pull-requests\/\d+)/i);
  return match ? normalizePrUrl(match[0]) : '';
}

function walkForPrUrl(value, depth) {
  if (value == null || depth > 8) return '';
  if (typeof value === 'string') {
    var direct = extractUrlField(value);
    if (isPullRequestUrl(direct)) return normalizePrUrl(direct);
    return extractPrUrlFromText(value);
  }
  if (Array.isArray(value)) {
    for (var i = 0; i < value.length; i++) {
      var found = walkForPrUrl(value[i], depth + 1);
      if (found) return found;
    }
    return '';
  }
  if (typeof value === 'object') {
    var url = value.url || value.href || value.objectUrl || '';
    if (isPullRequestUrl(url)) return normalizePrUrl(url);
    if (value.marks && Array.isArray(value.marks)) {
      for (var m = 0; m < value.marks.length; m++) {
        var href = value.marks[m] && value.marks[m].attrs && value.marks[m].attrs.href;
        if (isPullRequestUrl(href)) return normalizePrUrl(href);
      }
    }
    var keys = Object.keys(value);
    for (var k = 0; k < keys.length; k++) {
      var nested = walkForPrUrl(value[keys[k]], depth + 1);
      if (nested) return nested;
    }
  }
  return '';
}

function extractPrUrl(fields, preferredFieldId) {
  if (!fields) return '';
  var preferred = extractUrlField(fields[preferredFieldId]);
  if (preferred) return normalizePrUrl(preferred);
  return walkForPrUrl(fields, 0);
}

function formatPrLinkLabel(url, issueKey) {
  var key = String(issueKey || '').trim();
  if (key) return 'PR-' + key;
  var match = String(url || '').match(/\/(?:pull|merge_requests|pull-requests)\/(\d+)/i);
  if (match) return 'PR-' + match[1];
  return 'PR';
}

module.exports = {
  adfToPlainText: adfToPlainText,
  extractReproSteps: extractReproSteps,
  formatIssueDate: formatIssueDate,
  priorityToSeverity: priorityToSeverity,
  parseSummaryModule: parseSummaryModule,
  splitReproFragments: splitReproFragments,
  extractUrlField: extractUrlField,
  extractPrUrl: extractPrUrl,
  isPullRequestUrl: isPullRequestUrl,
  formatPrLinkLabel: formatPrLinkLabel
};
