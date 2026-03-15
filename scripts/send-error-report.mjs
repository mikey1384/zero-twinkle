#!/usr/bin/env node
import os from "os";
import nodemailer from "nodemailer";
import dotenv from "dotenv";

dotenv.config();

const componentPath = process.argv[2] || "AIZero/Watchdog";
const message = process.argv[3] || "AIZero error detected";
const info = process.argv[4] || "";
const clientVersion = process.argv[5] || "";

const mailAuth = {
  type: "OAuth2",
  user: process.env.MAIL_USER,
  serviceClient: process.env.MAIL_CLIENT_ID,
  privateKey: (process.env.MAIL_PRIVATE_KEY || "").replace(/\\n/gm, "\n"),
};

if (!mailAuth.user || !mailAuth.serviceClient || !mailAuth.privateKey) {
  console.error("[error-report] missing mail auth env vars");
  process.exit(1);
}

const smtpTransport = nodemailer.createTransport({
  host: "smtp.gmail.com",
  port: 465,
  secure: true,
  auth: mailAuth,
});

const to = process.env.ERROR_REPORT_TO || "mikey1384@gmail.com";
const from = process.env.ERROR_REPORT_FROM || "twinkle.notification@gmail.com";
const subject = process.env.ERROR_REPORT_SUBJECT || "Error Report";
const hostname = os.hostname();
const nowUtc = new Date().toISOString();

const mailOptions = {
  from,
  to,
  subject,
  html: `
    ${componentPath ? `<b>Component: ${escapeHtml(componentPath)}</b>` : ""}
    <p>Error Message: ${escapeHtml(message)}</p>
    ${info ? `<p>Info: ${escapeHtml(info)}</p>` : ""}
    <p>Hostname: ${escapeHtml(hostname)}</p>
    <p>Time (UTC): ${escapeHtml(nowUtc)}</p>
    ${clientVersion ? `<p>Client version: ${escapeHtml(clientVersion)}</p>` : ""}
  `,
};

try {
  await smtpTransport.sendMail(mailOptions);
  console.log(`[error-report] sent to ${to}`);
} catch (error) {
  console.error("[error-report] email sending failed:", error);
  process.exit(1);
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
