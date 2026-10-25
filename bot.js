const mineflayer = require('mineflayer');
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder');
const fs = require('fs');
const path = require('path');
const createCombat = require('./combat');
const { Vec3 } = require('vec3');
const createGuard = require('./guard');
const createEscape = require('./escape');
const createTalk = require('./talk');
const errs = require('./errors');
const createBrain = require('./brain');
const createBuilder = require('./build');
const llm = require('./llm');
const crypto = require('crypto');
const compat = require('./compat');
const createSurvival = require('./survival');
const createNav = require('./nav');
const createFirebase = require('./firebase');

const defaults = {
  reconnectDelay: 5000,
  maxReconnectDelay: 60000,
  owners: [],
  commandPrefix: '',
  autoArmor: true,
  autoTotem: true,
  autoEat: true,
  autoElytra: true,
  autoKit: true,
  eatBelowFood: 14,
  eatGappleBelowHealth: 10,
  weaponPriority: ['mace', 'spear', 'sword', 'axe'],
  huntRadius: 32,
  guardRadius: 12,
  killGiveUpMs: 20000,
  logChat: true,
  friends: [],
  guardAssist: true,
  antiIdleSeconds: 25,
  keepAliveTimeoutMs: 90000,
  autoOpKit: true,
  godGear: true,
  talk: true,
  trashTalk: true,
  aiChat: { enabled: false, apiKey: '', model: 'claude-sonnet-5-5' },
  escapeTpToOwner: true,
  huntGiveUpMs: 300000,
  silenceTimeoutMs: 75000,
  airstrike: true,
  windSmash: true,
  airstrikeMinDist: 18,
  airstrikeMobs: false,
  maxTravelRockets: 12,
  chatGapMs: 1150,
  huntLocateMs: 8000,
  climbHeight: 22,
  maxClimbRockets: 3,
  minHealthForStunts: 10,
  stuntCooldownMs: 2500,
  spearJab: 'both',
  spearStabStatus: 7,
  hostileMobs: ['zombie', 'creeper', 'spider', 'skeleton']
};
const cfg = { ...defaults, ...require('./config.json') };

const VERSION = '3.3';
// Compare names ignoring case and leading symbols (Bedrock/Geyser names start with "." or "*")
const normName = (n) => String(n || '').replace(/^[^A-Za-z0-9_]+/, '').toLowerCase();
const owners = cfg.owners.map(normName);
const hostileSet = new Set(cfg.hostileMobs);
const isOwner = (name) => !!name && owners.includes(normName(name));

// ---------- owner password lock ----------
// While locked the bot does nothing (no commands, no talking, no kit). The owner unlocks it by WHISPERING the password:
//   /msg <botname> <password>
const authCfg = { enabled: false, maxAttempts: 5, lockoutMinutes: 10, ...(cfg.auth || {}) };
const authPassword = process.env.BOT_PASSWORD || authCfg.password || '';
if (authCfg.enabled && !authPassword) { errs.report('E900', null, 'auth.enabled is true but no password is set - lock disabled'); authCfg.enabled = false; }
const sha = (x) => crypto.createHash('sha256').update(String(x)).digest();
const passwordOk = (x) => crypto.timingSafeEqual(sha(x), sha(authPassword));   // constant-time compare
const authed = new Set();            // owners who unlocked the bot (kept across reconnects, cleared by "lock" / restart)
const authFails = new Map();         // owner -> { count, until }
const lockedNow = () => authCfg.enabled && authed.size === 0;
const leaksPassword = (txt) => authCfg.enabled && !!authPassword && String(txt).includes(authPassword);

// Friends are never attacked (config "friends" + chat commands friend/unfriend, saved to friends.json)
const FRIENDS_FILE = path.join(__dirname, 'friends.json');
const friends = new Set((cfg.friends || []).map(normName));
try { JSON.parse(fs.readFileSync(FRIENDS_FILE, 'utf8')).forEach((n) => friends.add(normName(n))); } catch (e) { /* no file yet */ }
const saveFriends = () => { try { fs.writeFileSync(FRIENDS_FILE, JSON.stringify([...friends])); } catch (e) { /* ignore */ } };
const isFriend = (name) => !!name && friends.has(normName(name));

// Disconnect reasons are written to disconnects.log so you can see WHY it left
const DISCONNECT_LOG = path.join(__dirname, 'disconnects.log');
let lastDisconnect = null;
function flattenReason(r) {
  try {
    let v = r;
    if (typeof v === 'string') { try { v = JSON.parse(v); } catch (e) { return v; } }
    try { if (v && v.type === 'compound') v = require('prismarine-nbt').simplify(v); } catch (e) { /* ignore */ }
    const out = [];
    const walk = (n) => {
      if (n == null) return;
      if (typeof n === 'string' || typeof n === 'number') { out.push(String(n)); return; }
      if (Array.isArray(n)) { n.forEach(walk); return; }
      if (typeof n === 'object') {
        if (n.text !== undefined) walk(n.text);
        if (n.translate) out.push(n.translate);
        if (n.with) walk(n.with);
        if (n.extra) walk(n.extra);
      }
    };
    walk(v);
    return out.join('').trim() || JSON.stringify(r);
  } catch (e) {
    return String(r);
  }
}
const fmtDuration = (sec) => `${Math.floor(sec / 60)}m ${sec % 60}s`;

const escapeRe = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// Turns a raw chat line into [username, message] for different server chat formats
// Whisper formats: "X whispers to you: msg" | "[X -> me] msg" | "(From X): msg" | "From X: msg"
function parseWhisperLine(msg) {
  const c = msg.replace(/§./g, '').trim();
  let m = c.match(/^(\S+) whispers(?: to you)?:\s*(.+)$/i) || c.match(/^\[(\S+)\s*(?:->|→|»)\s*[^\]]+\]\s*(.+)$/) ||
    c.match(/^\(From (\S+)\):?\s*(.+)$/i) || c.match(/^From (\S+):\s*(.+)$/i);
  return m ? [m[1], m[2]] : null;
}
function parseChatLine(msg) {
  const clean = msg.replace(/§./g, '').trim();
  let m = clean.match(/^(?:\[[^\]]*\]\s*|\([^)]*\)\s*)*<([^>]+)>\s*(.+)$/);
  if (m) return [m[1], m[2]];
  // Owner-aware: "Name: cmd", "Name » cmd", "[Rank] Name > cmd", "Name cmd"...
  for (const o of cfg.owners) {
    const re = new RegExp(
      '^(?:\\[[^\\]]*\\]\\s*|\\([^)]*\\)\\s*)*<?[^\\w\\s<]{0,2}' + escapeRe(normName(o)) +
      '(?=[\\s>:»›➤→⇒|\\-\\]])[>\\]]?\\s*(?:[:»›>➤→⇒|\\-]+\\s*)?(\\S.*)$', 'i');
    m = clean.match(re);
    if (m) return [o, m[1]];
  }
  return null;
}

const STEP_INTERVAL = 1500;
const JUMP_DURATION = 500;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const ARMOR_TIERS = ['netherite', 'diamond', 'iron', 'chainmail', 'golden', 'copper', 'leather', 'turtle'];
const ARMOR_SLOTS = { head: 5, torso: 6, legs: 7, feet: 8 };
const BAD_FOOD = new Set([
  'pufferfish', 'spider_eye', 'rotten_flesh', 'poisonous_potato',
  'chorus_fruit', 'chicken', 'suspicious_stew', 'golden_apple', 'enchanted_golden_apple'
]);

const HELP_LINES = [
  '== ALL COMMANDS (owner only; type them in chat, with or without !) ==',
  'MOVE: come (fly/walk/run to me) | follow [name] | goto <x> <y> <z> | guard [me|here|strict] | afk | stop | unstuck | sleep | autosleep on|off',
  'FIGHT: kill <player|mob> (then returns to me) | pvp (hunt mobs) | style <auto|god|mace|spear|sword|axe> | trick <name> on|off | air|wind|pearl on|off | flee | friend <n> | unfriend <n> | friends',
  'GEAR: kit [op] | armor | totem | eat | elytra | fly | inv | status | tactics | godcheck (why is a trick not working)',
  'AI: just talk normally and I answer & act like a player | ai <anything> | ai auto on|off | ai goal <text> | ai on|off (chat replies) | brain [on|off] | think | aitest | talk on|off',
  'BUILD: build <wall|shelter|platform|bridge|tower|cover> [size] | cleanup | say <text>',
  'SYSTEM: help | why (last disconnect) | errors [codes] | fbtest (firebase) | lock | rejoin'
];

// Enchantments for the creative kit (only applied if the server version accepts them)
const E = {
  helmet: { protection: 4, unbreaking: 3, mending: 1, respiration: 3, aqua_affinity: 1 },
  chest: { protection: 4, unbreaking: 3, mending: 1 },
  legs: { protection: 4, unbreaking: 3, mending: 1, swift_sneak: 3 },
  boots: { protection: 4, feather_falling: 4, depth_strider: 3, unbreaking: 3, mending: 1 },
  mace: { breach: 4, wind_burst: 3, unbreaking: 3, mending: 1, fire_aspect: 2 },
  spear: { sharpness: 5, lunge: 3, fire_aspect: 2, looting: 3, unbreaking: 3, mending: 1 },
  sword: { sharpness: 5, fire_aspect: 2, looting: 3, sweeping_edge: 3, unbreaking: 3, mending: 1 },
  axe: { sharpness: 5, efficiency: 5, unbreaking: 3, mending: 1 },
  elytra: { unbreaking: 3, mending: 1 },
  pickaxe: { efficiency: 5, unbreaking: 3, mending: 1 }
};

// "God" weapons: custom-named, unbreakable, over-enchanted (vanilla limits only apply to tables/anvils)
const G = {
  mace: { density: 10, breach: 10, wind_burst: 5, fire_aspect: 5, unbreaking: 10, mending: 1 },
  spear: { sharpness: 10, lunge: 5, fire_aspect: 5, looting: 10, unbreaking: 10, mending: 1 },
  sword: { sharpness: 10, fire_aspect: 5, looting: 10, sweeping_edge: 5, unbreaking: 10, mending: 1 },
  axe: { sharpness: 10, efficiency: 10, unbreaking: 10, mending: 1 },
  elytra: { unbreaking: 10, mending: 1 }
};
const GOD_NAMES = { mace: 'God Mace', spear: 'God Spear', sword: 'God Sword', axe: 'God Axe', elytra: 'God Wings' };

// Never let one stray error kill the whole bot: log it with an error code and keep running.
// If errors pour in (>8 in 30 s) the state is probably corrupt: exit so run.js restarts a clean process.
const crashTimes = [];
function logCrash(kind, err, code) {
  errs.report(code, err);
  const now = Date.now();
  crashTimes.push(now);
  while (crashTimes.length && now - crashTimes[0] > 30000) crashTimes.shift();
  if (crashTimes.length > 8) {
    errs.report('E002', err, `${crashTimes.length} errors in 30s`);
    console.error('💥 Too many errors in a row - exiting so the supervisor (run.js) restarts a clean bot. Use "npm start" to get auto-restart.');
    process.exit(2);
  }
}
process.on('uncaughtException', (err) => logCrash('Uncaught exception', err, 'E100'));
process.on('unhandledRejection', (err) => logCrash('Unhandled rejection', err, 'E101'));

let opDenied = false; // set when a /give command was refused (bot is not OP); `kit` retries
let bot = null;
let reconnectTimer = null;
let currentDelay = cfg.reconnectDelay;
let shuttingDown = false;
let chatGapBoost = 1;   // grows if the server ever kicks us for chat spam

function createBot() {
  try { createBotInner(); } catch (e) {
    errs.report('E200', e);
    scheduleReconnect();
  }
}

function createBotInner() {
  console.log(`🔌 Connecting to ${cfg.serverHost}:${cfg.serverPort} as ${cfg.botUsername}...`);

  const instance = mineflayer.createBot({
    host: cfg.serverHost,
    port: cfg.serverPort,
    username: cfg.botUsername,
    auth: 'offline',
    version: false,
    viewDistance: cfg.botChunk,
    checkTimeoutInterval: cfg.keepAliveTimeoutMs   // tolerate laggy servers (default 30s is too strict)
  });
  bot = instance;
  instance.loadPlugin(pathfinder);
  instance._client.on('packet', () => { lastPacketAt = Date.now(); });

  // ---------- per-session state ----------
  const sessionStart = Date.now();
  let kickReason = null;
  let spawnedAt = 0;
  let ended = false;
  let started = false;
  const timers = [];
  const every = (ms, fn) => timers.push(setInterval(() => { try { fn(); } catch (e) { errs.report('E110', e); } }, ms));

  let mode = authCfg.enabled && authed.size === 0 ? 'idle' : 'afk';   // afk | idle | pvp | guard | kill | follow | goto   (idle = locked, waiting for the password)
  let killSpec = null;         // { type: 'player'|'mob', name }
  let followName = null;
  let guardPos = null;
  let guardOwner = false;
  let selfDefenseUntil = 0;
  let huntStart = 0;
  let huntPos = null;
  let locating = false;
  let lastLocate = 0;
  let travelling = false;
  let hintedOp = false;
  const lastSeen = {};
  let safeMovements = null;
  let lastPacketAt = Date.now();
  let guardStrict = false;
  let lastAutoOpKit = 0;
  let cmdWatch = false;
  let goalKey = null;
  let killLostSince = 0;
  let killCount = 0;
  let eating = false;
  let armorBusy = false;
  let elytraWorn = false;      // true => don't swap elytra out for a chestplate
  let elytraRestore = false;   // true => put chestplate back after landing
  let deploying = false;
  let kitGiven = false;
  let kitBusy = false;
  let justDied = false;
  let movementPhase = 0;
  let movementTimer = null;
  let jumpTimer = null;
  let lastCmdKey = '';
  let lastCmdTime = 0;

  // ---------- packet guard: never let a bad (NaN / Infinity) move packet reach the server ----------
  // A single NaN position/rotation makes the server disconnect us ("Invalid move player packet received").
  {
    const rawWrite = instance._client.write.bind(instance._client);
    const MOVE_PACKETS = new Set(['position', 'position_look', 'look', 'flying']);
    let lastGood = null;
    let blocked = 0;
    instance._client.write = (name, params) => {
      try {
        if (name === 'entity_action' && params) {
          const r = compat.sanitizeEntityAction(instance, params);
          if (r.bad) { errs.report('E602', null, `entity_action id ${params.actionId} blocked`); return undefined; }
          if (r.fixed) { errs.report('E602', null, 'entity_action id 8 repaired -> start_fall_flying'); params = r.params; }
        }
        if (params && MOVE_PACKETS.has(name)) {
          const bad = ['x', 'y', 'z', 'yaw', 'pitch'].some((k) => k in params && (typeof params[k] !== 'number' || !Number.isFinite(params[k]))) ||
            Math.abs(params.x || 0) > 3e7 || Math.abs(params.z || 0) > 3e7 || Math.abs(params.y || 0) > 1e5;
          if (bad) {
            if (++blocked <= 5) errs.report('E600', null, `${name} ${JSON.stringify(params)}`);
            const en = instance.entity;
            if (en && lastGood) { en.position.set(lastGood.x, lastGood.y, lastGood.z); en.velocity.set(0, 0, 0); }
            return undefined;
          }
          if ('x' in params) lastGood = { x: params.x, y: params.y, z: params.z };
        }
      } catch (e) { /* never break the connection from the guard itself */ }
      return rawWrite(name, params);
    };
  }

  // ---------- chat / command output ----------
  // ONE queue for everything the bot sends (chat, /give, /data, /tp ...). Vanilla servers kick for spam
  // when more than ~1 message per second is sustained, so the gap between messages is never below ~1.1 s.
  let rawChat = null;                                // mineflayer adds bot.chat only after the connection is up
  const outQ = [];
  let lastOut = 0;
  const chatGap = () => Math.max(1000, cfg.chatGapMs || 1150) * chatGapBoost;
  function sendLine(text) {
    return new Promise((resolve) => {
      if (ended) return resolve(false);
      const isCmd = String(text).startsWith('/');
      if (!isCmd) {                                   // chatter never piles up: keep the newest few lines
        let n = outQ.filter((o) => !o.cmd).length;
        while (n >= 14) {
          const i = outQ.findIndex((o) => !o.cmd);
          outQ.splice(i, 1)[0].resolve(false);
          n--;
        }
      }
      outQ.push({ text: String(text), cmd: isCmd, resolve });
    });
  }
  every(100, () => {
    if (ended || !rawChat || !outQ.length || Date.now() - lastOut < chatGap()) return;
    const m = outQ.shift();
    lastOut = Date.now();
    try { rawChat(m.text); m.resolve(true); } catch (e) { m.resolve(false); }
  });
  function installChatWrap() {
    if (rawChat || typeof instance.chat !== 'function') return;
    rawChat = instance.chat.bind(instance);
    instance.chat = (t) => { sendLine(t); };          // anything that calls bot.chat() is throttled too
    instance.whisper = (u, t) => { sendLine(`/tell ${u} ${t}`); };
  }
  installChatWrap();
  instance.once('inject_allowed', installChatWrap);
  instance.once('login', installChatWrap);
  instance.once('spawn', installChatWrap);
  // mineflayer's elytraFly() sends an action id that 1.21.9+ servers cannot decode (kick!). Use the version-aware one.
  function installCompat() { instance.elytraFly = () => compat.elytraFly(instance); }
  installCompat();
  instance.once('inject_allowed', installCompat);
  instance.once('login', installCompat);
  instance.once('spawn', installCompat);
  function say(text) {
    if (lockedNow()) return;                           // locked: stay silent until the owner whispers the password
    for (const line of String(text).split('\n')) {
      for (let i = 0; i < line.length; i += 240) sendLine(line.slice(i, i + 240));
    }
  }

  // ---------- inventory lock (one inventory action at a time) ----------
  let invLock = Promise.resolve();
  function withInv(fn) {
    const p = invLock.then(fn);
    invLock = p.catch(() => {});
    return p;
  }

  // ---------- helpers ----------
  const gameMode = () => instance.game && instance.game.gameMode;
  const inSurvivalLike = () => ['survival', 'adventure'].includes(gameMode());

  function clearControls() {
    for (const c of ['forward', 'back', 'left', 'right', 'jump', 'sprint', 'sneak']) instance.setControlState(c, false);
  }
  function clearGoal() {
    goalKey = null;
    instance.pathfinder.setGoal(null);
  }
  function setGoalOnce(key, make, dynamic = false) {
    if (goalKey === key) return;
    goalKey = key;
    instance.pathfinder.setGoal(make(), dynamic);
  }
  /** A task is over (kill done, target lost, retreat finished ...): go back to the owner (or just stand by). */
  function endTask() {
    if (cfg.returnAfterTask === false || lockedNow()) return setMode(lockedNow() ? 'idle' : 'afk');
    comeName = ownerName();
    comeStart = Date.now();
    comePos = null;
    dimChecked = false;
    pathFails = 0;
    travelFailedAt = 0;
    comeNoDestSince = 0;
    setMode('come');
  }
  function setMode(m) {
    mode = m;
    killSpec = null;
    if (nav) nav.reset();
    combat.disengage();
    clearGoal();
    clearControls();
    if (m === 'afk') instance.setControlState('sneak', true);
  }
  function findPlayer(name) {
    return Object.values(instance.players).find((p) => p.username.toLowerCase() === name.toLowerCase());
  }
  function isProtected(name) {
    return isOwner(name) || isFriend(name) || name.toLowerCase() === instance.username.toLowerCase();
  }

  // ---------- combat (see combat.js) ----------
  const fight = (ent) => { if (brain && brain.shouldAvoid(ent)) return; combat.engage(ent); };
  function findHostile(origin, radius) {
    let best = null;
    let bestDist = Infinity;
    for (const e of Object.values(instance.entities)) {
      if (e === instance.entity || !hostileSet.has(e.name) || e.isValid === false) continue;
      const d = origin.distanceTo(e.position);
      if (d < radius && d < bestDist) { best = e; bestDist = d; }
    }
    return best;
  }
  function findMobByName(name, radius = 64) {
    let best = null;
    let bestDist = Infinity;
    for (const e of Object.values(instance.entities)) {
      if (e === instance.entity || e.name !== name || e.isValid === false) continue;
      const d = instance.entity.position.distanceTo(e.position);
      if (d < radius && d < bestDist) { best = e; bestDist = d; }
    }
    return best;
  }

  // ---------- hunting a player that is out of sight ----------
  /** Ask the server (needs OP) for something about an entity, e.g. /data get entity Steve Pos. Never throws, always resolves. */
  function serverQuery(cmd, regex) {
    return new Promise((resolve) => {
      let finished = false;
      let timer = null;
      const prevWatch = cmdWatch;
      cmdWatch = true;
      const hard = setTimeout(() => done(null), 20000);      // absolute safety net
      const done = (v) => {
        if (finished) return;
        finished = true;
        instance.removeListener('messagestr', onMsg);
        clearTimeout(timer);
        clearTimeout(hard);
        cmdWatch = prevWatch;
        resolve(v);
      };
      const onMsg = (msg) => {
        const m = msg.match(regex);
        if (m) return done(m);
        if (/no entity was found|no player was found|no entities found|no targets matched/i.test(msg)) return done('offline');
        if (opDenied) return done(null);
      };
      instance.on('messagestr', onMsg);
      // the timeout only starts once the command has really been sent (it waits in the anti-spam queue)
      sendLine(cmd).then((ok) => {
        if (finished) return;
        if (!ok) return done(null);
        timer = setTimeout(() => done(null), 4000);
      });
    });
  }
  let dimChecked = false;
  async function locatePlayer(name) {
    const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // dimension: only asked once per hunt (saves commands); position: every cycle
    if (!dimChecked) {
      const dim = await serverQuery(`/data get entity ${name} Dimension`, new RegExp(`${esc}.*entity data:\\s*"?(?:minecraft:)?([a-z_]+)"?`, 'i'));
      if (dim === 'offline') return 'offline';
      if (dim === null && opDenied) return null;
      dimChecked = true;
      const mine = String((instance.game && instance.game.dimension) || '').replace('minecraft:', '');
      if (Array.isArray(dim) && mine && dim[1] && !mine.includes(dim[1]) && !dim[1].includes(mine)) { dimChecked = false; return 'dimension'; }
    }
    const pos = await serverQuery(`/data get entity ${name} Pos`, new RegExp(`${esc}.*entity data:\\s*\\[\\s*(-?[\\d.eE+-]+)d?\\s*,\\s*(-?[\\d.eE+-]+)d?\\s*,\\s*(-?[\\d.eE+-]+)d?\\s*\\]`, 'i'));
    if (pos === 'offline') return 'offline';
    if (!Array.isArray(pos)) return null;
    const v = new Vec3(+pos[1], +pos[2], +pos[3]);
    return Number.isFinite(v.x + v.y + v.z) ? v : null;
  }

  let gotoDest = null;
  let comeName = null;
  let comeStart = 0;
  let comePos = null;
  let comeLastLocate = 0;
  let comeLocating = false;
  let comeNoDestSince = 0;
  let comeEscaped = false;
  let pathFails = 0;
  let travelFailedAt = 0;
  let arrivedSince = 0;
  let huntNoDestSince = 0;
  instance.on('path_update', (r) => {
    if (!r) return;
    if (r.status === 'noPath' || r.status === 'timeout') pathFails++;
    else if (r.status === 'success') pathFails = 0;
  });
  /** A walking target that is never farther than ~48 blocks (long legs are cut up, the pathfinder hates unloaded chunks). */
  function legGoal(dest) {
    const me = instance.entity.position;
    const dx = dest.x - me.x;
    const dz = dest.z - me.z;
    const dh = Math.hypot(dx, dz);
    if (dh <= 48) return new goals.GoalNear(dest.x, dest.y, dest.z, 4);
    const k = 44 / dh;
    return new goals.GoalNearXZ(me.x + dx * k, me.z + dz * k, 4);
  }
  function giveUpHunt(text, code) {
    errs.report(code || 'E402', null, text);
    say(text);
    endTask();
  }
  /** mode 'come': get next to the owner by the best way: elytra / pearl when far, then run (sprint) or walk. */
  function comeTick() {
    combat.release();
    const name = comeName || ownerName();
    if (Date.now() - comeStart > 240000) { say("I could not reach you. Tell me where you are: goto x y z"); setMode('afk'); return; }
    if (combat.isBusy()) return;                       // flying / landing / swimming out: let it finish
    const pl = findPlayer(name);
    const ent = pl && pl.entity;
    if (ent) { lastSeen[name] = ent.position.clone(); comePos = null; comeNoDestSince = 0; }
    if (!ent && !opDenied && !comeLocating && Date.now() - comeLastLocate > 8000) {
      comeLocating = true;
      locatePlayer(name).then((r) => {
        comeLocating = false;
        comeLastLocate = Date.now();
        if (mode !== 'come') return;
        if (r === 'offline') { say(`${name} is not online.`); setMode('afk'); } else if (r === 'dimension') { say(`${name} is in another dimension.`); setMode('afk'); } else if (r) comePos = r;
      }).catch(() => { comeLocating = false; comeLastLocate = Date.now(); });
    }
    const dest = ent ? ent.position : (comePos || lastSeen[name]);
    if (!dest) {
      if (!comeNoDestSince) comeNoDestSince = Date.now();
      if (Date.now() - comeNoDestSince > 20000) { say(`I can't find you. Give me OP so I can locate you, or tell me: goto x y z`); setMode('afk'); }
      return;
    }
    const me = instance.entity.position;
    const dh = Math.hypot(dest.x - me.x, dest.z - me.z);
    if (ent && me.distanceTo(ent.position) <= 4) { clearGoal(); setMode('afk'); return; }     // arrived
    if (!ent && dh < 5) { clearGoal(); return; }                                              // at the last known spot, waiting for a location update
    // the navigator plans the route (fly when far, walk otherwise), watches progress and un-sticks itself
    const liveDest = () => { const p = findPlayer(name); return (p && p.entity) ? p.entity.position : (comePos || lastSeen[name]); };
    const res = nav.step(dest, { key: 'come', range: 2, follow: ent || null, destFn: liveDest, tpName: name, abort: () => mode !== 'come' });
    if (res === 'failed') {
      if (!comeEscaped) { comeEscaped = true; nav.reset(); escapeSys.escape('terrain').catch(() => {}); return; }
      say("I can't find a way to you. Come closer, or give me OP so I can teleport.");
      setMode('afk');
    }
  }

  // ---------- water rescue (after a wind / elytra landing in water the bot used to float there doing nothing) ----------
  let waterSince = 0;
  let rescuing = false;
  function waterTick() {
    const e = instance.entity;
    if (!e || rescuing || instance.isSleeping || ended) return;
    if (!e.isInWater) { waterSince = 0; return; }
    if (!waterSince) waterSince = Date.now();
    if (Date.now() - waterSince < 1500 || combat.isBusy() || e.elytraFlying) return;
    const t = combat.getTarget();
    if (t && t.position && e.position.distanceTo(t.position) < 6) return;                     // fighting in the water is fine
    rescuing = true;
    const name = comeName || ownerName();
    const hint = (mode === 'come' || mode === 'kill') ? (comePos || huntPos || lastSeen[(killSpec && killSpec.name) || name] || lastSeen[name]) : lastSeen[name];
    combat.waterEscape(hint || null).catch(() => {}).finally(() => { rescuing = false; waterSince = 0; });
  }

  function huntTick() {
    const name = killSpec.name;
    combat.release();                               // drop the fight target but NEVER abort a flight in progress
    if (Date.now() - huntStart > cfg.huntGiveUpMs) return giveUpHunt(`I could not find ${name}. Giving up.`);

    // 1) ask the server where the player is (needs OP) - rate limited
    if (!opDenied && !locating && Date.now() - lastLocate > (cfg.huntLocateMs || 8000)) {
      locating = true;
      locatePlayer(name).then((r) => {
        locating = false;
        lastLocate = Date.now();
        if (mode !== 'kill' || !killSpec || killSpec.name !== name) return;
        if (r === 'offline') giveUpHunt(`${name} is not online.`, 'E403');
        else if (r === 'dimension') giveUpHunt(`${name} is in another dimension. I can't reach them.`, 'E403');
        else if (r) { huntPos = r; huntNoDestSince = 0; }
      }).catch(() => { locating = false; lastLocate = Date.now(); });
    }
    const dest = huntPos || lastSeen[name];
    if (!dest) {
      if (!huntNoDestSince) huntNoDestSince = Date.now();
      if (opDenied && !hintedOp) {
        hintedOp = true;
        say(`I can't see ${name}. Give me OP (/op ${instance.username}) so I can locate players, or use: goto x y z`);
      }
      if (opDenied && Date.now() - huntNoDestSince > 45000) giveUpHunt(`I can't find ${name} without OP. Stopping the hunt.`, 'E400');
      return;
    }
    const me = instance.entity.position;
    const dh = Math.hypot(dest.x - me.x, dest.z - me.z);
    const d = me.distanceTo(dest);

    // 2) arrived but still can't see them: wait for the next location update, give up if we can't get one
    if (dh < 6 && Math.abs(dest.y - me.y) < 12) {
      clearGoal();
      if (!arrivedSince) arrivedSince = Date.now();
      if (opDenied && Date.now() - arrivedSince > 8000) giveUpHunt(`I reached the last place I saw ${name}, but they are gone. Stopping.`);
      return;
    }
    arrivedSince = 0;

    // 3) the navigator plans the route (elytra when far, walking legs otherwise), detects "stuck" and recovers
    const liveDest = () => huntPos || lastSeen[name];
    const res = nav.step(dest, { key: 'hunt', range: 4, destFn: liveDest, tpName: name,
      abort: () => mode !== 'kill' || !!(instance.players[name] && instance.players[name].entity) });
    if (res === 'failed') giveUpHunt(`I can't find a way to ${name}. Stopping the hunt.`, 'E401');
  }

  function modeTick() {
    if (!instance.entity || ended || escapeSys.isEscaping() || instance.isSleeping) return;
    switch (mode) {
      case 'pvp': {
        const t = findHostile(instance.entity.position, cfg.huntRadius);
        if (t) fight(t);
        else { combat.release(); if (!combat.isBusy()) { clearGoal(); instance.setControlState('sprint', false); } }
        break;
      }
      case 'guard': {
        const oe = guardOwner ? guard.ownerEntities()[0] : null;
        const anchor = (oe && oe.position) || guardPos || instance.entity.position;
        const t = guard.pick(anchor, cfg.guardRadius, { strict: guardStrict });
        if (t) {
          if (selfDefenseUntil) selfDefenseUntil = Date.now() + 20000;
          fight(t);
        } else {
          combat.release();
          if (combat.isBusy()) break;
          instance.setControlState('sprint', false);
          if (selfDefenseUntil && Date.now() > selfDefenseUntil) { selfDefenseUntil = 0; setMode('afk'); break; }
          if (oe) {
            if (oe.position.distanceTo(instance.entity.position) > 4) setGoalOnce(`gf${oe.id}`, () => new goals.GoalFollow(oe, 3), true);
          } else if (guardPos && instance.entity.position.distanceTo(guardPos) > 2) {
            setGoalOnce('home', () => new goals.GoalNear(guardPos.x, guardPos.y, guardPos.z, 1));
          } else clearGoal();
        }
        break;
      }
      case 'kill': {
        const ent = killSpec.type === 'player'
          ? (instance.players[killSpec.name] && instance.players[killSpec.name].entity)
          : findMobByName(killSpec.name, Math.max(64, cfg.huntRadius));
        if (ent) {
          killLostSince = Date.now();
          huntPos = null;
          arrivedSince = 0;
          lastSeen[killSpec.name] = ent.position.clone();      // players AND mobs: remember where it was
          fight(ent);
        } else if (killSpec.type === 'player') {
          huntTick();
        } else {
          // mob out of range / not loaded: walk to where we last saw it, give up politely after killGiveUpMs
          combat.release();
          const last = lastSeen[killSpec.name];
          if (Date.now() - killLostSince > cfg.killGiveUpMs) {
            say(`I lost ${killSpec.name} (too far / not loaded). Coming back.`);
            endTask();
          } else if (last && !combat.isBusy() && instance.entity.position.distanceTo(last) > 5) {
            setGoalOnce(`mob${Math.round(last.x / 4)}_${Math.round(last.z / 4)}`, () => legGoal(last));
          } else if (!combat.isBusy()) clearGoal();
        }
        break;
      }
      case 'come': comeTick(); break;
      case 'goto': {
        if (!gotoDest) { setMode('afk'); break; }
        const r = nav.step(gotoDest, { key: 'goto', range: 1.5, tpName: null });
        if (r === 'arrived') { say('Arrived.'); setMode('afk'); } else if (r === 'failed') { say("Can't find a way there."); setMode('afk'); }
        break;
      }
      case 'follow': {
        const p = instance.players[followName];
        if (p && p.entity) setGoalOnce(`f${p.entity.id}`, () => new goals.GoalFollow(p.entity, 2), true);
        break;
      }
      default:
        break;
    }
  }

  instance.on('playerLeft', (p) => {
    if (mode === 'kill' && killSpec && killSpec.type === 'player' && p && p.username === killSpec.name) {
      say(`${killSpec.name} left the game.`);
      endTask();
    }
  });

  instance.on('entityDead', (e) => {
    if (e === instance.entity) return;
    if (mode === 'pvp' || mode === 'guard') {
      if (hostileSet.has(e.name)) killCount++;
    } else if (mode === 'kill' && killSpec) {
      const hit = killSpec.type === 'player' ? e.username === killSpec.name : e.name === killSpec.name;
      if (hit) {
        fb.event('kill', { target: killSpec.name });
        if (killSpec.type === 'player') talk.kill(killSpec.name);
        else say(`Killed ${killSpec.name}!`);
        endTask();
      }
    }
    if (e.type === 'player' && e.username && !isProtected(e.username) && combat.hasTarget() && mode !== 'kill') talk.kill(e.username);
  });

  // ---------- armor ----------
  function pieceDest(name) {
    if (name.endsWith('_helmet')) return 'head';
    if (name.endsWith('_chestplate')) return 'torso';
    if (name.endsWith('_leggings')) return 'legs';
    if (name.endsWith('_boots')) return 'feet';
    return null;
  }
  const armorScore = (name) => {
    const i = ARMOR_TIERS.findIndex((t) => name.startsWith(t));
    return i === -1 ? 50 : i;
  };
  async function autoArmor() {
    if (!cfg.autoArmor || armorBusy || !instance.entity) return;
    armorBusy = true;
    try {
      for (const dest of ['head', 'torso', 'legs', 'feet']) {
        if (dest === 'torso' && elytraWorn) continue;
        const worn = instance.inventory.slots[ARMOR_SLOTS[dest]];
        const wornScore = worn && pieceDest(worn.name) === dest ? armorScore(worn.name) : 99;
        const best = instance.inventory.items()
          .filter((i) => pieceDest(i.name) === dest)
          .sort((a, b) => armorScore(a.name) - armorScore(b.name))[0];
        if (best && armorScore(best.name) < wornScore) await withInv(() => instance.equip(best, dest));
      }
    } catch (e) { /* ignore, retry next cycle */ }
    armorBusy = false;
  }

  // ---------- totem ----------
  async function autoTotem() {
    if (!cfg.autoTotem || !instance.entity) return;
    try {
      const slot = instance.getEquipmentDestSlot('off-hand');
      const off = instance.inventory.slots[slot];
      if (off && off.name === 'totem_of_undying') return;
      const totem = instance.inventory.items().find((i) => i.name === 'totem_of_undying');
      if (totem) await withInv(() => instance.equip(totem, 'off-hand'));
    } catch (e) { /* ignore */ }
  }

  // ---------- eating ----------
  function bestFood() {
    const foods = instance.registry.foodsByName;
    return instance.inventory.items()
      .filter((i) => foods[i.name] && !BAD_FOOD.has(i.name))
      .sort((a, b) => foods[b.name].foodPoints - foods[a.name].foodPoints)[0];
  }
  function gapple() {
    const items = instance.inventory.items();
    return items.find((i) => i.name === 'golden_apple') || items.find((i) => i.name === 'enchanted_golden_apple');
  }
  async function eatNow(force = false) {
    if (eating || !instance.entity || !inSurvivalLike()) return false;
    let item = null;
    if (instance.health <= cfg.eatGappleBelowHealth) item = gapple();
    if (!item && (force || instance.food <= cfg.eatBelowFood) && instance.food < 20) item = bestFood();
    if (!item) return false;
    eating = true;
    try {
      await withInv(() => instance.equip(item, 'hand'));
      await instance.consume();
      return true;
    } catch (e) {
      await sleep(3000);
      return false;
    } finally {
      eating = false;
    }
  }

  // ---------- elytra ----------
  const findElytra = () => instance.inventory.items().find((i) => i.name === 'elytra');
  async function wearElytra() {
    const torso = instance.inventory.slots[ARMOR_SLOTS.torso];
    if (torso && torso.name === 'elytra') { elytraWorn = true; return true; }
    const el = findElytra();
    if (!el) return false;
    await withInv(() => instance.equip(el, 'torso'));
    elytraWorn = true;
    return true;
  }
  async function flyNow() {
    const r = await combat.flyUp();
    if (!r.ok) say(`Could not take off: ${r.why}`.slice(0, 200));
    // combat.js lands the bot safely once it is gliding with nothing to do (see landSafely)
  }
  async function equipChestplateNow() {
    elytraWorn = false;
    elytraRestore = false;
    const best = instance.inventory.items()
      .filter((i) => pieceDest(i.name) === 'torso')
      .sort((a, b) => armorScore(a.name) - armorScore(b.name))[0];
    if (!best) return false;
    await withInv(() => instance.equip(best, 'torso'));
    return true;
  }

  const combat = createCombat(instance, {
    cfg,
    say,
    report: errs.report,
    aggression: () => { try { return brain.aggression(); } catch (e) { return 'normal'; } },
    withInv,
    isEating: () => eating,
    pathFollow: (ent) => setGoalOnce(`t${ent.id}`, () => new goals.GoalFollow(ent, 2), true),
    pathStop: () => clearGoal(),
    elytra: {
      wear: wearElytra,
      isWorn: () => elytraWorn,
      setRestore: (v) => { elytraRestore = v; },
      putChestplate: equipChestplateNow
    }
  });

  const guard = createGuard(instance, {
    cfg,
    isOwner,
    isFriend,
    isHostile: (e) => hostileSet.has(e.name),
    say
  });

  const talk = createTalk(instance, {
    cfg,
    report: errs.report,
    isOwner,
    say,
    whisper: (u, t) => instance.whisper(u, t)
  });

  const ownerName = () => {
    const p = Object.values(instance.players).find((x) => isOwner(x.username));
    return p ? p.username : cfg.owners[0];
  };
  const escapeSys = createEscape(instance, {
    cfg,
    pf: { goals, Movements },
    say,
    abortCombat: () => combat.disengage(),
    windLaunchOut: (dir) => combat.windLaunchOut(dir),
    pearlOut: (dir) => combat.pearlOut(dir),
    tpToOwner: async () => { await sendLine(`/tp ${instance.username} ${ownerName()}`); await sleep(1500); },
    // OP last resort: clear a 3x3x3 area around us
    opClear: async () => {
      if (opDenied) return false;
      const f = instance.entity.position.floored();
      cmdWatch = true;
      await sendLine(`/fill ${f.x - 1} ${f.y} ${f.z - 1} ${f.x + 1} ${f.y + 2} ${f.z + 1} air destroy`);
      await sleep(1500);
      cmdWatch = false;
      return !opDenied;
    },
    whisperOwner: (text) => { try { instance.whisper(ownerName(), text); } catch (e) { /* owner offline */ } },
    withInv,
    resetGoal: () => { goalKey = null; },
    restoreMovements: () => {
      if (safeMovements) instance.pathfinder.setMovements(safeMovements);
      if (mode === 'afk') instance.setControlState('sneak', true);   // the escape cleared it
    }
  });

  let survival = null;
  let nav = null;
  // ---------- builder + brain ----------
  function walkTo(pos, range = 3) {
    return new Promise((resolve) => {
      const p = pos.offset ? pos : new Vec3(pos.x, pos.y, pos.z);
      instance.pathfinder.setGoal(new goals.GoalNear(p.x, p.y, p.z, range));
      const t0 = Date.now();
      const iv = setInterval(() => {
        if (!instance.entity || Date.now() - t0 > 9000 || instance.entity.position.distanceTo(p) <= range + 1) {
          clearInterval(iv);
          instance.pathfinder.setGoal(null);
          resolve();
        }
      }, 250);
    });
  }
  const builder = createBuilder(instance, { cfg, withInv, walkTo });
  const brain = createBrain(instance, {
    cfg, say, combat, builder,
    isProtected, isOwner, hostileSet,
    getMode: () => mode,
    setMode: (m) => setMode(m),
    runCommand: (c, args) => { const f = commands[aliases[c] || c]; if (f) f(args || [], ownerName()); },
    eatNow,
    tpToOwner: async () => { await sendLine(`/tp ${instance.username} ${ownerName()}`); await sleep(1500); },
    opDenied: () => opDenied,
    goTo: (pos, range) => { goalKey = `brain${Date.now()}`; instance.pathfinder.setGoal(new goals.GoalNearXZ(pos.x, pos.z, range || 5)); },
    clearGoal,
    locked: lockedNow,
    report: errs.report,
    currentTarget: () => combat.getTarget(),
    techStats: () => combat.techStats(),
    event: (k, d) => { try { fb.event(k, d); } catch (e) { /* ignore */ } }
  });
  const fb = createFirebase(cfg, { name: () => instance.username || cfg.botUsername, report: errs.report });
  errs.setSink((en) => { fb.event('error', { code: en.code, msg: en.msg }); });
  function syncFirebase() {
    if (!fb.enabled() || !instance.entity) return;
    const p = instance.entity.position;
    fb.status({ version: VERSION, hp: Math.round(instance.health), food: instance.food, mode, style: combat.getWeapon(), pos: [Math.round(p.x), Math.round(p.y), Math.round(p.z)],
      dim: String((instance.game && instance.game.dimension) || ''), kills: killCount, uptimeSec: Math.round((Date.now() - sessionStart) / 1000), brain: brain.status(), sleeping: !!instance.isSleeping });
    fb.saveMemory({ friends: [...friends], goal: brain.getGoal(), techniques: combat.techStats(), kills: killCount });
  }
  survival = createSurvival(instance, {
    cfg, say, withInv, walkTo, builder, brain, combat,
    getMode: () => mode,
    escape: (r) => escapeSys.escape(r),
    report: errs.report,
    locked: lockedNow
  });
  instance.on('physicsTick', () => { try { survival.stepTick(); } catch (e) { /* never break physics */ } });
  nav = createNav(instance, {
    cfg, combat, builder,
    think: (t) => brain.think(t),
    countOf: (n) => instance.inventory.items().filter((i) => i.name === n).reduce((a, i) => a + i.count, 0),
    canFly: () => combat.canFly(),
    opDenied: () => opDenied,
    tp: (d, name) => sendLine(name ? `/tp ${instance.username} ${name}` : `/tp ${instance.username} ${d.x.toFixed(1)} ${d.y.toFixed(1)} ${d.z.toFixed(1)}`),
    report: errs.report
  });


  function escapeIntent() {
    if (mode === 'idle' || combat.isBusy() || eating) return 'none';
    if (mode === 'afk') return 'none';
    if (mode === 'goto' || mode === 'come') return 'none';       // the navigator (nav.js) watches progress itself
    if (mode === 'follow') {
      const p = instance.players[followName];
      return p && p.entity && p.entity.position.distanceTo(instance.entity.position) > 6 ? 'moving' : 'none';
    }
    if (combat.hasTarget()) return combat.targetDistance() > 4 ? 'moving' : 'none';
    if (mode === 'kill' && killSpec && killSpec.type === 'player' && (huntPos || lastSeen[killSpec.name])) return travelling ? 'none' : 'moving';
    if (mode === 'guard' && guardOwner) {
      const oe = guard.ownerEntities()[0];
      return oe && oe.position.distanceTo(instance.entity.position) > 6 ? 'moving' : 'none';
    }
    return 'none';
  }

  // Auto-deploy elytra when falling fast, put chestplate back after landing
  instance.on('physicsTick', () => {
    const e = instance.entity;
    if (!cfg.autoElytra || !e || deploying || combat.hasTarget() || combat.isBusy()) {
      if (e && elytraRestore && e.onGround && !e.elytraFlying && !combat.isBusy()) {
        elytraRestore = false;
        elytraWorn = false;
        autoArmor();
      }
      return;
    }
    if (elytraRestore && e.onGround && !e.elytraFlying) {
      elytraRestore = false;
      elytraWorn = false;
      autoArmor();
      return;
    }
    if (inSurvivalLike() && !e.onGround && !e.elytraFlying && !e.isInWater && e.velocity.y < -1.0 &&
        (findElytra() || (instance.inventory.slots[ARMOR_SLOTS.torso] || {}).name === 'elytra')) {
      deploying = true;
      wearElytra()
        .then(() => { elytraRestore = true; return instance.elytraFly(); })
        .catch(() => {})
        .finally(() => { deploying = false; });
    }
  });

  // ---------- creative kit ----------
  async function giveKit(auto = false) {
    if (kitBusy || (auto && kitGiven)) return;
    if (gameMode() !== 'creative') {
      say("I need creative mode for the kit. Give me creative, then type: kit");
      return;
    }
    kitBusy = true;
    const Item = require('prismarine-item')(instance.registry);
    const skipped = [];
    const reg = instance.registry;
    let enchantFailed = false;
    const makeItem = (name, count, ench) => {
      const item = new Item(reg.itemsByName[name].id, count);
      if (ench) {
        const list = Object.entries(ench).filter(([n]) => reg.enchantmentsByName[n]);
        if (list.length) {
          if (reg.version['>=']('1.20.5')) {
            item.components.push({
              type: 'enchantments',
              data: { enchantments: list.map(([n, l]) => ({ id: reg.enchantmentsByName[n].id, level: l })) }
            });
          } else {
            item.enchants = list.map(([n, l]) => ({ name: n, lvl: l }));
          }
        }
      }
      return item;
    };
    // Check the packet can be encoded BEFORE sending, so a bad enchant never breaks the connection
    const encodable = (slot, item) => {
      try {
        instance._client.serializer.createPacketBuffer({ name: 'set_creative_slot', params: { slot, item: Item.toNotch(item) } });
        return true;
      } catch (e) {
        return false;
      }
    };
    const put = async (slot, names, count = 1, ench = null) => {
      const list = Array.isArray(names) ? names : [names];
      const name = list.find((n) => reg.itemsByName[n]);
      if (!name) { skipped.push(list[0]); return; }
      let item = makeItem(name, count, ench);
      if (ench && !encodable(slot, item)) {
        enchantFailed = true;
        item = makeItem(name, count, null);
      }
      try {
        await instance.creative.setInventorySlot(slot, item);
      } catch (e) {
        errs.report('E501', e, `slot ${slot} ${name}`);
      }
      await sleep(60);
    };
    try {
      say('Getting my PvP kit...');
      // worn armor
      await put(5, 'netherite_helmet', 1, E.helmet);
      await put(6, 'netherite_chestplate', 1, E.chest);
      await put(7, 'netherite_leggings', 1, E.legs);
      await put(8, 'netherite_boots', 1, E.boots);
      // hotbar
      const W = cfg.godGear !== false ? G : E;
      await put(36, 'mace', 1, W.mace);
      await put(37, ['netherite_spear', 'diamond_spear', 'iron_spear'], 1, W.spear);
      await put(38, 'netherite_sword', 1, W.sword);
      await put(39, 'netherite_axe', 1, W.axe);
      await put(40, 'enchanted_golden_apple', 64);
      await put(41, 'ender_pearl', 16);
      await put(42, 'wind_charge', 64);
      await put(43, 'firework_rocket', 64);
      await put(44, 'water_bucket', 1);
      await put(23, 'cooked_beef', 64);
      await put(24, 'cobblestone', 64);
      await put(26, 'white_bed', 1);
      await put(25, ['netherite_pickaxe', 'diamond_pickaxe', 'iron_pickaxe'], 1, E.pickaxe);
      // inventory: 9 totems, elytra, spare armor
      for (let s = 9; s <= 17; s++) await put(s, 'totem_of_undying');
      await put(18, 'elytra', 1, (cfg.godGear !== false ? G : E).elytra);
      await put(19, 'netherite_helmet', 1, E.helmet);
      await put(20, 'netherite_chestplate', 1, E.chest);
      await put(21, 'netherite_leggings', 1, E.legs);
      await put(22, 'netherite_boots', 1, E.boots);
      await sleep(800);
      await autoArmor();
      await autoTotem();
      kitGiven = true;
      say('Kit ready! You can switch me to survival now.' + (enchantFailed ? ' (Could not enchant on this MC version - items are plain.)' : ' (Enchanted.)') + (skipped.length ? ` Not in this MC version: ${skipped.join(', ')}.` : ''));
    } finally {
      kitBusy = false;
    }
  }
  // ---------- OP kit: /give with enchantments (works in survival, any version) ----------
  function giveCommand(name, count, ench, extra) {
    const reg = instance.registry;
    const me = instance.username;
    const list = Object.entries(ench || {}).filter(([n]) => reg.enchantmentsByName[n]);
    const label = extra && extra.name;
    const unbreakable = extra && extra.unbreakable;
    if (!list.length && !label && !unbreakable) return `/give ${me} minecraft:${name} ${count}`;
    const v = reg.version;
    if (v['>=']('1.20.5')) {
      const modern = v['>=']('1.21.5');
      const parts = [];
      if (label) parts.push(modern ? `custom_name="${label}"` : `custom_name='"${label}"'`);
      if (list.length) {
        const inner = list.map(([n, l]) => `${n}:${l}`).join(',');
        parts.push(modern ? `enchantments={${inner}}` : `enchantments={levels:{${inner}}}`);
      }
      if (unbreakable) parts.push('unbreakable={}');
      return `/give ${me} minecraft:${name}[${parts.join(',')}] ${count}`;
    }
    const nbt = [];
    if (label) nbt.push(`display:{Name:'{"text":"${label}"}'}`);
    if (unbreakable) nbt.push('Unbreakable:1b');
    if (list.length) nbt.push(`Enchantments:[${list.map(([n, l]) => `{id:"minecraft:${n}",lvl:${l}s}`).join(',')}]`);
    return `/give ${me} minecraft:${name}{${nbt.join(',')}} ${count}`;
  }

  async function giveKitOp() {
    if (kitBusy) return false;
    kitBusy = true;
    opDenied = false;
    cmdWatch = true;
    const reg = instance.registry;
    const skipped = [];
    const sendList = async (specs) => {
      for (const [names, count, ench, extra] of specs) {
        if (opDenied || ended) return false;
        const name = (Array.isArray(names) ? names : [names]).find((n) => reg.itemsByName[n]);
        if (!name) { skipped.push(Array.isArray(names) ? names[0] : names); continue; }
        await sendLine(giveCommand(name, count, ench, extra));   // waits in the anti-spam queue until it is really sent
        await sleep(200);
      }
      return !opDenied;
    };
    try {
      say('Getting my PvP kit with commands (needs OP)...');
      const armorOk = await sendList([
        ['netherite_helmet', 1, E.helmet], ['netherite_chestplate', 1, E.chest],
        ['netherite_leggings', 1, E.legs], ['netherite_boots', 1, E.boots]
      ]);
      if (!armorOk) {
        if (opDenied) say(`I need OP to run commands. Type this in the server console or as an admin: /op ${instance.username}`);
        return false;
      }
      await sleep(1200);
      await autoArmor();                  // wear it, which frees the hotbar for the weapons below
      await sleep(600);
      // verify the commands really worked (some servers ignore them silently)
      const gotArmor = [5, 6, 7, 8].some((i) => instance.inventory.slots[i]) ||
        instance.inventory.items().some((i) => i.name.startsWith('netherite_'));
      if (!gotArmor) {
        opDenied = true;
        errs.report('E500');
        say('My /give commands had no effect (I probably need OP, or this server rejected the command syntax).');
        return false;
      }
      const god = cfg.godGear !== false;
      const W = (key, names, plain) => [names, 1, god ? G[key] : plain, god ? { name: GOD_NAMES[key], unbreakable: true } : null];
      await sendList([
        W('mace', 'mace', E.mace), W('spear', ['netherite_spear', 'diamond_spear', 'iron_spear'], E.spear),
        W('sword', 'netherite_sword', E.sword), W('axe', 'netherite_axe', E.axe),
        ['enchanted_golden_apple', 64], ['ender_pearl', 16], ['wind_charge', 64], ['firework_rocket', 64],
        ['water_bucket', 1], W('elytra', 'elytra', E.elytra), ['totem_of_undying', 8], ['cooked_beef', 64],
        ['cobblestone', 64], ['cobblestone', 64], ['white_bed', 1], [['netherite_pickaxe', 'diamond_pickaxe', 'iron_pickaxe'], 1, E.pickaxe]
      ]);
      await sleep(1000);
      await autoArmor();
      await autoTotem();
      kitGiven = true;
      say('Kit ready! (Enchanted via commands.)' + (skipped.length ? ` Not in this MC version: ${skipped.join(', ')}.` : ''));
      return true;
    } finally {
      cmdWatch = false;
      kitBusy = false;
    }
  }

  /** Best way to get a kit: OP commands (enchanted, any version) else creative slots. */
  async function smartKit(manual = false) {
    if (kitBusy) return;
    if (manual) opDenied = false;
    const modern = instance.registry.version['>=']('1.21.5');
    if (gameMode() === 'creative' && !modern) { await giveKit(false); return; }
    if (!opDenied) {
      const ok = await giveKitOp();
      if (ok) return;
    }
    if (gameMode() === 'creative') { await giveKit(false); return; }
    say(`I need OP (/op ${instance.username}) or creative mode to get my kit.`);
  }

  const needsKit = () => {
    const slots = instance.inventory.slots;
    const armor = [5, 6, 7, 8].some((i) => slots[i]);
    const weapon = instance.inventory.items().some((i) => ['mace', 'sword', 'axe'].some((w) => i.name === w || i.name.endsWith(`_${w}`)));
    return !armor && !weapon;
  };

  function maybeAutoKit() {
    if (lockedNow()) return;
    if (!started || kitBusy || Date.now() - spawnedAt < 4000) return;
    if (gameMode() === 'creative') {
      if (cfg.autoKit && !kitGiven) smartKit().catch((e) => console.error('kit error:', e.message));
      return;
    }
    kitGiven = false; // switch to creative again => new kit
    // survival + OP: kit up on join / after dying (only when the inventory is really empty)
    if (cfg.autoOpKit && !opDenied && inSurvivalLike() && needsKit() && Date.now() - lastAutoOpKit > 180000) {
      lastAutoOpKit = Date.now();
      smartKit().catch((e) => console.error('kit error:', e.message));
    }
  }

  // ---------- anti-idle ----------
  // Servers with player-idle-timeout only reset the idle timer on actions like arm swings, sneak toggles,
  // hotbar changes and chat - NOT on walking. So we send those regularly.
  function antiIdle() {
    if (ended || !instance.entity || combat.hasTarget() || combat.isBusy() || escapeSys.isEscaping()) return;
    if (instance.entity.elytraFlying || !instance.entity.onGround || instance.isSleeping) return;      // never touch the hotbar mid-air / mid-flight
    instance.swingArm('right');
    if (mode === 'afk' || mode === 'idle') {
      instance.look(instance.entity.yaw + (Math.random() - 0.5) * 1.2, (Math.random() - 0.5) * 0.5, true);
      instance.setControlState('sneak', !instance.getControlState('sneak'));
      setTimeout(() => { if (!ended && (mode === 'afk' || mode === 'idle')) instance.setControlState('sneak', mode === 'afk'); }, 300);
      const cur = instance.quickBarSlot;
      instance.setQuickBarSlot((cur + 1) % 9);
      setTimeout(() => { if (!ended && !combat.hasTarget()) instance.setQuickBarSlot(cur); }, 300);
    }
  }

  // ---------- AFK movement (original behaviour) ----------
  /** True when a 1-block step is in the way (dir 1 = forward, -1 = backward): jump over it. */
  function stepAhead(dir) {
    try {
      const e = instance.entity;
      if (!e || !e.onGround) return false;
      const dx = -Math.sin(e.yaw) * dir;
      const dz = -Math.cos(e.yaw) * dir;
      const feet = e.position.floored();
      const ahead = e.position.offset(dx * 0.9, 0, dz * 0.9).floored();
      const solidAt = (v) => { const b = instance.blockAt(v); return !!b && b.boundingBox === 'block'; };
      return solidAt(ahead) && !solidAt(ahead.offset(0, 1, 0)) && !solidAt(ahead.offset(0, 2, 0)) && !solidAt(feet.offset(0, 2, 0));
    } catch (err) {
      return false;
    }
  }

  function movementCycle() {
    if (ended) return;
    movementTimer = setTimeout(movementCycle, STEP_INTERVAL);
    if (mode !== 'afk' || !instance.entity || instance.isSleeping) return;

    switch (movementPhase) {
      case 0:
        instance.setControlState('forward', true);
        instance.setControlState('back', false);
        instance.setControlState('jump', stepAhead(1));
        break;
      case 1:
        instance.setControlState('forward', false);
        instance.setControlState('back', true);
        instance.setControlState('jump', stepAhead(-1));
        break;
      case 2:
        instance.setControlState('forward', false);
        instance.setControlState('back', false);
        instance.setControlState('jump', true);
        jumpTimer = setTimeout(() => { if (!ended && mode === 'afk') instance.setControlState('jump', false); }, JUMP_DURATION);
        break;
      case 3:
        instance.setControlState('forward', false);
        instance.setControlState('back', false);
        instance.setControlState('jump', false);
        break;
    }
    movementPhase = (movementPhase + 1) % 4;
  }

  // ---------- commands ----------
  const run = (p) => p.catch((e) => say(`Error: ${e.message}`));
  const commands = {
    help(args, user) { for (const l of HELP_LINES) instance.whisper(user || ownerName(), l); },   // sent privately to the person who asked
    status() {
      const w = instance.heldItem ? instance.heldItem.name : 'nothing';
      say(`HP ${Math.round(instance.health)}/20 | Food ${instance.food}/20 | Mode: ${mode} | Holding: ${w} | Weapon pref: ${combat.getWeapon()} | Gamemode: ${gameMode()} | Kills: ${killCount} | Uptime: ${fmtDuration(Math.round((Date.now() - sessionStart) / 1000))}`);
    },
    inv() {
      const counts = {};
      for (const i of instance.inventory.items()) counts[i.name] = (counts[i.name] || 0) + i.count;
      const parts = Object.entries(counts).map(([n, c]) => `${n} x${c}`);
      say(parts.length ? `Inventory: ${parts.join(', ')}` : 'Inventory is empty.');
    },
    stop() { setMode('idle'); say('Stopped. Standing still. (type afk to resume AFK moving)'); },
    afk() { setMode('afk'); say('Back to AFK mode.'); },
    pvp() { setMode('pvp'); say('PvP mode ON: hunting hostile mobs. Type stop to end.'); },
    guard(args) {
      const a = (args[0] || '').toLowerCase();
      setMode('guard');
      guardOwner = a !== 'here';
      guardStrict = a === 'strict' || a === 'all';
      guard.clear();
      guardPos = instance.entity.position.clone();
      if (!guardOwner) say(`Guarding this spot (radius ${cfg.guardRadius}). I attack anyone who attacks you or me, plus hostile mobs.`);
      else if (guardStrict) say('Strict guard: I stay near you, attack anyone who attacks you, hostile mobs, AND any stranger who comes close.');
      else say('Guarding you: I stay near you and attack anyone who attacks you, plus hostile mobs. (guard here / guard strict)');
    },
    friend(args) {
      const n = args[0];
      if (!n) return say('Usage: friend <name>');
      friends.add(normName(n));
      saveFriends();
      say(`${n} is a friend now - I will never attack them.`);
    },
    unfriend(args) {
      const n = args[0];
      if (!n) return say('Usage: unfriend <name>');
      friends.delete(normName(n));
      saveFriends();
      say(`${n} is no longer a friend.`);
    },
    unstuck() { escapeSys.escape('manual request').catch(() => {}); },
    talk(args) {
      const v = (args[0] || '').toLowerCase();
      if (!['on', 'off'].includes(v)) return say(`Talking is ${talk.status().enabled ? 'ON' : 'OFF'}. Usage: talk <on|off>`);
      talk.setEnabled(v === 'on');
      say(`Talking ${v.toUpperCase()}.`);
    },
    // ai on|off = chat replies | ai <anything> = the AI brain plans & acts | ai auto on|off | ai goal <text> | ai status
    ai(args, user) {
      const v = (args[0] || '').toLowerCase();
      if (!args.length) return say(`${brain.status()}. Usage: ai <what you want> | ai auto on|off | ai goal <text> | ai on|off (chat replies)`);
      if (v === 'auto') { const on = (args[1] || '').toLowerCase() === 'on'; if (on && !llm.available(cfg)) return say('No AI key (aiChat.apiKey / GEMINI_API_KEY).'); brain.setAuto(on); return say(`Auto-think ${on ? 'ON - I decide things myself every ~30s' : 'OFF'}.`); }
      if (v === 'goal') { brain.setGoal(args.slice(1).join(' ')); return say(brain.getGoal() ? `Standing goal: ${brain.getGoal()}` : 'Goal cleared.'); }
      if (v === 'status') return say(brain.status());
      if (!['on', 'off'].includes(v)) {
        brain.plan(args.join(' '), user || ownerName()).then((r) => { if (!r.said && !r.done.length) say('I thought about it but had nothing to do.'); else if (r.done.length) say(`Plan: ${r.done.join(' > ').slice(0, 200)}`); })
          .catch((e) => { if (!/no AI key|cooling|rate limit|still thinking/.test(e.message)) errs.report('E700', e, 'ai plan'); say(`AI error: ${e.message}`.slice(0, 200)); });
        return;
      }
      const on = talk.setAI(v === 'on');
      say(v === 'on' && !on ? 'No API key in config.json (aiChat.apiKey), so AI chat stays OFF.' : `AI chat ${on ? 'ON' : 'OFF'}.`);
    },
    brain(args) {
      const v = (args[0] || '').toLowerCase();
      if (v === 'on' || v === 'off') { brain.setEnabled(v === 'on'); return say(`Tactical brain ${v.toUpperCase()}.`); }
      const a = brain.assessNow();
      say(`${brain.status()} | ${nav.status()} | now: ${a.text}`.slice(0, 230));
    },
    sleep() { survival.goSleep(true).then((r) => { if (r === 'sleeping') say('Going to bed.'); else if (r !== 'nobed') say(`Can't sleep: ${r}`.slice(0, 200)); }).catch(() => {}); },
    autosleep(args) { const v = (args[0] || '').toLowerCase(); cfg.survival = { ...(cfg.survival || {}), autoSleep: v !== 'off' }; say(`Auto-sleep ${v === 'off' ? 'OFF' : 'ON'}. ${survival.status()}`); },
    fbtest() { fb.test().then((r) => say(r.text.slice(0, 220))); },
    aitest() { llm.diagnose(cfg).then((r) => { say(r.text.slice(0, 220)); if (!r.ok) errs.report('E800', null, r.text); }); },
    godcheck() { for (const l of combat.readiness()) say(l.slice(0, 230)); },
    think() {
      const t = brain.thoughts(5);
      if (!t.length) return say('No thoughts yet.');
      for (const x of t) say(`[${x.at}] ${x.text}`.slice(0, 200));
    },
    flee() { brain.flee('owner told me to', true).catch(() => {}); },
    build(args) {
      const shape = (args[0] || '').toLowerCase();
      if (!shape) return say(`Usage: build <${builder.shapes().join('|')}> [size]   (I have ${builder.blockCount()} blocks)`);
      builder.build(shape, parseInt(args[1], 10) || undefined).then((r) => say(r.text)).catch((e) => say(`Build error: ${e.message}`));
    },
    cleanup() { builder.cleanup().then((r) => say(r.text)).catch((e) => say(`Cleanup error: ${e.message}`)); },
    friends() { say(friends.size ? `Friends: ${[...friends].join(', ')}` : 'No friends yet. Use: friend <name>'); },
    why() {
      say(lastDisconnect
        ? `Last disconnect [${lastDisconnect.code}]: ${lastDisconnect.text} (${errs.describe(lastDisconnect.code)}; after ${fmtDuration(lastDisconnect.uptime)}, ${lastDisconnect.at}). Log file: disconnects.log`
        : 'I have not been disconnected since I started.');
    },
    lock(args, user) {
      authed.clear();
      setMode('idle');
      instance.whisper(user, `Locked. Whisper the password to wake me up: /msg ${instance.username} <password>`);
    },
    errors(args) {
      if ((args[0] || '').toLowerCase() === 'codes') {
        say('Error codes: E1xx crash handler | E2xx connection + kicks (E210 fly, E211 spam, E212 timeout, E213 bad packet) | E3xx elytra/stunts | E4xx hunting | E5xx kit/OP | E6xx packet guard | E7xx combat. Full list in errors.js');
        return;
      }
      const list = errs.recent(5);
      if (!list.length) return say('No errors since I started. (type "errors codes" for the legend)');
      for (const e of list) say(`[${e.code}] ${errs.describe(e.code)}${e.msg ? ` - ${e.msg.slice(0, 80)}` : ''} (${e.at.slice(11, 19)})`);
    },
    pearl(args) {
      const v = (args[0] || '').toLowerCase();
      if (!['on', 'off'].includes(v)) return say(`Ender pearl tactics are ${combat.options.pearl ? 'ON' : 'OFF'}. Usage: pearl <on|off>`);
      combat.setPearl(v === 'on');
      say(`Ender pearl tactics ${v.toUpperCase()}.`);
    },
    kill(args) {
      const name = args[0];
      if (!name) return say('Usage: kill <playername or mob>');
      if (isProtected(name)) return say("I won't attack that one.");
      const pl = findPlayer(name);
      if (pl) {
        setMode('kill');
        killSpec = { type: 'player', name: pl.username };
        huntStart = Date.now();
        huntPos = null;
        hintedOp = false;
        dimChecked = false;
        pathFails = 0;
        travelFailedAt = 0;
        arrivedSince = 0;
        huntNoDestSince = 0;
        const visible = !!(pl.entity);
        say(visible ? `Attacking player ${pl.username}!` : `Hunting ${pl.username}... I will find them.`);
        talk.fight(pl.username);
      } else if (name.toLowerCase() !== 'player' && instance.registry.entitiesByName[name.toLowerCase()]) {
        setMode('kill');
        killSpec = { type: 'mob', name: name.toLowerCase() };
        say(`Attacking nearest ${name.toLowerCase()}!`);
      } else {
        return say(`${name} is not online and not a mob I know.`);
      }
      killLostSince = Date.now();
    },
    follow(args, user) {
      const name = args[0] || user;
      const pl = findPlayer(name);
      if (!pl) return say(`${name} is not online.`);
      setMode('follow');
      followName = pl.username;
      say(`Following ${pl.username}.`);
    },
    come(args, user) {                                   // fly / walk / run to the person who asked
      comeName = (user && isOwner(user)) ? user : ownerName();
      comeStart = Date.now();
      comePos = null;
      comeNoDestSince = 0;
      comeEscaped = false;
      dimChecked = false;
      pathFails = 0;
      travelFailedAt = 0;
      setMode('come');
      say('Coming!');
    },
    goto(args) {
      const [x, y, z] = args.map(Number);
      if ([x, y, z].some((n) => Number.isNaN(n))) return say('Usage: goto <x> <y> <z>');
      setMode('goto');
      gotoDest = new Vec3(x, y, z);
      say(`Going to ${x} ${y} ${z}...`);
    },
    weapon(args) {
      const w = (args[0] || '').toLowerCase();
      if (!['mace', 'spear', 'sword', 'axe', 'auto', 'god'].includes(w)) return say('Usage: style <auto|god|mace|spear|sword|axe>   auto = the bot picks its own style from its gear (default), god = every trick');
      const found = combat.setWeapon(w);
      say(found ? (w === 'auto' ? 'Fight style: AUTO - I will pick the best style from my gear and switch if it is not working.' : `Fight style: ${w}`) : `Fight style set to ${w}, but I don't have one in my inventory.`);
    },
    trick(args) {
      const name = (args[0] || '').toLowerCase();
      const v = (args[1] || '').toLowerCase();
      const names = Object.keys(combat.tricks);
      if (!names.includes(name) || !['on', 'off'].includes(v)) return say(`Usage: trick <name> <on|off>. Tricks: ${names.map((n) => `${n}=${combat.tricks[n] ? 'on' : 'off'}`).join(', ')}`);
      combat.setTrick(name, v === 'on');
      say(`Trick ${name} ${v.toUpperCase()}.`);
    },
    air(args) {
      const v = (args[0] || '').toLowerCase();
      if (!['on', 'off'].includes(v)) return say(`Elytra strikes are ${combat.options.air ? 'ON' : 'OFF'}. Usage: air <on|off>`);
      combat.setAir(v === 'on');
      say(`Elytra strikes ${v.toUpperCase()}.`);
    },
    wind(args) {
      const v = (args[0] || '').toLowerCase();
      if (!['on', 'off'].includes(v)) return say(`Wind-charge mace jumps are ${combat.options.wind ? 'ON' : 'OFF'}. Usage: wind <on|off>`);
      combat.setWind(v === 'on');
      say(`Wind-charge mace jumps ${v.toUpperCase()}.`);
    },
    tactics() { say(combat.status()); },
    armor() {
      elytraWorn = false;
      elytraRestore = false;
      run(autoArmor());
      say('Equipping best armor.');
    },
    totem() {
      run(autoTotem());
      const has = instance.inventory.items().some((i) => i.name === 'totem_of_undying');
      say(has ? 'Totem to offhand.' : 'I have no totem.');
    },
    eat() { run(eatNow(true).then((ok) => say(ok ? 'Ate something.' : "Nothing to eat or I'm full."))); },
    elytra() { run(wearElytra().then((ok) => say(ok ? 'Elytra on. (type armor to swap back)' : "I don't have an elytra."))); },
    fly() { run(flyNow()); },
    kit(args) { run(args[0] === 'op' ? giveKitOp().then((ok) => { if (!ok && opDenied) opDenied = true; }) : smartKit(true)); },
    say(args) {
      const text = args.join(' ');
      if (!text) return say('Usage: say <text>');
      if (text.startsWith('/')) return say("I won't run slash commands from chat.");
      say(text);
    },
    rejoin() { say('Rejoining...'); setTimeout(() => instance.quit('rejoin'), 1500); }
  };
  const aliases = { return: 'come', back: 'come', comehere: 'come', style: 'weapon', fightstyle: 'weapon', commands: 'help', cmds: 'help', attack: 'kill', gear: 'armor', chest: 'armor', unfollow: 'stop' };

  function tryAuth(username, message, isWhisper) {
    if (!authCfg.enabled) return false;
    const text = String(message).trim();
    const n = normName(username);
    const reply = (t) => instance.whisper(username, t);
    if (isWhisper && isOwner(username) && !authed.has(n)) {
      const f = authFails.get(n) || { count: 0, until: 0 };
      if (Date.now() < f.until) return true;                  // locked out: swallow silently
      if (passwordOk(text)) {
        authed.add(n);
        authFails.delete(n);
        console.log(`🔓 ${username} unlocked the bot.`);
        if (mode === 'idle') setMode('afk');
        say(`Unlocked by ${username}. Type help`);
        reply('Password accepted. I am awake. Type help.');
        return true;
      }
      f.count++;
      console.log(`🔒 Wrong password from ${username} (${f.count}/${authCfg.maxAttempts})`);
      if (f.count >= authCfg.maxAttempts) {
        f.count = 0;
        f.until = Date.now() + authCfg.lockoutMinutes * 60000;
        reply(`Too many wrong passwords - locked out for ${authCfg.lockoutMinutes} minutes.`);
      } else reply(`Wrong password (${f.count}/${authCfg.maxAttempts}). Whisper it: /msg ${instance.username} <password>`);
      authFails.set(n, f);
      return true;
    }
    if (leaksPassword(text)) {                               // password typed in public chat or by a stranger: swallow it
      if (isOwner(username) && !isWhisper) reply('Never type the password in public chat! Use /msg, and change the password now.');
      return true;
    }
    return false;
  }

  /** Phrases that work without any AI key (English / Hinglish). Returns [command, args] or null. */
  function localIntent(text) {
    const t = text.toLowerCase();
    if (/\b(come|aa ja|aaja|aa jao|aajao|idhar aa|idhar aao|yaha aa|yahan aa|come here|come to me)\b/.test(t)) return ['come', []];
    if (/\b(follow me|follow|mere peeche|peeche aa)\b/.test(t)) return ['follow', []];
    if (/\b(stop|ruk|ruko|ruk ja|wait)\b/.test(t)) return ['stop', []];
    if (/\b(sleep|so ja|so jao|go to bed)\b/.test(t)) return ['sleep', []];
    if (/\b(eat|khana kha|kha le)\b/.test(t)) return ['eat', []];
    if (/\b(guard|protect me|meri raksha)\b/.test(t)) return ['guard', []];
    return null;
  }
  let aiChatBusy = false;
  /** The owner talks normally: the AI brain answers like a player AND can act (come, kill, build, flee ...). */
  function ownerChatToBrain(username, message, whisper) {
    const bcfg = cfg.brain || {};
    if (bcfg.chatAI === false) return false;
    const mentioned = new RegExp(escapeRe(instance.username), 'i').test(message);
    if (bcfg.chatAll === false && !mentioned && !whisper) return false;      // default: the owner's every message goes to the brain
    const reply = (t) => (whisper ? instance.whisper(username, t) : say(t));
    const fallback = () => {
      const it = localIntent(message);
      if (it && commands[it[0]]) { console.log(`💬 ${username}: ${message}  -> ${it[0]}`); try { commands[it[0]](it[1], username); } catch (e) { /* ignore */ } return true; }
      return false;
    };
    if (!llm.available(cfg) || brain.isFleeing()) return fallback();
    if (aiChatBusy) return true;                                              // still thinking about the previous message
    aiChatBusy = true;
    console.log(`💬 ${username}: ${message}  (AI brain)`);
    brain.plan(message, username, false, { chat: true, reply })
      .catch((e) => {
        if (!/no AI key|cooling|rate limit|still thinking/.test(e.message)) errs.report('E800', e, 'brain chat');
        if (!fallback()) talk.onChat(username, message, { whisper, owner: true }).catch(() => {});
      })
      .finally(() => { aiChatBusy = false; });
    return true;
  }
  function handleChat(username, message, whisper = false) {
    if (!username || username === instance.username) return;
    const key = `${normName(username)}|${message.trim()}`;
    if (key === lastCmdKey && Date.now() - lastCmdTime < 1000) return; // de-dupe chat + fallback parser
    lastCmdKey = key;
    lastCmdTime = Date.now();
    if (tryAuth(username, message, whisper)) return;         // password handling (never forwarded to commands / chat / AI)
    if (lockedNow()) return;                                  // locked: ignore everything
    const owner = isOwner(username) && (!authCfg.enabled || authed.has(normName(username)));
    let text = message.trim();
    if (cfg.commandPrefix && text.startsWith(cfg.commandPrefix)) text = text.slice(cfg.commandPrefix.length).trim();
    else if (text.startsWith('!')) text = text.slice(1).trim();
    const [word, ...args] = text.split(/\s+/);
    let cmd = (word || '').toLowerCase();
    cmd = aliases[cmd] || cmd;
    if (cmd === 'hunt' && args.length) cmd = 'kill';           // "hunt Steve" = find & kill Steve
    if (cmd === 'hunt') cmd = 'pvp';
    const isCommand = owner && Object.prototype.hasOwnProperty.call(commands, cmd);
    if (!isCommand) {                                           // normal chat
      if (owner && ownerChatToBrain(username, message, whisper)) return;
      talk.onChat(username, message, { whisper, owner }).catch(() => {});
      return;
    }
    console.log(`💬 ${username}: ${message}`);
    try { commands[cmd](args, username); } catch (e) { say(`Error: ${e.message}`); }
  }
  instance.on('chat', (u, m) => handleChat(u, m));
  instance.on('whisper', (u, m) => handleChat(u, m, true));
  // Works for any chat format (also logs raw chat so you can see what the server sends)
  instance.on('messagestr', (msg) => {
    if (leaksPassword(msg)) {                                 // never log or forward a line that contains the password
      const w = parseWhisperLine(msg);
      if (w) handleChat(w[0], w[1], true);
      else { const p = parseChatLine(msg); if (p) handleChat(p[0], p[1], false); }
      return;
    }
    if (cfg.logChat) console.log('📨', msg);
    if (cmdWatch && /unknown or incomplete command|unknown command|do not have permission|don't have permission|no permission/i.test(msg)) opDenied = true;
    const parsed = parseChatLine(msg);
    if (parsed) handleChat(parsed[0], parsed[1]);
  });

  // ---------- lifecycle ----------
  instance.on('spawn', () => {
    currentDelay = cfg.reconnectDelay; // connected: reset backoff
    spawnedAt = Date.now();

    if (!started) {
      started = true;
      const movements = new Movements(instance);
      movements.canDig = false;          // never break the world
      movements.scafoldingBlocks = [];   // never place blocks
      movements.maxDropDown = 3;         // never walk off a ledge higher than 3 blocks
      movements.allowParkour = cfg.parkour === true;           // jumping over gaps is risky: opt-in
      movements.canOpenDoors = (cfg.survival || {}).openDoors !== false;   // open doors / fence gates on the way
      for (const n of ['fire', 'soul_fire', 'cactus', 'magma_block', 'sweet_berry_bush', 'campfire', 'soul_campfire', 'wither_rose', 'powder_snow', 'cobweb', 'lava', 'pointed_dripstone']) {
        const b = instance.registry.blocksByName[n];
        if (b) movements.blocksToAvoid.add(b.id);                // damage blocks are routed around, never stepped in
      }
      instance.pathfinder.thinkTimeout = 3500;
      instance.pathfinder.setMovements(movements);
      safeMovements = movements;

      setTimeout(() => {
        if (ended) return;
        if (mode === 'afk') instance.setControlState('sneak', true);
        console.log(`✅ ${cfg.botUsername} is Ready!`);
      }, 3000);
      movementTimer = setTimeout(movementCycle, STEP_INTERVAL);

      every(150, modeTick);
      if (cfg.aiChat && cfg.aiChat.enabled && llm.available(cfg)) setTimeout(() => llm.diagnose(cfg).then((r) => console.log(r.ok ? `🤖 ${r.text}` : `🤖 ❌ ${r.text}  (type aitest in chat to retry)`)), 6000);
      if (fb.enabled()) {
        fb.loadMemory().then((m) => {
          if (!m) return console.log(fb.lastError() ? `☁️ ❌ Firebase: ${fb.lastError()}  (type fbtest)` : '☁️ Firebase connected (no saved memory yet).');
          (m.friends || []).forEach((f) => friends.add(normName(f)));
          if (m.goal && !brain.getGoal()) brain.setGoal(m.goal);
          console.log(`☁️ Firebase memory loaded (${(m.friends || []).length} friends, goal: ${m.goal || '-'}).`);
        });
        every(Math.max(20, (cfg.firebase && cfg.firebase.syncSeconds) || 60) * 1000, syncFirebase);
        setTimeout(syncFirebase, 8000);
      }
      every(500, waterTick);
      every(500, () => brain.tick());
      every(1000, () => { survival.pitTick().catch(() => {}); });
      every(4000, () => { survival.sleepTick().catch(() => {}); });
      every(1000, () => { brain.autoTick().catch(() => {}); });
      every(500, autoTotem);
      every(2000, autoArmor);
      every(1000, () => { if (cfg.autoEat) eatNow(false).catch(() => {}); });
      every(2000, maybeAutoKit);
      setTimeout(() => { const n = combat.popLearnedNotice(); if (n && !ended) say(n); }, 4000);
      every(Math.max(5, cfg.antiIdleSeconds) * 1000, antiIdle);
      every(1000, () => escapeSys.tick(escapeIntent()));
      every(10000, () => {
        if (Date.now() - lastPacketAt > cfg.silenceTimeoutMs) {
          errs.report('E220', null, `${Math.round((Date.now() - lastPacketAt) / 1000)}s of silence`);
          instance.end('silence watchdog');
        }
      });
      say(`PvP bot v${VERSION} online! Owner: ${cfg.owners.join(', ')}. Type help`);
      if (lockedNow()) console.log(`🔒 Locked. Owner must whisper the password: /msg ${instance.username} <password>`);
      console.log(`🤖 PvP bot v${VERSION} running. Owners: ${cfg.owners.join(', ')}`);
    }

    if (justDied) {
      justDied = false;
      guardPos = null;
      setMode(lockedNow() ? 'idle' : 'afk');
    }
  });

  instance.on('death', () => {
    justDied = true;
    fb.event('death', { mode });
    talk.death();
    console.log('💀 Bot died.');
  });

  instance.on('entityHurt', (victim, source) => {
    if (victim !== instance.entity || !source) return;
    const playerAttacker = source.type === 'player' && source.username && !isProtected(source.username);
    brain.noteDamage(source);
    if (playerAttacker) talk.hit(source.username);
    // Fight back instead of standing there: when idle/AFK and something hits us, defend ourselves
    if (cfg.selfDefense !== false && (mode === 'afk' || mode === 'idle') && (playerAttacker || hostileSet.has(source.name)) && !escapeSys.isEscaping() && !brain.isFleeing() && !lockedNow()) {
      setMode('guard');
      guardOwner = false;
      guardStrict = false;
      guardPos = instance.entity.position.clone();
      selfDefenseUntil = Date.now() + 20000;
      guard.mark(source, 'hit me');
    }
  });

  instance.on('playerCollect', (collector) => {
    if (collector === instance.entity) setTimeout(() => { autoArmor(); autoTotem(); }, 400);
  });

  instance.on('kicked', (reason) => {
    kickReason = flattenReason(reason);
    console.log('👢 Kicked from server:', kickReason);
    if (/spam/i.test(kickReason)) {
      chatGapBoost = Math.min(3, chatGapBoost * 1.4);
      console.log(`💡 Kicked for chat spam - the bot will now send messages ${chatGapBoost.toFixed(1)}x slower after reconnecting.`);
    }
    const learned = combat.noteKick(kickReason);
    if (learned) console.log('🧠', learned);
    if (/idle|afk|inactiv/i.test(kickReason)) {
      console.log(`💡 The server kicks idle players. Anti-idle runs every ${cfg.antiIdleSeconds}s; if this keeps happening lower "antiIdleSeconds" in config.json.`);
    }
  });

  instance.on('error', (err) => {
    errs.report(errs.classifyNetError(err), err);
  });

  instance.on('end', (reason) => {
    ended = true;
    timers.forEach(clearInterval);
    clearTimeout(movementTimer);
    clearTimeout(jumpTimer);
    const uptime = Math.round((Date.now() - sessionStart) / 1000);
    const text = kickReason || String(reason || 'connection closed');
    const code = kickReason ? errs.classifyKick(kickReason) : (/silence/.test(String(reason)) ? 'E220' : errs.classifyNetError({ message: text, code: reason }));
    lastDisconnect = { text, uptime, at: new Date().toISOString(), code };
    console.log(`⛔️ Bot Disconnected after ${fmtDuration(uptime)}: ${text}  [${code}: ${errs.describe(code)}]`);
    errs.report(code, null, text);
    try { fs.appendFileSync(DISCONNECT_LOG, `[${lastDisconnect.at}] uptime=${fmtDuration(uptime)} code=${code} reason="${text}"\n`); } catch (e) { /* ignore */ }
    scheduleReconnect();
  });
}

function scheduleReconnect() {
  if (shuttingDown || reconnectTimer) return; // avoid double-scheduling
  const delay = currentDelay;
  console.log(`🔁 Reconnecting in ${(delay / 1000).toFixed(1)}s...`);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    createBot();
  }, delay);
  currentDelay = Math.min(currentDelay * 2, cfg.maxReconnectDelay);
}

process.on('SIGINT', () => {
  shuttingDown = true;
  clearTimeout(reconnectTimer);
  console.log('\n👋 Shutting down...');
  if (bot) bot.quit();
  setTimeout(() => process.exit(0), 500);
});

createBot();
