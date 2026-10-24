'use strict';
/**
 * Escape system: gets the bot out when it is packed in / covered with blocks, or stuck.
 *
 * DETECTION (every second): a flood-fill over the cells the bot can reach by walking, jumping up one
 * block or dropping down. If it cannot get away from its spot (small closed region) it is "enclosed":
 * walled in, covered with blocks, in a deep pit, or in a cobweb. A one-block fall or a normal tree
 * is NOT a trap.
 *
 * WHEN ENCLOSED the bot says so in chat (with coordinates) and then:
 *   1. jumps out (walls of 1 block)
 *   2. digs through the thinnest wall with the best tool
 *   3. digs up and builds a block pillar (pit / covered with blocks)
 *   4. wind charge launch / ender pearl over the walls
 *   5. (needs OP) /fill to clear the blocks, then /tp to the owner
 *
 * WHEN MERELY STUCK on terrain (wants to move but doesn't) it just jumps / turns quietly.
 */
const { Vec3 } = require('vec3');

const PLACEABLE = ['cobblestone', 'dirt', 'netherrack', 'stone', 'cobbled_deepslate', 'andesite', 'diorite', 'granite', 'deepslate', 'tuff', 'blackstone'];
const PLANK_RE = /_(planks|log|wood)$/;
const PASS_RE = /(_door|_fence_gate|_trapdoor|^ladder$|^vine|^scaffolding$|_sign$|_banner$|torch|_carpet$|^snow$|_button$|_pressure_plate$|^rail|_rail$|^lever$|^tripwire|^string$|^cobweb_none$)/;
const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]];

function createEscape(bot, ctx) {
  const { goals, Movements } = ctx.pf;
  const cfg = ctx.cfg;
  const samples = [];            // { t, pos }
  let escaping = false;
  let lastTry = 0;
  let trappedSince = 0;
  let lastSoft = 0;
  let firstStuckAt = 0;
  let lastAnnounce = 0;
  let attempts = 0;
  let lastEnd = 0;
  let unknownSeen = false;

  const now = () => Date.now();
  const log = (...a) => console.log('🧗', ...a);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const ticks = (n) => bot.waitForTicks(n);

  // ---------- world helpers ----------
  const blockAt = (v) => bot.blockAt(v);
  const isSolidBlock = (b) => !!b && (b.name === 'cobweb' || (b.boundingBox === 'block' && !PASS_RE.test(b.name)));
  function cellSolid(x, y, z) {
    const b = bot.blockAt(new Vec3(x, y, z));
    if (!b) { unknownSeen = true; return false; }
    return isSolidBlock(b);
  }
  const isLava = (b) => !!b && /lava|magma/.test(b.name);
  const nextToLava = (b) => {
    const p = b.position;
    return [[0, 1, 0], [0, -1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1]].some(([dx, dy, dz]) => isLava(blockAt(p.offset(dx, dy, dz))));
  };
  const diggable = (b) => !!b && b.diggable !== false && b.hardness !== null && b.hardness >= 0 && !isLava(b) && !nextToLava(b);

  /**
   * Flood-fill from the bot's cell. Returns { enclosed, cells, reason }.
   * Reachable = walk on, step up 1 block, drop down up to 4. Leaving the area (6+ blocks away),
   * a cliff, a big region or an unloaded chunk all count as "not enclosed".
   */
  function analyze() {
    const e = bot.entity;
    if (!e) return { enclosed: false, cells: 0 };
    const sx = Math.floor(e.position.x);
    const sy = Math.floor(e.position.y + 0.01);
    const sz = Math.floor(e.position.z);
    unknownSeen = false;
    const here = bot.blockAt(new Vec3(sx, sy, sz));
    if (here && here.name === 'cobweb') return { enclosed: true, cells: 1, reason: 'cobweb' };
    const pass = (x, y, z) => !cellSolid(x, y, z) && !cellSolid(x, y + 1, z);
    const floor = (x, y, z) => cellSolid(x, y - 1, z);
    const seen = new Set([`${sx},${sy},${sz}`]);
    const queue = [[sx, sy, sz]];
    let exit = false;
    while (queue.length && !exit) {
      const [x, y, z] = queue.shift();
      if (seen.size > 250 || Math.abs(x - sx) > 6 || Math.abs(z - sz) > 6) { exit = true; break; }
      for (const [dx, dz] of DIRS) {
        const nx = x + dx;
        const nz = z + dz;
        let ny = null;
        if (pass(nx, y, nz)) {
          ny = y;
          if (!floor(nx, y, nz)) {                    // nothing to stand on: drop down (up to 4)
            let landed = false;
            for (let d = 1; d <= 4; d++) {
              if (!pass(nx, y - d, nz)) break;
              if (floor(nx, y - d, nz)) { ny = y - d; landed = true; break; }
            }
            if (!landed) { exit = true; break; }       // cliff / void / deep drop = a way out
          }
        } else if (cellSolid(nx, y, nz) && !cellSolid(x, y + 2, z) && pass(nx, y + 1, nz)) {
          ny = y + 1;                                  // 1-block step up
        }
        if (ny === null) continue;
        const k = `${nx},${ny},${nz}`;
        if (seen.has(k)) continue;
        seen.add(k);
        queue.push([nx, ny, nz]);
      }
      if (unknownSeen) exit = true;                    // unloaded chunk: can't be sure, assume free
    }
    return { enclosed: !exit, cells: seen.size };
  }
  const isTrapped = () => analyze().enclosed;

  // ---------- tools / items ----------
  const hasBlocks = () => bot.inventory.items().some((i) => PLACEABLE.includes(i.name) || PLANK_RE.test(i.name));
  const findPlaceable = () => bot.inventory.items().find((i) => PLACEABLE.includes(i.name)) ||
    bot.inventory.items().find((i) => PLANK_RE.test(i.name));

  /** Pick the inventory item that breaks this block fastest (or bare hand). */
  function bestToolFor(block) {
    const creative = bot.game && bot.game.gameMode === 'creative';
    let best = null;
    let bestTime = block.digTime(null, creative, false, false);
    for (const it of bot.inventory.items()) {
      const t = block.digTime(it.type, creative, false, false);
      if (t < bestTime) { best = it; bestTime = t; }
    }
    return { tool: best, time: bestTime };
  }

  async function withTimeout(promise, ms) {
    let timer;
    const timeout = new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('timeout')), ms); });
    try { return await Promise.race([promise, timeout]); } finally { clearTimeout(timer); }
  }

  let digFailReason = '';
  async function digBlock(b) {
    if (!b || !isSolidBlock(b)) return true;
    if (!diggable(b)) { digFailReason = `${b.name} cannot be broken (or lava next to it)`; return false; }
    const { tool, time } = bestToolFor(b);
    if (time > 25000) { digFailReason = `${b.name} would take too long to break`; return false; }
    try {
      if (tool) await ctx.withInv(() => bot.equip(tool, 'hand'));
      else if (bot.heldItem) await ctx.withInv(() => bot.unequip('hand'));
    } catch (e) { /* keep going with whatever is in hand */ }
    if (!bot.canDigBlock(b)) { digFailReason = `cannot reach / break ${b.name}`; return false; }
    try {
      await withTimeout(bot.dig(b, true), (isFinite(time) ? time : 10000) + 5000);
      return true;
    } catch (e) {
      digFailReason = `digging ${b.name} failed: ${e.message}`;
      return false;
    }
  }

  // ---------- movement helpers ----------
  const CTL = ['forward', 'back', 'left', 'right', 'jump', 'sprint', 'sneak'];
  const setCtl = (c = {}) => CTL.forEach((k) => bot.setControlState(k, !!c[k]));
  const stopCtl = () => setCtl({});
  const solidAt = (v) => isSolidBlock(blockAt(v));

  function blockedAhead() {
    const e = bot.entity;
    const dx = -Math.sin(e.yaw);
    const dz = -Math.cos(e.yaw);
    const feet = e.position.floored();
    const ahead = e.position.offset(dx * 0.9, 0, dz * 0.9).floored();
    return solidAt(ahead) && !solidAt(ahead.offset(0, 1, 0)) && !solidAt(ahead.offset(0, 2, 0)) && !solidAt(feet.offset(0, 2, 0));
  }

  async function walkTo(target, maxTicks = 40) {
    for (let i = 0; i < maxTicks; i++) {
      const p = bot.entity.position;
      const dx = target.x - p.x;
      const dz = target.z - p.z;
      if (Math.hypot(dx, dz) < 0.3) break;
      bot.look(Math.atan2(-dx, -dz), 0, true);
      setCtl({ forward: true, jump: bot.entity.onGround && blockedAhead() });
      await ticks(1);
    }
    stopCtl();
  }

  /** Walk-and-jump in a compass direction for a moment. */
  async function hop(yaw, n = 18) {
    bot.look(yaw, 0, true);
    for (let i = 0; i < n; i++) {
      setCtl({ forward: true, jump: true, sprint: true });
      await ticks(1);
    }
    stopCtl();
  }

  // ---------- escape steps ----------
  /** 1. Walls of 1 block (or a gap): jump out. */
  async function jumpOut() {
    const origin = bot.entity.position.clone();
    const yaws = [];
    for (let i = 0; i < 8; i++) yaws.push((i / 8) * Math.PI * 2);
    for (const yaw of yaws) {
      await hop(yaw);
      if (!analyze().enclosed || bot.entity.position.distanceTo(origin) > 3) return true;
    }
    return false;
  }

  /** How thick is the wall in this direction (blocks to dig), or Infinity if blocked by something unbreakable. */
  function wallThickness(dir) {
    const feet = bot.entity.position.floored();
    let thick = 0;
    for (let k = 1; k <= 6; k++) {
      const c = feet.offset(dir[0] * k, 0, dir[1] * k);
      const f = blockAt(c);
      const h = blockAt(c.offset(0, 1, 0));
      const sf = isSolidBlock(f);
      const sh = isSolidBlock(h);
      if (!sf && !sh) return thick;
      if ((sf && !diggable(f)) || (sh && !diggable(h))) return Infinity;
      thick += (sf ? 1 : 0) + (sh ? 1 : 0);
    }
    return Infinity;
  }

  /** 2. Dig a tunnel through the thinnest wall. */
  async function digOut() {
    const options = DIRS.map((d) => ({ d, t: wallThickness(d) })).filter((o) => isFinite(o.t)).sort((a, b) => a.t - b.t);
    for (const { d } of options) {
      const feet0 = bot.entity.position.floored();
      let ok = true;
      for (let k = 1; k <= 6 && ok; k++) {
        const base = bot.entity.position.floored();
        const cellFeet = feet0.offset(d[0] * k, 0, d[1] * k);
        for (const c of [cellFeet.offset(0, 1, 0), cellFeet]) {          // head level first, then feet
          for (let tries = 0; tries < 3 && isSolidBlock(blockAt(c)); tries++) {
            if (!(await digBlock(blockAt(c)))) { ok = false; break; }
            await ticks(2);
          }
          if (!ok) break;
        }
        if (!ok) break;
        await walkTo(new Vec3(cellFeet.x + 0.5, cellFeet.y, cellFeet.z + 0.5), 50);
        if (!analyze().enclosed) return true;
        if (bot.entity.position.distanceTo(base) < 0.2) { ok = false; }
      }
    }
    return false;
  }

  /** Collect a few blocks by breaking wall blocks around us (they drop at our feet). */
  async function gatherBlocks() {
    const feet = bot.entity.position.floored();
    for (const [dx, dz] of DIRS) {
      const b = blockAt(feet.offset(dx, 0, dz));
      if (isSolidBlock(b) && diggable(b) && (await digBlock(b))) { await sleep(700); return true; }
    }
    return false;
  }

  /** 3. Open the ceiling and build a block pillar upward until we are free. */
  async function digUpAndPillar() {
    let fails = 0;
    for (let i = 0; i < 16; i++) {
      if (!analyze().enclosed) return true;
      const feet = bot.entity.position.floored();
      const above = blockAt(feet.offset(0, 2, 0));
      if (isSolidBlock(above) && !(await digBlock(above))) return false;
      let item = findPlaceable();
      if (!item) { await gatherBlocks(); item = findPlaceable(); }
      if (!item) { digFailReason = 'no blocks to build with'; return false; }
      try { await ctx.withInv(() => bot.equip(item, 'hand')); } catch (e) { /* ignore */ }
      const base = blockAt(feet.offset(0, -1, 0));
      if (!base || !isSolidBlock(base)) { fails++; if (fails > 3) return false; await ticks(5); continue; }
      const startY = bot.entity.position.y;
      bot.look(bot.entity.yaw, -Math.PI / 2, true);
      bot.setControlState('jump', true);
      let sent = false;
      for (let t = 0; t < 16; t++) {
        await ticks(1);
        if (!sent && bot.entity.position.y >= startY + 1.0) {
          sent = true;
          // fire and forget: some servers confirm slowly, we verify by looking at the world instead
          bot.placeBlock(base, new Vec3(0, 1, 0)).catch(() => {});
        }
        if (sent && t > 3) break;
      }
      bot.setControlState('jump', false);
      for (let t = 0; t < 12 && !bot.entity.onGround; t++) await ticks(1);   // land on the new block
      await ticks(3);
      const rose = bot.entity.position.y - startY;
      log(`pillar step ${i + 1}: rose ${rose.toFixed(1)} block(s)`);
      if (rose < 0.6) { fails++; if (fails > 4) return false; }
    }
    return !analyze().enclosed;
  }

  // ---------- notifications ----------
  function announce(text, force = false) {
    if (!force && now() - lastAnnounce < 15000) return;
    lastAnnounce = now();
    ctx.say(text);
    if (ctx.whisperOwner) ctx.whisperOwner(text);
  }
  const where = () => {
    const p = bot.entity.position;
    return `${Math.floor(p.x)} ${Math.floor(p.y)} ${Math.floor(p.z)}`;
  };

  // ---------- main escape ----------
  async function escape(reason) {
    if (escaping || !bot.entity) return;
    escaping = true;
    lastTry = now();
    if (now() - lastEnd > 120000) attempts = 0;
    attempts++;
    const origin = bot.entity.position.clone();
    try {
      ctx.abortCombat();
      stopCtl();                                       // clears the AFK sneak, which blocks jumping / dropping
      const info = analyze();
      if (!info.enclosed) {
        if (reason === 'manual request') ctx.say("I'm not trapped - I have room to move. Giving myself a nudge.");
        await softUnstick();
        return;
      }
      announce(`I'm trapped! Packed in / covered with blocks at ${where()}. Breaking out now.`, true);
      log(`enclosed (${info.cells} cells${info.reason ? ', ' + info.reason : ''}), trying to get out`);
      const freed = () => !analyze().enclosed;
      const openAbove = !isSolidBlock(blockAt(bot.entity.position.floored().offset(0, 2, 0))) &&
                        !isSolidBlock(blockAt(bot.entity.position.floored().offset(0, 3, 0)));

      // 1. jump out
      if (await jumpOut()) { announce("I'm out!", true); return; }
      // 2/3. pit with open top -> pillar first; covered -> dig sideways first
      const steps = openAbove ? [digUpAndPillar, digOut] : [digOut, digUpAndPillar];
      for (const step of steps) {
        if (!hasBlocks() && step === digUpAndPillar) { /* gatherBlocks inside will try */ }
        if (await step()) { announce("I'm out!", true); return; }
        if (freed()) { announce("I'm out!", true); return; }
      }
      if (digFailReason) log('dig problem:', digFailReason);
      // 4. wind charge / pearl
      if (attempts >= 2 || info.cells <= 2) {
        if (bot.inventory.items().some((i) => i.name === 'wind_charge')) {
          await ctx.windLaunchOut(new Vec3(1, 0, 0));
          await sleep(2500);
          if (freed()) { announce("I'm out!", true); return; }
        }
        if (ctx.pearlOut && (await ctx.pearlOut(new Vec3(1, 0, 0)))) {
          await sleep(3000);
          if (freed()) { announce("I'm out!", true); return; }
        }
      }
      // 5. OP commands
      if (cfg.escapeUseCommands !== false && ctx.opClear) {
        log('last resort: clearing the blocks with /fill');
        if (await ctx.opClear()) {
          await sleep(1200);
          if (freed()) { announce("I'm out!", true); return; }
        }
      }
      if (cfg.escapeTpToOwner && ctx.tpToOwner && now() - (firstStuckAt || now()) > 30000) {
        log('last resort: teleporting to the owner');
        await ctx.tpToOwner();
        await sleep(1500);
        if (freed()) return;
      }
      announce(`I can't get out at ${where()}${digFailReason ? ` (${digFailReason})` : ''}. Please break the blocks around me, op me, or /tp me.`);
    } catch (err) {
      log('escape error:', err.message);
    } finally {
      stopCtl();
      try { bot.pathfinder.setGoal(null); } catch (e) { /* ignore */ }
      ctx.restoreMovements();                          // safe movements + AFK sneak again
      escaping = false;
      lastEnd = now();
      void origin;
    }
  }

  /** Not enclosed, just not getting anywhere: jump and turn a bit (no chat). */
  async function softUnstick() {
    const origin = bot.entity.position.clone();
    for (let i = 0; i < 3; i++) {
      await hop(bot.entity.yaw + (Math.random() - 0.5) * 3, 16);
      if (bot.entity.position.distanceTo(origin) > 2) break;
    }
    if (ctx.resetGoal) ctx.resetGoal();
  }

  /** Called every second. `intent` = what the bot is trying to do ('none' | 'moving' | 'wander'). */
  function tick(intent) {
    const e = bot.entity;
    if (!e || escaping) return;
    samples.push({ t: now(), pos: e.position.clone() });
    while (samples.length && now() - samples[0].t > 60000) samples.shift();
    if (now() - lastTry < 8000) { trappedSince = 0; return; }
    if (!(e.onGround || e.isInWater)) { trappedSince = 0; return; }   // mid-air is not "trapped"

    const info = analyze();
    if (info.enclosed) {
      if (!trappedSince) trappedSince = now();
      if (!firstStuckAt) firstStuckAt = now();
      if (now() - trappedSince > 3000) { trappedSince = 0; escape('trapped').catch(() => {}); }
      return;
    }
    trappedSince = 0;
    firstStuckAt = 0;

    // not enclosed: a quiet nudge if it wants to move but does not
    if (intent === 'moving' && now() - lastSoft > 10000) {
      const t = now() - 8000;
      const old = samples.find((s) => s.t >= t);
      if (old && samples.length > 8 && old.pos.distanceTo(e.position) < 1.0) {
        lastSoft = now();
        escape('terrain').catch(() => {});
      }
    }
  }

  return { tick, escape, analyze, isTrapped, isEscaping: () => escaping, _digOut: digOut, _pillar: digUpAndPillar, _jumpOut: jumpOut };
}

module.exports = createEscape;
