'use strict';
// BRAIN = two layers
//  1) Tactical brain (rules, no internet, always on): threat scan, "can I win this?" estimate, flee / recover / avoid.
//  2) LLM planner (optional, Gemini/Claude): the owner talks to it ("ai go kill Steve then build a shelter"); it answers
//     with a JSON plan that is validated against a strict whitelist before anything is executed.
const llm = require('./llm');

const ARMOR_PTS = {
  helmet: { netherite: 3, diamond: 3, iron: 2, chainmail: 2, golden: 2, turtle: 2, leather: 1 },
  chestplate: { netherite: 8, diamond: 8, iron: 6, chainmail: 5, golden: 5, leather: 3 },
  leggings: { netherite: 6, diamond: 6, iron: 5, chainmail: 4, golden: 3, leather: 2 },
  boots: { netherite: 3, diamond: 3, iron: 2, chainmail: 1, golden: 1, leather: 1 }
};
const SWORD = { netherite: 8, diamond: 7, iron: 6, stone: 5, golden: 4, wooden: 4, copper: 5 };
const AXE = { netherite: 10, diamond: 9, iron: 9, stone: 9, golden: 7, wooden: 7, copper: 9 };
const MOB = { creeper: [25, 20], skeleton: [3, 20], zombie: [3, 20], husk: [3, 20], drowned: [3, 20], spider: [2.5, 16], cave_spider: [2, 12], enderman: [7, 40], witch: [3, 26], blaze: [4, 20], wither_skeleton: [6, 20], ravager: [10, 100], vindicator: [10, 24], pillager: [4, 24], evoker: [5, 24], phantom: [3, 20], piglin_brute: [10, 50], warden: [40, 500], hoglin: [6, 40], zoglin: [6, 40], stray: [3, 20], slime: [2, 16], magma_cube: [3, 16], ghast: [6, 10] };
const MAX_THOUGHTS = 30;

function createBrain(bot, ctx) {
  const cfg = ctx.cfg;
  const bc = () => ({ enabled: true, fleeBelow: 0.35, reengageAbove: 0.55, narrate: true, autoCover: true, thinkEveryMs: 30000, ...(cfg.brain || {}) });
  const now = () => Date.now();
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const thoughts = [];
  const attackers = new Map();             // name -> last time it hurt us
  let enabled = bc().enabled !== false;
  let fleeing = false;
  let fleeStage = '';
  let lastFledAt = 0;
  let lastNarrate = 0;
  let lastVerdict = '';
  let autoOn = false;
  let standingGoal = '';
  let autoBusy = false;
  let autoNext = 0;
  let autoBackoff = 0;
  let planning = false;
  let lastWin = 1;
  let lastThreatAt = 0;

  function think(text) {
    thoughts.push({ at: new Date().toISOString().slice(11, 19), text });
    if (thoughts.length > MAX_THOUGHTS) thoughts.shift();
    console.log('🧠', text);
  }
  function narrate(text) {
    if (!bc().narrate || now() - lastNarrate < 15000) return;
    lastNarrate = now();
    ctx.say(text);
  }

  // ---------- reading the world ----------
  const typeOf = (name, suffix) => { const m = String(name || '').match(new RegExp(`^(\\w+?)_${suffix}$`)); return m ? m[1] : null; };
  function armorPoints(items) {
    let p = 0;
    for (const it of items) {
      if (!it) continue;
      for (const piece of Object.keys(ARMOR_PTS)) {
        const mat = typeOf(it.name, piece);
        if (mat && ARMOR_PTS[piece][mat]) p += ARMOR_PTS[piece][mat];
      }
    }
    return Math.min(20, p);
  }
  function weaponDamage(item) {
    if (!item) return 1;
    const n = item.name;
    let d = 1;
    if (n === 'mace') d = 12;
    else if (n === 'trident') d = 9;
    else if (/_sword$/.test(n)) d = SWORD[typeOf(n, 'sword')] || 5;
    else if (/_axe$/.test(n)) d = AXE[typeOf(n, 'axe')] || 7;
    else if (/_spear$/.test(n)) d = (SWORD[typeOf(n, 'spear')] || 5) - 1;
    else if (n === 'bow' || n === 'crossbow') d = 6;
    try {
      const sh = item.enchants && item.enchants.find((e) => e.name === 'sharpness');
      if (sh) d += 0.5 * Math.min(sh.lvl, 10) + 0.5;
    } catch (e) { /* no enchant info */ }
    return d;
  }
  const entHealth = (e) => {
    if (typeof e.health === 'number' && e.health > 0) return e.health;
    const m = e.metadata && e.metadata[9];
    return typeof m === 'number' && m > 0 && m <= 1024 ? m : 20;
  };
  const reduction = (armor) => Math.min(0.8, armor * 0.04);

  function myState() {
    const inv = bot.inventory.items();
    const armorItems = [5, 6, 7, 8].map((s) => bot.inventory.slots[s]);
    const off = bot.inventory.slots[45];
    const totems = inv.filter((i) => i.name === 'totem_of_undying').reduce((n, i) => n + i.count, 0) + (off && off.name === 'totem_of_undying' ? 1 : 0);
    const gapples = inv.filter((i) => /golden_apple/.test(i.name)).reduce((n, i) => n + i.count, 0);
    const weapons = inv.filter((i) => /(^mace$|_sword$|_axe$|_spear$|^trident$)/.test(i.name));
    const bestDmg = Math.max(2, ...weapons.map(weaponDamage));
    const armor = armorPoints(armorItems);
    const hp = bot.health + ((bot.entity && bot.entity.metadata && 0) || 0);
    const ehp = hp / (1 - reduction(armor)) + Math.min(3, totems) * 12 + Math.min(3, Math.floor(gapples / 2)) * 4;
    return { hp: bot.health, food: bot.food, armor, totems, gapples, bestDmg, ehp, dps: bestDmg * 1.25,
      pearls: inv.filter((i) => i.name === 'ender_pearl').reduce((n, i) => n + i.count, 0),
      wind: inv.filter((i) => i.name === 'wind_charge').reduce((n, i) => n + i.count, 0),
      rockets: inv.filter((i) => i.name === 'firework_rocket').reduce((n, i) => n + i.count, 0),
      elytra: !!(inv.find((i) => i.name === 'elytra') || (bot.inventory.slots[6] && bot.inventory.slots[6].name === 'elytra')),
      blocks: ctx.builder ? ctx.builder.blockCount() : 0, weapons: weapons.map((w) => w.name) };
  }

  function describeEnemy(e) {
    if (e.type === 'player') {
      const eq = (e.equipment || []).filter(Boolean);
      const armor = armorPoints(eq);
      const hand = eq.find((i) => weaponDamage(i) > 2) || (e.heldItem || null);
      const dmg = weaponDamage(hand);
      const hp = entHealth(e);
      return { name: e.username, type: 'player', armor, hp, ehp: hp / (1 - reduction(armor)), dps: dmg * 1.1, weapon: hand ? hand.name : 'fist', dist: bot.entity.position.distanceTo(e.position) };
    }
    const m = MOB[e.name] || [3, 20];
    return { name: e.name, type: 'mob', armor: 0, hp: m[1], ehp: m[1], dps: m[0], weapon: '-', dist: bot.entity.position.distanceTo(e.position) };
  }

  /** Everything that is currently a danger to us. */
  function scan() {
    if (!bot.entity) return [];
    const out = [];
    const t = now();
    for (const e of Object.values(bot.entities)) {
      if (!e || e === bot.entity || !e.position || e.isValid === false) continue;
      const d = bot.entity.position.distanceTo(e.position);
      if (e.type === 'player') {
        if (!e.username || ctx.isProtected(e.username)) continue;
        const recent = attackers.has(e.username) && t - attackers.get(e.username) < 15000;
        if (d <= 30 && (recent || (ctx.currentTarget && ctx.currentTarget() === e))) out.push(e);
      } else if (ctx.hostileSet.has(e.name) && d <= 14) out.push(e);
    }
    return out;
  }

  /** 0..1 chance of winning a fight against `enemies` (rough heuristic, not a promise). */
  function assess(enemies) {
    const me = myState();
    if (!enemies.length) return { win: 1, me, enemies: [], text: 'no enemies' };
    const info = enemies.map(describeEnemy);
    const eEhp = info.reduce((n, x) => n + x.ehp, 0);
    const eDps = info.reduce((n, x) => n + x.dps, 0);
    const myTtk = eEhp / Math.max(1, me.dps);
    const enTtk = me.ehp / Math.max(0.5, eDps);
    let win = enTtk / (myTtk + enTtk);
    if (info.filter((x) => x.type === 'player').length >= 3) win *= 0.6;       // outnumbered
    if (me.hp <= 6 && !me.totems) win = Math.min(win, 0.2);
    return { win, me, enemies: info, text: `win ${(win * 100).toFixed(0)}% (me ${me.hp.toFixed(0)}hp/${me.armor}armor/${me.totems}totems vs ${info.map((x) => `${x.name} ${x.hp.toFixed(0)}hp/${x.armor}armor/${x.weapon}`).join(', ')})` };
  }

  // ---------- fleeing ----------
  function awayVector(threats) {
    const me = bot.entity.position;
    let x = 0; let z = 0;
    for (const e of threats) { x += me.x - e.position.x; z += me.z - e.position.z; }
    let n = Math.hypot(x, z);
    if (n < 0.01) { const a = Math.random() * Math.PI * 2; x = Math.cos(a); z = Math.sin(a); n = 1; }
    let v = { x: x / n, z: z / n };
    // prefer running toward the owner (protection) when they are on the other side
    const ow = Object.values(bot.players).find((p) => ctx.isOwner(p.username) && p.entity);
    if (ow) {
      const ox = ow.entity.position.x - me.x; const oz = ow.entity.position.z - me.z; const od = Math.hypot(ox, oz) || 1;
      if (od > 6 && od < 60 && (ox / od) * v.x + (oz / od) * v.z > -0.2) v = { x: (v.x + ox / od) / 2, z: (v.z + oz / od) / 2 };
    }
    const m = Math.hypot(v.x, v.z) || 1;
    return { x: v.x / m, z: v.z / m };
  }

  async function flee(reason, manual = false) {
    if (fleeing) return;
    fleeing = true;
    lastFledAt = now();
    const prev = ctx.getMode();
    const threats = scan();
    think(`RETREAT: ${reason}`);
    if (ctx.event) ctx.event('retreat', { reason });
    narrate(manual ? 'Retreating!' : `Too dangerous (${reason}). Retreating!`);
    try {
      ctx.combat.disengage();
      ctx.setMode('idle');
      const dir = awayVector(threats);
      const away = { x: dir.x, z: dir.z };
      const me = () => bot.entity.position;
      const nearest = () => Math.min(99, ...scan().map((e) => bot.entity.position.distanceTo(e.position)));
      const opts = ctx.combat.options || {};
      let moved = false;

      // 1) ender pearl away (instant, 12-28 blocks)
      if (!moved && opts.pearl && ctx.combat.pearlItem() && nearest() < 16) {
        fleeStage = 'pearl';
        if (await ctx.combat.pearlOut(away)) { moved = true; think('escaped with an ender pearl'); }
      }
      // 2) elytra + rockets (long distance)
      const s = myState();
      if (!moved && opts.air && s.elytra && s.rockets >= 3) {
        fleeStage = 'elytra';
        const dest = { x: me().x + away.x * 110, y: me().y, z: me().z + away.z * 110 };
        const how = await ctx.combat.travel(dest, () => false);
        if (how) { moved = true; think(`escaped by ${how}`); }
      }
      // 3) wind charge launch away
      if (!moved && opts.wind && s.wind > 0) {
        fleeStage = 'wind';
        if (await ctx.combat.windLaunchOut(away)) { moved = true; think('escaped with a wind charge jump'); }
      }
      // 3b) spear lunge dashes (needs the Lunge enchant + food): several fast dashes away
      if (!moved && ctx.combat.lungeEscape) {
        fleeStage = 'lunge';
        if (await ctx.combat.lungeEscape(away, 4)) { think('dashed away with spear lunges'); }
      }
      // 4) OP: teleport to the owner
      if (!moved && cfg.escapeTpToOwner !== false && !ctx.opDenied() && bot.health <= 8) {
        fleeStage = 'tp';
        try { await ctx.tpToOwner(); moved = true; think('teleported to the owner'); } catch (e) { /* no OP */ }
      }
      // 5) run (sprint to a point ~45 blocks away)
      fleeStage = 'run';
      const target = { x: me().x + away.x * 45, y: me().y, z: me().z + away.z * 45 };
      ctx.goTo(target, 5, true);

      // monitor until safe (max 45 s); cornered => cover
      const t0 = now();
      let coverTried = false;
      while (now() - t0 < 45000 && bot.entity) {
        await sleep(600);
        const th = scan();
        const near = th.length ? Math.min(...th.map((e) => bot.entity.position.distanceTo(e.position))) : 99;
        if (near > 28) break;
        if (near < 3.2 && bot.health < 9 && bc().autoCover && !coverTried && ctx.builder && ctx.builder.blockCount() >= 6) {
          coverTried = true;
          fleeStage = 'cover';
          think('cornered - building cover');
          ctx.clearGoal();
          const r = await ctx.builder.cover();
          think(r.text);
        }
        if (near > 12 && !moved) { /* far enough while running: keep going */ }
        if (coverTried && near < 5) { await ctx.eatNow(true).catch(() => {}); }
      }

      // recover
      fleeStage = 'recover';
      ctx.clearGoal();
      const r0 = now();
      while (bot.health < 17 && now() - r0 < 25000 && bot.entity) {
        if (scan().some((e) => bot.entity.position.distanceTo(e.position) < 10)) break;
        const ate = await ctx.eatNow(true).catch(() => false);
        if (!ate) await sleep(1500);
      }
      think(`recovered: ${bot.health.toFixed(0)}hp`);
      if (ctx.builder && ctx.builder.ownBlocks() > 0 && !scan().length) ctx.builder.cleanup().catch(() => {});
    } catch (e) {
      ctx.report && ctx.report('E700', e, 'flee');
    } finally {
      fleeing = false;
      fleeStage = '';
      lastFledAt = now();
      const back = { guard: 'guard', pvp: 'pvp', follow: 'follow', afk: 'afk', come: 'come' }[prev];
      ctx.setMode('afk');
      if (back && back !== 'afk') ctx.runCommand(back, []);
      else if (cfg.returnAfterTask !== false && !ctx.locked()) ctx.runCommand('come', []);      // safe again: go back to the owner
    }
  }

  /** Called every 500 ms. */
  function tick() {
    if (!enabled || !bot.entity || fleeing || planning) return;
    const th = scan();
    if (!th.length) { lastVerdict = ''; return; }
    const a = assess(th);
    lastWin = a.win;
    lastThreatAt = now();
    const verdict = a.win < bc().fleeBelow ? 'flee' : 'fight';
    const cool = now() - lastFledAt < 8000;
    if (verdict !== lastVerdict) { lastVerdict = verdict; think(`${verdict.toUpperCase()}: ${a.text}`); }
    const hard = bot.health <= 5 && a.me.totems === 0 && th.some((e) => bot.entity.position.distanceTo(e.position) < 12);
    if ((verdict === 'flee' && !cool) || (hard && !cool)) flee(hard ? 'health critical, no totem' : `only ${(a.win * 100).toFixed(0)}% win chance`).catch(() => {});
  }

  /** fight() gate: should the bot refuse to start / resume this fight? */
  function shouldAvoid(ent) {
    if (!enabled || !bot.entity) return false;
    if (fleeing) return true;
    const th = scan();
    if (!th.includes(ent)) th.push(ent);
    const a = assess(th);
    const recentlyFled = now() - lastFledAt < 90000;
    const avoid = recentlyFled ? a.win < bc().reengageAbove : a.win < Math.min(0.2, bc().fleeBelow);
    if (avoid && now() - lastNarrate > 15000) think(`avoiding ${ent.username || ent.name}: ${a.text}`);
    return avoid;
  }

  // ---------- LLM planner ----------
  const NAME_RE = /^[A-Za-z0-9_.*]{1,24}$/;
  const num = (v, lo, hi) => { const n = Number(v); return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : null; };

  function situation() {
    const s = myState();
    const near = Object.values(bot.entities).filter((e) => e && e !== bot.entity && e.position && bot.entity.position.distanceTo(e.position) < 40 && (e.type === 'player' || ctx.hostileSet.has(e.name)));
    return {
      health: s.hp, food: s.food, mode: ctx.getMode(), fleeing,
      position: bot.entity.position.floored(),
      gear: { weapons: s.weapons, armorPoints: s.armor, totems: s.totems, goldenApples: s.gapples, pearls: s.pearls, windCharges: s.wind, rockets: s.rockets, elytra: s.elytra, buildBlocks: s.blocks },
      nearby: near.slice(0, 8).map((e) => { const d = describeEnemy(e); return { name: d.name, type: d.type, distance: Math.round(d.dist), hp: Math.round(d.hp), armor: d.armor, weapon: d.weapon, protectedPlayer: e.type === 'player' && ctx.isProtected(e.username) }; }),
      techniqueRecord: ctx.techStats ? ctx.techStats() : {},
      recentThoughts: thoughts.slice(-4).map((t) => t.text)
    };
  }

  const SYSTEM = (auto, chat) => `You are the brain of a Minecraft PvP bot named ${bot.username}. You decide what the bot does next.
${chat ? 'CHAT MODE: your owner is just chatting with you in game chat. Behave like a real, friendly human player (not an assistant): answer naturally and briefly in the SAME language and style as the owner (English, Hindi, Hinglish...). Only take actions when the owner clearly wants something done ("come" -> come, "kill X" -> kill, "build a shelter" -> build ...); for plain conversation return an empty actions list.' : ''}
Reply with ONLY a JSON object: {"say":"<short chat message or empty>","actions":[{"do":"<action>", ...}]}
Allowed actions (anything else is ignored):
 kill {"target":"<player or mob name>"} | pvp | guard {"mode":"me|here|strict"} | follow | come (fly/walk/run to the owner) | goto {"x":n,"y":n,"z":n} | afk | stop | sleep
 style {"name":"auto|god|mace|spear|sword|axe"} | flee | eat | kit | build {"shape":"wall|shelter|platform|bridge|tower|cover","size":n} | cleanup | wait {"seconds":n<=20}
Rules: at most 6 actions. Prefer safety: if health is low or the enemy is much stronger, use "flee" or "build cover". Never attack protected players.
${auto ? 'AUTONOMOUS mode: only act if it really helps; an empty actions list is fine. Do not attack players unless they attacked us.' : 'The owner gave you an instruction: follow it sensibly.'}
Keep "say" under 140 characters, plain text.`;

  async function execAction(a, auto, hostileOk) {
    const d = String(a && a.do || '').toLowerCase();
    const cmd = (c, args = []) => { ctx.runCommand(c, args); return `${c}${args.length ? ' ' + args.join(' ') : ''}`; };
    switch (d) {
      case 'kill': {
        const t = String(a.target || '');
        if (!NAME_RE.test(t)) return null;
        if (ctx.isProtected(t)) return `refused: ${t} is protected`;
        if (auto && !hostileOk(t)) return `refused (auto): ${t} has not attacked us`;
        return cmd('kill', [t]);
      }
      case 'pvp': case 'follow': case 'come': case 'afk': case 'stop': case 'kit': case 'sleep': return cmd(d);
      case 'guard': { const m = ['me', 'here', 'strict'].includes(a.mode) ? a.mode : ''; return cmd('guard', m && m !== 'me' ? [m] : []); }
      case 'goto': {
        const x = num(a.x, -3e7, 3e7); const y = num(a.y, -64, 320); const z = num(a.z, -3e7, 3e7);
        if (x === null || y === null || z === null) return null;
        return cmd('goto', [String(Math.round(x)), String(Math.round(y)), String(Math.round(z))]);
      }
      case 'style': return ['auto', 'god', 'mace', 'spear', 'sword', 'axe'].includes(a.name) ? cmd('weapon', [a.name]) : null;
      case 'flee': flee('plan', true).catch(() => {}); return 'flee';
      case 'eat': await ctx.eatNow(true).catch(() => {}); return 'eat';
      case 'cleanup': { const r = await ctx.builder.cleanup(); return r.text; }
      case 'build': {
        const shape = String(a.shape || '').toLowerCase();
        if (!ctx.builder.shapes().includes(shape)) return null;
        const r = await ctx.builder.build(shape, num(a.size, 1, shape === 'tower' ? 30 : 9) || undefined);
        return r.text;
      }
      case 'wait': { const s = num(a.seconds, 0, 20) || 0; await sleep(s * 1000); return `wait ${s}s`; }
      default: return null;
    }
  }

  async function plan(request, user, auto = false, opt = {}) {
    if (!llm.available(cfg)) throw new Error('no AI key set (aiChat.apiKey / GEMINI_API_KEY)');
    if (planning) throw new Error('still thinking about the last request');
    planning = true;
    try {
      think(`${auto ? 'auto-think' : opt.chat ? `${user} said` : `${user} asked`}: ${request.slice(0, 80)}`);
      const raw = await llm.complete(cfg, { system: SYSTEM(auto, !!opt.chat), user: `SITUATION:\n${JSON.stringify(situation())}\n\nREQUEST: ${request}`, maxTokens: 500, json: true, minGapMs: opt.chat ? 1500 : 3500 });
      const out = llm.parseJson(raw);
      const actions = Array.isArray(out.actions) ? out.actions.slice(0, 6) : [];
      const goalLc = String(standingGoal + ' ' + request).toLowerCase();
      const hostileOk = (name) => attackers.has(name) || ctx.hostileSet.has(name) || goalLc.includes(String(name).toLowerCase());
      const said = String(out.say || '').replace(/[\r\n]+/g, ' ').replace(/^\/+/, '').slice(0, 160);
      if (said && !(cfg.auth && cfg.auth.password && said.includes(cfg.auth.password))) (opt.reply || ctx.say)(said);
      const done = [];
      let waitTotal = 0;
      for (const a of actions) {
        if (String(a && a.do).toLowerCase() === 'wait') { waitTotal += Number(a.seconds) || 0; if (waitTotal > 60) break; }
        const r = await execAction(a, auto, hostileOk).catch((e) => `error: ${e.message}`);
        if (r) done.push(r);
        await sleep(400);
      }
      think(`plan done: ${done.join(' -> ') || 'nothing to do'}`);
      return { said, done };
    } finally { planning = false; }
  }

  /** Autonomous thinking loop (owner enables it with "ai auto on"). Called once a second. */
  async function autoTick() {
    if (!autoOn || autoBusy || planning || fleeing || !bot.entity || now() < autoNext) return;
    if (ctx.locked() || ctx.combat.hasTarget() || ctx.combat.isBusy() || (ctx.builder && ctx.builder.isBuilding())) return;
    autoBusy = true;
    try {
      await plan(standingGoal || 'Stay alive, stay near the owner and defend them. Only act if something needs doing.', 'auto', true);
      autoBackoff = 0;
      autoNext = now() + Math.max(20000, bc().thinkEveryMs);
    } catch (e) {
      autoBackoff = Math.min(300000, (autoBackoff || 15000) * 2);
      autoNext = now() + autoBackoff;
      think(`auto-think failed: ${e.message} (retry in ${Math.round(autoBackoff / 1000)}s)`);
    } finally { autoBusy = false; }
  }

  return {
    tick, autoTick, shouldAvoid, plan, flee, think,
    noteDamage: (src) => { if (src && src.type === 'player' && src.username) attackers.set(src.username, now()); },
    isFleeing: () => fleeing,
    // all-in when we are clearly stronger (more stunts, shorter cooldowns), cautious when odds are bad (melee only)
    aggression: () => (now() - lastThreatAt > 6000 ? 'normal' : lastWin > 0.75 ? 'all-in' : lastWin < 0.45 ? 'cautious' : 'normal'),
    setEnabled: (v) => { enabled = !!v; },
    isEnabled: () => enabled,
    setAuto: (v) => { autoOn = !!v; autoNext = 0; autoBackoff = 0; },
    isAuto: () => autoOn,
    setGoal: (t) => { standingGoal = String(t || '').slice(0, 200); },
    getGoal: () => standingGoal,
    thoughts: (n = 5) => thoughts.slice(-n),
    assessNow: () => assess(scan()),
    status: () => `Brain ${enabled ? 'ON' : 'OFF'} | ${fleeing ? `RETREATING (${fleeStage})` : 'ready'} | AI planner ${llm.available(cfg) ? 'key set' : 'no key'}${autoOn ? ' | auto-think ON' : ''}${standingGoal ? ` | goal: ${standingGoal}` : ''}`
  };
}

module.exports = createBrain;
