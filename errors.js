'use strict';
// Central error codes + crash log. Every problem the bot can hit gets a short code (E###) so you can
// tell at a glance what happened: see the table below, the `errors` chat command, and crash.log.
const fs = require('fs');
const path = require('path');

const CODES = {
  // process / crash handler
  E001: 'bot.js exited unexpectedly (supervisor restarted it)',
  E002: 'crash loop: too many crashes in a short time (bot restarted clean)',
  E100: 'uncaught exception (bot kept running)',
  E101: 'unhandled promise rejection (bot kept running)',
  E110: 'a timer/tick handler threw an error',
  // connection
  E200: 'could not create the connection',
  E201: 'connection error',
  E202: 'server refused the connection (offline / wrong port)',
  E203: 'server address not found (check serverHost)',
  E204: 'connection timed out',
  E205: 'connection reset',
  E220: 'silence watchdog: no data from the server for too long',
  // kicks
  E210: 'kicked: flying not allowed (anti-fly)',
  E211: 'kicked: chat/command spam',
  E212: 'kicked: timed out',
  E213: 'kicked: invalid / illegal movement packet',
  E214: 'kicked: banned or not whitelisted',
  E215: 'kicked: server full / restarting / stopping',
  E216: 'kicked: idle / AFK',
  E217: 'kicked: logged in from another location',
  E219: 'kicked: other reason',
  // elytra / flight
  E300: 'elytra take-off failed (server did not start gliding)',
  E301: 'elytra travel error',
  E302: 'safe-landing error',
  E303: 'elytra keeps failing: elytra flights turned OFF',
  E304: 'air strike error',
  // stunts
  E310: 'wind-charge jump error',
  E320: 'ender pearl error',
  E330: 'spear stabs are not registering (using normal attacks)',
  E331: 'reach glitch is not landing',
  E332: 'lunge dashes do not move the bot (no Lunge enchant or no hunger)',
  E340: 'grapple / wind-pearl error',
  E341: 'god technique failed repeatedly and was switched OFF (or threw an error)',
  // hunting
  E400: 'cannot locate player (bot is not OP)',
  E401: 'pathfinder keeps failing',
  E402: 'hunt target lost / gave up',
  E403: 'hunt target offline or in another dimension',
  // gear
  E500: 'kit / give command refused (bot is not OP)',
  E501: 'kit item failed',
  // safety nets
  E600: 'invalid (NaN) movement packet blocked before it was sent',
  E602: 'invalid entity_action id repaired/blocked (elytra packet fix for 1.21.9+)',
  E700: 'combat decision error',
  E701: 'combat circuit breaker: fight stopped after repeated errors',
  E800: 'AI request failed (bad key / quota / model / network) - type aitest',
  E801: 'Firebase sync failed (rules / token / network) - type fbtest',
  E900: 'invalid config.json value'
};

const LOG = path.join(__dirname, 'crash.log');
const MAX_LOG = 512 * 1024;
let sink = null;                  // optional: (entry) => void, e.g. Firebase events
const recentList = [];            // newest last, max 40
const lastLogged = {};            // code -> { at, repeats }

function rotate() {
  try { if (fs.statSync(LOG).size > MAX_LOG) fs.renameSync(LOG, LOG + '.old'); } catch (e) { /* no log yet */ }
}

/** Report an error. Never throws. Identical codes are collapsed (max 1 console line per 5 s). */
function report(code, err, extra) {
  try {
    const known = CODES[code] ? code : 'E100';
    const msg = err ? ((err && err.message) || String(err)) : '';
    const entry = { code: known, at: new Date().toISOString(), msg: String(msg).slice(0, 300), extra: extra ? String(extra).slice(0, 200) : undefined };
    recentList.push(entry);
    if (recentList.length > 40) recentList.shift();
    const st = lastLogged[known] || { at: 0, repeats: 0 };
    const quiet = Date.now() - st.at < 5000;
    if (quiet) { st.repeats++; lastLogged[known] = st; }
    else {
      console.error(`❗ [${known}] ${CODES[known]}${msg ? ` - ${String(msg).slice(0, 160)}` : ''}${extra ? ` (${extra})` : ''}${st.repeats ? ` [+${st.repeats} similar]` : ''}`);
      lastLogged[known] = { at: Date.now(), repeats: 0 };
    }
    if (sink && known !== 'E801' && !quiet) { try { sink(entry); } catch (err) { /* never throw from the reporter */ } }
    rotate();
    const stack = err && err.stack && /^E1|^E7|^E0/.test(known) ? `\n${err.stack}` : '';
    fs.appendFileSync(LOG, `[${entry.at}] [${known}] ${CODES[known]}${msg ? ` | ${msg}` : ''}${extra ? ` | ${extra}` : ''}${stack}\n`);
    return entry;
  } catch (e) {
    return null;
  }
}

/** Map a kick / disconnect text to an error code. */
function classifyKick(text = '') {
  const t = String(text);
  if (/fly/i.test(t)) return 'E210';
  if (/spam/i.test(t)) return 'E211';
  if (/time[ds]? ?out/i.test(t)) return 'E212';
  if (/invalid move|illegal|moved (too quickly|wrongly)|invalid (player|position)|netty|decoder|protocol/i.test(t)) return 'E213';
  if (/banned|whitelist/i.test(t)) return 'E214';
  if (/full|restart|stopp?ing|shutdown|maintenance|closed/i.test(t)) return 'E215';
  if (/idle|afk|inactiv/i.test(t)) return 'E216';
  if (/another location|duplicate|logged in/i.test(t)) return 'E217';
  return 'E219';
}

/** Map a Node/network error to a code. */
function classifyNetError(err) {
  const c = (err && (err.code || err.errno)) || '';
  const m = (err && err.message) || String(err || '');
  if (/ECONNREFUSED/.test(c + m)) return 'E202';
  if (/ENOTFOUND|EAI_AGAIN/.test(c + m)) return 'E203';
  if (/ETIMEDOUT|timed out/i.test(c + m)) return 'E204';
  if (/ECONNRESET|EPIPE|socketClosed/.test(c + m)) return 'E205';
  return 'E201';
}

const recent = (n = 5) => recentList.slice(-n);
const describe = (code) => CODES[code] || 'unknown error';

module.exports = { setSink: (f) => { sink = f; }, CODES, report, classifyKick, classifyNetError, recent, describe, LOG };
