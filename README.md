<!-- Last updated: 2025-08-21T17:25:27Z -->
# 🤖 Minecraft AFK Bot (Mineflayer-Based)

This is a lightweight Minecraft Java AFK Bot powered by [Mineflayer](https://github.com/PrismarineJS/mineflayer). It connects to a Java server, performs basic movements to avoid AFK detection, and can be customized via a simple configuration file.

<p>
  <a href="https://discord.gg/SjQydGvs5p" target="_blank">
    <img src="https://img.shields.io/badge/Discord-Join-7289DA?logo=discord&logoColor=white" alt="Discord" width="300" />
  </a>
</p>

<p>
  <a href="https://buy.polar.sh/polar_cl_yODs3Ofw3OH6yaZYZYBgRSSZKYneEpLjkBm702IGyN2" target="_blank">
    <img src="https://img.shields.io/badge/💖_Support_&_Contribute-8B5CF6?logoColor=white" alt="Contribute on Polar" width="300" />
  </a>
</p>

# ⭐ Star this project, fork and use!

## ⚠️ Warning Before You Begin

- Before starting the bot, please make sure that the Offline Mode (Pirated/Not Original) option in the settings section of your Aternos server is active.

- Secure the bot to protect it from monsters in the game.

---

## ✨ Features

* Connect to Minecraft Java servers (IP + port)
* Customize bot username
* Control chunk loading and memory usage
* Periodic chunk pruning to reduce resource usage
* Auto-movement behavior: step forward/backward, jump, sneak, loop
* Auto-reconnect with exponential backoff if the bot disconnects or is kicked
* **PvP**: fights with mace / spear / sword / axe, hunts hostile mobs, kills players on command
* **Auto armor**, **auto totem** (offhand), **auto eat** (golden apple when low HP), **auto elytra** when falling
* **Creative kit**: give the bot creative mode and it gets its own gear, then switch it back to survival
* **Chat commands** (owner only) - type `help` in game to see them all
* Easy configuration via `config.json`

---

## ⚡ Installation

### 1. Clone the repository

```bash
git clone https://github.com/nuekkis/Minecraft-AFK-Bot.git
cd Minecraft-AFK-Bot
```

### 2. Install dependencies

```bash
npm install
```

### 3. Configure `config.json`

```json
{
  "serverHost": "yourserver.aternos.me",
  "serverPort": 25565,
  "botUsername": "MyBotName",
  "botChunk": 4
}
```

> ⚠️ Make sure the server is in offline mode if you're not using premium accounts.

---

## 🤖 Starting the Bot

```bash
node bot.js
```

On successful connection:

* You'll see `✅ BotName is Ready!` in the console
* After 5 seconds, all loaded chunks are cleared
* Every 20 seconds, any chunks beyond a 6-chunk radius will be removed

---

## 🎮 Chat Commands

Only players listed in `owners` (config.json) can control the bot. Just type the command in normal chat (an optional `!` in front also works, e.g. `!pvp`).

| Command | What it does |
| ------- | ------------ |
| `help` | The bot types all commands in chat |
| `status` | HP, food, mode, held item, gamemode, kills |
| `inv` | Lists the bot's inventory |
| `stop` | Stand still (cancels everything) |
| `afk` | Back to the normal AFK movement |
| `pvp` | Hunt hostile mobs (zombie, creeper, spider, skeleton, ...) until you type `stop` |
| `guard` | Guard **you**: stays near you, attacks anyone who attacks you (or it) and hostile mobs, and helps when you fight someone |
| `guard here` | Guard the spot it's standing on instead of following you |
| `guard strict` | Like `guard`, but also attacks any stranger who comes close |
| `friend <name>` / `unfriend <name>` / `friends` | Players the bot never attacks (saved in friends.json) |
| `unstuck` | Escape a trap / stuck spot right now |
| `why` | Shows why it last disconnected (also written to disconnects.log) |
| `pearl <on\|off>` | Allow / forbid ender pearl tactics |
| `talk <on\|off>` | The bot chatting / trash talk on or off |
| `ai <on\|off>` | AI chat on/off (needs `aiChat.apiKey` in config.json) |
| `hunt <player>` | Same as `kill <player>` |
| `kill <player or mob>` | Attack a player or the nearest mob of that type. If the player is **out of sight**, the bot finds them (asks the server for their position, needs OP) and flies / pearls / walks to them |
| `follow [name]` | Follow you (or another player) |
| `come` | Walk to where you are |
| `goto <x> <y> <z>` | Walk to coordinates |
| `weapon <god\|mace\|spear\|sword\|axe>` | Fight style. `god` (same as `auto`) uses every trick that fits; the others stick to one weapon |
| `trick <name> <on\|off>` | Switch one God trick on/off (`dive`, `lungeswap`, `attrswap`, `windpearl`, `stunslam`, `backstab`, `dtap`, `grapple`) |
| `air <on\|off>` | Allow / forbid elytra strikes |
| `wind <on\|off>` | Allow / forbid wind-charge mace jumps |
| `tactics` | Shows fight style, toggles and loadout (weapons, wind charges, rockets, elytra, totems) |
| `armor` | Wear the best armor now (swaps elytra back to chestplate) |
| `totem` | Put a totem in the offhand now |
| `eat` | Eat now |
| `elytra` | Wear the elytra |
| `fly` | Take off with the elytra (uses a firework if it has one) |
| `kit` | Give itself the enchanted PvP kit (OP: via `/give`, or creative mode) |
| `say <text>` | Make the bot chat (slash-commands are blocked) |
| `rejoin` | Disconnect and reconnect |

The bot never attacks owners or itself.

### OP kit (recommended): `/op <botname>`

Give the bot OP and it runs `/give` commands for a fully **enchanted** kit, even in survival and on any Minecraft version (it writes the right command syntax for your version). It does this automatically when it joins with an empty inventory (and after it dies), or when you type `kit`. If the server ignores the commands, it notices and tells you instead of pretending.
It also gets 64 cobblestone and a pickaxe so it can dig and build its way out of traps.

### Creative kit workflow

1. Start the bot, then give it creative: `/gamemode creative <botname>`
2. It automatically gives itself **enchanted** netherite armor (Protection IV, Unbreaking, Mending...), a mace (Breach IV, Wind Burst III), spear (MC 1.21.11+), sword, axe, elytra, plus enchanted golden apples, cooked beef, 64 fireworks, 64 wind charges and 9 totems. It also wears the armor and puts a totem in the offhand. If the server version can't take enchantment data, it gives plain items and tells you in chat.
3. When it says **"Kit ready!"**, switch it back: `/gamemode survival <botname>`

Set `"autoKit": false` in config.json if you want to trigger it manually with `kit`.

### Auto features

| Feature | Behaviour |
| ------- | --------- |
| Auto armor | Always wears the best armor it has (netherite > diamond > iron > ...) |
| Auto totem | Keeps a Totem of Undying in the offhand; re-equips after one pops |
| Auto eat | Eats when food <= `eatBelowFood`; eats a golden apple when HP <= `eatGappleBelowHealth` (survival only) |
| Auto elytra | If it falls fast and has an elytra, it deploys it, then puts the chestplate back after landing |


---

## 🧠 More things it does

* **Escapes traps**: it checks every second whether it is really packed in or covered with blocks (a one-block fall is not a trap). If so it says so in chat with its coordinates, then jumps out, digs through the thinnest wall with the best tool, or digs up and builds a block pillar, then tries a wind charge / ender pearl and, with OP, `/fill` and a teleport to you.
* **Fights back** when idle and something attacks it, **never walks off cliffs or into lava** while fighting, and won't attack through walls.
* **Jumps over obstacles** while fighting instead of getting stuck on a block.
* **Guard that works**: it knows who hit you (the server tells it who the attacker is) and goes after them. Friends and owners are never attacked.
* **Hunts players**: `kill <player>` works even if they are far away (OP needed to ask the server for their position).
* **Talks**: replies when someone says its name or whispers it, and comments on fights. Optional AI chat with Claude: put your key in `aiChat.apiKey` and set `aiChat.enabled` to `true`.
* **Never goes idle**: servers with `player-idle-timeout` kick players who only walk. The bot sends arm swings, sneak toggles, look changes and hotbar changes every `antiIdleSeconds`, which is what actually resets the idle timer.
* **Crash-proof**: errors are logged to `crash.log` and the bot keeps running. `npm start` (run.js) also restarts it if the process ever dies. If the server kicks it right after a risky stunt (elytra, wind charge, pearl), it turns that stunt off automatically.

---

## 👑 God fighting style (`weapon god`, the default)

God style uses every advanced technique that fits the situation. Each one can be switched off with `trick <name> off`.

| Trick (`trick` name) | What the bot does |
| --- | --- |
| **Elytra-mace divebombing** (`dive`) | Takes off with a wind charge / fireworks, climbs, dives on the target, **swaps to a chestplate in mid-air** (gliding blocks the smash) and smashes with the mace for huge fall damage |
| **Lunge swapping** (`lungeswap`) | Holds a no-cooldown item (wind charge / pearl / rocket) between jabs, then swaps **into the spear and jabs on the same tick** to bypass its slow cooldown |
| **Attribute swapping** (`attrswap`) | Holds a sword (or wind charge) while falling and swaps to the mace **at the moment of impact**, so the smash lands with full cooldown and crit |
| **Wind-charge pearling** (`windpearl`) | Throws an ender pearl to close the gap, then on arrival throws a wind charge at its feet and launches into a mace divebomb |
| **Stun slamming** (`stunslam`) | Axe hit disables the shield, then swaps to the mace (wind-charge smash if available) to break through |
| **Backstabbing** (`backstab`) | Against a shielding opponent it sprints around to their back, where the shield can't block, and hits there |
| **Mace double-tapping** (`dtap`) | After a smash it opens a short window and strikes again immediately (Wind Burst chain smash, or a fast wind-charge smash) to finish a target whose totem just popped |
| **Grappling / far pulling** (`grapple`) | Wind charge at a player's feet launches them up, then an ender pearl to their feet pulls the bot in to hit them out of the air |

Notes: lunge swapping, attribute swapping and the exact timings follow community PvP guides; they are implemented as described but I could not verify their damage on a real server. The bot needs the swap items on its **hotbar** (the kit puts them there).

### God weapons

With OP, `kit` gives custom-named, **unbreakable, over-enchanted** weapons (vanilla limits only apply to tables and anvils): **God Mace** (Density X, Breach X, Wind Burst V), **God Spear** (Sharpness X, Lunge V), **God Sword**, **God Axe** and **God Wings** elytra. The bot prefers them over normal weapons. Turn this off with `"godGear": false`. Over the creative-mode kit the enchant levels are the same but without custom names.

---

## ⚔️ How the PvP bot fights

The tactics come from current Java Edition mechanics. With `weapon auto` the bot picks one itself:

| Situation | What it does |
| --------- | ------------ |
| Target far away (> `airstrikeMinDist`), has elytra + fireworks + mace/spear | **Elytra strike**: wears the elytra, takes off, climbs with rockets, then dives on the target. With the **mace** it takes the elytra off right before contact (a smash does not work while gliding) so the fall damage becomes smash damage. With the **spear** it holds the charge attack during the dive, because spear charge damage grows with speed. |
| Target 6+ blocks away, has elytra + rockets + **both mace and spear** | **Combo**: wind-charge launch, spear charge pass first, then climb and finish with a mace smash. Close and mid range use a short climb. |
| Can't fly and the target is 22-52 blocks away, has ender pearls | **Pearl** across the gap (aimed with real pearl physics, leading a moving target) |
| Low health, no totem, has pearls | **Pearl escape**, then heal with golden apples |
| Falls far with a water bucket | **Water clutch** |
| Target within ~9 blocks, has mace + wind charges | **Wind-charge smash**: jump, throw a wind charge at its feet at the top of the jump, swap to the mace and fall on the target (smash needs a fall of 1.5+ blocks) |
| Close range | **Sword/axe fighting**: jump-crits (hits while falling, sprint released), strafing, spacing, full attack-cooldown timing |
| Target blocking with a shield | Swaps to the **axe** to disable the shield, then continues |
| In the air above a target | Switches to the **mace** for an opportunistic smash |
| Spear in auto mode | Charges in from 5-12 blocks, then switches to the sword up close |
| Spear style (`weapon spear`) | Jab at 2-4.5 blocks (forced cooldown) and charge attacks in between |

It also eats a golden apple when low, keeps a totem in the offhand, and only does risky stunts (air strikes / wind jumps) when health is at least `minHealthForStunts`.

Note: spears only exist in Minecraft **1.21.11 or newer**. If the bot is kicked right after a spear jab, it stops sending the special jab packet automatically; you can also set `"spearJab": "attack"` in config.json.

---

## ⚙️ Configuration Options (`config.json`)

| Key            | Description                                |
| -------------- | ------------------------------------------ |
| `serverHost`         | IP or domain of your Minecraft server      |
| `serverPort`         | Server port (default is 25565)             |
| `botUsername`     | The bot's visible name in-game             |
| `botChunk` | Radius of loaded chunks (recommended: 1–6) |
| `reconnectDelay` | *(optional)* Wait before the first reconnect attempt, in ms (default 5000) |
| `owners` | Player names allowed to control the bot (e.g. `[".Shadowhester"]`) |
| `autoArmor` / `autoTotem` / `autoEat` / `autoElytra` / `autoKit` | Turn each automatic feature on/off |
| `eatBelowFood`, `eatGappleBelowHealth` | Auto-eat thresholds |
| `weaponPriority` | Order for `weapon auto`, e.g. `["mace","spear","sword","axe"]` |
| `huntRadius`, `guardRadius` | Search radius for `pvp` / `guard` |
| `hostileMobs` | Mob names `pvp` and `guard` will attack |
| `airstrike`, `windSmash` | Turn elytra strikes / wind-charge jumps on or off at startup |
| `airstrikeMinDist`, `climbHeight`, `maxClimbRockets` | Elytra strike tuning |
| `minHealthForStunts` | Minimum HP for air strikes / wind jumps (default 10) |
| `spearJab` | `both` (default), `stab` or `attack`: how spear jabs are sent |
| `debugCombat` | Prints a combat status line every second (for troubleshooting) |
| `friends` | Names that are never attacked |
| `antiIdleSeconds` | How often it sends anti-idle activity (default 25) |
| `keepAliveTimeoutMs` | How long to wait for the server before timing out (default 90000) |
| `autoOpKit` | Auto-get the kit via commands when it has OP and an empty inventory |
| `guardAssist`, `guardRadius` | Guard helps you in fights / how far it looks for mobs |
| `talk`, `trashTalk`, `aiChat` | Chat features (see above) |
| `escapeTpToOwner` | Last-resort teleport to you when trapped (needs OP) |
| `huntGiveUpMs` | How long it hunts a player before giving up (default 5 min) |
| `godGear` | `true`: kit gives the God weapons |
| `tricks` | Start-up on/off for each God trick, e.g. `{"grapple": false}` |
| `escapeUseCommands` | Last-resort `/fill` to clear blocks when trapped (needs OP, default on) |
| `selfDefense` | Fight back when idle and attacked (default on) |
| `maxReconnectDelay` | *(optional)* Max wait between attempts, in ms (default 60000). The delay doubles after each failed attempt and resets once the bot joins. |

---

## ⚠️ Notes

* **Security**: on offline-mode (cracked) servers anyone can join with any name. If someone else can join as an owner name, they can control the bot, so use a whitelist or login plugin.
* **View distance**: PvP needs the bot to see players/mobs, so `botChunk` is now `4` (1 is too small to see far).
* **Skins**: Skins might not appear properly if the server is in offline mode.
* **Sneak Movement**: The bot uses `setControlState('sneak', true)`, but some servers may block or ignore this action.
* **AFK Prevention**: The bot periodically moves, sneaks, and jumps to prevent disconnection due to inactivity.

---

## 🛠️ Troubleshooting

**It leaves and rejoins every 10-20 minutes**
That is almost always the server's idle kick (`player-idle-timeout`), which ignores walking. v3.3+ sends real activity packets. Type `why` in chat, or open `disconnects.log`: it shows the exact kick reason with the time it was online. If you still see idle kicks, lower `antiIdleSeconds` (e.g. 10).

**It disappears after using elytra / when a player is out of range**
Run it with `npm start` (restarts it automatically) and check `crash.log` and `disconnects.log`. If the server's anti-fly kicks it, it turns elytra strikes off by itself; you can also set `allow-flight=true` in server.properties and type `air on`.

**The bot only sneaks and walks around, commands do nothing**
You are running the old AFK-only version. Stop it (Ctrl+C), make sure you are in the new folder, then:

```bash
npm install
npm start
```

The console must show `🤖 PvP bot v3.3 running`, and the bot types `PvP bot v3.3 online!` in game chat. If you don't see those, the old file is still running (also check any hosting panel / second terminal that is running the old bot).

**Commands still don't work**
The console prints every chat line the bot sees, starting with `📨`. Type `help` in game and look at what the console shows. Check that:
* your name in `owners` matches yours (`.Shadowhester`; a leading `.` is optional),
* the `📨` line for your message contains your name and the command.

If you still have trouble, send me those `📨` lines. Set `"logChat": false` to hide them later.

**Armor not worn after giving creative**
The bot gives itself the kit within a few seconds of switching to creative and says `Kit ready!`. If you gave it items yourself (`/give`), it also wears the best armor it finds in its inventory automatically.

---

## 📚 Resources & Contributions

* [Mineflayer Docs](https://mineflayer.prismarine.js.org/)
* [PrismarineJS GitHub](https://github.com/PrismarineJS/)

Feel free to contribute by opening a pull request or submitting an issue.

---

## 📄 License

This project is licensed under the MIT License.

---

Get started now and keep your server active with a smart, customizable bot! ⛏️
