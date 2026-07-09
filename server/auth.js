'use strict';

var crypto = require('crypto');

var OTP_TTL_MS = 10 * 60 * 1000;
var SESSION_TTL_MS = 24 * 60 * 60 * 1000;
var OTP_RATE_LIMIT_MS = 60 * 1000;
var CHALLENGE_COOKIE = 'qa_otp_challenge';
var SESSION_COOKIE = 'qa_session';
var RATE_COOKIE = 'qa_otp_rate';

function getAuthSecret() {
  return String(process.env.AUTH_SECRET || '').trim();
}

function getAllowedEmail() {
  return String(process.env.JIRA_EMAIL || '').trim().toLowerCase();
}

function isAuthEnabled() {
  if (!getAuthSecret() || getAuthSecret().length < 16) return false;
  if (!getAllowedEmail()) return false;
  if (process.env.RESEND_API_KEY) return true;
  if (process.env.SMTP_HOST && process.env.SMTP_USER) return true;
  return false;
}

function maskEmail(email) {
  var e = String(email || '').trim();
  var at = e.indexOf('@');
  if (at <= 1) return '***';
  return e.charAt(0) + '***' + e.slice(at);
}

function signPayload(payload) {
  var secret = getAuthSecret();
  var body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  var sig = crypto.createHmac('sha256', secret).update(body).digest('base64url');
  return body + '.' + sig;
}

function verifySignedToken(token) {
  if (!token || typeof token !== 'string') return null;
  var parts = token.split('.');
  if (parts.length !== 2) return null;
  var secret = getAuthSecret();
  var expected = crypto.createHmac('sha256', secret).update(parts[0]).digest('base64url');
  if (parts[1].length !== expected.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(parts[1]))) return null;
  try {
    var payload = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
    if (!payload || !payload.exp || Date.now() > payload.exp) return null;
    return payload;
  } catch (e) {
    return null;
  }
}

function hashOtp(otp) {
  return crypto.createHmac('sha256', getAuthSecret()).update(String(otp)).digest('hex');
}

function generateOtp() {
  return String(crypto.randomInt(100000, 1000000));
}

function parseCookies(req) {
  var out = {};
  var header = req.headers && (req.headers.cookie || req.headers.Cookie);
  if (!header) return out;
  String(header).split(';').forEach(function (part) {
    var idx = part.indexOf('=');
    if (idx === -1) return;
    var key = part.slice(0, idx).trim();
    var val = part.slice(idx + 1).trim();
    try { out[key] = decodeURIComponent(val); } catch (e) { out[key] = val; }
  });
  return out;
}

function isSecureRequest(req) {
  if (process.env.VERCEL) return true;
  var proto = req.headers && (req.headers['x-forwarded-proto'] || '');
  if (proto === 'https') return true;
  return false;
}

function buildCookie(name, value, maxAgeSec, req, clear) {
  var parts = [name + '=' + (clear ? '' : encodeURIComponent(value))];
  parts.push('Path=/');
  parts.push('HttpOnly');
  parts.push('SameSite=Lax');
  if (isSecureRequest(req)) parts.push('Secure');
  if (clear) parts.push('Max-Age=0');
  else if (maxAgeSec) parts.push('Max-Age=' + maxAgeSec);
  return parts.join('; ');
}

function setCookie(res, name, value, maxAgeSec, req) {
  var existing = res.getHeader && res.getHeader('Set-Cookie');
  var cookie = buildCookie(name, value, maxAgeSec, req, false);
  if (!existing) res.setHeader('Set-Cookie', cookie);
  else if (Array.isArray(existing)) res.setHeader('Set-Cookie', existing.concat(cookie));
  else res.setHeader('Set-Cookie', [existing, cookie]);
}

function clearCookie(res, name, req) {
  setCookie(res, name, '', 0, req);
  var cookie = buildCookie(name, '', 0, req, true);
  var existing = res.getHeader && res.getHeader('Set-Cookie');
  if (!existing) res.setHeader('Set-Cookie', cookie);
  else if (Array.isArray(existing)) res.setHeader('Set-Cookie', existing.concat(cookie));
  else res.setHeader('Set-Cookie', [existing, cookie]);
}

function getSession(req) {
  var cookies = parseCookies(req);
  var payload = verifySignedToken(cookies[SESSION_COOKIE]);
  if (!payload || !payload.email) return null;
  if (payload.email !== getAllowedEmail()) return null;
  return payload;
}

function requireAuth(req, res, httpUtil) {
  if (!isAuthEnabled()) return true;
  if (getSession(req)) return true;
  httpUtil.sendJson(res, 401, { ok: false, error: 'Unauthorized', authRequired: true });
  return false;
}

function getSessionInfo(req) {
  if (!isAuthEnabled()) {
    return { ok: true, authEnabled: false, authenticated: true };
  }
  var session = getSession(req);
  return {
    ok: true,
    authEnabled: true,
    authenticated: !!session,
    email: session ? maskEmail(session.email) : maskEmail(getAllowedEmail())
  };
}

async function sendOtp(req, res, httpUtil) {
  if (!isAuthEnabled()) {
    httpUtil.sendJson(res, 503, { ok: false, error: 'Auth is not configured on the server.' });
    return;
  }
  var cookies = parseCookies(req);
  var ratePayload = verifySignedToken(cookies[RATE_COOKIE]);
  if (ratePayload && ratePayload.sentAt && Date.now() - ratePayload.sentAt < OTP_RATE_LIMIT_MS) {
    httpUtil.sendJson(res, 429, { ok: false, error: 'Please wait a minute before requesting another code.' });
    return;
  }

  var otp = generateOtp();
  var challenge = signPayload({
    h: hashOtp(otp),
    email: getAllowedEmail(),
    exp: Date.now() + OTP_TTL_MS
  });
  var rate = signPayload({ sentAt: Date.now(), exp: Date.now() + OTP_RATE_LIMIT_MS });

  var mail = require('./mail');
  await mail.sendOtpEmail(getAllowedEmail(), otp);

  setCookie(res, CHALLENGE_COOKIE, challenge, Math.ceil(OTP_TTL_MS / 1000), req);
  setCookie(res, RATE_COOKIE, rate, 120, req);
  httpUtil.sendJson(res, 200, {
    ok: true,
    sent: true,
    email: maskEmail(getAllowedEmail()),
    expiresInMinutes: 10
  });
}

async function verifyOtp(req, res, httpUtil, body) {
  if (!isAuthEnabled()) {
    httpUtil.sendJson(res, 503, { ok: false, error: 'Auth is not configured on the server.' });
    return;
  }
  var code = String((body && body.code) || (body && body.otp) || '').trim();
  if (!/^\d{6}$/.test(code)) {
    httpUtil.sendJson(res, 400, { ok: false, error: 'Enter the 6-digit code from your email.' });
    return;
  }
  var cookies = parseCookies(req);
  var challenge = verifySignedToken(cookies[CHALLENGE_COOKIE]);
  if (!challenge || challenge.h !== hashOtp(code) || challenge.email !== getAllowedEmail()) {
    httpUtil.sendJson(res, 401, { ok: false, error: 'Invalid or expired code.' });
    return;
  }
  var session = signPayload({
    email: getAllowedEmail(),
    exp: Date.now() + SESSION_TTL_MS
  });
  clearCookie(res, CHALLENGE_COOKIE, req);
  setCookie(res, SESSION_COOKIE, session, Math.ceil(SESSION_TTL_MS / 1000), req);
  httpUtil.sendJson(res, 200, { ok: true, authenticated: true, email: maskEmail(getAllowedEmail()) });
}

function logout(req, res, httpUtil) {
  clearCookie(res, SESSION_COOKIE, req);
  clearCookie(res, CHALLENGE_COOKIE, req);
  httpUtil.sendJson(res, 200, { ok: true, loggedOut: true });
}

module.exports = {
  isAuthEnabled: isAuthEnabled,
  maskEmail: maskEmail,
  getSession: getSession,
  requireAuth: requireAuth,
  getSessionInfo: getSessionInfo,
  sendOtp: sendOtp,
  verifyOtp: verifyOtp,
  logout: logout
};
