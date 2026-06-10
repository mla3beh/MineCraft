# Cubeworld 🟩

An **original, browser-based voxel sandbox** in the spirit of the plan in `plan.md` — a Minecraft-style
game that runs entirely in the browser with no build step and **full local save/load**. Built with
[Three.js](https://threejs.org/) (WebGL2). All textures, sounds and names are 100% original and generated
at runtime (no third-party assets / no Mojang IP).

> **Play:** serve the folder over any static web server and open `index.html` — see *Run locally* below.
> (There's no build step; Three.js loads from a CDN via an import map.)

## Features

**Engine & world**
- First/third-person camera (F5), Pointer-Lock mouse look, fixed-timestep (20 tps) simulation + interpolated rendering
- Infinite chunked world (16×16×128), seeded deterministic terrain — *same seed ⇒ same world*
- Biomes (plains, forest, desert, snowy, mountains, beach, ocean), caves, ore distribution by depth, trees & plants
- Custom AO chunk mesher with face culling, procedural texture atlas, transparent/cutout passes (water, glass, leaves)
- Voxel **lighting**: sky-light columns + block-light flood fill (torches), smooth day/night cycle with dynamic sky & fog

**Gameplay**
- AABB swept-collision physics, gravity, jumping, sprint, sneak, **auto-step**, swimming, fall damage, creative fly
- Block break/place with voxel raycast + selection highlight; per-block hardness, tool tiers & correct-tool drops
- Survival: health, hunger/saturation, regen, starvation, drowning, death & respawn; Creative: fly + infinite items
- **Inventory** (36 + 9 hotbar), drag/drop, stack split, shift-move, Q to drop, number keys & scroll
- **Crafting** (2×2 + 3×3 table, shaped & shapeless), **furnace** smelting (with fuel & progress), **chests** (27 slots)
- Mobs: passive (cow/pig, wander/breed-ready) + hostile (zombie: chases at night, burns by day), drops, melee combat & knockback
- Item-entity drops with magnet pickup, break/explosion particles, procedural Web Audio SFX

**Persistence (the plan's "critical" item)**
- **IndexedDB** save/load: world meta, modified chunks (RLE), block-entities (chest/furnace state), and full player state
- Autosave every 45 s + on tab hide / page unload + on *Save & Quit to Title*
- Multiple worlds (create / load / delete), and **export / import** a world as a single `.json` file
- Versioned format so future updates can migrate old saves

**UI**
- Main menu with world list, seed input, mode & size; loading screen with progress
- HUD (hotbar, hearts, hunger, held-item popup, crosshair), **F3 debug overlay**, pause menu with settings
  (render distance, FOV, sensitivity, volume), death screen
- **Chat / commands**: `/give`, `/time set`, `/tp`, `/gamemode`, `/seed`, `/heal`, `/help`

## Controls

| Action | Key |
| --- | --- |
| Move | `W` `A` `S` `D` |
| Jump / swim up | `Space` (double-tap = toggle fly in Creative) |
| Sneak / Sprint | `Shift` / `Ctrl` |
| Break / Place·Use | Left-click / Right-click |
| Pick block | Middle-click |
| Hotbar | `1`–`9`, mouse wheel |
| Inventory | `E` · Drop `Q` |
| Camera / Debug | `F5` / `F3` |
| Chat / Command | `T` / `/` |
| Pause | `Esc` |

## Run locally

ES modules require HTTP (not `file://`):

```bash
npm start          # serves on http://localhost:8099
# then open http://localhost:8099/index.html
```

Three.js is loaded from a CDN via an import map, so there is **no build step**.

## Tests

The simulation core (noise, terrain determinism, lighting, the mesher, save round-trip, recipes, smelting)
is covered by headless Node tests that run without WebGL:

```bash
npm test
```

CI runs the same checks on every push (`.github/workflows/test.yml`).

## Project layout

```
index.html        UI shell, styles, import map
game.js           engine, rendering, player, physics, interaction, UI, mobs, day/night, main loop
world.js          chunks, terrain gen, lighting, chunk mesher
blocks.js         data-driven block/item registries, texture atlas, icons, recipes, smelting
noise.js          seeded value-noise + fbm
persistence.js    IndexedDB save/load + export/import
test_core.mjs     headless logic tests
```

The registries (blocks, items, recipes) are **data-driven** — adding content is mostly adding entries,
keeping the Phase-4 parity backlog in `plan.md` easy to extend.
