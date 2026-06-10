// world.js — chunks, seeded terrain generation, voxel lighting (sky+block flood fill), and the chunk mesher.
import * as THREE from 'three';
import { makeNoise } from './noise.js';
import { B, blockDef, isOpaque, isSolid, isLiquid, lightOf } from './blocks.js';

export const CH = 16;            // chunk width/depth
export const WH = 128;           // world height
export const SEA = 40;           // sea level
const AREA = CH * CH;
const VOL = CH * WH * CH;
export const idx = (x, y, z) => x + CH * z + AREA * y;
export const key = (cx, cz) => cx + ',' + cz;

// ---------------- Chunk ----------------
export class Chunk {
  constructor(cx, cz) {
    this.cx = cx; this.cz = cz;
    this.blocks = new Uint8Array(VOL);
    this.sky = new Uint8Array(VOL);
    this.block = new Uint8Array(VOL);
    this.generated = false;
    this.dirty = false;          // edited by player → must be saved
    this.meshDirty = true;       // needs remesh
    this.meshes = null;          // {solid,cutout,water} THREE.Mesh
    this.entities = [];          // block entities by "x,y,z" handled in world map instead
  }
  get(x, y, z) { return this.blocks[idx(x, y, z)]; }
  set(x, y, z, v) { this.blocks[idx(x, y, z)] = v; }
}

// ---------------- World ----------------
export class World {
  constructor(seed, opts = {}) {
    this.seed = seed | 0;
    this.noise = makeNoise(this.seed);
    this.chunks = new Map();
    this.blockEntities = new Map(); // "wx,wy,wz" -> {type,...}
    this.maxHeightHint = SEA + 30;
    this.sizeHint = opts.size || 64;
  }

  getChunk(cx, cz) { return this.chunks.get(key(cx, cz)); }

  ensureChunk(cx, cz) {
    let c = this.chunks.get(key(cx, cz));
    if (!c) { c = new Chunk(cx, cz); this.chunks.set(key(cx, cz), c); }
    if (!c.generated) { this.generate(c); this.computeLight(c); }
    return c;
  }

  getBlock(wx, wy, wz) {
    if (wy < 0 || wy >= WH) return 0;
    const cx = Math.floor(wx / CH), cz = Math.floor(wz / CH);
    const c = this.chunks.get(key(cx, cz));
    if (!c || !c.generated) return 0;
    return c.blocks[idx(wx - cx * CH, wy, wz - cz * CH)];
  }
  getSky(wx, wy, wz) {
    if (wy >= WH) return 15; if (wy < 0) return 0;
    const cx = Math.floor(wx / CH), cz = Math.floor(wz / CH);
    const c = this.chunks.get(key(cx, cz));
    if (!c || !c.generated) return 15;
    return c.sky[idx(wx - cx * CH, wy, wz - cz * CH)];
  }
  getBlockLight(wx, wy, wz) {
    if (wy < 0 || wy >= WH) return 0;
    const cx = Math.floor(wx / CH), cz = Math.floor(wz / CH);
    const c = this.chunks.get(key(cx, cz));
    if (!c || !c.generated) return 0;
    return c.block[idx(wx - cx * CH, wy, wz - cz * CH)];
  }

  // Edit a block at world coords; marks dirty + relights + flags remesh of self & neighbors.
  setBlock(wx, wy, wz, v) {
    if (wy < 0 || wy >= WH) return;
    const cx = Math.floor(wx / CH), cz = Math.floor(wz / CH);
    const c = this.ensureChunk(cx, cz);
    const lx = wx - cx * CH, lz = wz - cz * CH;
    c.set(lx, wy, lz, v);
    c.dirty = true;
    this.computeLight(c);
    c.meshDirty = true;
    // neighbor remesh if on border
    if (lx === 0) this.flagRemesh(cx - 1, cz);
    if (lx === CH - 1) this.flagRemesh(cx + 1, cz);
    if (lz === 0) this.flagRemesh(cx, cz - 1);
    if (lz === CH - 1) this.flagRemesh(cx, cz + 1);
  }
  flagRemesh(cx, cz) { const c = this.chunks.get(key(cx, cz)); if (c) c.meshDirty = true; }

  // ---------------- Terrain generation ----------------
  columnInfo(wx, wz) {
    const n = this.noise;
    const cont = n.fbm2(wx * 0.0035, wz * 0.0035, 4);          // continents
    const hills = n.fbm2(wx * 0.013, wz * 0.013, 4);           // local hills
    const mtn = Math.pow(Math.max(0, n.fbm2(wx * 0.006 + 50, wz * 0.0066 + 50, 4) - 0.45), 1.5) * 60;
    let h = SEA - 6 + (cont - 0.45) * 46 + (hills - 0.5) * 16 + mtn;
    h = Math.max(4, Math.min(WH - 12, Math.round(h)));
    const temp = n.fbm2(wx * 0.004 + 1000, wz * 0.004, 3);
    const hum = n.fbm2(wx * 0.004, wz * 0.004 + 2000, 3);
    let biome;
    if (h < SEA - 1) biome = 'ocean';
    else if (h <= SEA + 1) biome = 'beach';
    else if (temp > 0.62 && hum < 0.45) biome = 'desert';
    else if (temp < 0.32) biome = 'snowy';
    else if (h > SEA + 26) biome = 'mountains';
    else if (hum > 0.55) biome = 'forest';
    else biome = 'plains';
    return { h, biome, temp, hum };
  }

  generate(c) {
    const ox = c.cx * CH, oz = c.cz * CH, n = this.noise;
    const bl = c.blocks;
    for (let lz = 0; lz < CH; lz++) {
      for (let lx = 0; lx < CH; lx++) {
        const wx = ox + lx, wz = oz + lz;
        const info = this.columnInfo(wx, wz);
        const h = info.h, biome = info.biome;
        let surface = B.GRASS, sub = B.DIRT;
        if (biome === 'desert' || biome === 'beach') { surface = B.SAND; sub = B.SAND; }
        else if (biome === 'snowy') { surface = B.SNOW; sub = B.DIRT; }
        else if (biome === 'mountains' && h > SEA + 40) { surface = B.STONE; sub = B.STONE; }
        else if (biome === 'ocean') { surface = B.GRAVEL; sub = B.DIRT; }
        for (let y = 0; y <= Math.max(h, SEA); y++) {
          let v = 0;
          if (y <= 2) v = (y === 0 || n.rand(wx * 7 + y, wz * 13) < 0.5 ? B.BEDROCK : B.STONE);
          else if (y < h - 4) v = B.STONE;
          else if (y < h) v = sub;
          else if (y === h) v = surface;
          else if (y <= SEA) v = (biome === 'snowy' && y === SEA) ? B.ICE : B.WATER;
          // caves: carve below surface
          if (v === B.STONE || v === sub) {
            const cave = n.fbm3(wx * 0.05, y * 0.07, wz * 0.05, 3);
            const cave2 = n.fbm3(wx * 0.05 + 99, y * 0.07, wz * 0.05 + 99, 3);
            if (y > 3 && y < h - 1 && cave > 0.55 && cave2 > 0.5) v = 0;
          }
          if (v) bl[idx(lx, y, lz)] = v;
        }
        // ores
        for (let y = 3; y < Math.min(h, WH - 1); y++) {
          if (bl[idx(lx, y, lz)] !== B.STONE) continue;
          const r = n.rand(wx * 31 + y * 17, wz * 53 + y * 7);
          if (y < 16 && r < 0.012) bl[idx(lx, y, lz)] = B.DIAMOND_ORE;
          else if (y < 30 && r < 0.02) bl[idx(lx, y, lz)] = B.GOLD_ORE;
          else if (y < 56 && r < 0.04) bl[idx(lx, y, lz)] = B.IRON_ORE;
          else if (r < 0.06) bl[idx(lx, y, lz)] = B.COAL_ORE;
        }
      }
    }
    // vegetation & trees — iterate an expanded region so canopies cross chunk borders seamlessly
    for (let bz = -2; bz < CH + 2; bz++) {
      for (let bx = -2; bx < CH + 2; bx++) {
        const wx = ox + bx, wz = oz + bz;
        const info = this.columnInfo(wx, wz);
        const h = info.h, biome = info.biome;
        if (h <= SEA) continue;
        const r = n.rand(wx * 911 + 7, wz * 877 + 3);
        if (biome === 'forest' && r < 0.06) this.stampTree(c, bx, h + 1, bz, 'oak');
        else if (biome === 'plains' && r < 0.012) this.stampTree(c, bx, h + 1, bz, 'oak');
        else if (biome === 'snowy' && r < 0.02) this.stampTree(c, bx, h + 1, bz, 'spruce');
        else if (biome === 'desert' && r < 0.01) this.stampCactus(c, bx, h + 1, bz);
        else {
          // small plants only within this chunk's own columns
          if (bx >= 0 && bx < CH && bz >= 0 && bz < CH && biome !== 'ocean' && biome !== 'beach' && biome !== 'desert') {
            const rr = n.rand(wx * 17 + 5, wz * 23 + 9);
            if (rr < 0.10) this.put(c, bx, h + 1, bz, B.TALL_GRASS);
            else if (rr < 0.115) this.put(c, bx, h + 1, bz, B.FLOWER_RED);
            else if (rr < 0.13) this.put(c, bx, h + 1, bz, B.FLOWER_YELLOW);
          }
        }
      }
    }
    c.generated = true;
  }
  // write only if cell is inside this chunk and currently air
  put(c, lx, y, lz, v, overwrite = false) {
    if (lx < 0 || lx >= CH || lz < 0 || lz >= CH || y < 0 || y >= WH) return;
    const i = idx(lx, y, lz);
    if (overwrite || c.blocks[i] === 0) c.blocks[i] = v;
  }
  stampTree(c, lx, baseY, lz, type) {
    const th = type === 'spruce' ? 6 : (4 + (Math.abs((lx * 31 + lz * 7) % 3)));
    const trunk = B.LOG, leaf = B.LEAVES;
    for (let i = 0; i < th; i++) this.put(c, lx, baseY + i, lz, trunk);
    const top = baseY + th;
    const rad = type === 'spruce' ? 2 : 2;
    for (let dy = -2; dy <= 1; dy++) {
      const ry = top + dy;
      const r = dy >= 0 ? 1 : 2;
      for (let dx = -r; dx <= r; dx++) for (let dz = -r; dz <= r; dz++) {
        if (dx === 0 && dz === 0 && dy < 1) continue;
        if (Math.abs(dx) === r && Math.abs(dz) === r && (dx * dz !== 0)) continue;
        this.put(c, lx + dx, ry, lz + dz, leaf);
      }
    }
    this.put(c, lx, top + 1, lz, leaf);
  }
  stampCactus(c, lx, baseY, lz) {
    const hgt = 1 + (Math.abs((lx * 13 + lz * 7) % 3));
    for (let i = 0; i < hgt; i++) this.put(c, lx, baseY + i, lz, B.CACTUS);
  }

  // ---------------- Lighting (sky + block flood fill, per chunk) ----------------
  computeLight(c) {
    const sky = c.sky, blk = c.block, bl = c.blocks;
    sky.fill(0); blk.fill(0);
    const q = [];
    // sky columns
    for (let z = 0; z < CH; z++) for (let x = 0; x < CH; x++) {
      let y = WH - 1, lit = true;
      while (y >= 0) {
        const i = idx(x, y, z);
        if (lit && !isOpaque(bl[i])) { sky[i] = 15; q.push(i); }
        else { lit = false; }
        y--;
      }
    }
    this.flood(c, sky, q, true);
    // block light emitters
    const q2 = [];
    for (let i = 0; i < VOL; i++) { const e = lightOf(bl[i]); if (e > 0) { blk[i] = e; q2.push(i); } }
    this.flood(c, blk, q2, false);
  }
  flood(c, light, queue, isSky) {
    const bl = c.blocks;
    let head = 0;
    while (head < queue.length) {
      const i = queue[head++];
      const lv = light[i];
      if (lv <= 1) continue;
      const y = (i / AREA) | 0; const rem = i - y * AREA; const z = (rem / CH) | 0; const x = rem - z * CH;
      const nb = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
      for (let k = 0; k < 6; k++) {
        const nx = x + nb[k][0], ny = y + nb[k][1], nz = z + nb[k][2];
        if (nx < 0 || nx >= CH || nz < 0 || nz >= CH || ny < 0 || ny >= WH) continue;
        const ni = idx(nx, ny, nz);
        if (isOpaque(bl[ni])) continue;
        // sunlight travels straight down without losing level
        let nl = lv - 1;
        if (isSky && nb[k][1] === -1 && lv === 15) nl = 15;
        if (light[ni] < nl) { light[ni] = nl; queue.push(ni); }
      }
    }
  }

  // ---------------- Save / Load ----------------
  serializeChunk(c) {
    // RLE over block array
    const a = c.blocks; const out = [];
    let run = 1;
    for (let i = 1; i <= a.length; i++) {
      if (i < a.length && a[i] === a[i - 1] && run < 65535) run++;
      else { out.push(a[i - 1], run); run = 1; }
    }
    return out;
  }
  static inflateChunk(c, rle) {
    const a = c.blocks; let p = 0;
    for (let i = 0; i < rle.length; i += 2) { const v = rle[i], n = rle[i + 1]; for (let k = 0; k < n; k++) a[p++] = v; }
    c.generated = true;
  }
}

// ===================================================================
//  Mesher  — builds solid / cutout / water geometry for a chunk
// ===================================================================
const FACES = [
  { n: [1, 0, 0], u: [0, 1, 0], v: [0, 0, 1], fi: 0 },
  { n: [-1, 0, 0], u: [0, 1, 0], v: [0, 0, 1], fi: 1 },
  { n: [0, 1, 0], u: [1, 0, 0], v: [0, 0, 1], fi: 2 },
  { n: [0, -1, 0], u: [1, 0, 0], v: [0, 0, 1], fi: 3 },
  { n: [0, 0, 1], u: [1, 0, 0], v: [0, 1, 0], fi: 4 },
  { n: [0, 0, -1], u: [1, 0, 0], v: [0, 1, 0], fi: 5 },
];
const CORNERS = [[0, 0], [1, 0], [1, 1], [0, 1]];

function vAO(s1, s2, cor) { if (s1 && s2) return 0; return 3 - (s1 + s2 + cor); }

class Builder {
  constructor() { this.pos = []; this.uv = []; this.al = []; this.idx = []; this.count = 0; }
  quad(p, uvq, sky, blk, ao) {
    const b = this.count;
    for (let i = 0; i < 4; i++) {
      this.pos.push(p[i][0], p[i][1], p[i][2]);
      this.uv.push(uvq[i][0], uvq[i][1]);
      const a = (ao[i] + 1) / 4; // 0..3 -> 0.25..1
      this.al.push(sky / 15, blk / 15, a);
    }
    // flip quad if AO asymmetric to reduce artifacts
    if (ao[0] + ao[2] > ao[1] + ao[3]) this.idx.push(b + 1, b + 2, b + 3, b + 1, b + 3, b + 0);
    else this.idx.push(b, b + 1, b + 2, b, b + 2, b + 3);
    this.count += 4;
  }
  geometry() {
    if (this.count === 0) return null;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    g.setAttribute('alight', new THREE.Float32BufferAttribute(this.al, 3));
    g.setIndex(this.idx);
    g.computeVertexNormals();
    return g;
  }
}

export function meshChunk(world, c, atlas) {
  const solid = new Builder(), cutout = new Builder(), water = new Builder();
  const ox = c.cx * CH, oz = c.cz * CH, bl = c.blocks;
  for (let y = 0; y < WH; y++) {
    for (let z = 0; z < CH; z++) {
      for (let x = 0; x < CH; x++) {
        const id = bl[idx(x, y, z)];
        if (!id) continue;
        const def = blockDef(id);
        const wx = ox + x, wy = y, wz = oz + z;
        if (def.render === 'cross') { addCross(cutout, def, atlas, wx, wy, wz, world); continue; }
        if (def.render === 'liquid') { addLiquid(water, def, atlas, x, y, z, wx, wy, wz, world); continue; }
        const target = def.opaque ? solid : cutout;
        for (const F of FACES) {
          const nx = wx + F.n[0], ny = wy + F.n[1], nz = wz + F.n[2];
          const nb = world.getBlock(nx, ny, nz);
          const nbDef = nb ? blockDef(nb) : null;
          const visible = !nb || (!nbDef.opaque && nb !== id) || (nbDef.render === 'liquid' && def.opaque);
          if (!visible) continue;
          emitFace(target, def, atlas, wx, wy, wz, F, world);
        }
      }
    }
  }
  return { solid: solid.geometry(), cutout: cutout.geometry(), water: water.geometry() };
}

function emitFace(b, def, atlas, wx, wy, wz, F, world) {
  const tile = def.faces[F.fi];
  const [u0, v0, u1, v1] = atlas.uv(tile);
  const fx = wx + F.n[0], fy = wy + F.n[1], fz = wz + F.n[2];
  const sky = world.getSky(fx, fy, fz);
  const blk = world.getBlockLight(fx, fy, fz);
  const p = [], uvq = [], ao = [];
  for (let i = 0; i < 4; i++) {
    const uVal = CORNERS[i][0], vVal = CORNERS[i][1];
    const cx = (F.n[0] > 0 ? 1 : 0) + F.u[0] * uVal + F.v[0] * vVal;
    const cy = (F.n[1] > 0 ? 1 : 0) + F.u[1] * uVal + F.v[1] * vVal;
    const cz = (F.n[2] > 0 ? 1 : 0) + F.u[2] * uVal + F.v[2] * vVal;
    p.push([wx + cx, wy + cy, wz + cz]);
    uvq.push([uVal ? u1 : u0, vVal ? v1 : v0]);
    // AO sampling around the front cell
    const du = uVal ? 1 : -1, dv = vVal ? 1 : -1;
    const s1 = isOpaque(world.getBlock(fx + F.u[0] * du, fy + F.u[1] * du, fz + F.u[2] * du)) ? 1 : 0;
    const s2 = isOpaque(world.getBlock(fx + F.v[0] * dv, fy + F.v[1] * dv, fz + F.v[2] * dv)) ? 1 : 0;
    const cc = isOpaque(world.getBlock(fx + F.u[0] * du + F.v[0] * dv, fy + F.u[1] * du + F.v[1] * dv, fz + F.u[2] * du + F.v[2] * dv)) ? 1 : 0;
    ao.push(vAO(s1, s2, cc));
  }
  b.quad(p, uvq, sky, blk, ao);
}

function addCross(b, def, atlas, wx, wy, wz, world) {
  const tile = def.faces[0];
  const [u0, v0, u1, v1] = atlas.uv(tile);
  const sky = world.getSky(wx, wy, wz), blk = Math.max(world.getBlockLight(wx, wy, wz), def.light || 0);
  const ao = [3, 3, 3, 3];
  const diag = [
    [[0, 0, 0], [1, 0, 1], [1, 1, 1], [0, 1, 0]],
    [[0, 0, 1], [1, 0, 0], [1, 1, 0], [0, 1, 1]],
  ];
  for (const d of diag) {
    const p = d.map((o) => [wx + o[0], wy + o[1], wz + o[2]]);
    const uvq = [[u0, v0], [u1, v0], [u1, v1], [u0, v1]];
    b.quad(p, uvq, sky, blk, ao);
  }
}

function addLiquid(b, def, atlas, x, y, z, wx, wy, wz, world) {
  const above = world.getBlock(wx, wy + 1, wz);
  const topLower = isLiquid(above) ? 0 : 0.12;
  const tile = def.faces[0];
  const [u0, v0, u1, v1] = atlas.uv(tile);
  const sky = world.getSky(wx, wy + 1, wz), blk = world.getBlockLight(wx, wy + 1, wz);
  for (const F of FACES) {
    const nx = wx + F.n[0], ny = wy + F.n[1], nz = wz + F.n[2];
    const nb = world.getBlock(nx, ny, nz);
    if (isLiquid(nb)) continue;
    if (nb && isOpaque(blockDef(nb))) continue;
    if (F.fi === 3 && nb) continue; // skip hidden bottom
    const ao = [3, 3, 3, 3];
    const p = [], uvq = [];
    for (let i = 0; i < 4; i++) {
      const uVal = CORNERS[i][0], vVal = CORNERS[i][1];
      let cx = (F.n[0] > 0 ? 1 : 0) + F.u[0] * uVal + F.v[0] * vVal;
      let cy = (F.n[1] > 0 ? 1 : 0) + F.u[1] * uVal + F.v[1] * vVal;
      let cz = (F.n[2] > 0 ? 1 : 0) + F.u[2] * uVal + F.v[2] * vVal;
      if (cy >= 1) cy -= topLower; // lower the top surface a touch
      p.push([wx + cx, wy + cy, wz + cz]);
      uvq.push([uVal ? u1 : u0, vVal ? v1 : v0]);
    }
    b.quad(p, uvq, sky, blk, ao);
  }
}
