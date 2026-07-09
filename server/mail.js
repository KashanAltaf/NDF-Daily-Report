'use strict';

async function sendViaResend(to, otp) {
  var apiKey = process.env.RESEND_API_KEY;
  var from = process.env.AUTH_FROM_EMAIL || process.env.SMTP_FROM || 'QA Report <onboarding@resend.dev>';
  var res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + apiKey,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      from: from,
      to: [to],
      subject: 'Your NDF QA Report login code',
      html: '<div style="font-family:Arial,sans-serif;line-height:1.5;color:#222;">' +
        '<h2 style="color:#16265f;">NDF Daily QA Report</h2>' +
        '<p>Your one-time login code is:</p>' +
        '<p style="font-size:28px;font-weight:700;letter-spacing:4px;color:#16265f;">' + otp + '</p>' +
        '<p>This code expires in <strong>10 minutes</strong>.</p>' +
        '<p style="color:#666;font-size:12px;">If you did not request this, you can ignore this email.</p>' +
        '</div>'
    })
  });
  var text = await res.text();
  var data;
  try { data = JSON.parse(text); } catch (e) { data = { raw: text }; }
  if (!res.ok) {
    var err = new Error((data && data.message) || text || 'Failed to send email via Resend');
    err.code = 'MAIL';
    throw err;
  }
  return data;
}

async function sendViaSmtp(to, otp) {
  var nodemailer = require('nodemailer');
  var port = Number(process.env.SMTP_PORT || 587);
  var transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: port,
    secure: port === 465,
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS
    }
  });
  var from = process.env.AUTH_FROM_EMAIL || process.env.SMTP_FROM || process.env.SMTP_USER;
  await transporter.sendMail({
    from: from,
    to: to,
    subject: 'Your NDF QA Report login code',
    html: '<div style="font-family:Arial,sans-serif;line-height:1.5;color:#222;">' +
      '<h2 style="color:#16265f;">NDF Daily QA Report</h2>' +
      '<p>Your one-time login code is:</p>' +
      '<p style="font-size:28px;font-weight:700;letter-spacing:4px;color:#16265f;">' + otp + '</p>' +
      '<p>This code expires in <strong>10 minutes</strong>.</p>' +
      '</div>'
  });
}

async function sendOtpEmail(to, otp) {
  if (process.env.RESEND_API_KEY) return sendViaResend(to, otp);
  if (process.env.SMTP_HOST && process.env.SMTP_USER) return sendViaSmtp(to, otp);
  var err = new Error('Email is not configured. Set RESEND_API_KEY or SMTP_HOST/SMTP_USER in environment variables.');
  err.code = 'CONFIG';
  throw err;
}

module.exports = {
  sendOtpEmail: sendOtpEmail
};
