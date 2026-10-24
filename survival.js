'use strict';
// Survival helpers that run in the background:
//  - step assist: auto-jump when walking into a 1-block step / fence-less ledge, open doors & gates in the way
//  - pit escape: standing in a deep 1x1 hole -> pillar up with blocks (or let escape.js dig)
//  - auto sleep: at night find a bed (or place one from the inventory) and sleep; wake up in the morning
const { Vec3 } = require('vec3');

function createSurvival(bot, ctx) {
  const cfg = ctx.cfg;
  const log = (...a) => console.log('🛏️', ...a);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const now = () => Date.now();
  const sv = () => ({ stepAssist: true, autoSleep: true, openDoors: true, ...(cfg.survival || {}) });

  const solid = (b) => !!b && b.boundingBox === 'block';
  const isDoor = (b) => !!b && /(^|_)(door|fence_gate|trapdoor)$/.test(b.name) && !/iron/.test(b.name);
  const isOpen = (b) => { try { const p = b.getProperties(); return p && p.open === true; } catch (e) { return false; } };

  // ---------- step assist ----------
  let blockedTicks = 0;
  let lastDoor = 0;
  function stepTick() {
    const e = bot.entity;
    if (!e || !sv().stepAssist || bot.isSleeping || bot.targetDigBlock || e.elytraFlying) return;
    if (!bot.getControlState('forward') && !bot.getControlState('back')) { blockedTicks = 0; return; }
    if (!e.onGround) return;
    if (Math.hypot(e.velocity.x, e.velocity.z) > 0.03) { blockedTicks = 0; return; }
    if (++blockedTicks < 5) return;                       // ~0.25 s of pushing against something
    const dir = bot.getControlState('back') ? -1 : 1;
    const ax = e.position.x + dir * -Math.sin(e.yaw) * 0.9;
    const az = e.position.z + dir * -Math.cos(e.yaw) * 0.9;
    const cell = new Vec3(Math.floor(ax), Math.floor(e.position.y + 0.1), Math.floor(az));
    const b0 = bot.blockAt(cell);
    const b1 = bot.blockAt(cell.offset(0, 1, 0));
    const b2 = bot.blockAt(cell.offset(0, 2, 0));
    // closed door / gate in the way: open it (they are not solid-looking for the pathfinder on some servers)
    for (const d of [b0, b1]) {
      if (sv().openDoors && isDoor(d) && !isOpen(d) && now() - lastDoor > 1200) {
        lastDoor = now();
        bot.activateBlock(d).catch(() => {});
        blockedTicks = 0;
        return;
      }
    }
    if (solid(b0) && !solid(b1) && !solid(b2)) {           // 1 block high step: jump
      bot.setControlState('jump', true);
      setTimeout(() => { try { bot.setControlState('jump', false); } catch (e2) { /* ended */ } }, 140);
      blockedTicks = 0;
    } else if (blockedTicks > 40) blockedTicks = 0;
  }

  // ---------- pit escape ----------
  let pitSince = 0;
  let pitBusy = false;
  function wallHeight(dx, dz) {
    const p = bot.entity.position.floored();
    let h = 0;
    for (let y = 0; y < 5; y++) { if (solid(bot.blockAt(p.offset(dx, y, dz)))) h++; else break; }
    return h;
  }
  async function pitTick() {
    const e = bot.entity;
    if (!e || !e.onGround || pitBusy || bot.isSleeping || ctx.combat.isBusy()) { pitSince = 0; return; }
    if (Math.hypot(e.velocity.x, e.velocity.z) > 0.03) { pitSince = 0; return; }
    const h = Math.min(wallHeight(1, 0), wallHeight(-1, 0), wallHeight(0, 1), wallHeight(0, -1));
    if (h < 2) { pitSince = 0; return; }                    // a 1-high wall can be jumped
    if (!pitSince) pitSince = now();
    if (now() - pitSince < 2500) return;
    pitBusy = true;
    pitSince = 0;
    try {
      log(`stuck in a ${h}-deep hole - climbing out`);
      if (ctx.builder && ctx.builder.blockCount() >= h + 1) await ctx.builder.tower(h + 1);
      else if (ctx.escape) await ctx.escape('trapped');
    } catch (err) { ctx.report && ctx.report('E110', err, 'pit escape'); } finally { pitBusy = false; }
  }

  // ---------- sleeping ----------
  const bedIds = () => bot.registry.blocksArray.filter((b) => /_bed$/.test(b.name)).map((b) => b.id);
  const isNight = () => {
    const t = bot.time && bot.time.timeOfDay;
    if (typeof t !== 'number') return false;
    return (t >= 12542 && t <= 23459) || (bot.thunderState > 0.5);
  };
  let sleepBusy = false;
  let nextSleepTry = 0;
  let saidNoBed = false;
  const dimOk = () => !/nether|end/.test(String((bot.game && bot.game.dimension) || ''));

  async function placeBedFromInventory() {
    const item = bot.inventory.items().find((i) => /_bed$/.test(i.name));
    if (!item) return null;
    const e = bot.entity;
    const base = e.position.floored();
    const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]];
    await ctx.withInv(() => bot.equip(item, 'hand'));
    for (const [dx, dz] of dirs) {
      const foot = base.offset(dx, 0, dz);
      const head = base.offset(dx * 2, 0, dz * 2);
      const ground = bot.blockAt(foot.offset(0, -1, 0));
      const groundHead = bot.blockAt(head.offset(0, -1, 0));
      if (!solid(ground) || !solid(groundHead)) continue;
      if (solid(bot.blockAt(foot)) || solid(bot.blockAt(head)) || solid(bot.blockAt(foot.offset(0, 1, 0)))) continue;
      try {
        await bot.lookAt(foot.offset(0.5, 0, 0.5).plus(new Vec3(dx * 0.5, 0, dz * 0.5)), true);   // the bed's head points the way we face
        await bot.placeBlock(ground, new Vec3(0, 1, 0));
        await sleep(300);
        const placed = bot.findBlock({ matching: bedIds(), maxDistance: 5 });
        if (placed) return placed;
      } catch (err) { /* try the next direction */ }
    }
    return null;
  }

  async function goSleep(force = false) {
    if (sleepBusy || bot.isSleeping || !bot.entity) return 'busy';
    if (!force && (!sv().autoSleep || !isNight())) return 'day';
    if (!dimOk()) return 'dimension';
    sleepBusy = true;
    try {
      let bed = bot.findBlock({ matching: bedIds(), maxDistance: 64 });
      if (!bed) bed = await placeBedFromInventory();
      if (!bed) {
        if (!saidNoBed) { saidNoBed = true; ctx.say('No bed nearby and none in my inventory, so I cannot sleep tonight.'); }
        nextSleepTry = now() + 120000;
        return 'nobed';
      }
      if (bot.entity.position.distanceTo(bed.position) > 3) await ctx.walkTo(bed.position, 2);
      if (ctx.combat.hasTarget()) return 'busy';
      await bot.sleep(bed);
      log('sleeping');
      ctx.say('Good night! Sleeping.');
      saidNoBed = false;
      return 'sleeping';
    } catch (err) {
      const m = String(err.message || err);
      nextSleepTry = now() + (/monsters/i.test(m) ? 20000 : 60000);
      if (!/not night|day/i.test(m)) log('could not sleep:', m);
      return m;
    } finally { sleepBusy = false; }
  }

  async function sleepTick() {
    if (!bot.entity) return;
    if (bot.isSleeping) {                                   // morning: get up
      if (!isNight()) { try { await bot.wake(); log('good morning'); } catch (err) { /* already awake */ } }
      return;
    }
    if (now() < nextSleepTry || !isNight() || !sv().autoSleep) return;
    const mode = ctx.getMode();
    if (!['afk', 'idle'].includes(mode)) return;            // never wander off to bed while fighting / guarding / hunting
    if (ctx.brain.isFleeing() || ctx.combat.hasTarget() || ctx.combat.isBusy() || (ctx.builder && ctx.builder.isBuilding())) return;
    await goSleep(false);
  }

  return {
    stepTick, pitTick, sleepTick, goSleep,
    isSleeping: () => !!bot.isSleeping,
    status: () => `Sleep: ${bot.isSleeping ? 'sleeping' : isNight() ? 'night' : 'day'} | auto-sleep ${sv().autoSleep ? 'ON' : 'OFF'}`
  };
}

module.exports = createSurvival;
