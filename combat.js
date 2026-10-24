'use strict';
/**
 * PvP combat engine.
 *
 * Tactics (all based on current Java Edition mechanics):
 *  - Sword / axe : jump-crits (hit while falling, sprint released), strafing, spacing,
 *                  axe swap to break shields.
 *  - Mace        : "smash" = hit while falling >= 1.5 blocks (not gliding).
 *                  Wind-charge jump -> dive onto target. Elytra dive: glide, take the elytra
 *                  off right before contact, smash.
 *  - Spear       : jab (reach 2-4.5, forced cooldown) + charge (hold use, damage scales with
 *                  relative speed). Elytra + rockets gives huge charge damage.
 */
const fs = require('fs');
const path = require('path');
const { Vec3 } = require('vec3');

const MELEE_CD = { sword: 650, axe: 1000, mace: 1700, fist: 500 };
const JAB_CD = { wooden: 650, golden: 950, stone: 750, copper: 850, iron: 950, diamond: 1050, netherite: 1150 };
const TIERS = ['netherite', 'diamond', 'iron', 'stone', 'golden', 'copper', 'wooden'];

// ---- Ender pearl ballistics (Java: speed 1.5 b/t, gravity 0.03, drag 0.99; order: accel, drag, position) ----
const PEARL_SPEED = 1.5;
const PEARL_G = 0.03;
const PEARL_DRAG = 0.99;

/** Forward-simulate a pearl. Returns landing info or null. `solid(x,y,z)` is optional. */
function simulatePearl(start, yaw, pitch, targetY, solid, maxTicks = 260) {
  let vx = -Math.sin(yaw) * Math.cos(pitch) * PEARL_SPEED;
  let vy = Math.sin(pitch) * PEARL_SPEED;
  let vz = -Math.cos(yaw) * Math.cos(pitch) * PEARL_SPEED;
  let x = start.x;
  let y = start.y;
  let z = start.z;
  for (let t = 1; t <= maxTicks; t++) {
    vy -= PEARL_G;
    vx *= PEARL_DRAG; vy *= PEARL_DRAG; vz *= PEARL_DRAG;
    x += vx; y += vy; z += vz;
    // landing check FIRST: reaching the target height on the way down is the goal, not an obstacle
    if (vy < 0 && y <= targetY + 0.3) return { blocked: false, x, y, z, ticks: t };
    if (t > 3 && solid && solid(x, y, z)) return { blocked: true, x, y, z, ticks: t };
  }
  return null;
}

/** Find yaw/pitch so a pearl lands at `to`. Prefers the fastest unobstructed arc. */
function solvePearl(from, to, solid) {
  const dx = to.x - from.x;
  const dz = to.z - from.z;
  const D = Math.hypot(dx, dz);
  const yaw = Math.atan2(-dx, -dz);
  let best = null;
  for (let pitch = -0.6; pitch <= 1.5; pitch += 0.004) {
    const r = simulatePearl(from, yaw, pitch, to.y, solid);
    if (!r || r.blocked) continue;
    const err = Math.hypot(r.x - from.x - 0, r.z - from.z - 0) - D;
    const lateral = Math.abs(err);
    if (lateral > 1.2) continue;
    if (!best || r.ticks < best.ticks) best = { yaw, pitch, ticks: r.ticks, err: lateral };
  }
  return best;
}

// Survives reconnects: if the server ever kicks us right after a spear "stab" packet, stop sending it.
let stabDisabled = false;
let lastStabAt = 0;
const disabledStunts = new Set();      // stunts that got us kicked (air / wind / pearl) - learned at runtime
let lastStunt = { kind: null, at: 0 };
const LEARNED_FILE = path.join(__dirname, 'learned.json');
let learnedNotice = '';
try {
  const l = JSON.parse(fs.readFileSync(LEARNED_FILE, 'utf8'));
  // v2 = written after the flight / hunt fixes. Older files blame the stunts for kicks that the old bugs caused: ignore them.
  if (l.ver === 3) {
    (l.disabled || []).forEach((k) => disabledStunts.add(k));
    if (l.stabDisabled) stabDisabled = true;
  }
  if (disabledStunts.size || stabDisabled) {
    learnedNotice = `Heads up: after an earlier kick I turned OFF: ${[...disabledStunts].join(', ') || 'spear stab'}. Type e.g. "air on" to try again.`;
  }
} catch (e) { /* nothing learned yet */ }
const saveLearned = () => {
  try { fs.writeFileSync(LEARNED_FILE, JSON.stringify({ ver: 3, disabled: [...disabledStunts], stabDisabled })); } catch (e) { /* ignore */ }
};

function createCombat(bot, ctx) {
  const cfg = Object.assign({
    airstrike: true,
    windSmash: true,
    airstrikeMinDist: 6,
    climbHeight: 22,
    maxClimbRockets: 3,
    minHealthForStunts: 10,
    stuntCooldownMs: 2500,
    pearl: true,
    pearlMinDist: 22,
    pearlMaxDist: 52,
    waterClutch: true,
    windTakeoff: true,
    spearJab: 'both',       // 'stab' | 'attack' | 'both'
    spearStabStatus: 7
  }, ctx.cfg);

  // A NaN / out-of-range rotation makes the server disconnect us ("Invalid move player packet"):
  // make sure nothing (our code, the pathfinder, physics) can ever send one.
  function installLookGuard() {
    if (bot.__lookGuarded || typeof bot.look !== 'function' || typeof bot.lookAt !== 'function') return;
    bot.__lookGuarded = true;
    const rawLook = bot.look.bind(bot);
    const rawLookAt = bot.lookAt.bind(bot);
    bot.look = (yaw, pitch, force) => {
      if (!Number.isFinite(yaw) || !Number.isFinite(pitch)) return Promise.resolve();
      return rawLook(yaw, Math.max(-Math.PI / 2, Math.min(Math.PI / 2, pitch)), force);
    };
    bot.lookAt = (point, force) => {
      if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y) || !Number.isFinite(point.z)) return Promise.resolve();
      return rawLookAt(point, force);
    };
  }
  // mineflayer installs look/lookAt only after the connection is up, so guard them as soon as they exist
  installLookGuard();
  bot.once('inject_allowed', installLookGuard);
  bot.once('login', installLookGuard);
  bot.once('spawn', installLookGuard);

  const opts = { air: !!cfg.airstrike, wind: !!cfg.windSmash, pearl: !!cfg.pearl };
  // God-style tricks (all on by default; "trick <name> off" turns one off)
  const tricks = { dive: true, grapple: true, windpearl: true, stunslam: true, backstab: true, lungeswap: true, attrswap: true, dtap: true,
    reachglitch: true, lungedash: true, elyloop: true, pearlrocket: true, countergrapple: true, offtap: true, greset: true };
  if (cfg.tricks) Object.assign(tricks, cfg.tricks);
  for (const k of disabledStunts) opts[k] = false;
  const markStunt = (kind) => { lastStunt = { kind, at: Date.now() }; };
  let weaponPref = 'smart';          // 'smart' = the bot picks its own style | 'auto' = god (every trick) | mace/spear/sword/axe
  const rep = (code, e, x) => { try { if (ctx.report) ctx.report(code, e, x); } catch (err) { /* ignore */ } };
  let tickErrors = [];

  // ---------- state ----------
  let target = null;
  let gen = 0;                 // bumped on disengage => aborts async routines
  let busy = null;             // 'wind' | 'air' | null
  let manual = false;          // manual movement vs pathfinder
  let lastAttack = 0;
  let lastJab = 0;
  let readySince = 0;
  let wasReady = false;
  let strafe = 1;
  let nextStrafeFlip = 0;
  let suppressSprint = false;
  let charging = false;
  let chargeStart = 0;
  let chargeEnd = 0;
  let weaponLockUntil = 0;
  let lockedType = null;
  let stuntCooldownUntil = 0;
  let peakY = 0;
  let tPos = null;
  let tVel = new Vec3(0, 0, 0); // target velocity, blocks/tick (smoothed)
  let seq = 1000;
  let hits = 0;
  let lastPearl = 0;
  let retreatUntil = 0;
  let escapeCd = 0;
  let clutching = false;
  let clutchCd = 0;
  let strikeN = 0;
  let stunnedUntil = 0;
  let lastStun = 0;
  let dtapUntil = 0;
  let lastGrapple = 0;
  let lastWindPearl = 0;
  let backstabUntil = 0;
  let backstabNext = 0;
  let lungeBackAt = 0;
  let losBlockedUntil = 0;
  let hoverTicks = 0;
  let hitsConfirmed = 0;        // hits the server really registered (entityHurt on our target)
  let airMisses = 0;
  let airBlockedUntil = 0;
  let windMisses = 0;
  let windBlockedUntil = 0;
  let lastWindSmash = 0;
  let finishUntil = 0;          // target just popped a totem: finish them NOW
  let openerUntil = 0;
  let openerCd = 0;
  let flightFails = 0;
  let landing = false;
  let stabSent = 0;             // stabs sent since the last confirmed hit
  let stabOffSession = false;   // stab packets don't seem to land on this server: use normal attacks

  const now = () => Date.now();
  const log = (...a) => console.log('⚔️ ', ...a);

  // The server tells us when our target is really hurt / pops a totem. We use that to adapt.
  bot.on('entityHurt', (victim) => {
    if (target && victim && victim.id === target.id) { hitsConfirmed++; stabSent = 0; }
  });
  try {
    bot._client.on('entity_status', (p) => {
      if (p && p.entityStatus === 35 && target && p.entityId === target.id) {
        finishUntil = now() + 2500;      // totem popped: they are at 1 HP, strike again at once
        log('target popped a totem - finishing them');
      }
    });
  } catch (err) { /* old protocol: no totem tracking */ }

  // ---------- inventory helpers ----------
  const items = () => bot.inventory.items();
  const tierScore = (name) => {
    const i = TIERS.findIndex((t) => name.startsWith(t));
    return i === -1 ? 50 : i;
  };
  function weaponType(item) {
    if (!item) return null;
    const n = item.name;
    if (n === 'mace') return 'mace';
    if (n.endsWith('_spear')) return 'spear';
    if (n.endsWith('_sword')) return 'sword';
    if (n.endsWith('_axe')) return 'axe';
    return null;
  }
  const godScore = (i) => {
    try { return /god/i.test(JSON.stringify(i.customName || i.displayName || '')) ? 0 : 1; } catch (e) { return 1; }
  };
  const findWeapon = (type) => items().filter((i) => weaponType(i) === type)
    .sort((a, b) => (godScore(a) - godScore(b)) || (tierScore(a.name) - tierScore(b.name)))[0] || null;
  const findByName = (name) => items().find((i) => i.name === name) || null;
  const countOf = (name) => items().filter((i) => i.name === name).reduce((a, i) => a + i.count, 0);
  const has = (type) => !!findWeapon(type);

  /** Select an item: instant for hotbar items, inventory click otherwise. */
  async function hold(item) {
    if (!item) return false;
    if (bot.heldItem && bot.heldItem.name === item.name) return true;
    if (item.slot >= 36 && item.slot <= 44) {
      bot.setQuickBarSlot(item.slot - 36);
      return true;
    }
    try {
      await ctx.withInv(() => bot.equip(item, 'hand'));
      return true;
    } catch (e) {
      return false;
    }
  }

  // ---------- movement helpers ----------
  const lastCtl = {};
  function drive(c = {}) {
    for (const k of ['forward', 'back', 'left', 'right', 'jump', 'sprint']) {
      const v = !!c[k];
      if (lastCtl[k] !== v || bot.getControlState(k) !== v) {
        bot.setControlState(k, v);
        lastCtl[k] = v;
      }
    }
  }
  const valid = (e) => !!e && e.isValid !== false && !!bot.entities[e.id];

  function trackFall() {
    const e = bot.entity;
    if (e.onGround || e.isInWater || e.isInLava || e.elytraFlying) peakY = e.position.y;
    else peakY = Math.max(peakY, e.position.y);
  }
  const fallen = () => Math.max(0, peakY - bot.entity.position.y);

  function trackTarget() {
    const p = target.position;
    if (tPos) tVel = tVel.scaled(0.6).plus(p.minus(tPos).scaled(0.4));
    tPos = p.clone();
  }

  /** Distance from our eyes to the nearest point of the target's hitbox. */
  function reachTo(ent) {
    const e = bot.entity;
    const eye = e.position.offset(0, 1.62, 0);
    const w = (ent.width || 0.6) / 2;
    const h = ent.height || 1.8;
    const cx = Math.max(ent.position.x - w, Math.min(eye.x, ent.position.x + w));
    const cy = Math.max(ent.position.y, Math.min(eye.y, ent.position.y + h));
    const cz = Math.max(ent.position.z - w, Math.min(eye.z, ent.position.z + w));
    return eye.distanceTo(new Vec3(cx, cy, cz));
  }
  /** True when a 1-block step is directly ahead (jump over it instead of getting stuck). */
  function blockedAhead() {
    const e = bot.entity;
    const dx = -Math.sin(e.yaw);
    const dz = -Math.cos(e.yaw);
    const feet = e.position.floored();
    const ahead = e.position.offset(dx * 0.9, 0, dz * 0.9).floored();
    return solidAt(ahead) && !solidAt(ahead.offset(0, 1, 0)) && !solidAt(ahead.offset(0, 2, 0)) && !solidAt(feet.offset(0, 2, 0));
  }
  function aimPoint(ent, leadTicks = 0) {
    const h = ent.height || 1.8;
    let p = ent.position.offset(0, h * 0.6, 0);
    if (leadTicks > 0) p = p.plus(tVel.scaled(leadTicks));
    return p;
  }
  function face(ent) {
    bot.lookAt(aimPoint(ent), true);
  }
  function isBlocking(ent) {
    try {
      const flags = ent.metadata && ent.metadata[8];
      if (typeof flags !== 'number' || (flags & 1) === 0) return false;
      const eq = ent.equipment || [];
      return [eq[0], eq[1], ent.heldItem].some((i) => i && i.name === 'shield');
    } catch (e) {
      return false;
    }
  }
  const solidAt = (v) => {
    const b = bot.blockAt(v);
    return !!b && b.boundingBox !== 'empty';
  };
  const skyOpen = (h = 14) => {
    const p = bot.entity.position.floored();
    for (let y = 2; y <= h; y++) if (solidAt(p.offset(0, y, 0))) return false;
    return true;
  };
  const groundWithin = (d) => {
    const p = bot.entity.position.floored();
    for (let y = 1; y <= d; y++) if (solidAt(p.offset(0, -y, 0))) return true;
    return false;
  };

  async function ticks(n, fn, token) {
    for (let i = 0; i < n; i++) {
      if (token !== gen || !valid(target)) return false;
      if (fn) fn();
      await bot.waitForTicks(1);
    }
    return true;
  }
  async function waitUntil(cond, maxTicks, token) {
    for (let i = 0; i < maxTicks; i++) {
      if (token !== gen) return false;
      if (cond()) return true;
      await bot.waitForTicks(1);
    }
    return false;
  }

  // ---------- god-style helpers ----------
  const hotbarSlot = (item) => (item && item.slot >= 36 && item.slot <= 44 ? item.slot - 36 : null);
  const targetHealth = (ent) => (ent && ent.metadata && typeof ent.metadata[9] === 'number' ? ent.metadata[9] : null);
  /** Item to hold before swapping to the mace (sword/axe/wind charge): the mace then hits with full cooldown. */
  const attrItem = () => [findWeapon('sword'), findWeapon('axe'), findByName('wind_charge')].find((i) => i && hotbarSlot(i) !== null) || null;
  /** A no-cooldown item to hold between spear jabs (lunge swapping). */
  const neutralItem = () => ['wind_charge', 'ender_pearl', 'firework_rocket', 'water_bucket'].map(findByName).find((i) => i && hotbarSlot(i) !== null) || null;

  /** Attribute swapping: select `item` and attack in the SAME tick (packets are sent in order). */
  function swapHit(item, ent) {
    const slot = hotbarSlot(item);
    if (slot !== null) bot.setQuickBarSlot(slot);
    else if (!(bot.heldItem && item && bot.heldItem.name === item.name)) return false;
    hit(ent);
    return true;
  }
  /** After a mace smash: open a short "double-tap" window for an immediate second strike. */
  function noteSmash() {
    if (tricks.dtap) dtapUntil = now() + 2500;
  }

  function facingOf(ent) {
    const yaw = Number.isFinite(ent.headYaw) ? ent.headYaw : ent.yaw;
    return { fx: -Math.sin(yaw), fz: -Math.cos(yaw) };
  }
  /** < 0 means we are behind the entity (a shield cannot block from there). */
  function behindDot(ent) {
    const e = bot.entity;
    const { fx, fz } = facingOf(ent);
    const rx = e.position.x - ent.position.x;
    const rz = e.position.z - ent.position.z;
    const d = Math.hypot(rx, rz) || 1;
    return (rx * fx + rz * fz) / d;
  }

  /** Would stepping one block in (dx,dz) drop us off a cliff, into lava/fire/cactus, or into the void? */
  function unsafeStep(dx, dz) {
    const e = bot.entity;
    for (const k of [1, 1.9]) {                          // look 1 and ~2 blocks ahead (sprinting overshoots)
      const cell = e.position.offset(dx * k, 0, dz * k).floored();
      let ground = false;
      for (let d = 0; d <= 3 && !ground; d++) {
        const b = bot.blockAt(cell.offset(0, -d, 0));
        if (!b) { ground = true; break; }
        if (/lava|^fire$|soul_fire|magma|cactus|sweet_berry|powder_snow|campfire|cobweb/.test(b.name)) return true;
        if (/water/.test(b.name)) { ground = true; break; }
        if (b.boundingBox !== 'empty') ground = true;     // ground found
      }
      if (!ground) return true;                           // nothing to stand on within 3 blocks
    }
    return false;
  }
  /** drive() that refuses to walk off cliffs / into lava while fighting on the ground. */
  function safeDrive(c = {}) {
    const e = bot.entity;
    const f = { x: -Math.sin(e.yaw), z: -Math.cos(e.yaw) };
    const r = { x: Math.cos(e.yaw), z: -Math.sin(e.yaw) };
    const out = { ...c };
    if (out.forward && unsafeStep(f.x, f.z)) {
      // hole / lava / cliff ahead: do not stop, walk AROUND it (sidestep on the safe side)
      out.forward = false; out.sprint = false;
      const canR = !unsafeStep(r.x, r.z);
      const canL = !unsafeStep(-r.x, -r.z);
      if (canR || canL) { const goR = canR && (!canL || strafe === 1); out.right = goR; out.left = !goR; }
    }
    if (out.back && unsafeStep(-f.x, -f.z)) out.back = false;
    if (out.left && unsafeStep(-r.x, -r.z)) out.left = false;
    if (out.right && unsafeStep(r.x, r.z)) out.right = false;
    drive(out);
  }

  function hasLOS(ent) {
    try {
      const e = bot.entity;
      const eye = e.position.offset(0, 1.62, 0);
      const to = aimPoint(ent);
      const dir = to.minus(eye);
      const dist = dir.norm();
      if (dist < 0.5) return true;
      const hitBlock = bot.world.raycast(eye, dir.scaled(1 / dist), dist);
      if (!hitBlock) return true;
      const p = hitBlock.intersect || hitBlock.position.offset(0.5, 0.5, 0.5);
      return eye.distanceTo(p) >= dist - 0.4;
    } catch (err) {
      return true;
    }
  }

  // ---------- attacks ----------
  function hit(ent) {
    bot.attack(ent);
    lastAttack = now();
    hits++;
  }
  /**
   * Spear jab. Within 3 blocks a normal attack is used (always valid). Between 3 and 4.5 blocks the spear's
   * extended-reach "stab" action is sent (1.21.11+). If stabs never register on this server we stop sending them.
   */
  const stabUsable = () => cfg.spearJab !== 'attack' && !stabDisabled && !stabOffSession && bot.registry.version['>=']('1.21.11');
  function jab(ent) {
    const reach = reachTo(ent);
    const canStab = stabUsable();
    let did = false;
    if (canStab && (reach > 3.0 || cfg.spearJab === 'stab')) {
      try {
        bot._client.write('block_dig', { status: cfg.spearStabStatus, location: { x: 0, y: 0, z: 0 }, face: 0, sequence: ++seq });
        lastStabAt = now();
        bot.swingArm('right');
        did = true;
        if (!isBlocking(ent)) stabSent++;
        if (stabSent >= 8) {
          stabOffSession = true;
          log('spear stabs are not registering - switching to normal attacks (stab off for this session)');
          rep('E330');
        }
      } catch (e) { /* fall through to a normal attack */ }
    }
    if (!did && reach <= 3.2) { bot.attack(ent); did = true; }
    if (!did) return false;
    lastJab = now();
    lastAttack = now();
    hits++;
    return true;
  }
  function startCharge() {
    if (charging) return;
    bot.activateItem();
    charging = true;
    chargeStart = now();
  }
  function stopCharge() {
    if (!charging) return;
    try { bot.deactivateItem(); } catch (e) { /* ignore */ }
    charging = false;
    chargeEnd = now();
  }

  // ---------- smart ("auto") style: the bot looks at its own gear and picks what to fight with ----------
  let smartIdx = 0;
  let smartSince = 0;
  let smartHits0 = 0;
  let smartTarget = null;
  let smartPick = null;
  function smartCandidates() {
    const c = [];
    const flies = (findByName('elytra') || ctx.elytra.isWorn()) && countOf('firework_rocket') >= 2;
    const fullKit = (has('mace') && (findByName('wind_charge') || flies)) || (has('spear') && neutralItem());
    if (fullKit) c.push('auto');                                   // god: every trick that fits the gear
    if (has('mace') && findByName('wind_charge')) c.push('mace');
    if (has('spear')) c.push('spear');
    if (has('sword')) c.push('sword');
    if (has('axe')) c.push('axe');
    if (has('mace')) c.push('mace');
    const u = [...new Set(c)];
    return u.length ? u : ['auto'];
  }
  /**
   * Effective fight style. For 'smart': best style the inventory allows (god > mace > spear > sword > axe).
   * If the style lands no confirmed hit for 12 s, the next candidate is tried - so it finds what works on THIS opponent.
   */
  function curStyle() {
    if (weaponPref !== 'smart') return weaponPref;
    const t = now();
    const c = smartCandidates();
    const id = target ? target.id : null;
    if (id !== smartTarget) { smartTarget = id; smartIdx = 0; smartSince = t; smartHits0 = hitsConfirmed; }
    else if (id !== null && t - smartSince > 12000) {
      if (hitsConfirmed === smartHits0 && c.length > 1) {
        const from = c[smartIdx % c.length];
        smartIdx++;
        log(`auto style: ${from} is not landing hits - trying ${c[smartIdx % c.length]}`);
      }
      smartSince = t;
      smartHits0 = hitsConfirmed;
    }
    const pick = c[smartIdx % c.length];
    if (pick !== smartPick) { smartPick = pick; if (id !== null) log(`auto style picked: ${pick === 'auto' ? 'god' : pick}`); }
    return pick;
  }

  // ---------- weapon choice ----------
  /**
   * One weapon at a time. Every item swap resets the server-side attack cooldown, so flipping between weapons
   * (or between a weapon and a wind charge) makes every hit weak. The choice is locked for a while, and only
   * changes for a clear reason: shield -> axe, falling -> mace smash.
   */
  function chooseMeleeType() {
    const e = bot.entity;
    const smashReady = !e.onGround && e.velocity.y < -0.1 && fallen() >= 1.8 && !e.elytraFlying;
    const first = (order) => order.find(has) || null;
    const blocking = isBlocking(target);
    const sty = curStyle();
    if (sty !== 'auto') {
      if (sty === 'mace') {
        if (has('mace') && smashReady) return 'mace';
        return first(['sword', 'axe', 'mace', 'spear']);          // flat mace hits are weak: sword/axe filler between smashes
      }
      if (blocking && has('axe') && sty !== 'spear') return 'axe';
      if (has(sty)) return sty;
      return first(['sword', 'axe', 'spear', 'mace']);
    }
    // god / auto
    if (blocking && has('axe')) { lockedType = 'axe'; weaponLockUntil = now() + 900; return 'axe'; }
    if (smashReady && has('mace')) return 'mace';
    if (now() < weaponLockUntil && lockedType && has(lockedType)) return lockedType;
    const t = first(['sword', 'axe', 'spear', 'mace']);
    if (t) { lockedType = t; weaponLockUntil = now() + 1200; }
    return t;
  }

  // ---------- melee (sword / axe / mace / fist) ----------
  function meleeTick(type, dist) {
    const e = bot.entity;
    const t = now();
    const reach = reachTo(target);
    const finishing = t < finishUntil || t < dtapUntil;
    const cd = finishing ? 350 : MELEE_CD[type || 'fist'];
    const ready = t - lastAttack >= cd;
    if (ready && !wasReady) readySince = t;
    wasReady = ready;

    // spacing
    let fwd = false;
    let back = false;
    if (reach > 2.7) fwd = true;
    else if (reach < 1.3) back = true;

    // strafing
    if (t > nextStrafeFlip) {
      strafe = Math.random() < 0.5 ? 1 : -1;
      nextStrafeFlip = t + 450 + Math.random() * 700;
    }
    const near = reach < 4.2;
    let jump = false;

    // A mace smash works regardless of attack cooldown -> chain smashes with Wind Burst
    const smashNow = type === 'mace' && !e.onGround && e.velocity.y < -0.05 && fallen() >= 1.5 && !e.elytraFlying;
    if (smashNow && reach <= 3.0 && t - lastAttack > 250) {
      hit(target);
      noteSmash();
      log('smash! fell', fallen().toFixed(1), 'blocks');
      drive({ forward: true, sprint: true });
      return;
    }

    if (ready && reach <= 3.0) {
      const falling = !e.onGround && e.velocity.y < -0.03 && !e.isInWater && !e.isInLava;
      if (finishing) {
        hit(target);                                    // no crit dance when they are about to die
      } else if (falling) {
        // crit: must NOT be sprinting. Release sprint one tick earlier, then hit.
        if (bot.getControlState('sprint')) suppressSprint = true;
        else { hit(target); suppressSprint = false; }
      } else if (e.onGround) {
        if (t - readySince < 280) jump = true;          // jump now, hit on the way down
        else hit(target);                                // can't crit (low ceiling etc.)
      } else if (t - readySince > 400) {
        hit(target);
      }
    } else {
      suppressSprint = false;
    }

    safeDrive({
      forward: fwd,
      back,
      left: near && strafe === 1,
      right: near && strafe === -1,
      jump: jump || (fwd && e.onGround && blockedAhead()),
      sprint: fwd && !suppressSprint
    });
  }

  // ---------- spear (ground) ----------
  /**
   * Lunge swapping: hold a no-cooldown item (wind charge / pearl / rocket) between jabs, then swap
   * into the spear and jab in the same tick, so the spear's slow cooldown is bypassed.
   */
  const lungeSwapReady = () => tricks.lungeswap && !!neutralItem();

  function spearTick(item) {
    const t = now();
    const reach = reachTo(target);
    const tier = TIERS.find((x) => item.name.startsWith(x)) || 'iron';
    const swapMode = lungeSwapReady() && hotbarSlot(item) !== null;
    const jabCd = JAB_CD[tier] || 1000;               // the REAL cooldown: jabbing faster only makes weak hits
    const maxReach = stabUsable() ? 4.4 : 3.0;        // without the extended stab only the normal ~3 block reach works
    const fwd = reach > maxReach - 0.6;
    const back = reach < 1.6;

    if (t > nextStrafeFlip) {
      strafe = Math.random() < 0.5 ? 1 : -1;
      nextStrafeFlip = t + 600 + Math.random() * 600;
    }

    if (reach <= maxReach && t - lastJab >= jabCd && hasLOS(target)) {
      stopCharge();
      if (swapMode) {
        bot.setQuickBarSlot(hotbarSlot(item));          // swap INTO the spear and jab on the same tick
        lungeBackAt = t + 80;
      }
      jab(target);
    }
    // lunge swapping only: back to the no-cooldown item between jabs
    if (swapMode && lungeBackAt && t >= lungeBackAt) {
      const n = neutralItem();
      if (n) bot.setQuickBarSlot(hotbarSlot(n));
      lungeBackAt = 0;
    }
    // charge while running in; let go just before the jab window
    if (!swapMode) {
      if (!charging && reach > maxReach + 0.4 && t - chargeEnd > 500) startCharge();
      if (charging && (reach <= maxReach || t - chargeStart > 3800)) stopCharge();
    }

    safeDrive({ forward: fwd, back, left: !fwd && reach < 4.2 && strafe === 1, right: !fwd && reach < 4.2 && strafe === -1, sprint: fwd, jump: fwd && bot.entity.onGround && blockedAhead() });
  }

  // ---------- wind charge launch ----------
  const yawTo = (ent) => Math.atan2(-(ent.position.x - bot.entity.position.x), -(ent.position.z - bot.entity.position.z));

  /**
   * Jump and throw a wind charge at our feet on the SAME tick while looking straight down:
   * this gives the maximum launch height (about 11 blocks).
   */
  async function windLaunch(token, yaw) {
    const wind = findByName('wind_charge');
    if (!wind) return false;
    await hold(wind);
    bot.look(yaw, -Math.PI / 2, true);
    await bot.waitForTicks(2);
    if (token !== gen) return false;
    bot.setControlState('jump', true);
    bot.activateItem();
    await bot.waitForTicks(1);
    bot.setControlState('jump', false);
    return true;
  }

  // ---------- wind-charge mace smash ----------
  async function windSmash() {
    const token = gen;
    busy = 'wind';
    markStunt('wind');
    lastWindSmash = now();
    const hitsBefore = hitsConfirmed;
    const e = bot.entity;
    let tapped = false;
    let swordHit = false;
    try {
      const mace = findWeapon('mace');
      if (!mace || !findByName('wind_charge')) return;
      log('wind-charge jump starting');
      ctx.pathStop();
      tapped = await offtapPrep();
      drive({ forward: true, sprint: true });
      if (!(await windLaunch(token, yawTo(target)))) return;
      // Attribute swapping: hold a sword (or wind charge) while falling, swap to the mace at the
      // moment of impact so the hit has full cooldown + crit. Without one, just hold the mace.
      const swapItem = tricks.attrswap ? attrItem() : null;
      await hold(swapItem || mace);

      // steer onto the target while rising/falling
      const t0 = now();
      let smashed = false;
      while (token === gen && valid(target) && now() - t0 < 4500) {
        face(target);
        drive({ forward: true, sprint: true });
        const reach = reachTo(target);
        if (tapped && reach < 12 && e.velocity.y < -0.05) offtapUse();
        // chain step 1: sprint-hit with the sword on the way (knockback), the mace swap-hit follows on the way down
        if (!swordHit && swapItem && /_sword$/.test(swapItem.name) && reach <= 3.2 && e.velocity.y > -0.05 && hotbarSlot(swapItem) !== null) {
          swordHit = true;
          bot.setQuickBarSlot(hotbarSlot(swapItem));
          hit(target);
          log('chain: sword sprint-hit');
        }
        if (e.velocity.y < -0.05 && reach <= 3.0 && fallen() >= 1.5) {
          const shield = isBlocking(target);
          if (!(swapItem && swapHit(mace, target))) { await hold(mace); hit(target); }
          if (shield) stunnedUntil = now() + 1500;                 // the smash disables the shield: follow up at once
          noteSmash();
          smashed = true;
          log('wind smash hit, fell', fallen().toFixed(1), 'blocks', swapItem ? '(attribute swap)' : '');
          break;
        }
        if (e.onGround && now() - t0 > 500) break;
        await bot.waitForTicks(1);
      }
      if (!smashed && token === gen) await bot.waitForTicks(1);
    } catch (err) {
      log('windSmash error:', err.message); rep('E310', err);
    } finally {
      if (tapped) await offtapRestore();
      busy = null;
      drive({});
      stuntCooldownUntil = now() + cfg.stuntCooldownMs;
      // two launches in a row that did not hurt anybody => stop launching, fight normally for a while
      if (hitsConfirmed === hitsBefore) {
        if (++windMisses >= 2) { windMisses = 0; windBlockedUntil = now() + 25000; log('wind-charge jumps keep missing - normal fighting for the next 25s'); }
      } else windMisses = 0;
    }
  }

  // ---------- elytra airstrike ----------
  const rocket = () => findByName('firework_rocket');
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

  async function boost(token, backTo) {
    const r = rocket();
    if (!r) return false;
    await hold(r);
    if (token !== gen) return false;
    bot.activateItem();
    if (backTo) await hold(backTo);
    return true;
  }

  /** Which aerial strike fits our kit and fight style? 'combo' = spear pass, then mace dive. */
  function airKind() {
    const m = has('mace');
    const sp = has('spear');
    const sty = curStyle();
    if (sty === 'mace') return m ? 'mace' : null;
    if (sty === 'spear') return sp ? 'spear' : null;
    if (sty !== 'auto') return null;
    if (m && sp) return 'combo';
    return m ? 'mace' : sp ? 'spear' : null;
  }

  // ---------- flight safety ----------
  /** Blocks of air below us (up to maxD); maxD when nothing solid / water is found (or the chunk is not loaded). */
  function groundDistance(maxD = 60) {
    const p = bot.entity.position.floored();
    for (let y = 1; y <= maxD; y++) {
      const b = bot.blockAt(p.offset(0, -y, 0));
      if (!b) return maxD;
      if (b.boundingBox !== 'empty' || /water|lava/.test(b.name)) return y;
    }
    return maxD;
  }
  /** Is a wall / mountain in our flight path within `dist` blocks? */
  function obstacleAhead(dist = 14) {
    try {
      const e = bot.entity;
      const v = e.velocity;
      const n = v.norm();
      if (n < 0.05) return false;
      const hit = bot.world.raycast(e.position.offset(0, 1, 0), v.scaled(1 / n), dist);
      return !!hit;
    } catch (err) {
      return false;
    }
  }
  function noteFlightFail() {
    flightFails++;
    if (flightFails >= 3 && opts.air) {
      opts.air = false;
      flightFails = 0;
      log('elytra take-off keeps failing - elytra flights OFF for now'); rep('E303');
      if (ctx.say) ctx.say('Elytra take-off keeps failing, so I turned elytra flights OFF. (type "air on" to try again)');
    }
  }
  /**
   * Whenever the bot is gliding and nothing is steering it any more (a routine ended, the target vanished,
   * the "fly" command, the emergency deploy while falling...), glide down gently, flare, and touch down.
   * Without this the bot keeps gliding in a straight line at full speed: crash damage, hovering over the void,
   * or an anti-fly kick.
   */
  async function landSafely(why) {
    if (landing || !bot.entity || !bot.entity.elytraFlying) return;
    landing = true;
    const e = bot.entity;
    log(`gliding with nothing to do - landing safely${why ? ` (${why})` : ''}`);
    try {
      const t0 = now();
      const yaw = e.yaw;
      while (e.elytraFlying && bot.entity && now() - t0 < 30000) {
        const gd = groundDistance(60);
        const speed = e.velocity.norm() * 20;
        const vy = e.velocity.y;
        let pitch = -0.12;                                   // gentle glide
        if (gd > 30) pitch = -0.5;                           // lose altitude faster
        else if (gd > 14) pitch = -0.25;
        if (gd <= 12 && (vy < -0.55 || speed > 22)) pitch = 0.45;    // flare: bleed off speed
        if (gd <= 4 && vy < -0.3) pitch = 0.6;
        if (obstacleAhead(12)) pitch = 0.6;                  // pull up in front of a wall
        bot.look(yaw, pitch, true);
        await bot.waitForTicks(1);
      }
    } catch (err) {
      log('landing error:', err.message); rep('E302', err);
    } finally {
      landing = false;
    }
  }

  /** Leave the ground (wind-charge launch if we have one, else a jump) and start gliding. */
  async function takeoff(token, yaw) {
    const e = bot.entity;
    if (e.elytraFlying) return true;
    if (e.isInWater || e.isInLava) return false;
    if (e.onGround && cfg.windTakeoff && findByName('wind_charge') && skyOpen(8)) {
      drive({ forward: true, sprint: true });
      await windLaunch(token, yaw);
      drive({});
      await waitUntil(() => !e.onGround && e.velocity.y < 0.05, 40, token);
    } else if (e.onGround) {
      bot.setControlState('jump', true);
      await bot.waitForTicks(2);
      bot.setControlState('jump', false);
    }
    if (!(await waitUntil(() => !e.onGround && e.velocity.y < -0.05, 45, token))) { log('could not leave the ground'); return false; }
    bot.look(yaw, 0.1, true);                                // level out (the wind launch left us looking straight down)
    try {
      await bot.elytraFly();
    } catch (err) {
      log('elytraFly failed:', err.message); rep('E300', err);
      return false;
    }
    // the server confirms gliding a few ticks later (entity metadata); ask once more if it did not
    if (!(await waitUntil(() => e.elytraFlying, 12, token))) {
      try { if (!e.onGround) await bot.elytraFly(); } catch (err) { /* ignore */ }
      if (!(await waitUntil(() => e.elytraFlying, 14, token))) {
        log('server did not start gliding (elytra broken or not worn?)');
        return false;
      }
    }
    flightFails = 0;
    return true;
  }

  /** Climb with rockets until we are `height` blocks above y (steering toward fx,fz). */
  async function climbTo(token, y, height, headingFn) {
    const e = bot.entity;
    let used = 0;
    while (token === gen && used < cfg.maxClimbRockets && e.position.y < y + height && e.elytraFlying) {
      if (!(await boost(token))) break;
      used++;
      await ticks(24, () => bot.look(headingFn(), 0.85, true), token);
    }
    return e.elytraFlying;
  }

  async function airstrike(kind) {
    const token = gen;
    busy = 'air';
    markStunt('air');
    const hitsBefore = hitsConfirmed;
    const e = bot.entity;
    const alive = () => token === gen && valid(target);
    const headingToTarget = () => Math.atan2(-(target.position.x - e.position.x), -(target.position.z - e.position.z));
    try {
      ctx.pathStop();
      const dist0 = e.position.distanceTo(target.position);
      log(`airstrike (${kind}) starting, target ${Math.round(dist0)} blocks away`);
      if (!(await ctx.elytra.wear())) { log('airstrike aborted: no elytra'); return; }
      ctx.elytra.setRestore(true);
      if (!rocket()) { log('airstrike aborted: no firework rockets'); return; }
      if (!(await takeoff(token, headingToTarget()))) { log('airstrike aborted: takeoff failed'); noteFlightFail(); return; }

      // climb only as high as the distance needs (short swoop up close, big dive from far away)
      const climb = clamp(dist0 * 0.6, 9, cfg.climbHeight);
      if (!(await climbTo(token, target.position.y, climb, headingToTarget)) || !alive()) { log('airstrike aborted: not gliding after climb'); return; }
      log(`climbed to y=${e.position.y.toFixed(0)}, diving`);

      if (kind === 'mace') {
        const hbMace = hitsConfirmed;
        const tapped = await offtapPrep();
        try { await strikeMace(token); } finally { if (tapped) await offtapRestore(); }
        await elyLoop(token, headingToTarget, alive, hbMace);
      } else if (kind === 'spear') {
        await strikeSpear(token, 3);
      } else {
        // combo: spear charge pass first, then climb again and finish with a mace smash
        const passes = await strikeSpear(token, 1);
        if (alive() && has('mace') && e.elytraFlying) {
          if (await climbTo(token, target.position.y, 12, headingToTarget)) {
            log('combo: second strike with the mace');
            await strikeMace(token);
          }
        } else if (passes === 0) log('combo: spear pass did not connect');
      }
      strikeN++;
    } catch (err) {
      log('airstrike error:', err.message); rep('E304', err);
    } finally {
      stopCharge();
      busy = null;
      drive({});
      stuntCooldownUntil = now() + cfg.stuntCooldownMs * 2;
      // two strikes in a row that never hurt anybody => stop wasting rockets, fight on the ground for a while
      if (hitsConfirmed === hitsBefore) {
        if (++airMisses >= 2) { airMisses = 0; airBlockedUntil = now() + 30000; log('air strikes keep missing - ground fight for the next 30s'); }
      } else airMisses = 0;
    }
  }

  async function strikeMace(token) {
    const e = bot.entity;
    const mace = findWeapon('mace');
    if (!mace) return;
    const swapItem = tricks.attrswap ? attrItem() : null;     // held during the dive, swapped to the mace on impact
    const dive = swapItem || mace;
    await hold(dive);
    let swapped = false;
    for (let i = 0; i < 20 * 14; i++) {
      if (token !== gen || !valid(target)) return;
      const d0 = e.position.distanceTo(target.position);
      const speed = e.velocity.norm() * 20;
      const aim = aimPoint(target, Math.min(15, d0 / Math.max(0.6, e.velocity.norm())));
      bot.lookAt(aim, true);

      if (offtapActive && d0 < 14) offtapUse();
      // take the elytra off just before contact: gliding blocks the smash, falling doesn't
      if (!swapped && e.elytraFlying && d0 < Math.max(6, speed * 0.22 + 3)) {
        swapped = true;
        ctx.elytra.putChestplate().catch(() => {});
      }
      if ((swapped || !e.elytraFlying) && reachTo(target) <= 3.1) {
        if (!(swapItem && swapHit(mace, target))) { await hold(mace); hit(target); }
        noteSmash();
        log('elytra mace dive-bomb smash at', speed.toFixed(0), 'b/s', swapItem ? '(attribute swap)' : '');
        await bot.waitForTicks(2);
        return;
      }
      if (swapped && e.onGround) return;
      // too slow / still far: rocket boost
      if (!swapped && e.elytraFlying && speed < 12 && d0 > 16 && rocket()) await boost(token, dive);
      await bot.waitForTicks(1);
    }
  }

  /** Spear charge passes while gliding. Returns how many passes were completed. */
  async function strikeSpear(token, maxPasses = 3) {
    const e = bot.entity;
    const spear = findWeapon('spear');
    if (!spear) return 0;
    await hold(spear);
    const t0 = now();
    let passes = 0;
    let lastD = Infinity;
    while (token === gen && valid(target) && now() - t0 < 16000 && passes < maxPasses) {
      const d = e.position.distanceTo(target.position);
      const vel = e.velocity.norm();
      const speed = vel * 20;
      let aim = aimPoint(target, Math.min(15, d / Math.max(0.6, vel)));
      // don't fly into the ground after passing through
      if ((d < 3.5 || (groundWithin(2) && e.velocity.y < -0.3)) && e.elytraFlying) aim = aim.offset(0, 6, 0);
      bot.lookAt(aim, true);

      const chargeDist = Math.max(8, speed * 0.55 + 4); // ~0.4-0.6 s activation delay
      if (!charging && e.elytraFlying && d < chargeDist) startCharge();
      if (charging && d > lastD + 0.4 && d > 5) {       // passed through
        stopCharge();
        passes++;
        if (passes < maxPasses && speed < 20 && rocket()) await boost(token, spear);
      }
      if (charging && now() - chargeStart > 3500) stopCharge();
      if (!e.elytraFlying && e.onGround) break;
      lastD = d;
      await bot.waitForTicks(1);
    }
    stopCharge();
    return passes;
  }

  // ---------- long-distance travel (used when hunting a player far away) ----------
  async function elytraTravel(pos, shouldAbort) {
    if (busy) return false;
    const token = gen;
    busy = 'travel';
    markStunt('air');
    const e = bot.entity;
    try {
      if (!(await ctx.elytra.wear())) return false;
      ctx.elytra.setRestore(true);
      const yawToPos = () => Math.atan2(-(pos.x - e.position.x), -(pos.z - e.position.z));
      if (!(await takeoff(token, yawToPos()))) { noteFlightFail(); return false; }
      log(`flying toward ${Math.round(pos.x)} ${Math.round(pos.z)}`);
      const t0 = now();
      let lastBoost = 0;
      let used = 0;
      while (token === gen && now() - t0 < 75000 && e.elytraFlying) {
        if (shouldAbort && shouldAbort()) break;
        if (bot.health < 8) break;                                  // too hurt for fancy flying: land
        const hd = Math.hypot(pos.x - e.position.x, pos.z - e.position.z);
        if (hd < 28) break;                                         // close enough: landSafely() takes over
        const speed = e.velocity.norm() * 20;
        // cruise high, come down gradually as we get close
        const wantAlt = pos.y + clamp(hd * 0.3, 10, 55);
        let pitch = clamp((wantAlt - e.position.y) * 0.03, -0.45, 0.5);
        if (groundDistance(40) < 8 && e.velocity.y < -0.3) pitch = 0.6;     // pull up
        if (obstacleAhead(16)) pitch = 0.7;                                  // mountain / wall ahead
        if (speed < 14 && used < (cfg.maxTravelRockets || 12) && rocket() && now() - lastBoost > 1500 && pitch > -0.3) {
          lastBoost = now();
          used++;
          await boost(token);
        }
        bot.look(yawToPos(), pitch, true);
        await bot.waitForTicks(1);
      }
      return true;
    } catch (err) {
      log('travel error:', err.message); rep('E301', err);
      noteFlightFail();
      return false;
    } finally {
      busy = null;
      drive({});
    }
  }

  // ---------- ender pearls ----------
  const pearlItem = () => findByName('ender_pearl');
  const solidFn = (x, y, z) => solidAt(new Vec3(Math.floor(x), Math.floor(y), Math.floor(z)));
  const hasTotemOffhand = () => {
    const o = bot.inventory.slots[45];
    return !!o && o.name === 'totem_of_undying';
  };
  let pearlRetryAt = 0;

  async function throwPearlAt(pos, token) {
    const e = bot.entity;
    if (!pearlItem() || now() - lastPearl < 1100) return null;
    const eye = e.position.offset(0, 1.52, 0);
    const sol = solvePearl(eye, pos, solidFn);
    if (!sol) return null;
    await hold(pearlItem());
    if (token !== gen) return null;
    drive({});
    bot.look(sol.yaw, sol.pitch, true);
    await bot.waitForTicks(2);
    bot.activateItem();
    lastPearl = now();
    await bot.waitForTicks(2);
    return sol;
  }

  /** Close a long gap by pearling toward the target (leading a moving target). */
  async function pearlEngage() {
    const token = gen;
    busy = 'pearl';
    markStunt('pearl');
    try {
      const e = bot.entity;
      const first = solvePearl(e.position.offset(0, 1.52, 0), target.position, solidFn);
      if (!first) { pearlRetryAt = now() + 3500; log('pearl: no clear throw path'); return; }
      const aim = target.position.plus(tVel.scaled(Math.min(40, first.ticks)));
      aim.y = target.position.y;
      const sol = await throwPearlAt(aim, token);
      if (sol) log(`pearl thrown at target ${Math.round(e.position.distanceTo(target.position))} blocks away (${sol.ticks} ticks flight)`);
      else pearlRetryAt = now() + 3500;
    } catch (err) {
      log('pearl error:', err.message); rep('E320', err);
    } finally {
      busy = null;
      stuntCooldownUntil = now() + 1500;
    }
  }

  /** Low health and no totem: pearl away from the target, then heal. */
  async function pearlEscape() {
    const token = gen;
    busy = 'pearl';
    markStunt('pearl');
    try {
      const e = bot.entity;
      const away = e.position.minus(target.position);
      away.y = 0;
      if (away.norm() < 0.1) away.x = 1;
      const dir = away.scaled(1 / away.norm());
      for (const d of [32, 26, 20, 14]) {
        const sol = await throwPearlAt(e.position.plus(dir.scaled(d)), token);
        if (sol) {
          retreatUntil = now() + 7000;
          log(`pearl escape (${d} blocks), hp=${Math.round(bot.health)}`);
          break;
        }
      }
    } catch (err) {
      log('pearl escape error:', err.message); rep('E320', err);
    } finally {
      busy = null;
      escapeCd = now() + 15000;
    }
  }

  // ---------- water-bucket clutch (survive a failed wind-charge launch) ----------
  function maybeClutch() {
    if (!cfg.waterClutch || clutching || busy === 'air') return;
    const e = bot.entity;
    if (e.onGround || e.isInWater || e.elytraFlying) return;
    if (e.velocity.y > -0.85 || fallen() < 7 || now() < clutchCd) return;
    if (!groundWithin(4)) return;
    if (target && has('mace') && reachTo(target) < 6) return;     // about to smash instead
    const bucket = findByName('water_bucket');
    if (!bucket) return;
    clutching = true;
    clutchCd = now() + 4000;
    (async () => {
      try {
        await hold(bucket);
        bot.look(e.yaw, -Math.PI / 2, true);
        await bot.waitForTicks(1);
        bot.activateItem();                                      // place water below
        await waitUntil(() => e.onGround || e.isInWater, 30, gen);
        await bot.waitForTicks(3);
        bot.look(e.yaw, -Math.PI / 2, true);
        bot.activateItem();                                      // pick the water back up
        await bot.waitForTicks(4);
        log('water clutch done');
      } catch (err) { /* ignore */ }
      clutching = false;
    })();
  }

  // ---------- shield tactics: backstab ----------
  /** Run around a shielding opponent and hit them from behind, where the shield cannot block. */
  function backstabTick(ent) {
    const e = bot.entity;
    const { fx, fz } = facingOf(ent);
    const reach = reachTo(ent);
    const weapon = findWeapon('sword') || findWeapon('axe') || findWeapon('mace') || findWeapon('spear');
    if (weapon) hold(weapon);
    if (behindDot(ent) < -0.25 && reach <= 3.0) {
      face(ent);
      if (now() - lastAttack >= 450) {
        if (weapon && weaponType(weapon) === 'spear') jab(ent); else hit(ent);
        log('backstab!');
      }
      safeDrive({ forward: reach > 2.4 });
      return;
    }
    // sprint to the point 1.7 blocks behind them
    const bx = ent.position.x - fx * 1.7;
    const bz = ent.position.z - fz * 1.7;
    if (tricks.lungedash && reach > 3.5 && now() - lastDash > 700 && findWeapon('spear') && lungeOnce(Math.atan2(-(bx - e.position.x), -(bz - e.position.z)), 0.1)) return;   // lunge dash past them
    bot.look(Math.atan2(-(bx - e.position.x), -(bz - e.position.z)), 0, true);
    safeDrive({ forward: true, sprint: true, jump: e.onGround && blockedAhead() });
  }

  // ---------- grappling (far pulling) ----------
  /** Wind charge at their feet launches them up; an ender pearl to their feet pulls us in to hit them out of the air. */
  async function grapple() {
    const token = gen;
    busy = 'grapple';
    markStunt('wind');
    lastGrapple = now();
    try {
      const wind = findByName('wind_charge');
      if (!wind || !pearlItem()) return;
      ctx.pathStop();
      drive({});
      log(`grapple: wind charge at their feet (${Math.round(bot.entity.position.distanceTo(target.position))} blocks)`);
      await hold(wind);
      bot.lookAt(target.position.offset(0, 0.1, 0), true);
      await bot.waitForTicks(2);
      if (token !== gen || !valid(target)) return;
      bot.activateItem();
      await bot.waitForTicks(3);
      markStunt('pearl');
      const sol = await throwPearlAt(target.position.clone(), token);
      if (!sol) { log('grapple: no clear pearl path'); return; }
      log(`grapple: pearl thrown (${sol.ticks} ticks) - pulling myself in`);
      const weapon = findWeapon('spear') || findWeapon('mace') || findWeapon('sword');
      if (weapon) await hold(weapon);
      // wait for the teleport, then keep hitting them while they fall
      const e = bot.entity;
      let prev = e.position.clone();
      const t0 = now();
      while (token === gen && valid(target) && now() - t0 < 4500) {
        await bot.waitForTicks(1);
        const p = e.position;
        if (p.distanceTo(prev) > 6) { log('grapple: teleported next to the target'); break; }
        prev = p.clone();
      }
    } catch (err) {
      log('grapple error:', err.message); rep('E340', err);
    } finally {
      busy = null;
      drive({});
      stuntCooldownUntil = now() + 2000;
    }
  }

  // ---------- wind charge pearling ----------
  /** Pearl closes the gap; on arrival a wind charge launches us straight into a mace divebomb. */
  async function windPearlStrike() {
    const token = gen;
    busy = 'windpearl';
    markStunt('pearl');
    lastWindPearl = now();
    let arrived = false;
    try {
      const e = bot.entity;
      const first = solvePearl(e.position.offset(0, 1.52, 0), target.position, solidFn);
      if (!first) { pearlRetryAt = now() + 3500; log('wind-pearl: no clear throw path'); return; }
      const aim = target.position.plus(tVel.scaled(Math.min(40, first.ticks)));
      aim.y = target.position.y;
      const sol = await throwPearlAt(aim, token);
      if (!sol) { pearlRetryAt = now() + 3500; return; }
      log(`wind-pearl: pearl thrown (${sol.ticks} ticks), wind charge ready for the arrival`);
      let prev = e.position.clone();
      const t0 = now();
      while (token === gen && valid(target) && now() - t0 < 5000) {
        await bot.waitForTicks(1);
        if (e.position.distanceTo(prev) > 6) { arrived = true; break; }
        prev = e.position.clone();
      }
    } catch (err) {
      log('wind-pearl error:', err.message); rep('E340', err);
    } finally {
      busy = null;
      drive({});
    }
    if (arrived && token === gen && valid(target)) {
      log('wind-pearl: arrived - launching the divebomb');
      stuntCooldownUntil = 0;
      await windSmash();
    } else {
      stuntCooldownUntil = now() + 1500;
    }
  }

  /**
   * GOD close combat ("lunge swapping" + "attribute swapping"): a no-cooldown item (wind charge...) stays in hand
   * so the attack cooldown keeps charging. When it is full, swap INTO the best weapon for the distance and hit on
   * the SAME tick (spear jab at 3-4.4 blocks, sword/axe/mace up close), then go back to the no-cooldown item.
   * Every hit lands at full cooldown, with whichever weapon fits - no weak hits from swapping.
   */
  function swapFightTick(n) {
    const t = now();
    const e = bot.entity;
    const reach = reachTo(target);
    const blocking = isBlocking(target);
    const spear = findWeapon('spear');
    const close = (blocking && findWeapon('axe')) || findWeapon('sword') || findWeapon('axe') || findWeapon('mace');
    const useSpear = spear && hotbarSlot(spear) !== null && stabUsable() && reach > 3.1;
    const maceItem = findWeapon('mace');
    const fallingFar = !e.onGround && e.velocity.y < -0.1 && fallen() >= 1.5 && !e.elytraFlying;
    const w = (fallingFar && maceItem && hotbarSlot(maceItem) !== null) ? maceItem : (useSpear ? spear : (close || spear));   // sword -> mace attribute swap chain
    if (!w) return false;
    const isSpear = weaponType(w) === 'spear';
    const tier = TIERS.find((x) => w.name.startsWith(x)) || 'iron';
    const cd = t < finishUntil || t < dtapUntil ? 350 : (isSpear ? (JAB_CD[tier] || 1000) : (MELEE_CD[weaponType(w)] || 650));
    const maxReach = isSpear ? 4.4 : 3.0;
    if (t > nextStrafeFlip) { strafe = Math.random() < 0.5 ? 1 : -1; nextStrafeFlip = t + 500 + Math.random() * 600; }

    // swap back to the neutral item shortly after a hit
    if (lungeBackAt && t >= lungeBackAt) { bot.setQuickBarSlot(hotbarSlot(n)); lungeBackAt = 0; }
    else if (!lungeBackAt && bot.heldItem && bot.heldItem.name !== n.name && t - lastAttack > 150) bot.setQuickBarSlot(hotbarSlot(n));

    if (t < rgBackUntil) { face(target); safeDrive({ back: true }); return true; }       // after a reach glitch: sprint back
    const ready = t - lastAttack >= cd;
    if (ready && reach <= (fallingFar ? 3.0 : maxReach) && hasLOS(target)) {
      const falling = !e.onGround && e.velocity.y < -0.1;
      if (isSpear || falling || t - lastAttack > cd + 450 || !e.onGround) {
        bot.setQuickBarSlot(hotbarSlot(w));
        if (isSpear) {
          if (tricks.reachglitch && maceItem && hotbarSlot(maceItem) !== null && reach > 3.3 && reachGlitchHit(target)) { /* done */ } else jab(target);
        } else { suppressSprint = falling; hit(target); if (falling && w === maceItem) noteSmash(); }
        lungeBackAt = t + 80;
      } else if (e.onGround && t - lastAttack < cd + 400) {
        drive({ jump: true, forward: true });       // jump first so the swap-hit lands as a crit
        return true;
      }
    }
    const fwd = reach > (isSpear ? 3.6 : 2.7);
    safeDrive({ forward: fwd, back: reach < 1.5, left: !fwd && strafe === 1, right: !fwd && strafe === -1, sprint: fwd && !suppressSprint, jump: fwd && e.onGround && blockedAhead() });
    return true;
  }

  // =====================================================================================================
  // GOD TECHNIQUES v2 (the god-level PvP guide). Each technique has a budget: when it keeps failing to land a
  // confirmed hit it switches itself OFF (error E341) so it can never loop forever.
  // =====================================================================================================
  const tstat = {};
  function trackTech(name, hitsBefore, limit = 3) {
    const s = tstat[name] || (tstat[name] = { uses: 0, hits: 0, fails: 0 });
    s.uses++;
    if (hitsConfirmed > hitsBefore) { s.hits++; s.fails = 0; } else if (++s.fails >= limit && tricks[name]) {
      tricks[name] = false;
      log(`technique "${name}" did not land ${limit} times in a row - switched OFF (trick ${name} on to retry)`);
      rep('E341', null, name);
    }
  }
  const sendStab = () => {
    try { bot._client.write('block_dig', { status: cfg.spearStabStatus, location: { x: 0, y: 0, z: 0 }, face: 0, sequence: ++seq }); return true; } catch (e) { return false; }
  };

  // ---- 1) Spear-Mace reach glitch: spear hotkey + click, then mace hotkey, all inside the same tick ----
  let rgBackUntil = 0;
  function reachGlitchHit(ent) {
    const spear = findWeapon('spear');
    const mace = findWeapon('mace');
    const ss = spear ? hotbarSlot(spear) : null;
    const ms = mace ? hotbarSlot(mace) : null;
    if (ss === null || ms === null) return false;
    const before = hitsConfirmed;
    bot.setQuickBarSlot(ss);                                  // spear: the game checks the long reach with it ...
    if (!(stabUsable() && sendStab())) bot.attack(ent); else bot.swingArm('right');
    bot.setQuickBarSlot(ms);                                  // ... mace in hand before the hit connects
    lastAttack = now(); lastJab = now(); hits++;
    rgBackUntil = now() + 450;                                // then sprint backward to keep the spacing
    log('reach glitch: spear reach + mace swap');
    setTimeout(() => trackTech('reachglitch', before, 5), 900);
    return true;
  }

  // ---- 2) Infinite spear lunging: spear + right-click, instantly back to the utility item ----
  let lastDash = 0;
  let dashCheck = null;
  let dashFails = 0;
  function lungeOnce(yaw, pitch = 0.12) {
    const spear = findWeapon('spear');
    const ss = spear ? hotbarSlot(spear) : null;
    if (ss === null || bot.food < 8) return false;
    const n = neutralItem();
    const back = n ? hotbarSlot(n) : bot.quickBarSlot;
    bot.look(yaw, pitch, true);
    bot.setQuickBarSlot(ss);
    bot.activateItem();                                       // right-click = lunge dash
    bot.setQuickBarSlot(back);                                // back to the utility item at once
    lastDash = now();
    dashCheck = { ticks: 0, sp: Math.hypot(bot.entity.velocity.x, bot.entity.velocity.z) };
    return true;
  }
  function checkDash() {                                      // called every physics tick
    if (!dashCheck) return;
    if (++dashCheck.ticks < 5) return;
    const sp = Math.hypot(bot.entity.velocity.x, bot.entity.velocity.z);
    if (sp - dashCheck.sp >= 0.2) dashFails = 0;
    else if (++dashFails >= 4 && tricks.lungedash) { tricks.lungedash = false; log('lunge dashes do not move me (no Lunge enchant?) - switched OFF'); rep('E332'); }
    dashCheck = null;
  }
  async function lungeChain() {                                // close a gap with chained dashes
    const token = gen;
    busy = 'lunge';
    markStunt('wind');
    try {
      for (let i = 0; i < 6 && token === gen && valid(target); i++) {
        if (reachTo(target) <= 4.2 || bot.food < 8) break;
        if (!lungeOnce(yawTo(target), 0.12)) break;
        await bot.waitForTicks(8);
      }
    } catch (err) { rep('E341', err, 'lungeChain'); } finally { busy = null; drive({}); stuntCooldownUntil = now() + 500; }
  }
  async function lungeEscape(dir, n = 4) {                     // used by the brain when fleeing
    if (!tricks.lungedash || !findWeapon('spear')) return false;
    const yaw = Math.atan2(-dir.x, -dir.z);
    let ok = false;
    for (let i = 0; i < n; i++) { if (lungeOnce(yaw, 0.12)) ok = true; else break; await bot.waitForTicks(8); }
    return ok;
  }

  // ---- 3) Elytra-mace loop: wind-burst bounce -> elytra back on at the apex -> rocket -> dive again ----
  async function elyLoop(token, headingFn, alive, hitsBefore) {
    if (!tricks.elyloop || hitsConfirmed === hitsBefore) return;
    const e = bot.entity;
    for (let loop = 0; loop < 2; loop++) {
      if (!alive() || bot.health < 12 || countOf('firework_rocket') < 2 || e.isInWater) return;
      if (!(await waitUntil(() => !e.onGround && e.velocity.y > 0.2, 12, token))) return;     // no bounce => no Wind Burst
      await waitUntil(() => e.velocity.y <= 0.05, 50, token);
      if (!alive() || e.onGround) return;
      if (!(await ctx.elytra.wear())) return;
      ctx.elytra.setRestore(true);
      try { await bot.elytraFly(); } catch (err) { log('loop: elytraFly failed:', err.message); return; }
      if (!(await waitUntil(() => e.elytraFlying, 14, token))) return;
      await boost(token, null);
      if (!(await climbTo(token, target.position.y, 10, headingFn)) || !alive()) return;
      log(`elytra-mace loop: dive #${loop + 2}`);
      const hb = hitsConfirmed;
      await strikeMace(token);
      if (hitsConfirmed === hb) return;
    }
  }

  // ---- 4) Kinetic wind-pearl launch: pearl straight up, wind charges under it, mace on the way down ----
  let lastPRocket = 0;
  async function fallSteer(token) {                            // steer a free fall onto the target and smash
    const e = bot.entity;
    const mace = findWeapon('mace');
    const t0 = now();
    const swapItem = tricks.attrswap ? attrItem() : null;
    await hold(swapItem || mace);
    while (token === gen && valid(target) && now() - t0 < 25000) {
      face(target);
      drive({ forward: true, sprint: true });
      if (e.velocity.y < -0.05 && reachTo(target) <= 3.0) {
        if (!(swapItem && swapHit(mace, target))) { await hold(mace); hit(target); }
        noteSmash();
        log('kinetic launch: smash from', fallen().toFixed(0), 'blocks');
        return true;
      }
      if (e.onGround && now() - t0 > 600) return false;
      await bot.waitForTicks(1);
    }
    return false;
  }
  async function pearlRocket() {
    const token = gen;
    busy = 'prock';
    markStunt('pearl');
    lastPRocket = now();
    const hb = hitsConfirmed;
    const e = bot.entity;
    try {
      const mace = findWeapon('mace');
      if (!pearlItem() || !findByName('wind_charge') || !mace) return;
      ctx.pathStop();
      drive({});
      log('kinetic wind-pearl launch: pearl straight up, wind charges under it');
      bot.look(e.yaw, Math.PI / 2, true);
      await bot.waitForTicks(3);
      await hold(pearlItem());
      bot.activateItem();
      lastPearl = now();
      await bot.waitForTicks(1);
      await hold(findByName('wind_charge'));
      for (let i = 0; i < 5 && token === gen; i++) { bot.activateItem(); await bot.waitForTicks(2); }
      const p0 = e.position.clone();
      const t0 = now();
      let tele = false;
      while (token === gen && now() - t0 < 7000) {
        await bot.waitForTicks(1);
        if (e.position.distanceTo(p0) > 20) { tele = true; break; }
      }
      if (!tele) { log('pearl launch: no teleport happened'); return; }
      await fallSteer(token);
    } catch (err) { log('pearl launch error:', err.message); rep('E341', err, 'pearlRocket'); } finally {
      busy = null;
      drive({});
      stuntCooldownUntil = now() + 3000;
      trackTech('pearlrocket', hb, 2);
    }
  }

  // ---- 5) Counter-grapple: wind charge at the diver's feet cancels his fall, pearl to his boots, mid-air mace smash ----
  let lastCG = 0;
  async function counterGrapple() {
    const token = gen;
    busy = 'cgrap';
    markStunt('wind');
    lastCG = now();
    const hb = hitsConfirmed;
    try {
      const wind = findByName('wind_charge');
      if (!wind) return;
      ctx.pathStop();
      drive({});
      await hold(wind);
      for (let i = 0; i < 4 && valid(target); i++) { bot.lookAt(target.position.offset(0, 0.1, 0), true); await bot.waitForTicks(1); }
      if (token !== gen || !valid(target)) return;
      bot.activateItem();                                       // wind charge at their feet: breaks the dive
      log('counter-grapple: wind charge at the diver');
      await waitUntil(() => tVel.y > -0.25 || reachTo(target) < 4, 14, token);
      const mace = findWeapon('mace');
      if (pearlItem() && valid(target) && mace) {
        const sol = await throwPearlAt(target.position.clone(), token);
        if (sol) {
          await hold(mace);
          const p0 = bot.entity.position.clone();
          await waitUntil(() => bot.entity.position.distanceTo(p0) > 3, 30, token);
        }
      }
      if (valid(target) && mace && reachTo(target) <= 3.8) {
        if (!swapHit(mace, target)) { await hold(mace); hit(target); }
        noteSmash();
        log('counter-grapple: mid-air counter-smash');
      }
    } catch (err) { log('counter-grapple error:', err.message); rep('E341', err, 'counterGrapple'); } finally {
      busy = null;
      drive({});
      stuntCooldownUntil = now() + 1500;
      trackTech('countergrapple', hb, 3);
    }
  }

  // ---- 8) Spear-mace d-tap: spear in the OFF-hand pops the totem, mace on the same tick kills ----
  let offPrev;                       // name of the item that was in the off-hand (restored afterwards)
  let offtapActive = false;
  let offtapUsed = false;
  async function offtapPrep() {
    if (!tricks.offtap || bot.health < 14 || offtapActive) return false;
    const spear = findWeapon('spear');
    if (!spear || !findWeapon('mace')) return false;
    const off = bot.inventory.slots[45];
    offPrev = off ? off.name : null;
    try { await ctx.withInv(() => bot.equip(spear, 'off-hand')); offtapActive = true; offtapUsed = false; return true; } catch (e) { return false; }
  }
  function offtapUse() {             // hold right-click with the off-hand spear while falling in
    if (!offtapActive || offtapUsed) return;
    offtapUsed = true;
    try { bot.activateItem(true); } catch (e) { /* ignore */ }
  }
  async function offtapRestore() {
    if (!offtapActive) return;
    offtapActive = false;
    try { bot.deactivateItem(); } catch (e) { /* ignore */ }
    const name = offPrev; offPrev = undefined;
    if (!name) return;
    const it = items().find((i) => i.name === name);
    if (it) await ctx.withInv(() => bot.equip(it, 'off-hand')).catch(() => {});
  }

  // ---- 10) Grapple reset: wind at own feet while sprinting, pearl to their feet, sword hit, spear lunge ----
  let lastGR = 0;
  async function grappleReset() {
    const token = gen;
    busy = 'greset';
    markStunt('pearl');
    lastGR = now();
    const hb = hitsConfirmed;
    const e = bot.entity;
    try {
      const wind = findByName('wind_charge');
      if (!wind || !pearlItem()) return;
      ctx.pathStop();
      log('grapple reset: sprint + wind charge at my feet');
      await hold(wind);
      bot.look(yawTo(target), -Math.PI / 4, true);              // 45 degrees down
      drive({ forward: true, sprint: true });
      await bot.waitForTicks(3);
      bot.setControlState('jump', true);
      bot.activateItem();
      await bot.waitForTicks(1);
      bot.setControlState('jump', false);
      await waitUntil(() => !e.onGround, 6, token);
      await bot.waitForTicks(2);
      if (token !== gen || !valid(target)) return;
      const sol = await throwPearlAt(target.position.clone(), token);   // mid-air: pearl at their feet
      if (!sol) { log('grapple reset: no clear pearl path'); return; }
      const p0 = e.position.clone();
      let prev = p0;
      let tele = false;
      for (let i = 0; i < 90 && token === gen && valid(target); i++) {
        await bot.waitForTicks(1);
        if (e.position.distanceTo(prev) > 5) { tele = true; break; }
        prev = e.position.clone();
      }
      if (!tele) return;
      log('grapple reset: teleported next to them');
      const sword = findWeapon('sword') || findWeapon('axe') || findWeapon('mace');
      if (sword) await hold(sword);
      for (let i = 0; i < 15 && token === gen && valid(target); i++) {         // sprint-knockback hit
        face(target);
        drive({ forward: true, sprint: true });
        if (reachTo(target) <= 3.2) { hit(target); break; }
        await bot.waitForTicks(1);
      }
      const spear = findWeapon('spear');
      if (spear && token === gen && valid(target)) {                          // spear before they land: dash + jab
        await hold(spear);
        face(target);
        if (tricks.lungedash) lungeOnce(yawTo(target), clamp(Math.atan2(target.position.y - e.position.y, Math.max(1, hdistTo(target))), -0.6, 0.6));
        await bot.waitForTicks(4);
        if (valid(target) && reachTo(target) <= 4.4) jab(target);
        log('grapple reset: spear follow-up');
      }
    } catch (err) { log('grapple reset error:', err.message); rep('E341', err, 'grappleReset'); } finally {
      busy = null;
      drive({});
      stuntCooldownUntil = now() + 1500;
      trackTech('greset', hb, 3);
    }
  }
  const hdistTo = (ent) => Math.hypot(ent.position.x - bot.entity.position.x, ent.position.z - bot.entity.position.z);

  // ---------- water rescue: swim to the nearest land (or launch out with a wind charge + glide) ----------
  /** Nearest standable land cell within maxR blocks (a solid block with 2 free blocks above it), biased toward `hint`. */
  function findLand(maxR, hint) {
    const e = bot.entity;
    let cells = [];
    try {
      cells = bot.findBlocks({
        matching: (b) => !!b && b.boundingBox === 'block' && !/water|lava|ice|kelp|seagrass|coral|leaves/.test(b.name),
        maxDistance: maxR, count: 120
      });
    } catch (err) { return null; }
    let best = null; let bestScore = Infinity;
    for (const p of cells) {
      const a1 = bot.blockAt(p.offset(0, 1, 0));
      const a2 = bot.blockAt(p.offset(0, 2, 0));
      if (!a1 || !a2 || a1.boundingBox !== 'empty' || a2.boundingBox !== 'empty' || /water|lava/.test(a1.name + a2.name)) continue;
      const d = Math.hypot(p.x + 0.5 - e.position.x, p.z + 0.5 - e.position.z) + Math.abs(p.y - e.position.y) * 0.5;
      const dh = hint ? Math.hypot(p.x - hint.x, p.z - hint.z) : 0;
      const score = d + dh * 0.15;                             // mostly "nearest", slightly "toward where I want to go"
      if (score < bestScore) { bestScore = score; best = p.offset(0, 1, 0); }
    }
    return best;
  }
  async function swimTo(land, maxMs, token) {
    const e = bot.entity;
    const t0 = now();
    let lastD = Infinity; let lastCheck = t0;
    while (token === gen && now() - t0 < maxMs && bot.entity) {
      if (e.onGround && !e.isInWater) return true;
      const c = land.offset(0.5, 0.2, 0.5);
      bot.lookAt(c, true);
      drive({ forward: true, sprint: true, jump: true });        // in water "jump" = swim up / climb out onto the shore
      const d = Math.hypot(c.x - e.position.x, c.z - e.position.z);
      if (now() - lastCheck > 4000) {                            // no progress for 4 s: give up on this spot
        if (lastD - d < 0.6) return false;
        lastD = d; lastCheck = now();
      }
      await bot.waitForTicks(1);
    }
    return !!bot.entity && !bot.entity.isInWater;
  }
  async function waterEscape(hint) {
    if (busy || !bot.entity) return false;
    const token = gen;
    const e = bot.entity;
    busy = 'water';
    let out = false;
    try {
      drive({});
      ctx.pathStop();
      stopCharge();
      log('stuck in water - looking for land');
      for (let attempt = 0; attempt < 3 && !out && token === gen; attempt++) {
        const land = findLand(attempt === 0 ? 32 : 48, hint);
        if (!land) break;
        log(`land found ${Math.round(land.distanceTo(e.position))} blocks away - swimming`);
        out = await swimTo(land, 30000, token);
      }
      // open water: a wind charge launches us out, then we glide (elytraTravel/landSafely take over)
      if (!out && token === gen && findByName('wind_charge') && (findByName('elytra') || ctx.elytra.isWorn()) && countOf('firework_rocket') >= 1) {
        log('open water - wind launch + elytra');
        const yaw = hint ? Math.atan2(-(hint.x - e.position.x), -(hint.z - e.position.z)) : e.yaw;
        if (await windLaunch(token, yaw)) {
          await waitUntil(() => !e.isInWater, 12, token);
          if (!e.isInWater) {
            busy = null;
            if (hint) { await elytraTravel(hint, null); out = true; }
            else { try { await ctx.elytra.wear(); await bot.elytraFly(); } catch (err) { /* landSafely handles the rest */ } out = true; }
          }
        }
      }
      // last resort: swim in one direction (toward the hint) hoping for land
      if (!out && token === gen) {
        const yaw = hint ? Math.atan2(-(hint.x - e.position.x), -(hint.z - e.position.z)) : e.yaw;
        const t0 = now();
        while (token === gen && now() - t0 < 20000 && e.isInWater) {
          bot.look(yaw, 0, true);
          drive({ forward: true, sprint: true, jump: true });
          await bot.waitForTicks(2);
        }
        out = !e.isInWater;
      }
    } catch (err) {
      log('water rescue error:', err.message); rep('E341', err, 'waterEscape');
    } finally {
      if (busy === 'water') busy = null;
      drive({});
    }
    return out;
  }

  // ---------- main decision ----------
  const aggr = () => (ctx.aggression ? ctx.aggression() : 'normal');   // from the brain: all-in | normal | cautious
  function canStunt() {
    return bot.health >= cfg.minHealthForStunts && !ctx.isEating() && now() > stuntCooldownUntil && aggr() !== 'cautious';
  }

  /** What can god style do RIGHT NOW, and what is stopping it? (chat command: godcheck) */
  function readiness() {
    const elytra = !!(findByName('elytra') || ctx.elytra.isWorn());
    const lines = [];
    lines.push(`Gear: elytra ${elytra ? 'yes' : 'NO'} | rockets ${countOf('firework_rocket')} | wind ${countOf('wind_charge')} | pearls ${countOf('ender_pearl')} | totems ${countOf('totem_of_undying')} | mace ${has('mace') ? 'yes' : 'NO'} spear ${has('spear') ? 'yes' : 'NO'} sword ${has('sword') ? 'yes' : 'NO'} axe ${has('axe') ? 'yes' : 'NO'}`);
    lines.push(`Switches: air ${opts.air ? 'ON' : 'OFF'} | wind ${opts.wind ? 'ON' : 'OFF'} | pearl ${opts.pearl ? 'ON' : 'OFF'} | tricks: ${Object.entries(tricks).map(([k, v]) => `${k}:${v ? 'on' : 'off'}`).join(' ')}`);
    const why = [];
    if (!opts.air) why.push('air is OFF (air on)');
    if (!elytra) why.push('no elytra');
    if (countOf('firework_rocket') < 2) why.push('fewer than 2 rockets');
    if (bot.health < cfg.minHealthForStunts) why.push(`health below ${cfg.minHealthForStunts}`);
    if (now() < airBlockedUntil) why.push(`air strikes paused ${Math.ceil((airBlockedUntil - now()) / 1000)}s (2 misses)`);
    if (now() < windBlockedUntil) why.push(`wind jumps paused ${Math.ceil((windBlockedUntil - now()) / 1000)}s (2 misses)`);
    if (flightFails) why.push(`${flightFails} recent take-off failures`);
    if (disabledStunts.size) why.push(`disabled by learning: ${[...disabledStunts].join(',')} (delete learned.json)`);
    if (aggr() === 'cautious') why.push('brain says CAUTIOUS (odds are bad): no stunts');
    const ts = Object.entries(tstat).map(([k, v]) => `${k} ${v.hits}/${v.uses}`).join(' ');
    if (ts) lines.push(`Technique hits/uses: ${ts}`);
    lines.push(`Style ${weaponPref === 'smart' ? 'auto' : weaponPref} | aggression ${aggr()} | blockers: ${why.join('; ') || 'none - ready'}`);
    return lines;
  }

  /**
   * Decision order (first match wins). The big stunts (elytra dive, wind-charge jump, pearls) are OPENERS for
   * players that are far away; they have budgets, cooldowns and a "stop after 2 misses" rule. Everything else
   * is solid close combat with ONE weapon at a time, so fights actually get finished.
   */
  function decide() {
    const e = bot.entity;
    const t = now();
    const dist = e.position.distanceTo(target.position);
    const hdist = Math.hypot(target.position.x - e.position.x, target.position.z - e.position.z);
    const style = curStyle();
    const god = style === 'auto';                       // "god" style = auto: use every trick that fits
    const isPlayer = target.type === 'player';
    const stuntTarget = isPlayer || !!cfg.airstrikeMobs; // never dive-bomb a zombie
    const airMin = Math.max(cfg.airstrikeMinDist, 14);

    if (ctx.isEating()) {
      safeDrive({ back: reachTo(target) < 3, left: strafe === 1, right: strafe === -1 });
      return;
    }

    // 0) low health & no totem: pearl away, then keep distance while healing
    if (opts.pearl && bot.health >= 6.5 && bot.health <= 10 && !hasTotemOffhand() && dist < 7 && pearlItem() &&
        t > escapeCd && t - lastPearl > 1100) {
      pearlEscape();
      return;
    }
    if (t < retreatUntil) {
      ctx.pathStop();
      stopCharge();
      drive({});
      return;
    }

    // S) shield tactics: stun slam (axe, then mace) and backstab
    const blocking = isPlayer && isBlocking(target);
    if (god) {
      if (t < stunnedUntil) {                           // shield just disabled: break through now
        const reach = reachTo(target);
        if (opts.wind && e.onGround && hdist <= 9 && hdist >= 3.5 && has('mace') && findByName('wind_charge') && t > windBlockedUntil) {
          stunnedUntil = 0;
          stuntCooldownUntil = 0;
          windSmash();
          return;
        }
        if (has('mace') && reach <= 3.0 && swapHit(findWeapon('mace'), target)) {
          stunnedUntil = 0;
          log('stun slam: mace follow-up');
          return;
        }
      }
      if (blocking && tricks.stunslam && has('axe') && reachTo(target) <= 3.0 && t - lastStun > 2500) {
        const ax = findWeapon('axe');
        if (swapHit(ax, target)) { lastStun = t; stunnedUntil = t + 1500; log('stun slam: axe on the shield'); return; }
        hold(ax);
      }
      if (blocking && tricks.backstab && manual) {
        if (t >= backstabNext && t >= backstabUntil) backstabUntil = t + 2500;      // start a new attempt
        if (t < backstabUntil) { stopCharge(); ctx.pathStop(); backstabTick(target); return; }
        if (backstabUntil && backstabNext < backstabUntil) backstabNext = backstabUntil + 4000;
      }
    }

    // 6) stun slam A: a falling mace smash into a raised shield disables it
    if (god && blocking && tricks.stunslam && opts.wind && e.onGround && has('mace') && findByName('wind_charge') && canStunt() &&
        t > windBlockedUntil && hdist >= 3 && hdist <= 9 && t - lastWindSmash > 4000 && bot.health >= 12 && skyOpen(11)) {
      log('stun slam: wind-charge mace smash into the shield');
      windSmash();
      return;
    }

    // D) right after a mace smash or a totem pop: keep hitting, no new stunts
    const dtap = t < dtapUntil || t < finishUntil;

    // 5) counter-grapple: somebody is diving at us
    if (god && tricks.countergrapple && isPlayer && !dtap && opts.wind && findByName('wind_charge') && has('mace') && dist < 12 &&
        target.position.y - e.position.y > 3.5 && tVel.y < -0.4 && t - lastCG > 6000 && bot.health >= 8) {
      counterGrapple();
      return;
    }

    // G) grapple: wind charge launches them, pearl pulls us in (off by default: "trick grapple on")
    if (god && tricks.grapple && isPlayer && !dtap && canStunt() && opts.pearl && opts.wind && e.onGround &&
        dist > 7 && dist < 18 && findByName('wind_charge') && pearlItem() && t - lastGrapple > 12000 &&
        t - lastPearl > 1100 && bot.health >= 12) {
      grapple();
      return;
    }

    // 1) elytra airstrike / divebomb: only on a player that is really far away, and not while it keeps missing
    if (!dtap && stuntTarget && canStunt() && opts.air && tricks.dive && dist > airMin && t > airBlockedUntil && !e.isInWater) {
      const kind = airKind();
      if (kind && (findByName('elytra') || ctx.elytra.isWorn()) && countOf('firework_rocket') >= 2 && skyOpen()) {
        airstrike(kind);
        return;
      }
    }
    // 10) grapple reset: wind at my feet + pearl to their feet + sword hit + spear lunge
    if (god && tricks.greset && isPlayer && !dtap && canStunt() && opts.pearl && opts.wind && e.onGround && dist > 8 && dist < 30 &&
        findByName('wind_charge') && pearlItem() && (has('sword') || has('mace')) && bot.health >= 12 && t - lastGR > 14000 &&
        t - lastPearl > 1100 && t > pearlRetryAt) {
      grappleReset();
      return;
    }
    // 4) kinetic wind-pearl launch (no elytra strike possible): pearl up + wind charges, steer the fall
    if (god && tricks.pearlrocket && isPlayer && !dtap && canStunt() && opts.pearl && opts.wind && e.onGround && dist > 25 && dist < 110 &&
        pearlItem() && countOf('wind_charge') >= 3 && has('mace') && bot.health >= 14 && t - lastPRocket > 30000 && t - lastPearl > 1100 &&
        skyOpen(60) && !(opts.air && tricks.dive && (findByName('elytra') || ctx.elytra.isWorn()) && countOf('firework_rocket') >= 2)) {
      pearlRocket();
      return;
    }
    // 2) lunge dash chain: close a mid-range gap with spear dashes (needs the Lunge enchant + food)
    if (god && tricks.lungedash && !dtap && e.onGround && dist > 7 && dist < 26 && findWeapon('spear') && bot.food >= 8 && now() - lastDash > 900 &&
        canStunt() && !(has('mace') && opts.wind && findByName('wind_charge') && dist < 10)) {
      lungeChain();
      return;
    }
    // W) wind-pearl divebomb (off by default: "trick windpearl on")
    if (god && !dtap && stuntTarget && tricks.windpearl && canStunt() && opts.pearl && opts.wind && dist > 12 && dist < cfg.pearlMaxDist &&
        pearlItem() && findByName('wind_charge') && has('mace') && bot.health >= 12 && t - lastWindPearl > 10000 &&
        t - lastPearl > 1100 && t > pearlRetryAt && t > windBlockedUntil) {
      windPearlStrike();
      return;
    }
    // 1b) can't fly: pearl across a long gap
    if (!dtap && isPlayer && canStunt() && opts.pearl && dist > cfg.pearlMinDist && dist < cfg.pearlMaxDist && pearlItem() &&
        bot.health >= 12 && t - lastPearl > 4000 && t > pearlRetryAt) {
      pearlEngage();
      return;
    }
    // 2) wind-charge mace smash: ONLY at mid range (4.5 - 9 blocks), with open sky, at most every 7 s, and not
    //    after two misses. At point-blank range the bot just fights - it used to launch itself over the target.
    if (!dtap && stuntTarget && canStunt() && opts.wind && e.onGround && hdist >= 4.5 && hdist <= 9 && has('mace') &&
        findByName('wind_charge') && (god || style === 'mace') && t > windBlockedUntil && t - lastWindSmash > (aggr() === 'all-in' ? 3500 : 7000) &&
        bot.health >= 12 && !target.isInWater && skyOpen(11)) {
      windSmash();
      return;
    }

    // 3) movement: pathfind when far or without line of sight, manual fighting when close
    if (!hasLOS(target)) losBlockedUntil = t + 1500;
    if (manual && (dist > 8.5 || t < losBlockedUntil)) manual = false;
    else if (!manual && dist < 6 && t >= losBlockedUntil) manual = true;
    if (!manual) {
      stopCharge();
      ctx.pathFollow(target);
      const w = chooseMeleeType();
      if (w) hold(findWeapon(w));
      return;
    }
    ctx.pathStop();

    // falling onto them (after a jump, Wind Burst, a drop...): attribute swap + smash, no cooldown needed
    if (has('mace') && !e.onGround && e.velocity.y < -0.1 && fallen() >= 1.8 && !e.elytraFlying && (god || style === 'mace')) {
      const reach = reachTo(target);
      const mace = findWeapon('mace');
      const ai = tricks.attrswap ? attrItem() : null;
      hold(ai && reach > 3.4 ? ai : mace);
      face(target);
      drive({ forward: true, sprint: true });
      if (reach <= 3.0 && t - lastAttack > 250) {
        if (!(ai && swapHit(mace, target))) { hold(mace); hit(target); }
        noteSmash();
        log('smash! (aerial, fell', fallen().toFixed(1), 'blocks)');
      }
      return;
    }

    // spear opener (god mode): charge in from 5-12 blocks for at most 2.5 s, then the normal weapon takes over
    if (dist <= 5 || dist >= 12) openerUntil = 0;
    if (god && has('spear') && (has('sword') || has('axe')) && !lungeSwapReady() && dist > 5 && dist < 12 && t > openerCd) {
      if (!openerUntil) openerUntil = t + 2500;
      if (t < openerUntil) {
        hold(findWeapon('spear'));
        face(target);
        startCharge();
        drive({ forward: true, sprint: true });
        return;
      }
      openerUntil = 0;
      openerCd = t + 6000;
      stopCharge();
    }
    if (charging && !(bot.heldItem && weaponType(bot.heldItem) === 'spear')) stopCharge();

    if (god && tricks.lungeswap && !blocking) {
      const n = neutralItem();
      if (n && swapFightTick(n)) { face(target); return; }
    }
    const type = chooseMeleeType();
    const item = type ? findWeapon(type) : null;
    const swapSpear = type === 'spear' && item && lungeSwapReady() && hotbarSlot(item) !== null;
    if (swapSpear) {
      // lunge swapping (opt-in trick): a no-cooldown item stays in hand between jabs
      const n = neutralItem();
      if (n && bot.heldItem && bot.heldItem.name !== n.name && bot.heldItem.name !== item.name) bot.setQuickBarSlot(hotbarSlot(n));
    } else if (item) hold(item);
    else if (!type) bot.setQuickBarSlot(bot.quickBarSlot);
    face(target);

    if (type === 'spear' && item) {
      spearTick(item);
      return;
    }
    if (charging) stopCharge();
    meleeTick(type, dist);
  }

  bot.on('physicsTick', () => {
    const e = bot.entity;
    if (!e) return;
    try {
      trackFall();
      checkDash();
      maybeClutch();
      // Anti-fly protection: hanging in mid-air without falling for ~2.5 s gets us kicked by the server.
      const vy = e.velocity.y;
      if (!e.onGround && !e.isInWater && !e.isInLava && !e.elytraFlying && Math.abs(vy) < 0.02) hoverTicks++;
      else hoverTicks = 0;
      if (hoverTicks > 50) {
        hoverTicks = 0;
        log('hovering in mid-air detected - aborting the stunt to avoid the anti-fly kick');
        gen++;
        busy = null;
        stopCharge();
        drive({});
        stuntCooldownUntil = now() + 8000;
        ctx.elytra.putChestplate().catch(() => {});
      }
      // gliding with nothing steering us: land safely instead of flying on at full speed
      if (e.elytraFlying && !busy && !landing && !clutching) { landSafely(); return; }
      if (!target) return;
      if (!valid(target)) { target = null; return; }
      trackTarget();
      if (busy || landing) return;
      decide();
    } catch (err) {
      rep('E700', err);
      const tn = now();
      tickErrors.push(tn);
      tickErrors = tickErrors.filter((x) => tn - x < 10000);
      if (tickErrors.length >= 6) {                       // the fight logic keeps failing: stop fighting instead of spamming errors
        tickErrors = [];
        rep('E701');
        try { disengage(); } catch (e2) { /* ignore */ }
        if (ctx.say) ctx.say('My fight logic hit repeated errors (E700), so I stopped the fight. Check crash.log.');
      }
    }
  });

  // optional debug output (config: "debugCombat": true)
  if (cfg.debugCombat) {
    const dbg = setInterval(() => {
      if (!bot.entity || !target) return;
      const d = bot.entity.position.distanceTo(target.position);
      log(`target=${target.username || target.name} dist=${d.toFixed(1)} hp=${Math.round(bot.health)} held=${bot.heldItem ? bot.heldItem.name : '-'} ` +
        `hits=${hits} busy=${busy || '-'} manual=${manual} charging=${charging} elytra=${!!bot.entity.elytraFlying} ground=${bot.entity.onGround}`);
    }, 1000);
    bot.once('end', () => clearInterval(dbg));
  }

  // ---------- public API ----------
  function engage(ent) {
    if (!ent) return;
    if (!target || target.id !== ent.id) {
      target = ent;
      tPos = null;
      tVel = new Vec3(0, 0, 0);
      manual = false;
      lockedType = null;
    }
  }
  function disengage() {
    if (!target && !busy && !charging) return;   // nothing to cancel (keeps pathfinder controls untouched)
    gen++;
    target = null;
    busy = null;
    stopCharge();
    drive({});
  }
  /**
   * Soft version of disengage(): forget the fight target but let a running flight / stunt finish on its own
   * (it notices the target is gone and lands). disengage() hard-aborts everything. The hunt code calls this
   * every tick; calling disengage() there used to cancel the elytra flight 6 times a second.
   */
  function release() {
    if (!target) return;
    target = null;
    tPos = null;
    manual = false;
    if (!busy && !landing) { stopCharge(); drive({}); }
  }
  function setWeapon(w) {
    // user-facing: "auto" = the bot decides (smart), "god" = every trick (internal 'auto')
    if (w === 'god') w = 'auto';
    else if (w === 'auto' || w === 'smart') w = 'smart';
    weaponPref = w;
    lockedType = null;
    smartIdx = 0;
    return w === 'auto' || w === 'smart' ? true : has(w);
  }
  function loadout() {
    const parts = ['mace', 'spear', 'sword', 'axe'].filter(has);
    return `${parts.join('/') || 'no weapons'} | wind x${countOf('wind_charge')} | pearls x${countOf('ender_pearl')} | rockets x${countOf('firework_rocket')} | elytra ${findByName('elytra') || ctx.elytra.isWorn() ? 'yes' : 'no'} | totems x${countOf('totem_of_undying')}`;
  }
  function status() {
    return `Style: ${weaponPref === 'auto' ? 'GOD (all tricks)' : weaponPref === 'smart' ? `AUTO (bot decides, now: ${smartCandidates()[smartIdx % smartCandidates().length] === 'auto' ? 'god' : smartCandidates()[smartIdx % smartCandidates().length]})` : weaponPref} | tricks: ${Object.entries(tricks).map(([k, v]) => `${k}:${v ? 'on' : 'off'}`).join(' ')} | air strikes: ${opts.air ? 'on' : 'off'} | wind smash: ${opts.wind ? 'on' : 'off'} | pearls: ${opts.pearl ? 'on' : 'off'} | ${loadout()}`;
  }
  /** Called when the server kicks us. If a risky stunt was running right before, turn it off. */
  function noteKick(reasonText = '') {
    const msgs = [];
    // the old elytra packet bug (fixed in compat.js): it must NOT permanently turn elytra / stunts off
    if (/player_command|DecoderException/i.test(reasonText)) return 'Kick was caused by an invalid elytra packet (now fixed in compat.js) - stunts stay ON.';
    // kicks that have nothing to do with what the bot was doing (spam / lag / idle / restart / ban ...)
    if (/spam|time[ds]? ?out|idle|afk|inactiv|restart|stopp?ing|shutdown|banned|whitelist|server is full|maintenance|another location|duplicate|logged in/i.test(reasonText)) {
      return /spam/i.test(reasonText) ? 'Kicked for chat spam - the bot now sends messages slower (stunts stay ON).' : '';
    }
    if (lastStabAt && now() - lastStabAt < 4000 && !stabDisabled) {
      stabDisabled = true;
      saveLearned();
      msgs.push('Kicked right after a spear stab packet - disabling stab (spear jabs now use the normal attack).');
    }
    const recent = lastStunt.kind && now() - lastStunt.at < (/fly/i.test(reasonText) ? 60000 : 12000);
    if (recent && !disabledStunts.has(lastStunt.kind)) {
      disabledStunts.add(lastStunt.kind);
      opts[lastStunt.kind] = false;
      saveLearned();
      const nice = { air: 'elytra strikes', wind: 'wind-charge jumps', pearl: 'ender pearls' }[lastStunt.kind] || lastStunt.kind;
      msgs.push(`Kicked right after using ${nice} (${reasonText || 'no reason given'}) - I turned them OFF for safety. (Type "${lastStunt.kind === 'air' ? 'air' : lastStunt.kind} on" to re-enable.)`);
    }
    return msgs.join(' ');
  }

  /** Escape helper: wind-charge launch while heading out in direction `dirVec` (x/z). */
  async function windLaunchOut(dirVec) {
    if (busy) return false;
    const token = gen;
    busy = 'wind';
    markStunt('wind');
    try {
      const yaw = Math.atan2(-dirVec.x, -dirVec.z);
      drive({ forward: true, sprint: true });
      if (!(await windLaunch(token, yaw))) return false;
      for (let i = 0; i < 60 && token === gen; i++) {
        drive({ forward: true, sprint: true });
        bot.look(yaw, 0, true);
        await bot.waitForTicks(1);
      }
      return true;
    } catch (err) {
      log('windLaunchOut error:', err.message);
      return false;
    } finally {
      busy = null;
      drive({});
    }
  }

  /** Escape helper: lob an ender pearl 14-30 blocks away in direction `dirVec` (over walls). */
  async function pearlOut(dirVec) {
    if (busy || !pearlItem()) return false;
    const token = gen;
    busy = 'pearl';
    markStunt('pearl');
    try {
      const e = bot.entity;
      for (const d of [28, 22, 16, 30, 12]) {
        const spot = e.position.plus(new Vec3(dirVec.x, 0, dirVec.z).scaled(d));
        const sol = await throwPearlAt(spot, token);
        if (sol) { log(`escape pearl thrown (${d} blocks)`); return true; }
      }
      return false;
    } catch (err) {
      return false;
    } finally {
      busy = null;
    }
  }

  /** Cross a long distance: elytra flight if possible, else a pearl toward the point. Returns the method used or null. */
  async function travel(pos, shouldAbort) {
    const e = bot.entity;
    const d = Math.hypot(pos.x - e.position.x, pos.z - e.position.z);
    if (busy || ctx.isEating()) return null;
    if (d > 70 && opts.air && (findByName('elytra') || ctx.elytra.isWorn()) && countOf('firework_rocket') >= 3 && skyOpen()) {
      return (await elytraTravel(pos, shouldAbort)) ? 'elytra' : null;
    }
    if (d > 45 && opts.pearl && pearlItem() && now() - lastPearl > 4000 && bot.health >= 12) {
      const k = Math.min(d, 44) / d;
      const spot = new Vec3(e.position.x + (pos.x - e.position.x) * k, e.position.y, e.position.z + (pos.z - e.position.z) * k);
      busy = 'pearl';
      markStunt('pearl');
      try {
        const sol = await throwPearlAt(spot, gen);
        if (sol) { log(`pearl toward hunted player (${Math.round(d)} blocks)`); return 'pearl'; }
      } finally { busy = null; }
    }
    return null;
  }

  return {
    engage,
    disengage,
    release,
    setWeapon,
    status,
    loadout,
    noteKick,
    travel,
    pearlItem,
    windLaunchOut,
    waterEscape,
    lungeEscape,
    techStats: () => tstat,
    pearlOut,
    setAir: (v) => { opts.air = !!v; if (v) { disabledStunts.delete('air'); saveLearned(); } },
    setWind: (v) => { opts.wind = !!v; if (v) { disabledStunts.delete('wind'); saveLearned(); } },
    setPearl: (v) => { opts.pearl = !!v; if (v) { disabledStunts.delete('pearl'); saveLearned(); } },
    tricks,
    setTrick: (name, v) => { if (!(name in tricks)) return false; tricks[name] = !!v; return true; },
    popLearnedNotice: () => { const n = learnedNotice; learnedNotice = ''; return n; },
    isBusy: () => !!busy || landing,
    hasTarget: () => !!target,
    getTarget: () => target,
    readiness,
    targetDistance: () => (target && bot.entity ? bot.entity.position.distanceTo(target.position) : Infinity),
    getWeapon: () => (weaponPref === 'auto' ? 'god' : weaponPref === 'smart' ? 'auto' : weaponPref),
    options: opts
  };
}

module.exports = createCombat;
module.exports.solvePearl = solvePearl;
module.exports.simulatePearl = simulatePearl;
