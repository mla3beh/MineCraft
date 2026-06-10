// test_systems.mjs — drives the REAL gameplay logic in game.js headlessly (no browser).
import { __test as G } from './game.js';
import { B, I, blockDef } from './blocks.js';
import { World } from './world.js';

let pass = 0, fail = 0;
const ok = (n, c) => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.log('  ✗ FAIL: ' + n); } };
const approx = (a, b) => Math.abs(a - b) < 1e-6;

console.log('\n== inventory: addItem stacking ==');
{
  G.inv = new Array(36).fill(null);
  const left = G.addItem(B.STONE, 100);
  ok('100 stone -> 64 + 36 across two slots', G.inv[0].count === 64 && G.inv[1].count === 36 && left === 0);
  G.inv = new Array(36).fill(null);
  G.addItem(B.STONE, 30); G.addItem(B.STONE, 30);
  ok('partial stacks merge into one slot', G.inv[0].count === 60 && G.inv[1] === null);
}
console.log('\n== inventory: tools & overflow ==');
{
  G.inv = new Array(36).fill(null);
  G.addItem(I.WOOD_PICK, 1);
  ok('tool stored with durability', G.inv[0].id === I.WOOD_PICK && G.inv[0].dura === 59);
  G.inv = Array.from({ length: 36 }, () => ({ id: B.STONE, count: 64 }));
  ok('no space -> returns full leftover', G.addItem(B.DIRT, 5) === 5);
}

console.log('\n== mining: break time & tool gating ==');
{
  const stone = blockDef(B.STONE), diamond = blockDef(B.DIAMOND_ORE), dirt = blockDef(B.DIRT);
  G.hotbarSel = 0;
  G.inv = new Array(36).fill(null);                 // bare hand
  ok('stone needs a tool to drop (hand = no harvest)', G.canHarvest(stone) === false);
  ok('dirt harvestable by hand', G.canHarvest(dirt) === true);
  const handTime = G.breakTime(stone);
  G.inv[0] = { id: I.WOOD_PICK, count: 1, dura: 59 };
  ok('wood pickaxe harvests stone', G.canHarvest(stone) === true);
  ok('pickaxe breaks stone faster than hand', G.breakTime(stone) < handTime);
  ok('wood pickaxe (tier1) cannot harvest diamond (needs tier2)', G.canHarvest(diamond) === false);
  G.inv[0] = { id: I.IRON_PICK, count: 1, dura: 250 };
  ok('iron pickaxe (tier3) harvests diamond', G.canHarvest(diamond) === true);
  ok('bedrock is unbreakable (Infinity)', G.breakTime(blockDef(B.BEDROCK)) === Infinity);
}

console.log('\n== furnace smelting ==');
{
  const w = new World(1); G.world = w; G.openScreen = null;
  const be = G.newBlockEntity('furnace');
  be.slots[0] = { id: B.IRON_ORE, count: 1 };
  be.slots[1] = { id: I.COAL, count: 1 };
  w.blockEntities.set('0,0,0', be);
  for (let i = 0; i < 220; i++) G.updateFurnaces(0.05);   // ~11s of sim
  ok('iron ore smelts to an iron ingot', be.slots[2] && be.slots[2].id === I.IRON_INGOT && be.slots[2].count === 1);
  ok('input consumed', be.slots[0] === null);
  ok('fuel consumed', be.slots[1] === null);
  ok('furnace still lit after one smelt (coal burns long)', be.lit > 0);

  // without fuel: nothing smelts
  const w2 = new World(2); G.world = w2;
  const be2 = G.newBlockEntity('furnace');
  be2.slots[0] = { id: B.SAND, count: 3 };
  w2.blockEntities.set('0,0,0', be2);
  for (let i = 0; i < 220; i++) G.updateFurnaces(0.05);
  ok('no fuel -> no smelting', be2.slots[2] === null && be2.lit <= 0);
}

console.log(`\n==== ${pass} passed, ${fail} failed ====\n`);
process.exit(fail ? 1 : 0);
