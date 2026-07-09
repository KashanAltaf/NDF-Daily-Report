'use strict';

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

var { authenticator } = require('otplib');

var email = String(process.env.JIRA_EMAIL || '').trim();
var issuer = 'NDF Daily QA Report';
var secret = authenticator.generateSecret();
var uri = authenticator.keyuri(email || 'user@company.com', issuer, secret);

console.log('');
console.log('Microsoft Authenticator setup for NDF Daily QA Report');
console.log('===================================================');
console.log('');
if (!email) {
  console.log('Warning: JIRA_EMAIL is not set in .env — set it before deploying.');
  console.log('');
}
console.log('1. Add this to .env and Vercel environment variables:');
console.log('');
console.log('AUTH_TOTP_SECRET=' + secret);
console.log('');
console.log('2. In Microsoft Authenticator:');
console.log('   - Tap + → Other account (Google, Facebook, etc.)');
console.log('   - Choose "Enter code manually"');
console.log('');
console.log('   Account: ' + (email || 'your JIRA_EMAIL'));
console.log('   Secret key: ' + secret);
console.log('   Type: Time based');
console.log('');
console.log('3. otpauth URL (for QR generators):');
console.log(uri);
console.log('');
console.log('Also ensure AUTH_SECRET is set (random string, 16+ chars).');
console.log('');
