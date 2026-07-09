'use strict';

var httpUtil = require('./vercel-http');
var auth = require('./auth');

module.exports = function guard(handler) {
  return async function guardedHandler(req, res) {
    if (req.method === 'OPTIONS') return httpUtil.handleOptions(res);
    if (!auth.requireAuth(req, res, httpUtil)) return;
    return handler(req, res);
  };
};
