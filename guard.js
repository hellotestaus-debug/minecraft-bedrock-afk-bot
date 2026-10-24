'use strict';
/**
 * Guard / threat tracking.
 *
 * Who counts as a threat?
 *  1. Anyone who damaged an owner or the bot (the server tells us the attacker on MC 1.20+;
 *     on older versions we guess from arm swings / weapons held near the victim).
 *  2. Anyone the owner is fighting ("assist").
 *  3. Hostile mobs near the guarded spot.
 *  4. In strict mode: any player that is not an owner or friend.
 * Owners, friends and the bot itself are never targets.
 */
const WEAPON_RE = /(_sword|_axe|_spear|^mace$|^trident$|^bow$|^crossbow$)/;

function createGuard(bot, ctx) {
  const cfg = ctx.cfg;
  const swings = new Map();       // entity id -> last arm swing time
  const aggressors = new Map();   // entity id -> { ts, why, name }
  let lastAnnounce = new Map();

  const now = () => Date.now();
  const isPlayerEnt = (e) => !!e && e.type === 'player' && !!e.username;
  const friendly = (e) => !e || e === bot.entity || (isPlayerEnt(e) && (ctx.isOwner(e.username) || ctx.isFriend(e.username)));
  const valid = (e) => !!e && e.isValid !== false && !!bot.entities[e.id];
  const nameOf = (e) => (isPlayerEnt(e) ? e.username : e.name || `entity#${e.id}`);

  function ownerEntities() {
    return Object.values(bot.players)
      .filter((p) => p.entity && ctx.isOwner(p.username))
      .map((p) => p.entity);
  }

  function mark(ent, why) {
    if (!ent || friendly(ent) || !valid(ent)) return;
    aggressors.set(ent.id, { ts: now(), why, name: nameOf(ent) });
    const last = lastAnnounce.get(ent.id) || 0;
    if (now() - last > 30000) {
      lastAnnounce.set(ent.id, now());
      console.log(`🛡️  threat: ${nameOf(ent)} (${why})`);
      if (ctx.say) ctx.say(`Defending! Target: ${nameOf(ent)}`);
    }
  }

  /** When the server doesn't tell us who hit: players nearby who just swung or hold a weapon. */
  function guessAttacker(victim) {
    let best = null;
    let bestScore = -1;
    for (const e of Object.values(bot.entities)) {
      if (!isPlayerEnt(e) || friendly(e) || e === victim) continue;
      const d = e.position.distanceTo(victim.position);
      if (d > 8) continue;
      const swung = now() - (swings.get(e.id) || 0) < 900;
      const armed = e.heldItem && WEAPON_RE.test(e.heldItem.name);
      const score = (swung ? 10 : 0) + (armed ? 3 : 0) + (8 - d) / 8;
      if ((swung || armed) && score > bestScore) { best = e; bestScore = score; }
    }
    return best;
  }

  function onHurt(victim, source) {
    if (!victim) return;
    const victimOwner = isPlayerEnt(victim) && ctx.isOwner(victim.username);
    if (victimOwner || victim === bot.entity) {
      let att = source && source !== victim ? source : null;
      if (!att) att = guessAttacker(victim);
      if (att && !friendly(att)) mark(att, victimOwner ? `hit ${victim.username}` : 'hit me');
      return;
    }
    // assist: the owner just swung at this entity
    if (cfg.guardAssist) {
      for (const o of ownerEntities()) {
        if (now() - (swings.get(o.id) || 0) < 800 && victim.position.distanceTo(o.position) < 6 && !friendly(victim) &&
            (isPlayerEnt(victim) || ctx.isHostile(victim))) {
          mark(victim, `${o.username} is fighting it`);
          return;
        }
      }
    }
  }

  bot.on('entitySwingArm', (e) => { if (e) swings.set(e.id, now()); });
  bot.on('entityHurt', (victim, source) => {
    try { onHurt(victim, source); } catch (err) { console.error('guard error:', err.message); }
  });

  /**
   * Pick what to attack. anchor = Vec3 we are guarding (owner position or fixed spot).
   * opts.strict = attack any non-friend player inside the radius.
   */
  function pick(anchor, radius, opts = {}) {
    const t = now();
    for (const [id, a] of aggressors) {
      if (t - a.ts > 25000 || !valid(bot.entities[id])) aggressors.delete(id);
    }
    // 1) aggressors
    let best = null;
    let bestD = Infinity;
    for (const id of aggressors.keys()) {
      const e = bot.entities[id];
      const d = bot.entity.position.distanceTo(e.position);
      if (d < 48 && d < bestD) { best = e; bestD = d; }
    }
    if (best) return best;
    // 2) hostile mobs near the anchor
    for (const e of Object.values(bot.entities)) {
      if (e === bot.entity || !ctx.isHostile(e) || e.isValid === false) continue;
      const d = anchor.distanceTo(e.position);
      if (d < radius && d < bestD) { best = e; bestD = d; }
    }
    if (best) return best;
    // 3) strict mode: any stranger
    if (opts.strict) {
      for (const e of Object.values(bot.entities)) {
        if (!isPlayerEnt(e) || friendly(e)) continue;
        const d = anchor.distanceTo(e.position);
        if (d < radius && d < bestD) { best = e; bestD = d; }
      }
    }
    return best;
  }

  return {
    pick,
    onHurt,
    mark,
    ownerEntities,
    clear: () => aggressors.clear(),
    threats: () => [...aggressors.values()].map((a) => a.name),
    _swings: swings
  };
}

module.exports = createGuard;
