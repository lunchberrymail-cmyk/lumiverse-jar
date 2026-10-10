'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const jarRoot = path.resolve(process.argv[2] || process.env.JAR_HOME || '.');
if (!fs.existsSync(path.join(jarRoot, 'src/index.js'))) throw new Error('Usage: node companion/start.cjs PATH_TO_JAR');
process.chdir(jarRoot);
process.env.PLAYWRIGHT_BROWSERS_PATH ||= path.join(jarRoot, 'browsers');
require(path.join(jarRoot, 'node_modules/dotenv')).config();
const tokenFile = path.join(jarRoot, 'companion-token.local.json');
let token = process.env.JAR_TOKEN;
if (!token) {
  if (fs.existsSync(tokenFile)) token = JSON.parse(fs.readFileSync(tokenFile, 'utf8')).token;
  else { token = crypto.randomBytes(32).toString('hex'); fs.writeFileSync(tokenFile, JSON.stringify({ token }), { mode: 0o600 }); }
}
const { app } = require(path.join(jarRoot, 'src/index.js'));
const express = require(path.join(jarRoot, 'node_modules/express'));
const { createService } = require('./service.cjs');
const service = createService({ express, jarApp: app, token, host: process.env.JAR_HOST || '127.0.0.1', port: Number(process.env.JAR_PORT || 4577), publicOrigin: process.env.JAR_PUBLIC_ORIGIN || '' });
service.start().then(address => {
  console.log(`JAR Companion: http://${address.address}:${address.port}/pair`);
  if (process.env.JAR_PUBLIC_ORIGIN) console.log(`Browser workspace: ${process.env.JAR_PUBLIC_ORIGIN}/pair`);
  console.log(`Companion token: ${token}`);
  console.log('Paste this token in the Lumiverse JAR tab. Keep it private.');
}).catch(error => { console.error(error.message); process.exitCode = 1; });
