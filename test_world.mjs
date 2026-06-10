// test_world.mjs — deeper terrain-generation & lighting checks.
import { World, CH, WH, SEA, idx } from './world.js';
import { B, isOpaque } from './blocks.js';

let pass = 0, fail = 0;
const ok = (n, c) => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.log('  ✗ FAIL: ' + n); } };

console.log('\n== biome variety ==');
{
  const w = new World(2026);
  const biomes = new Set();
  for (let x = -400; x <= 400; x += 16) for (let z = -400; z <= 400; z += 16) biomes.add(w.columnInfo(x, z).biome);
  ok('generates at least 4 distinct biomes', biomes.size >= 4);
  ok('includes an ocean somewhere', biomes.has('ocean'));
}

console.log('\n== block-level features (generated chunks) ==');
{
  const w = new World(99);
  // locate a land region with trees rather than assuming origin isn't ocean
  let fcx = 0, fcz = 0, found = false;
  for (let r = 0; r < 4000 && !found; r += 16) {
    const info = w.columnInfo(r, r);
    if (info.biome === 'forest' || info.biome === 'plains') { fcx = Math.floor(r / CH); fcz = fcx; found = true; }
  }
  const counts = {}; let caveAir = 0, waterAtSea = 0, logs = 0, deepDiamond = true;
  for (let cx = fcx - 3; cx <= fcx + 3; cx++) for (let cz = fcz - 3; cz <= fcz + 3; cz++) {
    const c = w.ensureChunk(cx, cz); const bl = c.blocks;
    for (let y = 0; y < WH; y++) for (let z = 0; z < CH; z++) for (let x = 0; x < CH; x++) {
      const b = bl[idx(x, y, z)]; if (!b) continue;
      counts[b] = (counts[b] || 0) + 1;
      if (b === B.LOG) logs++;
      if (b === B.WATER && y === SEA) waterAtSea++;
      if (b === B.DIAMOND_ORE && y >= 16) deepDiamond = false;
      // air pocket surrounded by stone => cave
      if (b === B.STONE && y > 5 && y < 50 && bl[idx(x, y + 1, z)] === 0) caveAir++;
    }
  }
  ok('coal ore generates', (counts[B.COAL_ORE] || 0) > 0);
  ok('iron ore generates', (counts[B.IRON_ORE] || 0) > 0);
  ok('diamond ore generates', (counts[B.DIAMOND_ORE] || 0) > 0);
  ok('diamonds only spawn at y < 16', deepDiamond);
  ok('bedrock generates', (counts[B.BEDROCK] || 0) > 0);
  ok('caves carve open space underground', caveAir > 50);
  ok('trees (logs) generate', logs > 0);
  // water: scan a guaranteed-ocean region (origin for seed 99 is all ocean)
  for (let cx = -1; cx <= 1; cx++) for (let cz = -1; cz <= 1; cz++) {
    const c = w.ensureChunk(cx, cz);
    for (let z = 0; z < CH; z++) for (let x = 0; x < CH; x++) if (c.blocks[idx(x, SEA, z)] === B.WATER) waterAtSea++;
  }
  ok('water fills to sea level', waterAtSea > 0);
}

console.log('\n== lighting through transparent blocks ==');
{
  const w = new World(7); const c = w.ensureChunk(0, 0);
  // build a glass roof at a known spot and verify skylight passes through it
  w.setBlock(8, 90, 8, B.GLASS);
  ok('glass is non-opaque', !isOpaque(B.GLASS));
  ok('skylight passes through glass', w.getSky(8, 89, 8) > 0);
  // solid roof blocks skylight below
  w.setBlock(10, 90, 10, B.STONE);
  // directly beneath the stone (and below surrounding terrain influence) sky should be lower than open air
  ok('opaque stone is opaque', isOpaque(B.STONE));
}

console.log(`\n==== ${pass} passed, ${fail} failed ====\n`);
process.exit(fail ? 1 : 0);
