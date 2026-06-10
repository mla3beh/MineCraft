// blocks.js — data-driven registries: blocks, items, procedural texture atlas, UI icons, recipes, smelting.
// All textures are generated at runtime (100% original, no external assets).

// ---------- Block IDs ----------
export const B = {
  AIR: 0, STONE: 1, GRASS: 2, DIRT: 3, COBBLE: 4, PLANKS: 5, LOG: 6, LEAVES: 7,
  SAND: 8, GRAVEL: 9, GLASS: 10, WATER: 11, BEDROCK: 12,
  COAL_ORE: 13, IRON_ORE: 14, GOLD_ORE: 15, DIAMOND_ORE: 16,
  SNOW: 17, ICE: 18, SANDSTONE: 19, TORCH: 20,
  CRAFTING_TABLE: 21, FURNACE: 22, CHEST: 23,
  TALL_GRASS: 24, FLOWER_RED: 25, FLOWER_YELLOW: 26, CACTUS: 27,
};

// ---------- Item IDs (>=100 so they never collide with block ids) ----------
export const I = {
  STICK: 100, COAL: 101, IRON_INGOT: 102, GOLD_INGOT: 103, DIAMOND: 104,
  APPLE: 105, BREAD: 106, CHARCOAL: 107, RAW_MEAT: 108, COOKED_MEAT: 109,
  // tools laid out as tier*10 below
  WOOD_PICK: 110, WOOD_AXE: 111, WOOD_SHOVEL: 112, WOOD_SWORD: 113,
  STONE_PICK: 114, STONE_AXE: 115, STONE_SHOVEL: 116, STONE_SWORD: 117,
  IRON_PICK: 118, IRON_AXE: 119, IRON_SHOVEL: 120, IRON_SWORD: 121,
  DIAMOND_PICK: 122, DIAMOND_AXE: 123, DIAMOND_SHOVEL: 124, DIAMOND_SWORD: 125,
};

export const isBlock = (id) => id > 0 && id < 100;

// ---------- Texture tiles (atlas) ----------
// Each entry is a name -> drawing function into a 16x16 context. Order defines atlas index.
const TILE = 16;
const tileNames = [
  'stone', 'dirt', 'grass_top', 'grass_side', 'cobble', 'planks', 'log_side', 'log_top',
  'leaves', 'sand', 'gravel', 'glass', 'water', 'bedrock', 'coal_ore', 'iron_ore',
  'gold_ore', 'diamond_ore', 'snow', 'ice', 'sandstone', 'torch', 'ct_top', 'ct_side',
  'furnace_front', 'furnace_side', 'furnace_top', 'chest', 'tallgrass', 'flower_red', 'flower_yellow', 'cactus_side', 'cactus_top'
];
export const T = {}; tileNames.forEach((n, i) => T[n] = i);

// tiny seeded prng for texture noise
function prng(s) { return () => { s = (Math.imul(s, 1664525) + 1013904223) | 0; return ((s >>> 8) & 0xffff) / 0xffff; }; }

function speckle(ctx, base, spread, amt) {
  const r = prng(0x9e37 + amt);
  for (let y = 0; y < TILE; y++) for (let x = 0; x < TILE; x++) {
    const n = (r() - 0.5) * spread;
    ctx.fillStyle = shade(base, n);
    ctx.fillRect(x, y, 1, 1);
  }
}
function shade(hex, d) {
  let c = parseInt(hex.slice(1), 16);
  let r = (c >> 16) & 255, g = (c >> 8) & 255, b = c & 255;
  r = clamp(r + d * 255), g = clamp(g + d * 255), b = clamp(b + d * 255);
  return `rgb(${r|0},${g|0},${b|0})`;
}
const clamp = (v) => v < 0 ? 0 : v > 255 ? 255 : v;

const drawers = {
  stone: (c) => speckle(c, '#7d7d7d', 0.18, 1),
  dirt: (c) => speckle(c, '#7a5230', 0.22, 2),
  grass_top: (c) => speckle(c, '#5fa047', 0.22, 3),
  grass_side: (c) => { speckle(c, '#7a5230', 0.22, 2); c.fillStyle = '#5fa047'; for (let x = 0; x < TILE; x++) { const h = 3 + ((prng(x * 7)() * 3) | 0); c.fillRect(x, 0, 1, h); } },
  cobble: (c) => { speckle(c, '#8a8a8a', 0.10, 4); const r = prng(5); for (let i = 0; i < 14; i++) { c.fillStyle = shade('#6f6f6f', -0.2); c.fillRect((r()*14)|0, (r()*14)|0, 2 + (r()*2|0), 2 + (r()*2|0)); } },
  planks: (c) => { speckle(c, '#9c7142', 0.10, 5); c.fillStyle = shade('#9c7142', -0.25); for (let y = 0; y < TILE; y += 4) c.fillRect(0, y, TILE, 1); for (let y = 0; y < TILE; y += 8) c.fillRect(8, y, 1, 4); },
  log_side: (c) => { speckle(c, '#6b4a2b', 0.12, 6); c.fillStyle = shade('#6b4a2b', -0.25); for (let y = 0; y < TILE; y += 3) c.fillRect(0, y, TILE, 1); },
  log_top: (c) => { speckle(c, '#a9824f', 0.10, 7); c.strokeStyle = shade('#6b4a2b', -0.2); for (let i = 2; i < 8; i += 2) { c.beginPath(); c.arc(8, 8, i, 0, 7); c.stroke(); } },
  leaves: (c) => { const r = prng(8); for (let y = 0; y < TILE; y++) for (let x = 0; x < TILE; x++) { const v = r(); c.fillStyle = v < 0.12 ? 'rgba(0,0,0,0)' : shade('#3f8a34', (v - 0.5) * 0.4); c.fillRect(x, y, 1, 1); } },
  sand: (c) => speckle(c, '#dcd09a', 0.10, 9),
  gravel: (c) => { speckle(c, '#8a8378', 0.16, 10); const r = prng(11); for (let i = 0; i < 10; i++) { c.fillStyle = shade('#6b6b66', -0.2); c.fillRect((r()*15)|0, (r()*15)|0, 2, 2); } },
  glass: (c) => { c.clearRect(0, 0, TILE, TILE); c.strokeStyle = '#cfe9ff'; c.lineWidth = 1; c.strokeRect(0.5, 0.5, 15, 15); c.fillStyle = 'rgba(200,235,255,0.12)'; c.fillRect(1, 1, 14, 14); c.fillStyle = '#eaffff'; c.fillRect(3, 2, 4, 1); },
  water: (c) => { for (let y = 0; y < TILE; y++) for (let x = 0; x < TILE; x++) { const v = Math.sin((x + y) * 0.6) * 0.06; c.fillStyle = shade('#2a6cf0', v); c.fillRect(x, y, 1, 1); } },
  bedrock: (c) => { speckle(c, '#444', 0.30, 13); },
  coal_ore: (c) => { speckle(c, '#7d7d7d', 0.18, 1); const r = prng(14); for (let i = 0; i < 6; i++) { c.fillStyle = '#1c1c1c'; c.fillRect((r()*12)|0, (r()*12)|0, 2 + (r()*2|0), 2 + (r()*2|0)); } },
  iron_ore: (c) => { speckle(c, '#7d7d7d', 0.18, 1); const r = prng(15); for (let i = 0; i < 6; i++) { c.fillStyle = '#d9a679'; c.fillRect((r()*12)|0, (r()*12)|0, 2, 2); } },
  gold_ore: (c) => { speckle(c, '#7d7d7d', 0.18, 1); const r = prng(16); for (let i = 0; i < 6; i++) { c.fillStyle = '#f4d042'; c.fillRect((r()*12)|0, (r()*12)|0, 2, 2); } },
  diamond_ore: (c) => { speckle(c, '#7d7d7d', 0.18, 1); const r = prng(17); for (let i = 0; i < 6; i++) { c.fillStyle = '#3fe0d0'; c.fillRect((r()*12)|0, (r()*12)|0, 2, 2); } },
  snow: (c) => speckle(c, '#f4faff', 0.05, 18),
  ice: (c) => { for (let y = 0; y < TILE; y++) for (let x = 0; x < TILE; x++) { c.fillStyle = shade('#9fd0ff', Math.sin(x * 0.8 + y * 0.3) * 0.05); c.fillRect(x, y, 1, 1); } },
  sandstone: (c) => { speckle(c, '#d8cc97', 0.06, 20); c.fillStyle = shade('#d8cc97', -0.2); c.fillRect(0, 2, TILE, 1); c.fillRect(0, 13, TILE, 1); },
  torch: (c) => { c.clearRect(0, 0, TILE, TILE); c.fillStyle = '#8a5a2b'; c.fillRect(7, 6, 2, 9); c.fillStyle = '#ffd34d'; c.fillRect(6, 3, 4, 4); c.fillStyle = '#fff7c0'; c.fillRect(7, 4, 2, 2); },
  ct_top: (c) => { drawers.planks(c); c.strokeStyle = '#5c3f22'; c.strokeRect(1, 1, 13, 13); c.fillStyle = '#5c3f22'; c.fillRect(8, 1, 1, 14); c.fillRect(1, 8, 14, 1); },
  ct_side: (c) => { drawers.planks(c); c.fillStyle = '#5c3f22'; c.fillRect(2, 2, 5, 5); c.fillRect(9, 9, 4, 4); },
  furnace_front: (c) => { drawers.cobble(c); c.fillStyle = '#222'; c.fillRect(4, 7, 8, 6); c.fillStyle = '#ff8a2a'; c.fillRect(5, 10, 6, 2); },
  furnace_side: (c) => drawers.cobble(c),
  furnace_top: (c) => { drawers.cobble(c); c.fillStyle = '#333'; c.fillRect(5, 5, 6, 6); },
  chest: (c) => { drawers.planks(c); c.fillStyle = '#5c3f22'; c.strokeStyle = '#5c3f22'; c.strokeRect(0.5, 0.5, 15, 15); c.fillRect(0, 7, 16, 1); c.fillStyle = '#3a2814'; c.fillRect(7, 6, 2, 3); },
  tallgrass: (c) => { c.clearRect(0, 0, TILE, TILE); const r = prng(28); for (let x = 1; x < TILE; x += 2) { const h = 6 + (r() * 6 | 0); c.fillStyle = shade('#5fa047', (r() - 0.5) * 0.3); c.fillRect(x, TILE - h, 1, h); } },
  flower_red: (c) => { c.clearRect(0, 0, TILE, TILE); c.fillStyle = '#3f8a34'; c.fillRect(7, 8, 1, 7); c.fillStyle = '#e23b3b'; c.fillRect(5, 4, 6, 5); c.fillStyle = '#ffd34d'; c.fillRect(7, 6, 2, 2); },
  flower_yellow: (c) => { c.clearRect(0, 0, TILE, TILE); c.fillStyle = '#3f8a34'; c.fillRect(7, 8, 1, 7); c.fillStyle = '#f4d042'; c.fillRect(5, 4, 6, 5); c.fillStyle = '#7a5230'; c.fillRect(7, 6, 2, 2); },
  cactus_side: (c) => { speckle(c, '#2f7d3a', 0.10, 31); c.fillStyle = shade('#2f7d3a', -0.25); c.fillRect(1, 0, 1, TILE); c.fillRect(14, 0, 1, TILE); },
  cactus_top: (c) => { speckle(c, '#2f7d3a', 0.10, 32); c.fillStyle = shade('#2f7d3a', 0.2); c.fillRect(6, 6, 4, 4); },
};

// Build the atlas canvas
export function buildAtlas() {
  const cols = 8, rows = Math.ceil(tileNames.length / cols);
  const cv = document.createElement('canvas');
  cv.width = cols * TILE; cv.height = rows * TILE;
  const ctx = cv.getContext('2d');
  tileNames.forEach((name, i) => {
    const tx = (i % cols) * TILE, ty = ((i / cols) | 0) * TILE;
    const sub = document.createElement('canvas'); sub.width = TILE; sub.height = TILE;
    const sctx = sub.getContext('2d');
    (drawers[name] || drawers.stone)(sctx);
    ctx.drawImage(sub, tx, ty);
  });
  const uv = (idx) => {
    const x = idx % cols, y = (idx / cols) | 0;
    // tiny inset to avoid bleeding
    const e = 0.001;
    return [(x + e) / cols, 1 - (y + 1 - e) / rows, (x + 1 - e) / cols, 1 - (y + e) / rows];
  };
  return { canvas: cv, cols, rows, uv };
}

// ---------- Block registry ----------
// faces: [px, nx, py(top), ny(bottom), pz, nz] tile indices. render: 'cube'|'cross'|'liquid'
function cube(name, t, opt = {}) { return Object.assign({ id: 0, name, render: 'cube', solid: true, opaque: true, faces: [t, t, t, t, t, t], hardness: 1, light: 0 }, opt); }
const reg = {};
function def(id, b) { b.id = id; reg[id] = b; }

def(B.STONE, cube('Stone', T.stone, { hardness: 1.5, drop: B.COBBLE, toolType: 'pickaxe', needsTool: true, minTier: 1 }));
def(B.GRASS, cube('Grass Block', T.grass_top, { faces: [T.grass_side, T.grass_side, T.grass_top, T.dirt, T.grass_side, T.grass_side], hardness: 0.6, drop: B.DIRT, toolType: 'shovel' }));
def(B.DIRT, cube('Dirt', T.dirt, { hardness: 0.5, toolType: 'shovel' }));
def(B.COBBLE, cube('Cobblestone', T.cobble, { hardness: 2, toolType: 'pickaxe', needsTool: true, minTier: 1 }));
def(B.PLANKS, cube('Wood Planks', T.planks, { hardness: 2, toolType: 'axe', flammable: true }));
def(B.LOG, cube('Wood Log', T.log_side, { faces: [T.log_side, T.log_side, T.log_top, T.log_top, T.log_side, T.log_side], hardness: 2, toolType: 'axe' }));
def(B.LEAVES, cube('Leaves', T.leaves, { hardness: 0.2, opaque: false, drop: 0, toolType: 'shears' }));
def(B.SAND, cube('Sand', T.sand, { hardness: 0.5, toolType: 'shovel', gravity: true }));
def(B.GRAVEL, cube('Gravel', T.gravel, { hardness: 0.6, toolType: 'shovel', gravity: true }));
def(B.GLASS, cube('Glass', T.glass, { hardness: 0.3, opaque: false, drop: 0 }));
def(B.WATER, cube('Water', T.water, { render: 'liquid', solid: false, opaque: false, liquid: true, hardness: 999, drop: 0 }));
def(B.BEDROCK, cube('Bedrock', T.bedrock, { hardness: -1, drop: 0, needsTool: true, minTier: 99 }));
def(B.COAL_ORE, cube('Coal Ore', T.coal_ore, { hardness: 3, drop: I.COAL, toolType: 'pickaxe', needsTool: true, minTier: 1, xp: 1 }));
def(B.IRON_ORE, cube('Iron Ore', T.iron_ore, { hardness: 3, toolType: 'pickaxe', needsTool: true, minTier: 2 }));
def(B.GOLD_ORE, cube('Gold Ore', T.gold_ore, { hardness: 3, toolType: 'pickaxe', needsTool: true, minTier: 3 }));
def(B.DIAMOND_ORE, cube('Diamond Ore', T.diamond_ore, { hardness: 3, drop: I.DIAMOND, toolType: 'pickaxe', needsTool: true, minTier: 2, xp: 4 }));
def(B.SNOW, cube('Snow Block', T.snow, { hardness: 0.4, toolType: 'shovel' }));
def(B.ICE, cube('Ice', T.ice, { hardness: 0.5, opaque: false, drop: 0, slippery: true, toolType: 'pickaxe' }));
def(B.SANDSTONE, cube('Sandstone', T.sandstone, { hardness: 0.8, toolType: 'pickaxe', needsTool: true, minTier: 1 }));
def(B.TORCH, cube('Torch', T.torch, { render: 'cross', solid: false, opaque: false, light: 14, hardness: 0 }));
def(B.CRAFTING_TABLE, cube('Crafting Table', T.ct_top, { faces: [T.ct_side, T.ct_side, T.ct_top, T.planks, T.ct_side, T.ct_side], hardness: 2.5, toolType: 'axe' }));
def(B.FURNACE, cube('Furnace', T.furnace_side, { faces: [T.furnace_front, T.furnace_side, T.furnace_top, T.furnace_top, T.furnace_side, T.furnace_side], hardness: 3.5, toolType: 'pickaxe', needsTool: true, minTier: 1, blockEntity: 'furnace' }));
def(B.CHEST, cube('Chest', T.chest, { hardness: 2.5, toolType: 'axe', blockEntity: 'chest' }));
def(B.TALL_GRASS, cube('Tall Grass', T.tallgrass, { render: 'cross', solid: false, opaque: false, hardness: 0, drop: 0 }));
def(B.FLOWER_RED, cube('Red Flower', T.flower_red, { render: 'cross', solid: false, opaque: false, hardness: 0 }));
def(B.FLOWER_YELLOW, cube('Yellow Flower', T.flower_yellow, { render: 'cross', solid: false, opaque: false, hardness: 0 }));
def(B.CACTUS, cube('Cactus', T.cactus_side, { faces: [T.cactus_side, T.cactus_side, T.cactus_top, T.cactus_top, T.cactus_side, T.cactus_side], hardness: 0.4, opaque: false }));

export const BLOCKS = reg;
export const blockDef = (id) => reg[id];
export const isOpaque = (id) => id !== 0 && reg[id] && reg[id].opaque;
export const isSolid = (id) => id !== 0 && reg[id] && reg[id].solid;
export const isLiquid = (id) => reg[id] && reg[id].liquid;
export const lightOf = (id) => (reg[id] && reg[id].light) || 0;

// ---------- Item registry (non-block) ----------
const items = {};
function defItem(id, o) { o.id = id; items[id] = o; }
defItem(I.STICK, { name: 'Stick', stack: 64 });
defItem(I.COAL, { name: 'Coal', stack: 64, fuel: 8 });
defItem(I.CHARCOAL, { name: 'Charcoal', stack: 64, fuel: 8 });
defItem(I.IRON_INGOT, { name: 'Iron Ingot', stack: 64 });
defItem(I.GOLD_INGOT, { name: 'Gold Ingot', stack: 64 });
defItem(I.DIAMOND, { name: 'Diamond', stack: 64 });
defItem(I.APPLE, { name: 'Apple', stack: 64, food: 4 });
defItem(I.BREAD, { name: 'Bread', stack: 64, food: 5 });
defItem(I.RAW_MEAT, { name: 'Raw Meat', stack: 64, food: 2 });
defItem(I.COOKED_MEAT, { name: 'Cooked Meat', stack: 64, food: 8 });

// tools
const tierName = ['', 'Wooden', 'Stone', 'Iron', 'Diamond'];
const tierDura = [0, 59, 131, 250, 1561];
const tierAtk = { sword: [0, 4, 5, 6, 7], axe: [0, 3, 4, 5, 6] };
function defTool(id, type, tier) {
  items[id] = { id, name: `${tierName[tier]} ${type[0].toUpperCase() + type.slice(1)}`, stack: 1, tool: type, tier, durability: tierDura[tier], attack: (tierAtk[type] ? tierAtk[type][tier] : 2) };
}
[['WOOD', 1], ['STONE', 2], ['IRON', 3], ['DIAMOND', 4]].forEach(([k, tier]) => {
  defTool(I[k + '_PICK'], 'pickaxe', tier);
  defTool(I[k + '_AXE'], 'axe', tier);
  defTool(I[k + '_SHOVEL'], 'shovel', tier);
  defTool(I[k + '_SWORD'], 'sword', tier);
});
export const ITEMS = items;
export function itemDef(id) { return isBlock(id) ? reg[id] : items[id]; }
export function displayName(id) { const d = itemDef(id); return d ? d.name : '?'; }
export function maxStack(id) { const d = itemDef(id); if (!d) return 64; if (d.tool) return 1; return d.stack || 64; }

// ---------- UI icon rendering (cached canvases) ----------
const iconCache = new Map();
let _atlas = null;
export function setAtlasForIcons(a) { _atlas = a; }
export function itemIcon(id) {
  if (iconCache.has(id)) return iconCache.get(id);
  const cv = document.createElement('canvas'); cv.width = 32; cv.height = 32;
  const ctx = cv.getContext('2d'); ctx.imageSmoothingEnabled = false;
  if (isBlock(id)) {
    // draw representative face from atlas
    const d = reg[id];
    const face = d.faces[0] === T.water ? T.water : (d.faces[4] ?? d.faces[0]);
    const top = d.faces[2];
    if (d.render === 'cross' || !d.opaque && d.render !== 'cube') {
      blitTile(ctx, face, 0, 0, 32, 32);
    } else {
      // simple faux-iso: top + front
      blitTile(ctx, top, 4, 0, 24, 14);
      blitTile(ctx, face, 4, 12, 24, 20);
      ctx.fillStyle = 'rgba(0,0,0,0.12)'; ctx.fillRect(4, 12, 24, 20);
    }
  } else {
    drawItemIcon(ctx, items[id]);
  }
  iconCache.set(id, cv); return cv;
}
function blitTile(ctx, idx, dx, dy, dw, dh) {
  if (!_atlas) { ctx.fillStyle = '#888'; ctx.fillRect(dx, dy, dw, dh); return; }
  const cols = _atlas.cols, x = (idx % cols) * 16, y = ((idx / cols) | 0) * 16;
  ctx.drawImage(_atlas.canvas, x, y, 16, 16, dx, dy, dw, dh);
}
function drawItemIcon(ctx, it) {
  if (!it) { ctx.fillStyle = '#f0f'; ctx.fillRect(8, 8, 16, 16); return; }
  if (it.tool) {
    const col = { 1: '#9c7142', 2: '#9a9a9a', 3: '#e8e8e8', 4: '#5fe0d4' }[it.tier];
    ctx.fillStyle = '#6b4a2b'; ctx.fillRect(14, 8, 3, 18); // handle
    ctx.fillStyle = col;
    if (it.tool === 'pickaxe') { ctx.fillRect(6, 6, 20, 3); ctx.fillRect(6, 6, 3, 4); ctx.fillRect(23, 6, 3, 4); }
    else if (it.tool === 'axe') { ctx.fillRect(15, 5, 8, 8); ctx.fillRect(13, 6, 3, 6); }
    else if (it.tool === 'shovel') { ctx.fillRect(12, 5, 8, 8); }
    else if (it.tool === 'sword') { ctx.fillStyle = '#6b4a2b'; ctx.fillRect(13, 18, 6, 3); ctx.fillStyle = col; ctx.fillRect(15, 4, 3, 16); }
    return;
  }
  const swatch = {
    [I.STICK]: () => { ctx.fillStyle = '#9c7142'; ctx.fillRect(14, 6, 4, 20); },
    [I.COAL]: () => { ctx.fillStyle = '#1c1c1c'; ctx.fillRect(7, 9, 18, 14); },
    [I.CHARCOAL]: () => { ctx.fillStyle = '#2b2620'; ctx.fillRect(7, 9, 18, 14); },
    [I.IRON_INGOT]: () => { ctx.fillStyle = '#d9d9d9'; ctx.fillRect(7, 12, 18, 8); },
    [I.GOLD_INGOT]: () => { ctx.fillStyle = '#f4d042'; ctx.fillRect(7, 12, 18, 8); },
    [I.DIAMOND]: () => { ctx.fillStyle = '#3fe0d0'; ctx.beginPath(); ctx.moveTo(16, 6); ctx.lineTo(26, 16); ctx.lineTo(16, 26); ctx.lineTo(6, 16); ctx.closePath(); ctx.fill(); },
    [I.APPLE]: () => { ctx.fillStyle = '#e23b3b'; ctx.beginPath(); ctx.arc(16, 18, 9, 0, 7); ctx.fill(); ctx.fillStyle = '#5fa047'; ctx.fillRect(15, 6, 2, 5); },
    [I.BREAD]: () => { ctx.fillStyle = '#c98a3a'; ctx.fillRect(6, 12, 20, 10); ctx.fillStyle = '#8a5a2b'; ctx.fillRect(6, 12, 20, 2); },
    [I.RAW_MEAT]: () => { ctx.fillStyle = '#d97a7a'; ctx.fillRect(8, 10, 16, 12); ctx.fillStyle = '#fff'; ctx.fillRect(8, 10, 16, 3); },
    [I.COOKED_MEAT]: () => { ctx.fillStyle = '#9a5a2b'; ctx.fillRect(8, 10, 16, 12); ctx.fillStyle = '#5a3318'; ctx.fillRect(8, 10, 16, 3); },
  };
  (swatch[it.id] || (() => { ctx.fillStyle = '#aaa'; ctx.fillRect(8, 8, 16, 16); }))();
}

// ---------- Recipes ----------
// Shaped recipe uses a grid pattern with a key. Shapeless uses an ingredient multiset.
// result: {id, count}
export const RECIPES = [];
function shaped(pattern, key, result) { RECIPES.push({ type: 'shaped', pattern, key, result }); }
function shapeless(ids, result) { RECIPES.push({ type: 'shapeless', ids, result }); }

shapeless([B.LOG], { id: B.PLANKS, count: 4 });
shaped(['P', 'P'], { P: B.PLANKS }, { id: I.STICK, count: 4 });
shaped(['PP', 'PP'], { P: B.PLANKS }, { id: B.CRAFTING_TABLE, count: 1 });
shaped(['CCC', 'C C', 'CCC'], { C: B.COBBLE }, { id: B.FURNACE, count: 1 });
shaped(['PPP', 'P P', 'PPP'], { P: B.PLANKS }, { id: B.CHEST, count: 1 });
shaped(['C', 'S'], { C: I.COAL, S: I.STICK }, { id: B.TORCH, count: 4 });
shaped(['SS', 'SS'], { S: B.SAND }, { id: B.SANDSTONE, count: 1 });
// tools & swords per tier
function toolRecipes(mat, picks) {
  shaped(['MMM', ' S ', ' S '], { M: mat, S: I.STICK }, { id: picks.pick, count: 1 });
  shaped(['MM', 'MS', ' S'], { M: mat, S: I.STICK }, { id: picks.axe, count: 1 });
  shaped(['M', 'S', 'S'], { M: mat, S: I.STICK }, { id: picks.shovel, count: 1 });
  shaped(['M', 'M', 'S'], { M: mat, S: I.STICK }, { id: picks.sword, count: 1 });
}
toolRecipes(B.PLANKS, { pick: I.WOOD_PICK, axe: I.WOOD_AXE, shovel: I.WOOD_SHOVEL, sword: I.WOOD_SWORD });
toolRecipes(B.COBBLE, { pick: I.STONE_PICK, axe: I.STONE_AXE, shovel: I.STONE_SHOVEL, sword: I.STONE_SWORD });
toolRecipes(I.IRON_INGOT, { pick: I.IRON_PICK, axe: I.IRON_AXE, shovel: I.IRON_SHOVEL, sword: I.IRON_SWORD });
toolRecipes(I.DIAMOND, { pick: I.DIAMOND_PICK, axe: I.DIAMOND_AXE, shovel: I.DIAMOND_SHOVEL, sword: I.DIAMOND_SWORD });

// match a grid (array of ids, size*size) against recipes. Returns result {id,count} or null.
export function matchRecipe(grid, size) {
  // shapeless: compare multisets
  const present = grid.filter((x) => x);
  for (const r of RECIPES) {
    if (r.result.count === 0) continue;
    if (r.type === 'shapeless') {
      if (present.length !== r.ids.length) continue;
      const a = [...present].sort((x, y) => x - y), b = [...r.ids].sort((x, y) => x - y);
      if (a.every((v, i) => v === b[i])) return r.result;
    } else {
      if (matchShaped(grid, size, r)) return r.result;
    }
  }
  return null;
}
function matchShaped(grid, size, r) {
  // trim recipe pattern to a 2D char grid
  const pat = r.pattern.map((row) => row.split(''));
  const ph = pat.length, pw = Math.max(...pat.map((p) => p.length));
  // try all offsets within the size grid
  for (let oy = 0; oy + ph <= size; oy++) {
    for (let ox = 0; ox + pw <= size; ox++) {
      if (checkOffset(grid, size, pat, ph, pw, ox, oy, r.key)) return true;
    }
  }
  return false;
}
function checkOffset(grid, size, pat, ph, pw, ox, oy, key) {
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const want = (y >= oy && y < oy + ph && x >= ox && x < ox + pw) ? (pat[y - oy][x - ox] || ' ') : ' ';
      const have = grid[y * size + x] || 0;
      if (want === ' ' || want === undefined) { if (have) return false; }
      else { if (key[want] !== have) return false; }
    }
  }
  return true;
}

// ---------- Smelting ----------
export const SMELT = {
  [B.IRON_ORE]: I.IRON_INGOT, [B.GOLD_ORE]: I.GOLD_INGOT, [B.SAND]: B.GLASS,
  [B.COBBLE]: B.STONE, [B.LOG]: I.CHARCOAL, [I.RAW_MEAT]: I.COOKED_MEAT,
};
export function fuelValue(id) { const d = itemDef(id); if (d && d.fuel) return d.fuel; if (id === B.PLANKS) return 1.5; if (id === B.LOG) return 1.5; if (id === I.STICK) return 0.5; return 0; }
