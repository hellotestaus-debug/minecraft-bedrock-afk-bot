'use strict';
// Version fixes for things mineflayer gets wrong on newer Minecraft versions.
//
// BUG FIXED HERE: mineflayer's bot.elytraFly() sends entity_action with actionId 8. On Minecraft 1.21.9+ the action list
// was shortened (start_fall_flying is 6 and the highest id is 6). A real server cannot decode id 8 and kicks the bot with
// "DecoderException: Failed to decode packet 'serverbound/minecraft:player_command'". We read the correct id from the
// protocol definition of the server's version instead.

/** The {id: name} map of entity_action's actionId for this server version (null on old versions without a mapper). */
function actionMap(bot) {
  try {
    const t = bot.registry.protocol.play.toServer.types.packet_entity_action;
    const f = t[1].find((x) => x.name === 'actionId');
    const m = f && f.type;
    if (Array.isArray(m) && m[0] === 'mapper') return m[1].mappings;
  } catch (e) { /* unknown protocol layout */ }
  return null;
}

/** Value to put in actionId for "start gliding with elytra" on this server version. */
function fallFlyingAction(bot) {
  const map = actionMap(bot);
  if (map) {
    const k = Object.keys(map).find((x) => /fall_flying|elytra/i.test(map[x]));
    if (k !== undefined) return map[k];            // the name; protodef turns it into the right number
  }
  return 8;                                         // old protocols without a mapper
}

/** Drop-in replacement for bot.elytraFly(). */
async function elytraFly(bot) {
  const e = bot.entity;
  if (e.elytraFlying) throw new Error('Already elytra flying');
  if (e.onGround) throw new Error('Unable to fly from ground');
  if (e.isInWater) throw new Error('Unable to elytra fly while in water');
  const item = bot.inventory.slots[bot.getEquipmentDestSlot('torso')];
  if (!item || item.name !== 'elytra') throw new Error('Elytra must be equip to start flying');
  bot._client.write('entity_action', { entityId: e.id, actionId: fallFlyingAction(bot), jumpBoost: 0 });
}

/** For the packet guard: fix / reject an entity_action whose numeric id the server could not decode. */
function sanitizeEntityAction(bot, params) {
  if (!params || typeof params.actionId !== 'number') return { params, bad: false };
  const map = actionMap(bot);
  if (!map || String(params.actionId) in map) return { params, bad: false };
  if (params.actionId === 8) return { params: { ...params, actionId: fallFlyingAction(bot) }, bad: false, fixed: true };
  return { params, bad: true };
}

module.exports = { actionMap, fallFlyingAction, elytraFly, sanitizeEntityAction };
