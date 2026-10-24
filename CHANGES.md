# What was fixed

## Disconnects
- Hunting a far/unseen player called `combat.disengage()` every 150 ms, which cancelled the elytra flight over and over,
  leaving the bot gliding with nobody steering (crash / anti-fly kick). Now `combat.release()` is used (never aborts a flight).
- New `landSafely()`: whenever the bot glides with nothing to do it glides down, flares and lands.
- Elytra take-off is verified (server must confirm gliding), retried once, and after 3 failures elytra flights switch off.
- Elytra travel: rocket cap, climbs/descends smoothly, avoids walls and the ground, stops if health < 8.
- Elytra dive-bombs only target PLAYERS 18+ blocks away (before: ANY mob 6+ blocks away). `airstrikeMobs` re-enables it.
- ALL chat/commands (/data, /give, /tp, say...) go through one queue with >= 1.15 s between messages (spam kick fix).
  /data locate: 1 command per 8 s instead of 2 per 5 s.
- Packet guard: a NaN/Infinity move packet is dropped instead of kicking the bot ("Invalid move player packet").
- Hunting: far legs are cut into 48-block pieces, pathfinder failures are handled, target leaving the game, mob lost,
  no OP, wrong dimension -> polite give-up instead of looping.
- Kick learning no longer blames stunts for spam/timeout kicks; old learned.json files (written by the buggy version) are ignored.
- antiIdle no longer touches the hotbar while flying.

## God mode
- Wind-charge jump only at 4.5-9 blocks, max every 7 s, stops for 25 s after 2 misses (before: launched at point-blank, nonstop).
- One weapon at a time (locked 1.2 s): sword by default, axe vs shield, mace when falling. No more weapon/wind flip-flop
  (every item swap resets the attack cooldown => tiny damage).
- Spear: real cooldown instead of 350 ms; normal attack <= 3 blocks, stab 3-4.5 blocks; if stabs never land it falls back to normal attacks.
- Totem pop detected -> immediate follow-up hits. Fight is adaptive: air/wind stunts that miss twice are paused.
- All god tricks are ON (dive, grapple, windpearl, stunslam, backstab, lungeswap, attrswap, dtap) with cooldowns + miss budgets.

## Fight styles (`style <name>` or `weapon <name>`)
god (default, adaptive) | mace | spear | sword | axe

## Auto style + error codes (latest)
- `style auto` (new default): the bot reads its own inventory and picks god / mace / spear / sword / axe. If a style lands no
  confirmed hit for 12 s on a target, it tries the next one. `style god` forces every trick.
- errors.js: every problem has a code (E1xx crash, E2xx connection/kicks, E3xx elytra, E4xx hunting, E5xx kit/OP, E6xx packet guard, E7xx combat).
  Chat commands: `errors` (last 5) and `errors codes`. Everything is written to crash.log; `why` shows the disconnect code.
- Crash handler: uncaught errors/rejections are logged and the bot keeps running; >8 in 30 s exits so run.js restarts a clean bot;
  5 crashes in 2 min = crash-loop wait of 5 min. Fight logic has a circuit breaker (6 errors in 10 s stops the fight, E701).

## Gemini + password lock
- AI chat: `"aiChat": { "enabled": true, "provider": "gemini", "apiKey": "...", "model": "gemini-2.5-flash" }` (or env var GEMINI_API_KEY).
- Password lock (`auth` in config.json, or env BOT_PASSWORD): the bot stays silent/idle until an OWNER whispers the password:
  `/msg <botname> <password>`. Wrong tries are limited (5, then 10 min lockout). The password is never logged, never sent to the AI,
  and a password typed in public chat is swallowed. `lock` re-locks the bot.
- .gitignore added so config.json (password / API key) is not uploaded to GitHub.

## AI brain (brain.js, build.js, llm.js)
- Tactical brain (always on, no internet): scans threats, estimates "can I win?" from HP, armor, totems, weapons vs the enemy's
  armor/weapon/health, and RETREATS when the chance is low (pearl > elytra > wind jump > tp to owner > run), builds cover if cornered,
  eats/recovers, cleans up its blocks, then only re-engages when the odds are good. Refuses fights it cannot win (e.g. warden).
- LLM planner (Gemini/Claude): `ai <anything>` e.g. "ai go kill Steve then build a shelter". The reply is JSON, validated against a
  strict whitelist (kill/pvp/guard/follow/goto/style/flee/eat/kit/build/cleanup/wait), protected players can't be attacked.
  `ai auto on` = it thinks by itself every ~30 s (rate-limited, backs off on quota errors), `ai goal <text>` sets a standing goal.
- Builder: `build wall|shelter|platform|bridge|tower|cover [size]`, `cleanup` (only removes blocks the bot placed itself).
- Other: `think` (last decisions + reasons), `brain on|off`, `flee`.

## ROOT CAUSE of "kicked when he goes high / uses elytra" (E213 DecoderException player_command)
- mineflayer's bot.elytraFly() sends entity_action id 8. Minecraft 1.21.9+ only accepts ids 0-6 (start_fall_flying = 6), so the server
  cannot decode the packet and kicks the bot. compat.js now sends the id from the server's own protocol definition (verified for
  1.20.1, 1.21.4, 1.21.8, 1.21.11, 26.1) and the packet guard repairs any stray id 8 (error E602).
- That kick also made the old "learning" turn elytra OFF permanently (learned.json) -> "he is not using elytra". learned.json is now
  ver 3 (old files ignored) and this kick can no longer disable stunts.
- New: `godcheck` = shows gear, switches and exactly what blocks each trick. Brain aggression: all-in (odds > 75%: shorter stunt cooldowns)
  / cautious (odds < 45%: melee only, no stunts).

## Big update: god techniques, survival, AI chat fix, Firebase
- 10 god-level techniques from the guide (all in combat.js, each with a budget: it switches itself OFF after repeated misses, error E341):
  reachglitch (spear reach + mace swap), lungedash (infinite spear lunging, also used to flee/backstab/close gaps), elyloop (elytra-mace loop),
  pearlrocket (kinetic wind-pearl launch), countergrapple (cancel a diver's momentum), stunslam (mace smash into a shield + axe),
  backstab (lunge past the shield), offtap (spear in off-hand + mace), attrswap (sword->mace chain), greset (grapple reset).
  Toggle: `trick <name> on|off`.  `godcheck` shows what is ready / blocked and each technique's hits/uses.
- Survival (survival.js): auto-jump when pushing into a 1-block step, opens doors/fence gates, climbs out of deep holes (tower),
  walks AROUND holes/lava/cactus/cliffs instead of stopping or falling, pathfinder avoids damage blocks + max drop 3, ladders/vines via pathfinder,
  auto-sleep at night (finds a bed within 64 blocks, or places the bed from its inventory; wakes in the morning). `sleep`, `autosleep on|off`.
- AI chat fix (llm.js): supports Google AI Studio keys (AIza...) AND Vertex express keys (AQ....), tries fallback models, works without
  global fetch, `aitest` tells the exact error. Startup self-test prints the result in the console.
- Firebase (firebase.js): status heartbeat, memory (friends, goal, technique record) and an events ring buffer. `fbtest` checks it.
  Never stores passwords, API keys or chat.

## Come / return / water / AI-player chat / help
- New mode `come` (command `come`, aliases return/back): the bot gets to you by the best way - elytra (or pearl) when far, then runs (sprint) / walks;
  if you are out of sight it locates you (needs OP), if it cannot walk there it can /tp (returnTpFallback).
- After a task (kill finished, target lost/left, retreat finished) the bot automatically returns to you (`returnAfterTask: false` to disable).
- Water rescue: after a wind jump / elytra landing in water the bot now swims to the nearest land (32-48 blocks scan), or - in open ocean -
  launches out with a wind charge and glides; then it continues (flies/walks to you).
- Normal chat from the owner goes to the AI brain: it answers like a player (same language) AND acts ("come", "kill X", "build a shelter" ...).
  Without an AI key simple phrases still work (come here / aa ja / follow me / stop / sleep ...).
- `help` is whispered to the person who typed it and lists every command.

## Ground take-off (double jump + rocket), run first, wind reset
- Take-off now works the way a player does it: rocket in hand, running jump, press jump again in the air (elytra opens), rocket at once.
  The wind-charge launch is only the backup. The `fly` command uses the same routine (combat.flyUp).
- If a flight does not work the reason is stored and shown by `godcheck` ("Last flight problem: ...": roof above, no elytra, server did not
  start gliding ...). A failed take-off pauses air strikes for 15 s instead of retrying every tick.
- RUN FIRST: when hunting a player the bot runs at them and only takes off if running does not close the gap (3.5 s, <4 blocks gained)
  or the target is farther than 38 blocks. config: runFirst, runFirstMs, airstrikeFarDist.
- New technique `windreset` (momentum breaking): wind charge angled at the feet when falling / dashing fast, then back to a weapon.
