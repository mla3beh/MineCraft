// test_persistence.mjs — exercises the real IndexedDB save/load path with an in-memory IDB.
import 'fake-indexeddb/auto';
import * as DB from './persistence.js';
import { World } from './world.js';
import { B, I } from './blocks.js';

let pass = 0, fail = 0;
const ok = (n, c) => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.log('  ✗ FAIL: ' + n); } };

console.log('\n== world meta store ==');
{
  const meta = { id: 'w1', name: 'Alpha', seed: 42, mode: 'survival', size: 64, created: 1, lastPlayed: 5, version: 1 };
  await DB.putWorldMeta(meta);
  const got = await DB.getWorld('w1');
  ok('putWorldMeta + getWorld', got && got.name === 'Alpha' && got.seed === 42);
  const list = await DB.listWorlds();
  ok('listWorlds includes it', list.some((m) => m.id === 'w1'));
}

console.log('\n== full save -> reload reproduces world (plan testing-checklist #1) ==');
{
  const seed = 1337;
  // --- original session ---
  const w = new World(seed);
  w.ensureChunk(0, 0); w.ensureChunk(1, 0); w.ensureChunk(-1, -1);
  // player edits
  w.setBlock(3, 70, 4, B.DIAMOND_ORE);
  w.setBlock(17, 65, 2, B.GLASS);      // chunk (1,0)
  w.setBlock(-5, 60, -9, B.TORCH);     // chunk (-1,-1)
  // a chest block-entity with contents
  w.setBlock(5, 70, 5, B.CHEST);
  w.blockEntities.set('5,70,5', { type: 'chest', slots: (() => { const s = new Array(27).fill(null); s[0] = { id: I.DIAMOND, count: 12 }; s[3] = { id: B.COBBLE, count: 64 }; return s; })() });

  const state = {
    player: { pos: [3.5, 72, 4.5], yaw: 1.2, pitch: -0.3, health: 14, food: 9, saturation: 2, air: 8, xp: 7, fly: false },
    inv: [{ id: I.IRON_PICK, count: 1, dura: 200 }, { id: B.PLANKS, count: 40 }, ...new Array(34).fill(null)],
    hotbarSel: 2, time: 0.6, gameMode: 'survival',
    blockEntities: [...w.blockEntities.entries()], settings: { renderDistance: 8, fov: 80, sensitivity: 1.1, volume: 0.5 },
  };
  const meta = { id: 'w2', name: 'Saved', seed, mode: 'survival', size: 64, created: 1, lastPlayed: 9, version: 1 };
  await DB.putWorldMeta(meta);
  await DB.saveState('w2', state);
  const dirty = [];
  for (const c of w.chunks.values()) if (c.dirty) dirty.push({ cx: c.cx, cz: c.cz, rle: w.serializeChunk(c) });
  await DB.saveChunks('w2', dirty);
  ok('3 edited chunks marked dirty & saved', dirty.length === 3);

  // --- reload session ---
  const w2 = new World(seed);
  const savedChunks = await DB.loadChunks('w2');
  for (const sc of savedChunks) { const c = w2.ensureChunk(sc.cx, sc.cz); World.inflateChunk(c, sc.rle); w2.computeLight(c); }
  const st = await DB.loadState('w2');

  ok('edited diamond ore restored', w2.getBlock(3, 70, 4) === B.DIAMOND_ORE);
  ok('edited glass restored (chunk 1,0)', w2.getBlock(17, 65, 2) === B.GLASS);
  ok('edited torch restored (chunk -1,-1)', w2.getBlock(-5, 60, -9) === B.TORCH);
  ok('torch light recomputed after reload', w2.getBlockLight(-5, 60, -9) >= 13);
  ok('player position restored', st.player.pos[0] === 3.5 && st.player.health === 14);
  ok('inventory restored (iron pick durability)', st.inv[0].id === I.IRON_PICK && st.inv[0].dura === 200);
  ok('time & gamemode restored', st.time === 0.6 && st.gameMode === 'survival');
  const be = new Map(st.blockEntities).get('5,70,5');
  ok('chest contents restored', be && be.slots[0].id === I.DIAMOND && be.slots[0].count === 12 && be.slots[3].count === 64);

  // unmodified chunk regenerates identically from seed (plan checklist #2)
  const wFresh = new World(seed);
  const a = wFresh.ensureChunk(9, 9).blocks, b = w2.ensureChunk(9, 9).blocks;
  let identical = true; for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) { identical = false; break; }
  ok('unsaved chunk regenerates identically (same seed)', identical);
}

console.log('\n== export / import round-trip ==');
{
  const exported = await DB.exportWorld('w2');
  ok('export has format tag + chunks + state', exported.format === 'cubeworld' && exported.chunks.length === 3 && !!exported.state);
  const newMeta = await DB.importWorld(JSON.parse(JSON.stringify(exported)));
  ok('import creates a new world id', newMeta.id !== 'w2');
  const importedChunks = await DB.loadChunks(newMeta.id);
  ok('imported world has the chunks', importedChunks.length === 3);
  const importedState = await DB.loadState(newMeta.id);
  ok('imported world has player state', importedState && importedState.player.health === 14);
}

console.log('\n== delete world ==');
{
  await DB.deleteWorld('w2');
  const list = await DB.listWorlds();
  ok('world removed from list', !list.some((m) => m.id === 'w2'));
  ok('deleted world state gone', (await DB.loadState('w2')) === undefined);
  ok('deleted world chunks gone', (await DB.loadChunks('w2')).length === 0);
}

console.log(`\n==== ${pass} passed, ${fail} failed ====\n`);
process.exit(fail ? 1 : 0);
