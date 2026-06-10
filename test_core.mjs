// Headless logic tests for the simulation core (no WebGL/DOM needed).
import { makeNoise } from './noise.js';
import { World, meshChunk, CH, WH, idx } from './world.js';
import { B, I, matchRecipe, SMELT, fuelValue, blockDef, isOpaque } from './blocks.js';

let pass = 0, fail = 0;
function ok(name, cond) { if (cond) { pass++; console.log('  ✓ ' + name); } else { fail++; console.log('  ✗ FAIL: ' + name); } }

console.log('\n== noise determinism ==');
{
  const a = makeNoise(4242), b = makeNoise(4242), c = makeNoise(99);
  ok('same seed -> same value2', a.value2(12.3, 4.5) === b.value2(12.3, 4.5));
  ok('same seed -> same fbm2', a.fbm2(3.1, 9.2, 4) === b.fbm2(3.1, 9.2, 4));
  ok('diff seed -> diff value', a.value2(1.5, 2.5) !== c.value2(1.5, 2.5));
  ok('value range 0..1', a.value2(7.7, 1.1) >= 0 && a.value2(7.7, 1.1) <= 1);
}

console.log('\n== world generation determinism ==');
{
  const w1 = new World(12345), w2 = new World(12345), w3 = new World(6789);
  const c1 = w1.ensureChunk(2, -3), c2 = w2.ensureChunk(2, -3), c3 = w3.ensureChunk(2, -3);
  let same = true; for (let i = 0; i < c1.blocks.length; i++) if (c1.blocks[i] !== c2.blocks[i]) { same = false; break; }
  ok('same seed -> identical chunk blocks', same);
  let diff = false; for (let i = 0; i < c1.blocks.length; i++) if (c1.blocks[i] !== c3.blocks[i]) { diff = true; break; }
  ok('different seed -> different terrain', diff);
  // chunk has bedrock floor + some stone + air on top
  ok('bedrock at y=0', c1.blocks[idx(0, 0, 0)] === B.BEDROCK);
  let hasStone = false, hasAir = false;
  for (let i = 0; i < c1.blocks.length; i++) { if (c1.blocks[i] === B.STONE) hasStone = true; if (c1.blocks[i] === 0) hasAir = true; }
  ok('chunk contains stone', hasStone);
  ok('chunk contains air', hasAir);
}

console.log('\n== lighting ==');
{
  const w = new World(555); const c = w.ensureChunk(0, 0);
  // find a surface column and verify sky light is 15 above the top solid block
  let okSky = false;
  for (let x = 0; x < CH && !okSky; x++) for (let z = 0; z < CH && !okSky; z++) {
    let top = WH - 1; while (top > 0 && c.blocks[idx(x, top, z)] === 0) top--;
    if (top > 5 && top < WH - 4) { if (c.sky[idx(x, top + 1, z)] === 15) okSky = true; }
  }
  ok('open sky has skylight 15', okSky);
  // place a torch and verify block light propagates
  w.setBlock(8, 70, 8, B.TORCH);
  ok('torch emits block light', w.getBlockLight(8, 70, 8) >= 13);
  ok('torch light falls off with distance', w.getBlockLight(11, 70, 8) < w.getBlockLight(9, 70, 8));
}

console.log('\n== chunk serialization round-trip ==');
{
  const w = new World(777); const c = w.ensureChunk(1, 1);
  w.setBlock(16 + 3, 64, 16 + 3, B.DIAMOND_ORE); // edit inside chunk (1,1)
  const rle = w.serializeChunk(c);
  const w2 = new World(0); const c2 = w2.ensureChunk(1, 1); // different seed, will be overwritten
  World.inflateChunk(c2, rle);
  let same = true; for (let i = 0; i < c.blocks.length; i++) if (c.blocks[i] !== c2.blocks[i]) { same = false; break; }
  ok('RLE serialize -> inflate reproduces blocks', same);
  ok('edited block survives round-trip', c2.blocks[idx(3, 64, 3)] === B.DIAMOND_ORE);
}

console.log('\n== mesher (no WebGL) ==');
{
  const w = new World(2024); const c = w.ensureChunk(0, 0);
  w.ensureChunk(1, 0); w.ensureChunk(-1, 0); w.ensureChunk(0, 1); w.ensureChunk(0, -1); // neighbors for borders
  const g = meshChunk(w, c, { uv: () => [0, 0, 1, 1], cols: 8 });
  ok('solid geometry produced', g.solid && g.solid.attributes.position.count > 0);
  const pos = g.solid.attributes.position, al = g.solid.attributes.alight, uv = g.solid.attributes.uv;
  ok('alight attribute matches vertex count', al.count === pos.count);
  ok('uv attribute matches vertex count', uv.count === pos.count);
  // all indices in range
  let inRange = true; const vc = pos.count;
  for (const i of g.solid.index.array) if (i < 0 || i >= vc) { inRange = false; break; }
  ok('all triangle indices within vertex range', inRange);
  ok('index count is multiple of 3', g.solid.index.count % 3 === 0);
  // alight values normalized 0..1
  let normd = true; for (const v of al.array) if (v < -0.001 || v > 1.001) { normd = false; break; }
  ok('alight values normalized 0..1', normd);
}

console.log('\n== recipes ==');
{
  const planksGrid2 = [B.LOG, 0, 0, 0];
  ok('log -> 4 planks (shapeless)', (matchRecipe(planksGrid2, 2) || {}).id === B.PLANKS);
  const sticks = [B.PLANKS, 0, B.PLANKS, 0];
  ok('planks column -> sticks', (matchRecipe(sticks, 2) || {}).id === I.STICK);
  const table = [B.PLANKS, B.PLANKS, B.PLANKS, B.PLANKS];
  ok('2x2 planks -> crafting table', (matchRecipe(table, 2) || {}).id === B.CRAFTING_TABLE);
  // wood pickaxe in 3x3
  const pick = [B.PLANKS, B.PLANKS, B.PLANKS, 0, I.STICK, 0, 0, I.STICK, 0];
  ok('3x3 -> wooden pickaxe', (matchRecipe(pick, 3) || {}).id === I.WOOD_PICK);
  // torch
  const torch = [I.COAL, 0, I.STICK, 0];
  ok('coal over stick -> torch', (matchRecipe(torch, 2) || {}).id === B.TORCH);
  ok('empty grid -> no recipe', matchRecipe([0, 0, 0, 0], 2) === null);
}

console.log('\n== smelting & fuel ==');
{
  ok('iron ore -> iron ingot', SMELT[B.IRON_ORE] === I.IRON_INGOT);
  ok('sand -> glass', SMELT[B.SAND] === B.GLASS);
  ok('coal fuel value > 0', fuelValue(I.COAL) === 8);
  ok('planks usable as fuel', fuelValue(B.PLANKS) > 0);
}

console.log(`\n==== ${pass} passed, ${fail} failed ====\n`);
process.exit(fail ? 1 : 0);
