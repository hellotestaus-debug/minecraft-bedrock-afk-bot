'use strict';
// Builder: places blocks from the bot's inventory. Safe by design:
//  - only places into empty air (never replaces anything), never digs anything EXCEPT blocks it placed itself
//  - hard limits (max blocks, max time), aborts when told to, uses cheap blocks first
const { Vec3 } = require('vec3');

const DENY = /(^|_)(chest|barrel|shulker|tnt|bedrock|spawner|command|barrier|lava|water|fire|portal|anvil|bed|door|sign|banner|torch|lantern|rail|button|lever|plate|pressure|sapling|flower|carpet|glass_pane|sand|gravel|concrete_powder|dragon_egg|ender_chest|beacon|crafting|furnace|enchanting|trapdoor|fence|gate|slab|stairs|wall|cake|pot|head|skull|egg)(_|$)/;
const PREFER = ['cobblestone', 'cobbled_deepslate', 'stone', 'deepslate', 'dirt', 'netherrack', 'andesite', 'diorite', 'granite', 'blackstone', 'oak_planks', 'spruce_planks', 'birch_planks', 'obsidian'];

function createBuilder(bot, ctx) {
  const placed = new Set();                    // "x,y,z" of blocks WE placed (the only ones we may dig)
  const key = (v) => `${Math.floor(v.x)},${Math.floor(v.y)},${Math.floor(v.z)}`;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const log = (...a) => console.log('🧱', ...a);
  let building = false;
  let abortFlag = false;
  const lim = () => ({ maxBlocks: (ctx.cfg.brain && ctx.cfg.brain.maxBlocks) || 120, maxMs: (ctx.cfg.brain && ctx.cfg.brain.buildMaxMs) || 90000 });

  const DIRS = [new Vec3(0, -1, 0), new Vec3(0, 1, 0), new Vec3(1, 0, 0), new Vec3(-1, 0, 0), new Vec3(0, 0, 1), new Vec3(0, 0, -1)];
  const isSolid = (b) => !!b && b.boundingBox === 'block';
  const isFree = (b) => !!b && b.boundingBox === 'empty' && !/water|lava/.test(b.name);

  function blockItems() {
    const inv = bot.inventory.items().filter((i) => {
      if (DENY.test(i.name)) return false;
      const b = bot.registry.blocksByName[i.name];
      return !!b && b.boundingBox === 'block';
    });
    inv.sort((a, b) => {
      const ia = PREFER.indexOf(a.name); const ib = PREFER.indexOf(b.name);
      return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
    });
    return inv;
  }
  const blockCount = () => blockItems().reduce((n, i) => n + i.count, 0);

  /** Place ONE block at pos (must be free). Returns true if the block is there afterwards. */
  async function placeAt(pos) {
    const here = bot.blockAt(pos);
    if (isSolid(here)) return true;
    if (!isFree(here)) return false;
    // never place into an entity (ourselves, the owner, enemies)
    for (const e of Object.values(bot.entities)) {
      if (!e || !e.position) continue;
      if (Math.abs(e.position.x - (pos.x + 0.5)) < 0.8 && Math.abs(e.position.z - (pos.z + 0.5)) < 0.8 && e.position.y > pos.y - 1.8 && e.position.y < pos.y + 1) return false;
    }
    const item = blockItems()[0];
    if (!item) return false;
    let ref = null; let face = null;
    for (const d of DIRS) {
      const nb = bot.blockAt(pos.plus(d));
      if (isSolid(nb)) { ref = nb; face = d.scaled(-1); break; }
    }
    if (!ref) return false;                                           // nothing to attach to
    if (bot.entity.position.offset(0, 1.62, 0).distanceTo(ref.position.offset(0.5, 0.5, 0.5)) > 4.6) return false;
    try {
      await ctx.withInv(() => bot.equip(item, 'hand'));
      await bot.lookAt(ref.position.offset(0.5, 0.5, 0.5).plus(face.scaled(0.5)), true);
      await bot.placeBlock(ref, face);
      placed.add(key(pos));
      return true;
    } catch (e) {
      // the server may still have accepted it
      await sleep(120);
      if (isSolid(bot.blockAt(pos))) { placed.add(key(pos)); return true; }
      return false;
    }
  }

  /** Build a list of positions bottom-up. */
  async function buildList(positions, label) {
    if (building) return { ok: false, text: 'already building' };
    if (!blockCount()) return { ok: false, text: 'I have no blocks to build with (cobblestone etc.).' };
    building = true;
    abortFlag = false;
    const { maxBlocks, maxMs } = lim();
    const t0 = Date.now();
    let n = 0; let skipped = 0; const retry = [];
    positions.sort((a, b) => a.y - b.y);
    try {
      for (const p of positions) {
        if (abortFlag || Date.now() - t0 > maxMs || n >= maxBlocks || !bot.entity) break;
        if (isSolid(bot.blockAt(p))) continue;
        if (bot.entity.position.distanceTo(p.offset(0.5, 0.5, 0.5)) > 4.4 && ctx.walkTo) await ctx.walkTo(p, 3);
        let ok = await placeAt(p);
        if (!ok) { await sleep(80); ok = await placeAt(p); }
        if (ok) n++; else retry.push(p);
        await sleep(60);
      }
      // second pass: spots that had nothing to attach to yet (neighbours exist now)
      for (const p of retry) {
        if (abortFlag || Date.now() - t0 > maxMs || n >= maxBlocks || !bot.entity) break;
        if (await placeAt(p)) n++; else skipped++;
        await sleep(60);
      }
    } finally { building = false; }
    log(`${label}: placed ${n}, skipped ${skipped}`);
    return { ok: n > 0, text: `${label}: placed ${n} blocks${skipped ? `, ${skipped} spots not possible` : ''}.` };
  }

  // direction the bot is facing, snapped to x/z axis
  function facing() {
    const y = bot.entity.yaw;
    const dx = -Math.sin(y); const dz = -Math.cos(y);
    return Math.abs(dx) > Math.abs(dz) ? new Vec3(Math.sign(dx), 0, 0) : new Vec3(0, 0, Math.sign(dz));
  }
  const feet = () => bot.entity.position.floored();

  const shapes = {
    wall(size = 5) {                                   // wall in front: width x 3 high
      const f = facing(); const side = new Vec3(-f.z, 0, f.x);
      const base = feet().plus(f.scaled(2)); const out = [];
      const w = Math.min(size, 9);
      for (let i = -Math.floor(w / 2); i <= Math.floor(w / 2); i++) for (let h = 0; h < 3; h++) out.push(base.plus(side.scaled(i)).offset(0, h, 0));
      return out;
    },
    shelter() {                                        // hollow 3x3 box around us, 2 high + roof (we are inside)
      const c = feet(); const out = [];
      for (let x = -1; x <= 1; x++) for (let z = -1; z <= 1; z++) {
        for (let h = 0; h <= 2; h++) {
          const edge = Math.abs(x) === 1 || Math.abs(z) === 1;
          if ((edge && h < 2) || h === 2) out.push(c.offset(x, h, z));
        }
      }
      return out.filter((p) => !(p.x === c.x && p.z === c.z && p.y < c.y + 2));
    },
    platform(size = 5) {
      const c = feet().offset(0, -1, 0); const out = []; const r = Math.floor(Math.min(size, 9) / 2);
      for (let x = -r; x <= r; x++) for (let z = -r; z <= r; z++) out.push(c.offset(x, 0, z));
      return out;
    },
    bridge(size = 8) {                                 // 1-wide bridge forward at foot level - 1 (built while walking)
      const f = facing(); const out = [];
      for (let i = 1; i <= Math.min(size, 30); i++) out.push(feet().offset(0, -1, 0).plus(f.scaled(i)));
      return out;
    },
    cover() {                                          // emergency: 4 sides at head + feet height
      const c = feet(); const out = [];
      for (const d of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { out.push(c.offset(d[0], 0, d[1])); out.push(c.offset(d[0], 1, d[1])); }
      return out;
    }
  };

  /** Stack up with a pillar: jump, place under our feet. */
  async function tower(h = 6) {
    if (building) return { ok: false, text: 'already building' };
    if (!blockCount()) return { ok: false, text: 'I have no blocks to build with.' };
    building = true; abortFlag = false;
    let up = 0;
    try {
      const t0 = Date.now();
      for (let i = 0; i < Math.min(h, 30) && !abortFlag && Date.now() - t0 < 40000; i++) {
        const item = blockItems()[0];
        if (!item) break;
        await ctx.withInv(() => bot.equip(item, 'hand'));
        const base = feet();
        bot.setControlState('jump', true);
        let placedOne = false;
        for (let k = 0; k < 14 && !placedOne; k++) {
          await bot.waitForTicks(1);
          if (bot.entity.position.y > base.y + 1.05) {
            bot.setControlState('jump', false);
            try {
              await bot.lookAt(base.offset(0.5, 0, 0.5), true);
              await bot.placeBlock(bot.blockAt(base.offset(0, -1, 0)), new Vec3(0, 1, 0));
              placed.add(key(base)); placedOne = true; up++;
            } catch (e) { /* retry next loop */ }
          }
        }
        bot.setControlState('jump', false);
        if (!placedOne) break;
        await sleep(150);
      }
    } finally { bot.setControlState('jump', false); building = false; }
    return { ok: up > 0, text: `tower: ${up} blocks high.` };
  }

  /** Remove everything we placed that is within reach (we never dig anything else). */
  async function cleanup() {
    if (building) return { ok: false, text: 'busy building' };
    building = true; abortFlag = false;
    let n = 0;
    try {
      const list = [...placed].map((k) => { const [x, y, z] = k.split(',').map(Number); return new Vec3(x, y, z); })
        .sort((a, b) => b.y - a.y);
      const pick = bot.inventory.items().find((i) => /_pickaxe$/.test(i.name));
      for (const p of list) {
        if (abortFlag || !bot.entity) break;
        const b = bot.blockAt(p);
        if (!b || !isSolid(b)) { placed.delete(key(p)); continue; }
        if (bot.entity.position.distanceTo(p.offset(0.5, 0.5, 0.5)) > 4.5) continue;
        try {
          if (pick) await ctx.withInv(() => bot.equip(pick, 'hand'));
          await bot.dig(b);
          placed.delete(key(p)); n++;
        } catch (e) { /* skip */ }
      }
    } finally { building = false; }
    return { ok: true, text: `cleanup: removed ${n} of my blocks (${placed.size} left out of reach).` };
  }

  async function build(shape, size) {
    const s = String(shape || '').toLowerCase();
    if (s === 'tower' || s === 'pillar') return tower(size || 6);
    if (!shapes[s]) return { ok: false, text: `Shapes: ${Object.keys(shapes).concat('tower').join(', ')}` };
    return buildList(shapes[s](size || undefined), s);
  }

  return {
    build, cleanup, tower,
    cover: () => buildList(shapes.cover(), 'cover'),
    abort: () => { abortFlag = true; },
    isBuilding: () => building,
    blockCount,
    shapes: () => Object.keys(shapes).concat('tower'),
    ownBlocks: () => placed.size
  };
}

module.exports = createBuilder;
