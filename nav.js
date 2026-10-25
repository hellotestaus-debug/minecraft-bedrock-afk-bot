'use strict';
// NAVIGATOR: "plan a route in the head, then go - and never stay stuck".
//   step(dest, opts) is called every tick by come / hunt / goto. It
//     1. decides HOW to go: far -> elytra flight (terrain-aware, see combat.js), otherwise a walking route (pathfinder A*),
//     2. watches progress: no movement for a few seconds = stuck,
//     3. escalates through recovery tricks until it works:
//        jump+sidestep -> different route (side offset) -> tower / bridge with blocks -> wind-charge hop -> ender pearl
//        -> elytra hop -> /tp (if OP) -> give up politely.
const { goals } = require('mineflayer-pathfinder');
const { Vec3 } = require('vec3');

function createNav(bot, ctx) {
  const cfg = ctx.cfg;
  const now = () => Date.now();
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  let plan = null;
  let note = 'idle';
  const think = (t) => { note = t; if (ctx.think) ctx.think(`nav: ${t}`); else console.log('🧭', t); };

  const fresh = (key) => ({ key, since: now(), goalKey: null, lastPos: null, lastMoveAt: now(), stuck: 0, nogo: 0, alt: 0, offX: 0, offZ: 0,
    flying: false, flyBlockedUntil: 0, busy: false, tpDone: false });

  bot.on('path_update', (r) => {
    if (!plan || !r) return;
    if (r.status === 'noPath' || r.status === 'timeout') plan.nogo++;
    else if (r.status === 'success') plan.nogo = 0;
  });

  const stopGoal = () => { try { bot.pathfinder.setGoal(null); } catch (e) { /* ignore */ } if (plan) plan.goalKey = null; };

  function startFlight(o, why, force) {
    plan.flying = true;
    think(`${why}: flying (elytra route planned over the terrain)`);
    const destFn = o.destFn || (() => plan.dest);
    ctx.combat.travel(destFn, o.abort || null, force ? { minDist: 12 } : {})
      .then((how) => { if (!how) plan.flyBlockedUntil = now() + 8000; })
      .catch(() => { plan.flyBlockedUntil = now() + 8000; })
      .finally(() => { if (plan) { plan.flying = false; plan.lastMoveAt = now(); plan.lastPos = null; } });
    return 'fly';
  }

  function setWalkGoal(o, dh, me) {
    const range = o.range === undefined ? 2 : o.range;
    const d = plan.dest;
    const k = `${plan.key}|${Math.round(d.x / 4)}|${Math.round(d.z / 4)}|${Math.round(me.x / 24)}|${Math.round(me.z / 24)}|${plan.alt}`;
    if (plan.goalKey === k) return;
    plan.goalKey = k;
    if (o.follow && o.follow.position && dh <= 48 && plan.alt === 0) {
      bot.pathfinder.setGoal(new goals.GoalFollow(o.follow, range), true);          // a moving target: follow it
    } else if (dh <= 48) {
      bot.pathfinder.setGoal(new goals.GoalNear(d.x + plan.offX, d.y, d.z + plan.offZ, range));
    } else {                                                                      // long way: legs of ~44 blocks (unloaded chunks confuse A*)
      const kk = 44 / dh;
      bot.pathfinder.setGoal(new goals.GoalNearXZ(me.x + (d.x - me.x) * kk + plan.offX, me.z + (d.z - me.z) * kk + plan.offZ, range + 2));
    }
  }

  async function escalate(level, o, me, dh) {
    plan.busy = true;
    const d = plan.dest;
    const yaw = Math.atan2(-(d.x - me.x), -(d.z - me.z));
    try {
      if (level === 1) {
        think('stuck - jump + sidestep');
        bot.setControlState('jump', true);
        bot.setControlState(Math.random() < 0.5 ? 'left' : 'right', true);
        await sleep(450);
        bot.setControlState('jump', false); bot.setControlState('left', false); bot.setControlState('right', false);
      } else if (level === 2) {
        plan.alt++;                                                                 // plan a DIFFERENT route: aim a few blocks to the side
        const side = (plan.alt % 2 ? 1 : -1) * (6 + 4 * plan.alt);
        plan.offX = Math.cos(yaw) * side; plan.offZ = -Math.sin(yaw) * side;
        plan.goalKey = null;
        think(`stuck - trying another route (side offset ${side})`);
      } else if (level === 3) {
        if (ctx.builder && ctx.builder.blockCount() >= 6 && !ctx.builder.isBuilding()) {
          const up = d.y - me.y;
          if (up > 3) { think(`stuck - building a tower (${Math.round(up)} up)`); await ctx.builder.tower(Math.min(8, Math.ceil(up))); }
          else { think('stuck - bridging toward the target'); stopGoal(); await bot.look(yaw, 0.1, true); await ctx.builder.build('bridge', 8); }
        }
      } else if (level === 4) {
        if (ctx.combat.options && ctx.combat.options.wind && ctx.countOf('wind_charge') > 0) {
          think('stuck - wind-charge hop over the obstacle');
          stopGoal();
          await ctx.combat.windLaunchOut({ x: Math.sin(yaw) * -1, z: Math.cos(yaw) * -1 });
        }
      } else if (level === 5) {
        if (await ctx.combat.pearlToward(d)) think('stuck - ender pearl toward the target');
      } else if (level === 6) {
        if (ctx.canFly()) startFlight(o, 'still stuck', true);
        else if (cfg.navTpFallback !== false && !ctx.opDenied() && !plan.tpDone) {
          plan.tpDone = true;
          think('stuck - teleporting (OP)');
          ctx.tp(d, o.tpName);
        }
      }
    } catch (err) { ctx.report && ctx.report('E110', err, `nav level ${level}`); } finally { plan.busy = false; }
  }

  /**
   * Call every tick. Returns: 'arrived' | 'fly' | 'moving' | 'waiting' | 'busy' | 'failed'.
   * o: { key, range, follow (entity), destFn, abort, tpName, flyDist }
   */
  function step(dest, o = {}) {
    if (!bot.entity || !dest) return 'busy';
    const key = o.key || 'nav';
    if (!plan || plan.key !== key) { plan = fresh(key); think(`new route (${key}) to ${Math.round(dest.x)} ${Math.round(dest.y)} ${Math.round(dest.z)}`); }
    plan.dest = dest;
    if (ctx.combat.isBusy() || plan.flying || plan.busy) { plan.lastMoveAt = now(); plan.lastPos = null; return plan.flying ? 'fly' : 'busy'; }
    const me = bot.entity.position;
    const dh = Math.hypot(dest.x - me.x, dest.z - me.z);
    const dy = dest.y - me.y;
    const range = o.range === undefined ? 2 : o.range;
    if (dh <= range + 1.5 && Math.abs(dy) <= 4) { stopGoal(); return 'arrived'; }

    // 1) far away: fly (route is planned over the terrain inside combat.js)
    if (dh > (o.flyDist || 70) && ctx.canFly() && now() > plan.flyBlockedUntil) return startFlight(o, `far (${Math.round(dh)} blocks)`, false);

    // 2) walking route
    setWalkGoal(o, dh, me);

    // 3) progress watchdog
    const t = now();
    if (!plan.lastPos) { plan.lastPos = me.clone(); plan.lastMoveAt = t; }
    if (me.distanceTo(plan.lastPos) > 0.7) {
      plan.lastPos = me.clone(); plan.lastMoveAt = t;
      if (plan.stuck) { plan.stuck = 0; plan.nogo = 0; think('moving again'); }
      return 'moving';
    }
    const idle = t - plan.lastMoveAt;
    let lvl = idle > 24000 ? 6 : idle > 19000 ? 5 : idle > 14000 ? 4 : idle > 9000 ? 3 : idle > 5500 ? 2 : idle > 3000 ? 1 : 0;
    if (plan.nogo >= 2) lvl = Math.max(lvl, 2);
    if (plan.nogo >= 5) lvl = Math.max(lvl, 3);
    if (idle > 32000) { think('giving up - no way found'); return 'failed'; }
    if (lvl > plan.stuck) { plan.stuck = lvl; escalate(lvl, o, me, dh); }
    return 'waiting';
  }

  return {
    step,
    reset: () => { if (plan) stopGoal(); plan = null; note = 'idle'; },
    status: () => `nav: ${note}${plan ? ` | stuck-level ${plan.stuck}${plan.flying ? ' | flying' : ''}` : ''}`
  };
}

module.exports = createNav;
