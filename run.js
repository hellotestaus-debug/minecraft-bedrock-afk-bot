'use strict';
// Supervisor: starts bot.js and restarts it if it ever crashes or exits unexpectedly.
// Usage: node run.js   (npm start does this for you)
const { spawn } = require('child_process');
const errs = require('./errors');
const fs = require('fs');
const path = require('path');

const CRASH_LOG = path.join(__dirname, 'crash.log');
let restarts = 0;
const recent = [];
let stopping = false;
let child = null;

function start() {
  const startedAt = Date.now();
  child = spawn(process.execPath, [path.join(__dirname, 'bot.js')], { stdio: 'inherit' });
  child.on('exit', (code, signal) => {
    if (stopping) return process.exit(0);
    const ranFor = Math.round((Date.now() - startedAt) / 1000);
    restarts++;
    recent.push(Date.now());
    while (recent.length && Date.now() - recent[0] > 120000) recent.shift();
    const loop = recent.length >= 5;                      // 5 crashes in 2 minutes = crash loop
    const ecode = code === 2 || loop ? 'E002' : 'E001';
    errs.report(ecode, null, `bot.js exited (code=${code} signal=${signal}) after ${ranFor}s - restart #${restarts}`);
    // wait longer if it keeps dying quickly
    const delay = loop ? 300000 : (ranFor < 20 ? Math.min(60000, 5000 * restarts) : 5000);
    if (loop) console.log('⚠️ Crash loop detected - waiting 5 minutes before the next start. Read crash.log (look at the [E###] codes).');
    console.log(`🔁 Restarting in ${delay / 1000}s...`);
    setTimeout(start, delay);
  });
}

process.on('SIGINT', () => { stopping = true; if (child) child.kill('SIGINT'); else process.exit(0); });
process.on('SIGTERM', () => { stopping = true; if (child) child.kill('SIGTERM'); else process.exit(0); });
start();
