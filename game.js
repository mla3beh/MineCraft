// game.js — engine, player, physics, interaction, inventory/crafting UI, mobs, day/night, save/load, main loop.
import * as THREE from 'three';
import { World, meshChunk, CH, WH, SEA, key } from './world.js';
import {
  B, I, BLOCKS, ITEMS, blockDef, itemDef, isBlock, isSolid, isLiquid, isOpaque,
  buildAtlas, setAtlasForIcons, itemIcon, displayName, maxStack,
  matchRecipe, SMELT, fuelValue,
} from './blocks.js';
import * as DB from './persistence.js';

const $ = (id) => document.getElementById(id);
const TAU = Math.PI * 2;

// ----------------------------------------------------------------------------
//  Globals
// ----------------------------------------------------------------------------
let renderer, scene, camera, atlas, atlasTex, mats;
let world = null;
let running = false, paused = false;
const clock = { last: performance.now(), acc: 0 };
const TICK = 1 / 20;            // 20 ticks/sec simulation
const REACH = 5;

const settings = { renderDistance: 6, fov: 75, sensitivity: 1.0, volume: 0.6 };
let worldMeta = null;
let gameMode = 'survival';
let timeOfDay = 0.2;            // 0..1
const DAY_LENGTH = 1200;       // seconds for a full cycle

const keys = {};
let pointerLocked = false;
let thirdPerson = 0;           // 0 first, 1 back, 2 front
let isTouch = false, touchFwd = 0, touchStrafe = 0;   // mobile virtual-stick analog input

const player = {
  pos: new THREE.Vector3(0, SEA + 12, 0),
  vel: new THREE.Vector3(),
  yaw: 0, pitch: 0,
  onGround: false, fly: false, inWater: false,
  health: 20, food: 20, saturation: 5, air: 10,
  xp: 0, level: 0,
  fallStart: null, hurtT: 0, lastSpace: 0,
};

let inv = new Array(36).fill(null);      // {id,count,dura?}
let hotbarSel = 0;
let cursor = null;                        // stack held by mouse in screens
let openScreen = null;                    // {type, ...}
const mobs = [];
const drops = [];
const particles = [];

let audioCtx = null;
let chunkMeshes = new Map();              // key -> THREE.Group
let highlightMesh = null;
let breakState = { target: null, progress: 0 };

// ----------------------------------------------------------------------------
//  Engine init
// ----------------------------------------------------------------------------
function initEngine() {
  renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5));
  renderer.setSize(innerWidth, innerHeight);
  $('game').appendChild(renderer.domElement);
  scene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(settings.fov, innerWidth / innerHeight, 0.1, 1000);

  atlas = buildAtlas();
  setAtlasForIcons(atlas);
  atlasTex = new THREE.CanvasTexture(atlas.canvas);
  atlasTex.magFilter = THREE.NearestFilter;
  atlasTex.minFilter = THREE.NearestFilter;
  atlasTex.generateMipmaps = false;
  mats = makeMaterials(atlasTex);

  // selection highlight
  const hg = new THREE.BoxGeometry(1.002, 1.002, 1.002);
  const he = new THREE.EdgesGeometry(hg);
  highlightMesh = new THREE.LineSegments(he, new THREE.LineBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.4 }));
  highlightMesh.visible = false; scene.add(highlightMesh);

  addEventListener('resize', () => {
    camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix();
    renderer.setSize(innerWidth, innerHeight);
  });
  buildHotbarDom();
}

function makeMaterials(tex) {
  const uniforms = () => ({
    map: { value: tex },
    uSun: { value: 1 }, uAmbient: { value: 0.08 }, uAlpha: { value: 1 },
    uFogColor: { value: new THREE.Color(0x88bbff) },
    uFogNear: { value: 40 }, uFogFar: { value: 110 },
  });
  const vert = `
    attribute vec3 alight;
    varying vec2 vUv; varying vec3 vL; varying float vFog;
    void main(){ vUv = uv; vL = alight;
      vec4 mv = modelViewMatrix * vec4(position,1.0);
      vFog = -mv.z; gl_Position = projectionMatrix * mv; }`;
  const frag = (cutout) => `
    uniform sampler2D map; uniform float uSun, uAmbient, uAlpha;
    uniform vec3 uFogColor; uniform float uFogNear, uFogFar;
    varying vec2 vUv; varying vec3 vL; varying float vFog;
    void main(){
      vec4 t = texture2D(map, vUv);
      ${cutout ? 'if(t.a < 0.5) discard;' : ''}
      float sky = vL.x * uSun;
      float lvl = max(max(sky, vL.y), uAmbient);
      vec3 col = t.rgb * lvl * vL.z;
      float f = clamp((vFog - uFogNear)/(uFogFar - uFogNear), 0.0, 1.0);
      col = mix(col, uFogColor, f);
      gl_FragColor = vec4(col, t.a * uAlpha);
    }`;
  const solid = new THREE.ShaderMaterial({ uniforms: uniforms(), vertexShader: vert, fragmentShader: frag(false), side: THREE.DoubleSide });
  const cutout = new THREE.ShaderMaterial({ uniforms: uniforms(), vertexShader: vert, fragmentShader: frag(true), side: THREE.DoubleSide });
  const water = new THREE.ShaderMaterial({ uniforms: uniforms(), vertexShader: vert, fragmentShader: frag(false), side: THREE.DoubleSide, transparent: true, depthWrite: false });
  water.uniforms.uAlpha.value = 0.72;
  return { solid, cutout, water };
}

function setUniform(name, value) {
  for (const m of [mats.solid, mats.cutout, mats.water]) m.uniforms[name].value = value;
}

// ----------------------------------------------------------------------------
//  Chunk streaming
// ----------------------------------------------------------------------------
function chunkOf(v) { return Math.floor(v / CH); }

function updateChunks() {
  const pcx = chunkOf(player.pos.x), pcz = chunkOf(player.pos.z);
  const rd = settings.renderDistance;
  // ensure data for rd+1 ring (needed for border meshing)
  for (let dz = -rd - 1; dz <= rd + 1; dz++)
    for (let dx = -rd - 1; dx <= rd + 1; dx++)
      world.ensureChunk(pcx + dx, pcz + dz);

  // mesh budget
  let budget = 3;
  const cand = [];
  for (let dz = -rd; dz <= rd; dz++) for (let dx = -rd; dx <= rd; dx++) {
    const c = world.getChunk(pcx + dx, pcz + dz);
    if (c && c.meshDirty) cand.push({ c, d: dx * dx + dz * dz });
  }
  cand.sort((a, b) => a.d - b.d);
  for (const { c } of cand) { if (budget <= 0) break; buildChunkMesh(c); budget--; }

  // unload far meshes & data
  for (const [k, grp] of chunkMeshes) {
    const [cx, cz] = k.split(',').map(Number);
    if (Math.abs(cx - pcx) > rd + 1 || Math.abs(cz - pcz) > rd + 1) {
      scene.remove(grp); disposeGroup(grp); chunkMeshes.delete(k);
      const c = world.getChunk(cx, cz); if (c) c.meshDirty = true;
    }
  }
  for (const [k, c] of world.chunks) {
    if (Math.abs(c.cx - pcx) > rd + 3 || Math.abs(c.cz - pcz) > rd + 3) {
      if (!c.dirty) world.chunks.delete(k);
    }
  }
}

function buildChunkMesh(c) {
  const k = key(c.cx, c.cz);
  const old = chunkMeshes.get(k);
  if (old) { scene.remove(old); disposeGroup(old); }
  const geos = meshChunk(world, c, atlas);
  const grp = new THREE.Group();
  grp.position.set(c.cx * CH, 0, c.cz * CH);
  if (geos.solid) grp.add(new THREE.Mesh(geos.solid, mats.solid));
  if (geos.cutout) grp.add(new THREE.Mesh(geos.cutout, mats.cutout));
  if (geos.water) grp.add(new THREE.Mesh(geos.water, mats.water));
  scene.add(grp); chunkMeshes.set(k, grp); c.meshDirty = false;
}
function disposeGroup(g) { g.traverse((o) => { if (o.geometry) o.geometry.dispose(); }); }
function remeshAround(wx, wz) {
  const cx = chunkOf(wx), cz = chunkOf(wz);
  for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
    const c = world.getChunk(cx + dx, cz + dz); if (c) c.meshDirty = true;
  }
}

// ----------------------------------------------------------------------------
//  Player physics & input
// ----------------------------------------------------------------------------
function solidAt(x, y, z) { const b = world.getBlock(Math.floor(x), Math.floor(y), Math.floor(z)); return b && isSolid(b); }

function collideAxis(p, vel, axis, hx, hyHi) {
  // AABB extents: x/z = hx (±), y from p.y to p.y+hyHi
  const min = [p.x - hx, p.y, p.z - hx];
  const max = [p.x + hx, p.y + hyHi, p.z + hx];
  const x0 = Math.floor(min[0]), x1 = Math.floor(max[0]);
  const y0 = Math.floor(min[1]), y1 = Math.floor(max[1]);
  const z0 = Math.floor(min[2]), z1 = Math.floor(max[2]);
  let hit = false;
  for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) for (let z = z0; z <= z1; z++) {
    if (!solidAt(x, y, z)) continue;
    hit = true;
    if (axis === 0) { if (vel.x > 0) p.x = Math.min(p.x, x - hx - 1e-3); else if (vel.x < 0) p.x = Math.max(p.x, x + 1 + hx + 1e-3); }
    else if (axis === 1) { if (vel.y > 0) p.y = Math.min(p.y, y - hyHi - 1e-3); else if (vel.y < 0) p.y = Math.max(p.y, y + 1 + 1e-3); }
    else { if (vel.z > 0) p.z = Math.min(p.z, z - hx - 1e-3); else if (vel.z < 0) p.z = Math.max(p.z, z + 1 + hx + 1e-3); }
  }
  if (hit) { if (axis === 1) { if (vel.y < 0) player.onGround = true; vel.y = 0; } else vel[axis === 0 ? 'x' : 'z'] = 0; }
  return hit;
}

function updatePlayer(dt) {
  const p = player.pos, v = player.vel;
  // feet block for water test
  player.inWater = isLiquid(world.getBlock(Math.floor(p.x), Math.floor(p.y + 0.9), Math.floor(p.z)));

  // movement input → desired horizontal velocity
  const fwd = new THREE.Vector3(-Math.sin(player.yaw), 0, -Math.cos(player.yaw));
  const right = new THREE.Vector3(Math.cos(player.yaw), 0, -Math.sin(player.yaw));
  let mx = 0, mz = 0;
  if (keys['KeyW']) { mx += fwd.x; mz += fwd.z; }
  if (keys['KeyS']) { mx -= fwd.x; mz -= fwd.z; }
  if (keys['KeyD']) { mx += right.x; mz += right.z; }
  if (keys['KeyA']) { mx -= right.x; mz -= right.z; }
  if (isTouch) { mx += fwd.x * touchFwd + right.x * touchStrafe; mz += fwd.z * touchFwd + right.z * touchStrafe; }
  const len = Math.hypot(mx, mz) || 1; mx /= len; mz /= len;
  const sprint = keys['ControlLeft'] || keys['ControlRight'];
  const sneak = keys['ShiftLeft'];
  let speed = sprint ? 6.0 : 4.3; if (sneak && !player.fly) speed = 1.9;
  if (player.fly) speed = sprint ? 14 : 8;
  if (player.inWater) speed *= 0.6;

  const accel = player.onGround || player.fly ? 12 : 4;
  v.x += (mx * speed - v.x) * Math.min(1, accel * dt);
  v.z += (mz * speed - v.z) * Math.min(1, accel * dt);

  if (player.fly) {
    let vy = 0; if (keys['Space']) vy += 1; if (sneak) vy -= 1;
    v.y += (vy * speed - v.y) * Math.min(1, 12 * dt);
  } else if (player.inWater) {
    v.y += -8 * dt;                                   // reduced gravity
    if (keys['Space']) v.y = 3.5;                     // swim up
    v.y = Math.max(v.y, -4);
  } else {
    v.y -= 28 * dt;                                   // gravity
    if (keys['Space'] && player.onGround) { v.y = 8.4; player.onGround = false; sfx('jump'); }
    else if (player.onGround) {
      // auto-step: hop over a single-block ledge in the movement direction
      const sp = Math.hypot(v.x, v.z);
      if (sp > 0.6) {
        const ax = p.x + (v.x / sp) * 0.45, az = p.z + (v.z / sp) * 0.45;
        if (solidAt(ax, p.y + 0.1, az) && !solidAt(ax, p.y + 1.2, az) && !solidAt(ax, p.y + 2.1, az)) v.y = 7.2;
      }
    }
  }

  if (!player.onGround && !player.fly && player.fallStart === null && v.y < 0) player.fallStart = p.y;
  const wasGround = player.onGround;
  player.onGround = false;

  // integrate + collide per axis
  p.x += v.x * dt; collideAxis(p, v, 0, 0.3, 1.8);
  p.z += v.z * dt; collideAxis(p, v, 2, 0.3, 1.8);
  p.y += v.y * dt; collideAxis(p, v, 1, 0.3, 1.8);

  // landing / fall damage
  if (player.onGround && !wasGround && player.fallStart !== null) {
    const fall = player.fallStart - p.y;
    if (gameMode === 'survival' && fall > 3 && !player.inWater) damagePlayer(Math.floor(fall - 3), 'fell');
    player.fallStart = null;
    if (fall > 0.4) sfx('step');
  }
  if (player.onGround) player.fallStart = null;

  // walk sound
  if (player.onGround && (Math.abs(v.x) + Math.abs(v.z)) > 1.5) {
    player._stepT = (player._stepT || 0) + dt;
    if (player._stepT > 0.34) { player._stepT = 0; sfx('step'); }
  }

  // void / survival upkeep
  if (p.y < -8) damagePlayer(4, 'void');
  if (gameMode === 'survival') survivalTick(dt, sprint, mx || mz);
  player.hurtT = Math.max(0, player.hurtT - dt);
}

let _foodTimer = 0, _regenTimer = 0, _starveTimer = 0, _airTimer = 0;
function survivalTick(dt, sprint, moving) {
  // hunger drain
  _foodTimer += dt + (sprint && moving ? dt * 1.5 : 0);
  if (_foodTimer > 18) { _foodTimer = 0; if (player.saturation > 0) player.saturation--; else if (player.food > 0) player.food--; }
  // regen
  if (player.food >= 18 && player.health < 20) { _regenTimer += dt; if (_regenTimer > 3) { _regenTimer = 0; player.health = Math.min(20, player.health + 1); } }
  // starve
  if (player.food <= 0) { _starveTimer += dt; if (_starveTimer > 4) { _starveTimer = 0; damagePlayer(1, 'starved'); } }
  // drowning
  const headWater = isLiquid(world.getBlock(Math.floor(player.pos.x), Math.floor(player.pos.y + 1.6), Math.floor(player.pos.z)));
  if (headWater) { _airTimer += dt; if (_airTimer > 1) { _airTimer = 0; player.air = Math.max(0, player.air - 1); if (player.air === 0) damagePlayer(1, 'drowned'); } }
  else { player.air = Math.min(10, player.air + 1); }
}

function damagePlayer(amt, cause) {
  if (gameMode === 'creative' || amt <= 0) return;
  player.health -= amt; player.hurtT = 0.4; sfx('hurt');
  flashVignette();
  if (player.health <= 0) die(cause);
}
function die(cause) {
  player.health = 0; running = false; document.exitPointerLock();
  $('deathMsg').textContent = ({ fell: 'You hit the ground too hard.', void: 'You fell out of the world.', starved: 'You starved to death.', drowned: 'You drowned.', mob: 'You were slain by a monster.' })[cause] || '';
  $('death').classList.remove('hidden');
}

// ----------------------------------------------------------------------------
//  Raycast (voxel DDA) + interaction
// ----------------------------------------------------------------------------
function raycastVoxel() {
  const o = camera.getWorldPosition(new THREE.Vector3());
  const d = camera.getWorldDirection(new THREE.Vector3());
  let x = Math.floor(o.x), y = Math.floor(o.y), z = Math.floor(o.z);
  const sx = Math.sign(d.x), sy = Math.sign(d.y), sz = Math.sign(d.z);
  const tDX = Math.abs(1 / (d.x || 1e-9)), tDY = Math.abs(1 / (d.y || 1e-9)), tDZ = Math.abs(1 / (d.z || 1e-9));
  let tMX = ((sx > 0 ? (x + 1 - o.x) : (o.x - x)) || 0) * tDX;
  let tMY = ((sy > 0 ? (y + 1 - o.y) : (o.y - y)) || 0) * tDY;
  let tMZ = ((sz > 0 ? (z + 1 - o.z) : (o.z - z)) || 0) * tDZ;
  let nx = 0, ny = 0, nz = 0;
  for (let i = 0; i < 100; i++) {
    const b = world.getBlock(x, y, z);
    if (b && !isLiquid(b)) return { x, y, z, nx, ny, nz, id: b };
    if (tMX < tMY && tMX < tMZ) { x += sx; tMX += tDX; nx = -sx; ny = 0; nz = 0; if (tMX > REACH) break; }
    else if (tMY < tMZ) { y += sy; tMY += tDY; nx = 0; ny = -sy; nz = 0; if (tMY > REACH) break; }
    else { z += sz; tMZ += tDZ; nx = 0; ny = 0; nz = -sz; if (tMZ > REACH) break; }
  }
  return null;
}

function heldStack() { return inv[hotbarSel]; }
function heldTool() { const s = heldStack(); return s && itemDef(s.id) && itemDef(s.id).tool ? itemDef(s.id) : null; }

function breakTime(def) {
  if (def.hardness < 0) return Infinity;
  let t = def.hardness * 1.5;
  const tool = heldTool();
  if (tool && def.toolType === tool.tool) t /= (1 + tool.tier * 1.2);
  else if (def.needsTool) t *= 2.5;
  return Math.max(0.05, t);
}
function canHarvest(def) {
  if (!def.needsTool) return true;
  const tool = heldTool();
  return !!(tool && def.toolType === tool.tool && tool.tier >= (def.minTier || 1));
}

function startMining(dt) {
  const hit = raycastVoxel();
  if (!hit) { breakState.target = null; breakState.progress = 0; return; }
  const def = blockDef(hit.id);
  const tk = hit.x + ',' + hit.y + ',' + hit.z;
  if (breakState.target !== tk) { breakState.target = tk; breakState.progress = 0; }
  if (gameMode === 'creative') { breakBlock(hit); breakState.target = null; return; }
  breakState.progress += dt / breakTime(def);
  if (Math.random() < 0.3) spawnParticles(hit.x + 0.5, hit.y + 0.6, hit.z + 0.5, def, 1);
  if (breakState.progress >= 1) { breakBlock(hit); breakState.target = null; breakState.progress = 0; }
}

function breakBlock(hit) {
  const id = hit.id, def = blockDef(id);
  if (def.hardness < 0) return;
  // mob/melee: handled separately; this is block break
  world.setBlock(hit.x, hit.y, hit.z, 0);
  if (def.blockEntity) world.blockEntities.delete(hit.x + ',' + hit.y + ',' + hit.z);
  remeshAround(hit.x, hit.z);
  sfx('break');
  spawnParticles(hit.x + 0.5, hit.y + 0.5, hit.z + 0.5, def, 10);
  // drops
  if (gameMode !== 'creative') {
    if (canHarvest(def)) {
      const drop = def.drop === undefined ? id : def.drop;
      if (drop) spawnDrop(hit.x + 0.5, hit.y + 0.4, hit.z + 0.5, drop, 1);
    }
    damageHeldTool();
    if (def.xp) player.xp += def.xp;
  }
  settleGravityAbove(hit.x, hit.y + 1, hit.z);
}

function settleGravityAbove(x, y, z) {
  let cy = y;
  while (cy < WH) {
    const b = world.getBlock(x, cy, z);
    if (b && blockDef(b).gravity) {
      // fall to lowest air
      let ty = cy; while (ty - 1 >= 0 && !world.getBlock(x, ty - 1, z)) ty--;
      if (ty !== cy) { world.setBlock(x, cy, z, 0); world.setBlock(x, ty, z, b); remeshAround(x, z); }
      cy++;
    } else break;
  }
}

function useItem() {
  const hit = raycastVoxel();
  // 1) interact with block entity (chest/furnace) unless sneaking
  if (hit) { const tb = blockDef(hit.id); if (tb && tb.blockEntity && !keys['ShiftLeft']) { openBlockEntity(hit); return; } }
  // 2) eat food
  const s = heldStack();
  if (s) { const d = itemDef(s.id); if (d && d.food && gameMode !== 'creative' && player.food < 20) { player.food = Math.min(20, player.food + d.food); player.saturation = Math.min(player.food, player.saturation + d.food * 0.6); s.count--; if (s.count <= 0) inv[hotbarSel] = null; renderHotbar(); renderStats(); sfx('pickup'); return; } }
  // 3) place block
  placeBlock();
}
function placeBlock() {
  const s = heldStack();
  if (!s || !isBlock(s.id)) return;
  const hit = raycastVoxel();
  if (!hit) return;
  const px = hit.x + hit.nx, py = hit.y + hit.ny, pz = hit.z + hit.nz;
  const existing = world.getBlock(px, py, pz);
  if (existing && !isLiquid(existing) && existing !== B.TALL_GRASS) return;
  // don't place inside player
  const pminX = player.pos.x - 0.3, maxX = player.pos.x + 0.3, minZ = player.pos.z - 0.3, maxZ = player.pos.z + 0.3;
  const minY = player.pos.y, maxY = player.pos.y + 1.8;
  if (blockDef(s.id).solid && px + 1 > minX && px < maxX && pz + 1 > minZ && pz < maxZ && py + 1 > minY && py < maxY) return;
  world.setBlock(px, py, pz, s.id);
  if (blockDef(s.id).blockEntity) world.blockEntities.set(px + ',' + py + ',' + pz, newBlockEntity(blockDef(s.id).blockEntity));
  remeshAround(px, pz);
  sfx('place');
  if (gameMode !== 'creative') { s.count--; if (s.count <= 0) inv[hotbarSel] = null; renderHotbar(); }
  settleGravityAbove(px, py, pz);
}

function damageHeldTool() {
  const s = heldStack(); if (!s) return; const d = itemDef(s.id);
  if (d && d.tool) { s.dura = (s.dura ?? d.durability) - 1; if (s.dura <= 0) { inv[hotbarSel] = null; sfx('break'); } renderHotbar(); }
}

// ----------------------------------------------------------------------------
//  Item drops & particles
// ----------------------------------------------------------------------------
function spawnDrop(x, y, z, id, count) {
  const geo = new THREE.BoxGeometry(0.28, 0.28, 0.28);
  const tex = new THREE.CanvasTexture(itemIcon(id)); tex.magFilter = THREE.NearestFilter;
  const mat = new THREE.MeshBasicMaterial({ map: tex });
  const m = new THREE.Mesh(geo, mat); m.position.set(x, y, z); scene.add(m);
  drops.push({ id, count, pos: m.position, vel: new THREE.Vector3((Math.random() - 0.5) * 2, 3, (Math.random() - 0.5) * 2), mesh: m, age: 0, tex });
}
function updateDrops(dt) {
  for (let i = drops.length - 1; i >= 0; i--) {
    const d = drops[i]; d.age += dt;
    d.vel.y -= 22 * dt;
    d.pos.x += d.vel.x * dt; d.pos.y += d.vel.y * dt; d.pos.z += d.vel.z * dt;
    // rest on ground
    if (solidAt(d.pos.x, d.pos.y - 0.15, d.pos.z) && d.vel.y < 0) { d.vel.set(0, 0, 0); d.pos.y = Math.floor(d.pos.y) + 0.15; }
    d.vel.x *= 0.9; d.vel.z *= 0.9;
    d.mesh.rotation.y += dt * 2;
    // magnet + pickup
    const dx = player.pos.x - d.pos.x, dy = player.pos.y + 0.9 - d.pos.y, dz = player.pos.z - d.pos.z;
    const dist = Math.hypot(dx, dy, dz);
    if (d.age > 0.6 && dist < 1.6) { d.pos.x += dx * dt * 6; d.pos.y += dy * dt * 6; d.pos.z += dz * dt * 6; }
    if (d.age > 0.6 && dist < 0.6) {
      const left = addItem(d.id, d.count);
      if (left === 0) { scene.remove(d.mesh); d.mesh.geometry.dispose(); d.tex.dispose(); drops.splice(i, 1); sfx('pickup'); renderHotbar(); }
      else d.count = left;
    }
  }
}
function spawnParticles(x, y, z, def, n) {
  const tile = def.faces ? def.faces[2] : 0;
  for (let i = 0; i < n; i++) {
    if (particles.length > 200) break;
    const g = new THREE.BoxGeometry(0.1, 0.1, 0.1);
    const col = sampleTileColor(tile);
    const m = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ color: col }));
    m.position.set(x + (Math.random() - 0.5) * 0.6, y + (Math.random() - 0.5) * 0.6, z + (Math.random() - 0.5) * 0.6);
    scene.add(m);
    particles.push({ mesh: m, vel: new THREE.Vector3((Math.random() - 0.5) * 3, Math.random() * 3 + 1, (Math.random() - 0.5) * 3), life: 0.7 });
  }
}
const _tcanvas = typeof document !== 'undefined' ? document.createElement('canvas') : null;
if (_tcanvas) { _tcanvas.width = _tcanvas.height = 1; }
const _tctx = _tcanvas ? _tcanvas.getContext('2d') : null;
function sampleTileColor(tile) {
  const cols = atlas.cols, sx = (tile % cols) * 16 + 8, sy = ((tile / cols) | 0) * 16 + 8;
  _tctx.drawImage(atlas.canvas, sx, sy, 1, 1, 0, 0, 1, 1);
  const d = _tctx.getImageData(0, 0, 1, 1).data; return (d[0] << 16) | (d[1] << 8) | d[2];
}
function updateParticles(dt) {
  for (let i = particles.length - 1; i >= 0; i--) {
    const p = particles[i]; p.life -= dt; p.vel.y -= 14 * dt;
    p.mesh.position.x += p.vel.x * dt; p.mesh.position.y += p.vel.y * dt; p.mesh.position.z += p.vel.z * dt;
    if (p.life <= 0) { scene.remove(p.mesh); p.mesh.geometry.dispose(); p.mesh.material.dispose(); particles.splice(i, 1); }
  }
}

// ----------------------------------------------------------------------------
//  Inventory helpers
// ----------------------------------------------------------------------------
function addItem(id, count) {
  const ms = maxStack(id);
  for (let i = 0; i < 36 && count > 0; i++) { const s = inv[i]; if (s && s.id === id && s.count < ms) { const add = Math.min(ms - s.count, count); s.count += add; count -= add; } }
  for (let i = 0; i < 36 && count > 0; i++) { if (!inv[i]) { const add = Math.min(ms, count); inv[i] = itemDef(id) && itemDef(id).tool ? { id, count: 1, dura: itemDef(id).durability } : { id, count: add }; count -= add; } }
  return count;
}

// ----------------------------------------------------------------------------
//  Mobs
// ----------------------------------------------------------------------------
function makeMobMesh(type) {
  const g = new THREE.Group();
  const bodyCol = type === 'zombie' ? 0x3a7d3a : (type === 'pig' ? 0xe39aa6 : 0xd8c89a);
  const headCol = type === 'zombie' ? 0x4a8a4a : (type === 'pig' ? 0xeaa6b2 : 0xc8b88a);
  const body = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.7, 0.4), new THREE.MeshBasicMaterial({ color: bodyCol }));
  body.position.y = 0.75; g.add(body);
  const head = new THREE.Mesh(new THREE.BoxGeometry(0.45, 0.45, 0.45), new THREE.MeshBasicMaterial({ color: headCol }));
  head.position.y = 1.35; g.add(head); g.userData.head = head;
  for (const sx of [-0.18, 0.18]) for (const sz of [-0.12, 0.12]) {
    const leg = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.45, 0.18), new THREE.MeshBasicMaterial({ color: bodyCol }));
    leg.position.set(sx, 0.22, sz); g.add(leg);
  }
  return g;
}
function spawnMob(type, x, y, z) {
  if (mobs.length > 24) return;
  const mesh = makeMobMesh(type); mesh.position.set(x, y, z); scene.add(mesh);
  mobs.push({ type, pos: mesh.position, vel: new THREE.Vector3(), mesh, health: type === 'zombie' ? 16 : 10, onGround: false, heading: Math.random() * TAU, wanderT: 0, cd: 0, age: 0, hurtT: 0 });
}
function mobSolidMove(m, dt) {
  const p = m.pos, v = m.vel;
  v.y -= 26 * dt;
  p.x += v.x * dt; collideAxis(p, v, 0, 0.3, 1.6);
  p.z += v.z * dt; collideAxis(p, v, 2, 0.3, 1.6);
  // reuse player.onGround flag hack: detect ground manually
  const wasY = v.y;
  p.y += v.y * dt;
  m.onGround = false;
  // ground collide
  const min = [p.x - 0.3, p.y, p.z - 0.3], max = [p.x + 0.3, p.y + 1.6, p.z + 0.3];
  for (let x = Math.floor(min[0]); x <= Math.floor(max[0]); x++)
    for (let y = Math.floor(min[1]); y <= Math.floor(max[1]); y++)
      for (let z = Math.floor(min[2]); z <= Math.floor(max[2]); z++)
        if (solidAt(x, y, z)) { if (v.y > 0) { p.y = y - 1.6 - 1e-3; } else { p.y = y + 1 + 1e-3; m.onGround = true; } v.y = 0; }
}
function updateMobs(dt) {
  const night = sunFactor(timeOfDay) < 0.35;
  for (let i = mobs.length - 1; i >= 0; i--) {
    const m = mobs[i]; m.age += dt; m.cd = Math.max(0, m.cd - dt); m.hurtT = Math.max(0, m.hurtT - dt);
    const dx = player.pos.x - m.pos.x, dz = player.pos.z - m.pos.z;
    const dist = Math.hypot(dx, dz);
    if (m.type === 'zombie' && night && dist < 18) {
      m.heading = Math.atan2(dx, dz);
      const sp = 2.6; m.vel.x = Math.sin(m.heading) * sp; m.vel.z = Math.cos(m.heading) * sp;
      // jump if blocked
      const ax = m.pos.x + Math.sin(m.heading) * 0.5, az = m.pos.z + Math.cos(m.heading) * 0.5;
      if (m.onGround && solidAt(ax, m.pos.y + 0.2, az)) m.vel.y = 7;
      if (dist < 1.3 && m.cd === 0) { m.cd = 1; damagePlayer(3, 'mob'); knockback(dx, dz); }
    } else {
      m.wanderT -= dt;
      if (m.wanderT <= 0) { m.wanderT = 2 + Math.random() * 3; m.heading = Math.random() * TAU; m._mv = Math.random() < 0.6; }
      const sp = m._mv ? 1.3 : 0; m.vel.x = Math.sin(m.heading) * sp; m.vel.z = Math.cos(m.heading) * sp;
      if (m.onGround && sp > 0 && solidAt(m.pos.x + Math.sin(m.heading) * 0.5, m.pos.y + 0.2, m.pos.z + Math.cos(m.heading) * 0.5)) m.vel.y = 7;
    }
    mobSolidMove(m, dt);
    m.mesh.rotation.y = -m.heading;
    if (m.mesh.userData.head) { const hp = player.pos.clone().sub(m.pos); m.mesh.userData.head.rotation.x = dist < 8 ? Math.atan2(-(player.pos.y - m.pos.y - 1.3), dist) * 0.5 : 0; }
    // zombie burns in day
    if (m.type === 'zombie' && !night && m.age > 4 && sunFactor(timeOfDay) > 0.6) { m.health -= dt * 3; }
    // despawn far / dead
    if (m.health <= 0) { if (m.type === 'zombie' || m.type === 'pig') spawnDrop(m.pos.x, m.pos.y + 0.5, m.pos.z, m.type === 'pig' ? I.RAW_MEAT : I.IRON_INGOT, 1 + (Math.random() * 2 | 0)); removeMob(i); continue; }
    if (Math.hypot(player.pos.x - m.pos.x, player.pos.z - m.pos.z) > 60 || m.pos.y < -20) removeMob(i);
  }
}
function removeMob(i) { const m = mobs[i]; scene.remove(m.mesh); disposeGroup(m.mesh); m.mesh.traverse((o) => o.material && o.material.dispose()); mobs.splice(i, 1); }
function knockback(dx, dz) { const l = Math.hypot(dx, dz) || 1; player.vel.x -= dx / l * 4; player.vel.z -= dz / l * 4; player.vel.y += 3; }

let _spawnTimer = 0;
function trySpawnMobs(dt) {
  _spawnTimer += dt; if (_spawnTimer < 3) return; _spawnTimer = 0;
  const night = sunFactor(timeOfDay) < 0.35;
  const hostiles = mobs.filter((m) => m.type === 'zombie').length;
  const passives = mobs.filter((m) => m.type !== 'zombie').length;
  const ang = Math.random() * TAU, r = 16 + Math.random() * 8;
  const x = Math.floor(player.pos.x + Math.cos(ang) * r), z = Math.floor(player.pos.z + Math.sin(ang) * r);
  // find surface
  let y = WH - 1; while (y > 0 && !world.getBlock(x, y, z)) y--;
  if (y <= SEA || y >= WH - 2) return;
  const sky = world.getSky(x, y + 1, z);
  if (night && hostiles < 6 && sky < 8) spawnMob('zombie', x + 0.5, y + 1, z + 0.5);
  else if (!night && passives < 8 && sky > 10 && Math.random() < 0.5) spawnMob(Math.random() < 0.5 ? 'pig' : 'cow', x + 0.5, y + 1, z + 0.5);
}
function attackMob() {
  // melee the mob the player is looking at
  const o = camera.getWorldPosition(new THREE.Vector3()), d = camera.getWorldDirection(new THREE.Vector3());
  let best = null, bestT = REACH;
  for (const m of mobs) {
    const c = m.pos.clone(); c.y += 0.9;
    const to = c.sub(o); const t = to.dot(d);
    if (t < 0 || t > bestT) continue;
    const closest = o.clone().add(d.clone().multiplyScalar(t));
    if (closest.distanceTo(m.pos.clone().setY(m.pos.y + 0.9)) < 0.7) { best = m; bestT = t; }
  }
  if (best) {
    const tool = heldTool(); const dmg = tool ? tool.attack : 1;
    best.health -= dmg; best.hurtT = 0.2; sfx('hit');
    const dx = best.pos.x - player.pos.x, dz = best.pos.z - player.pos.z, l = Math.hypot(dx, dz) || 1;
    best.vel.x += dx / l * 5; best.vel.z += dz / l * 5; best.vel.y = 4;
    if (tool) damageHeldTool();
    return true;
  }
  return false;
}

// ----------------------------------------------------------------------------
//  Block entities (furnace, chest)
// ----------------------------------------------------------------------------
function newBlockEntity(type) {
  if (type === 'furnace') return { type, slots: [null, null, null], lit: 0, fuelMax: 0, cook: 0 };
  if (type === 'chest') return { type, slots: new Array(27).fill(null) };
  return { type };
}
function openBlockEntity(hit) {
  const k = hit.x + ',' + hit.y + ',' + hit.z;
  let be = world.blockEntities.get(k);
  if (!be) { be = newBlockEntity(blockDef(hit.id).blockEntity); world.blockEntities.set(k, be); }
  openScreen = { type: be.type, be };
  document.exitPointerLock();
  renderScreen();
}
function updateFurnaces(dt) {
  for (const be of world.blockEntities.values()) {
    if (be.type !== 'furnace') continue;
    const [input, fuel, output] = be.slots;
    const smeltTo = input ? SMELT[input.id] : undefined;
    const canSmelt = smeltTo !== undefined && (!output || (output.id === smeltTo && output.count < maxStack(smeltTo)));
    if (be.lit > 0) { be.lit -= dt; if (canSmelt) { be.cook += dt; if (be.cook >= 8) { be.cook = 0; be.slots[2] = output ? { id: output.id, count: output.count + 1 } : { id: smeltTo, count: 1 }; input.count--; if (input.count <= 0) be.slots[0] = null; } } else be.cook = 0; }
    if (be.lit <= 0 && canSmelt && fuel && fuelValue(fuel.id) > 0) { be.fuelMax = fuelValue(fuel.id) * 10; be.lit = be.fuelMax; fuel.count--; if (fuel.count <= 0) be.slots[1] = null; }
  }
  if (openScreen && openScreen.type === 'furnace') renderScreen();
}

// ----------------------------------------------------------------------------
//  UI: HUD hotbar + stats + debug
// ----------------------------------------------------------------------------
function buildHotbarDom() {
  const hb = $('hotbar'); hb.innerHTML = '';
  for (let i = 0; i < 9; i++) { const s = document.createElement('div'); s.className = 'slot'; s.dataset.i = i; hb.appendChild(s); }
}
function renderHotbar() {
  const hb = $('hotbar');
  for (let i = 0; i < 9; i++) {
    const el = hb.children[i]; el.classList.toggle('sel', i === hotbarSel);
    const st = inv[i]; el.innerHTML = '';
    if (st) { drawSlot(el, st); }
  }
}
function drawSlot(el, st) {
  const cv = document.createElement('canvas'); cv.width = cv.height = 32;
  cv.getContext('2d').drawImage(itemIcon(st.id), 0, 0); el.appendChild(cv);
  if (st.count > 1) { const c = document.createElement('span'); c.className = 'count'; c.textContent = st.count; el.appendChild(c); }
  const d = itemDef(st.id);
  if (d && d.tool && st.dura !== undefined && st.dura < d.durability) { const bar = document.createElement('div'); bar.className = 'dura'; const inr = document.createElement('i'); inr.style.width = (st.dura / d.durability * 100) + '%'; bar.appendChild(inr); el.appendChild(bar); }
}
function renderStats() {
  if (gameMode === 'creative') { $('stats').classList.add('hidden'); return; }
  $('stats').classList.remove('hidden');
  const hb = $('healthBar'), fb = $('foodBar');
  hb.innerHTML = ''; fb.innerHTML = '';
  for (let i = 0; i < 10; i++) { hb.appendChild(heartIcon(player.health - i * 2)); }
  for (let i = 0; i < 10; i++) { fb.appendChild(foodIcon(player.food - i * 2)); }
}
function heartIcon(v) { const c = document.createElement('canvas'); c.width = c.height = 18; c.className = 'icon'; const x = c.getContext('2d'); x.fillStyle = '#400'; x.fillRect(2, 3, 14, 12); if (v > 0) { x.fillStyle = '#e23b3b'; x.fillRect(2, 3, v >= 2 ? 14 : 7, 12); } return c; }
function foodIcon(v) { const c = document.createElement('canvas'); c.width = c.height = 18; c.className = 'icon'; const x = c.getContext('2d'); x.fillStyle = '#321'; x.fillRect(2, 3, 14, 12); if (v > 0) { x.fillStyle = '#c98a3a'; x.fillRect(2, 3, v >= 2 ? 14 : 7, 12); } return c; }

let fpsT = 0, fpsN = 0, fps = 0;
function renderDebug() {
  if ($('debug').classList.contains('hidden')) return;
  const p = player.pos; const info = world.columnInfo(Math.floor(p.x), Math.floor(p.z));
  const dirs = ['south', 'west', 'north', 'east'];
  const facing = dirs[(Math.round(player.yaw / (Math.PI / 2)) % 4 + 4) % 4];
  $('debug').textContent =
    `Cubeworld v1.0  ${fps} fps\n` +
    `xyz ${p.x.toFixed(1)} ${p.y.toFixed(1)} ${p.z.toFixed(1)}\n` +
    `chunk ${chunkOf(p.x)},${chunkOf(p.z)}  facing ${facing}\n` +
    `biome ${info.biome}  height ${info.h}\n` +
    `light sky ${world.getSky(Math.floor(p.x), Math.floor(p.y + 1), Math.floor(p.z))} blk ${world.getBlockLight(Math.floor(p.x), Math.floor(p.y + 1), Math.floor(p.z))}\n` +
    `time ${(timeOfDay).toFixed(2)}  chunks ${chunkMeshes.size}  mobs ${mobs.length}  drops ${drops.length}\n` +
    `mode ${gameMode}  seed ${world.seed}`;
}

// ----------------------------------------------------------------------------
//  UI: container screens (inventory / crafting table / furnace / chest)
// ----------------------------------------------------------------------------
let craftGrid = [];
function openInventory() { openScreen = { type: 'inventory' }; craftGrid = new Array(4).fill(null); document.exitPointerLock(); renderScreen(); }
function closeScreen() {
  // return crafting grid items to inventory
  if (openScreen && (openScreen.type === 'inventory' || openScreen.type === 'crafting')) {
    for (const st of craftGrid) if (st) addItem(st.id, st.count);
  }
  if (cursor) { addItem(cursor.id, cursor.count); cursor = null; }
  craftGrid = [];
  openScreen = null;
  $('screen').classList.add('hidden'); $('cursorItem').style.display = 'none';
  renderHotbar();
  if (running) requestLock();
}

function slotEl(arr, i, opts = {}) {
  const el = document.createElement('div'); el.className = 'islot';
  const st = arr[i];
  if (st) drawSlot(el, st);
  el.onclick = (e) => { e.preventDefault(); handleSlotClick(arr, i, false, opts); };
  el.oncontextmenu = (e) => { e.preventDefault(); handleSlotClick(arr, i, true, opts); };
  el.onmousedown = (e) => { if (e.shiftKey && e.button === 0) { e.preventDefault(); shiftMove(arr, i, opts); } };
  return el;
}
function handleSlotClick(arr, i, right, opts) {
  if (opts.output) { takeCraftOutput(opts); return; }
  if (opts.readonly && cursor) { /* furnace output: only take */ }
  const st = arr[i];
  if (right) {
    if (cursor && (!st || st.id === cursor.id)) {
      if (!st) { arr[i] = { id: cursor.id, count: 1, dura: cursor.dura }; cursor.count--; }
      else if (st.count < maxStack(st.id)) { st.count++; cursor.count--; }
      if (cursor.count <= 0) cursor = null;
    } else if (!cursor && st) { const half = Math.ceil(st.count / 2); cursor = { id: st.id, count: half, dura: st.dura }; st.count -= half; if (st.count <= 0) arr[i] = null; }
  } else {
    if (cursor && st && st.id === cursor.id && !itemDef(st.id).tool) { const ms = maxStack(st.id); const add = Math.min(ms - st.count, cursor.count); st.count += add; cursor.count -= add; if (cursor.count <= 0) cursor = null; }
    else { const tmp = cursor; cursor = st ? { id: st.id, count: st.count, dura: st.dura } : null; arr[i] = tmp; }
  }
  if (opts.craft) updateCraftOutput();
  if (gameMode === 'creative' && opts.creative) { cursor = arr[i] ? null : cursor; }
  renderScreen();
}
function shiftMove(arr, i, opts) {
  const st = arr[i]; if (!st) return;
  if (opts.output) { takeCraftOutput(opts, true); return; }
  // move between inv and the active container quickly: just dump to inventory
  addItem(st.id, st.count); arr[i] = null;
  if (opts.craft) updateCraftOutput();
  renderScreen();
}

function updateCraftOutput() {
  const size = openScreen.type === 'crafting' ? 3 : 2;
  const grid = craftGrid.map((s) => s ? s.id : 0);
  openScreen._out = matchRecipe(grid, size);
}
function takeCraftOutput(opts, all) {
  const out = openScreen._out; if (!out) return;
  const give = () => { if (cursor && cursor.id === out.id) cursor.count += out.count; else if (!cursor) cursor = { id: out.id, count: out.count }; else return false; consumeGrid(); return true; };
  if (all) { let safety = 64; while (openScreen._out && safety-- > 0) { const o = openScreen._out; const left = addItem(o.id, o.count); if (left) break; consumeGrid(); updateCraftOutput(); } }
  else give();
  updateCraftOutput(); renderScreen();
}
function consumeGrid() { for (const st of craftGrid) if (st) { st.count--; } for (let i = 0; i < craftGrid.length; i++) if (craftGrid[i] && craftGrid[i].count <= 0) craftGrid[i] = null; }

function renderScreen() {
  const wrap = $('screen'), inner = $('screenInner');
  wrap.classList.remove('hidden'); inner.innerHTML = ''; inner.style.position = 'relative';
  const closeBtn = document.createElement('button');
  closeBtn.id = 'screenClose'; closeBtn.className = 'btn small'; closeBtn.textContent = '✕';
  closeBtn.onclick = closeScreen; inner.appendChild(closeBtn);
  const type = openScreen.type;
  if (type === 'inventory' || type === 'crafting') renderCraftingScreen(inner, type === 'crafting' ? 3 : 2);
  else if (type === 'furnace') renderFurnaceScreen(inner);
  else if (type === 'chest') renderChestScreen(inner);
  if (gameMode === 'creative' && (type === 'inventory')) renderCreativePalette(inner);
  renderInventoryGrid(inner);
  renderCursor();
}
function renderCraftingScreen(inner, size) {
  updateCraftOutput();
  const h = document.createElement('h3'); h.textContent = size === 3 ? 'Crafting Table' : 'Crafting'; inner.appendChild(h);
  const rowWrap = document.createElement('div'); rowWrap.className = 'invRow';
  const grid = document.createElement('div'); grid.className = 'grid'; grid.style.gridTemplateColumns = `repeat(${size},42px)`;
  if (craftGrid.length !== size * size) craftGrid = new Array(size * size).fill(null);
  for (let i = 0; i < size * size; i++) grid.appendChild(slotEl(craftGrid, i, { craft: true }));
  rowWrap.appendChild(grid);
  const arrow = document.createElement('div'); arrow.className = 'arrow'; arrow.textContent = '➜'; rowWrap.appendChild(arrow);
  const outArr = [openScreen._out ? { id: openScreen._out.id, count: openScreen._out.count } : null];
  const outSlot = slotEl(outArr, 0, { output: true }); rowWrap.appendChild(outSlot);
  inner.appendChild(rowWrap);
}
function renderFurnaceScreen(inner) {
  const be = openScreen.be;
  const h = document.createElement('h3'); h.textContent = 'Furnace'; inner.appendChild(h);
  const row = document.createElement('div'); row.className = 'invRow';
  const col = document.createElement('div'); col.className = 'col';
  col.appendChild(slotEl(be.slots, 0, {}));               // input
  const flame = document.createElement('div'); flame.className = 'tag'; flame.textContent = be.lit > 0 ? '🔥 burning' : '— unlit'; col.appendChild(flame);
  col.appendChild(slotEl(be.slots, 1, {}));               // fuel
  row.appendChild(col);
  const arrow = document.createElement('div'); arrow.className = 'arrow'; arrow.textContent = '➜ ' + Math.floor((be.cook / 8) * 100) + '%'; row.appendChild(arrow);
  row.appendChild(slotEl(be.slots, 2, { readonly: true })); // output
  inner.appendChild(row);
}
function renderChestScreen(inner) {
  const be = openScreen.be;
  const h = document.createElement('h3'); h.textContent = 'Chest'; inner.appendChild(h);
  const grid = document.createElement('div'); grid.className = 'grid'; grid.style.gridTemplateColumns = 'repeat(9,42px)';
  for (let i = 0; i < 27; i++) grid.appendChild(slotEl(be.slots, i, {}));
  inner.appendChild(grid);
}
function renderInventoryGrid(inner) {
  const tag = document.createElement('div'); tag.className = 'tag'; tag.textContent = 'Inventory'; inner.appendChild(tag);
  const grid = document.createElement('div'); grid.className = 'grid'; grid.style.gridTemplateColumns = 'repeat(9,42px)';
  for (let i = 9; i < 36; i++) grid.appendChild(slotEl(inv, i, {})); inner.appendChild(grid);
  const tag2 = document.createElement('div'); tag2.className = 'tag'; tag2.textContent = 'Hotbar'; inner.appendChild(tag2);
  const hb = document.createElement('div'); hb.className = 'grid'; hb.style.gridTemplateColumns = 'repeat(9,42px)';
  for (let i = 0; i < 9; i++) hb.appendChild(slotEl(inv, i, {})); inner.appendChild(hb);
}
function renderCreativePalette(inner) {
  const tag = document.createElement('div'); tag.className = 'tag'; tag.textContent = 'Creative items (click to grab)'; inner.appendChild(tag);
  const grid = document.createElement('div'); grid.className = 'grid'; grid.style.gridTemplateColumns = 'repeat(12,36px)'; grid.style.maxHeight = '180px'; grid.style.overflow = 'auto';
  const all = [...Object.keys(BLOCKS).map(Number).filter((id) => id > 0), ...Object.keys(ITEMS).map(Number)];
  for (const id of all) {
    const el = document.createElement('div'); el.className = 'islot'; el.style.width = el.style.height = '34px';
    const cv = document.createElement('canvas'); cv.width = cv.height = 32; cv.style.width = cv.style.height = '28px'; cv.getContext('2d').drawImage(itemIcon(id), 0, 0); el.appendChild(cv);
    el.onclick = () => { cursor = { id, count: maxStack(id), dura: itemDef(id).tool ? itemDef(id).durability : undefined }; renderScreen(); };
    grid.appendChild(el);
  }
  inner.appendChild(grid);
}
function renderCursor() {
  const ci = $('cursorItem');
  if (!cursor) { ci.style.display = 'none'; return; }
  ci.style.display = 'block';
  ci.querySelector('canvas').getContext('2d').clearRect(0, 0, 36, 36);
  ci.querySelector('canvas').getContext('2d').drawImage(itemIcon(cursor.id), 0, 0, 36, 36);
  ci.querySelector('.count').textContent = cursor.count > 1 ? cursor.count : '';
}
if (typeof window !== 'undefined') addEventListener('mousemove', (e) => { const ci = $('cursorItem'); if (cursor) { ci.style.left = (e.clientX - 18) + 'px'; ci.style.top = (e.clientY - 18) + 'px'; } });

// ----------------------------------------------------------------------------
//  Audio (procedural, original)
// ----------------------------------------------------------------------------
function sfx(type) {
  if (!audioCtx) return; if (settings.volume <= 0) return;
  const t = audioCtx.currentTime; const o = audioCtx.createOscillator(), g = audioCtx.createGain();
  const cfg = { step: [120, 'square', 0.05], jump: [320, 'square', 0.08], break: [180, 'sawtooth', 0.12], place: [240, 'square', 0.08], hurt: [90, 'sawtooth', 0.2], pickup: [660, 'sine', 0.08], hit: [200, 'square', 0.06], click: [440, 'sine', 0.04] }[type] || [200, 'sine', 0.05];
  o.type = cfg[1]; o.frequency.setValueAtTime(cfg[0], t); o.frequency.exponentialRampToValueAtTime(cfg[0] * 0.6, t + cfg[2]);
  g.gain.setValueAtTime(settings.volume * 0.25, t); g.gain.exponentialRampToValueAtTime(0.001, t + cfg[2]);
  o.connect(g); g.connect(audioCtx.destination); o.start(t); o.stop(t + cfg[2]);
}

// ----------------------------------------------------------------------------
//  Day / night
// ----------------------------------------------------------------------------
function sunFactor(t) { const h = Math.sin(t * TAU); return THREE.MathUtils.clamp(0.5 + h * 0.7, 0.08, 1); }
function updateSky() {
  const sun = sunFactor(timeOfDay);
  setUniform('uSun', sun);
  const day = new THREE.Color(0x88bbff), night = new THREE.Color(0x05060f), dusk = new THREE.Color(0xff8844);
  const h = Math.sin(timeOfDay * TAU);
  let sky = night.clone().lerp(day, THREE.MathUtils.clamp(h * 1.3 + 0.4, 0, 1));
  if (Math.abs(h) < 0.25) sky.lerp(dusk, (0.25 - Math.abs(h)) / 0.25 * 0.4);
  scene.background = sky; setUniform('uFogColor', sky);
  setUniform('uFogNear', settings.renderDistance * CH * 0.55);
  setUniform('uFogFar', settings.renderDistance * CH * 0.95);
}

// ----------------------------------------------------------------------------
//  Camera & vignette
// ----------------------------------------------------------------------------
function applyCamera() {
  const eye = player.pos.clone(); eye.y += keys['ShiftLeft'] && !player.fly ? 1.45 : 1.62;
  camera.rotation.order = 'YXZ';
  camera.rotation.y = player.yaw; camera.rotation.x = player.pitch; camera.rotation.z = 0;
  if (thirdPerson === 0) { camera.position.copy(eye); }
  else {
    const dir = camera.getWorldDirection(new THREE.Vector3());
    const back = thirdPerson === 1 ? -4 : 4;
    camera.position.copy(eye).addScaledVector(dir, back);
    if (thirdPerson === 2) { camera.rotation.y += Math.PI; camera.rotation.x *= -1; }
  }
}
let _flash = 0;
function flashVignette() { _flash = 1; }
function updateVignette(dt) { _flash = Math.max(0, _flash - dt * 3); $('vignette').style.boxShadow = `inset 0 0 ${80 + _flash * 120}px ${10 + _flash * 40}px rgba(180,0,0,${_flash * 0.6})`; }

// ----------------------------------------------------------------------------
//  Input handlers
// ----------------------------------------------------------------------------
function requestLock() {
  if (isTouch) return;                         // mobile uses on-screen controls, not pointer lock
  if (!openScreen && !paused && running && renderer.domElement.requestPointerLock) {
    try { renderer.domElement.requestPointerLock(); } catch (e) {}
  }
}
function bindInput() {
  renderer.domElement.addEventListener('click', () => { ensureAudio(); if (!pointerLocked && !openScreen && !paused) requestLock(); });
  document.addEventListener('pointerlockchange', () => { pointerLocked = document.pointerLockElement === renderer.domElement; });
  document.addEventListener('mousemove', (e) => {
    if (!pointerLocked) return;
    const s = settings.sensitivity * 0.0022;
    player.yaw -= e.movementX * s; player.pitch -= e.movementY * s;
    player.pitch = THREE.MathUtils.clamp(player.pitch, -Math.PI / 2 + 0.01, Math.PI / 2 - 0.01);
  });
  addEventListener('mousedown', (e) => {
    if (!pointerLocked) return;
    if (e.button === 0) { if (!attackMob()) startMining(0.001); _mining = true; }
    if (e.button === 2) useItem();
    if (e.button === 1) { const hit = raycastVoxel(); if (hit) pickBlock(hit.id); }
  });
  addEventListener('mouseup', (e) => { if (e.button === 0) { _mining = false; breakState.target = null; breakState.progress = 0; } });
  addEventListener('contextmenu', (e) => e.preventDefault());
  addEventListener('wheel', (e) => { if (!pointerLocked) return; hotbarSel = (hotbarSel + (e.deltaY > 0 ? 1 : -1) + 9) % 9; renderHotbar(); showHeld(); });

  addEventListener('keydown', (e) => {
    if (chatOpen) { handleChatKey(e); return; }
    keys[e.code] = true;
    if (e.code === 'Escape') { if (openScreen) closeScreen(); else togglePause(); }
    if (!running || paused) return;
    if (e.code.startsWith('Digit')) { const n = +e.code.slice(5); if (n >= 1 && n <= 9) { hotbarSel = n - 1; renderHotbar(); showHeld(); } }
    if (e.code === 'KeyE') { if (openScreen) closeScreen(); else openInventory(); }
    if (e.code === 'KeyQ') dropSelected();
    if (e.code === 'F3') { e.preventDefault(); $('debug').classList.toggle('hidden'); }
    if (e.code === 'F5') { thirdPerson = (thirdPerson + 1) % 3; }
    if (e.code === 'KeyT' || e.code === 'Slash') { e.preventDefault(); openChat(e.code === 'Slash' ? '/' : ''); }
    if (e.code === 'Space' && gameMode === 'creative') { const now = performance.now(); if (now - player.lastSpace < 300) { player.fly = !player.fly; player.vel.y = 0; } player.lastSpace = now; }
  });
  addEventListener('keyup', (e) => { keys[e.code] = false; });
  addEventListener('blur', () => { for (const k in keys) keys[k] = false; });
  // pause/quit visibility autosave
  addEventListener('visibilitychange', () => { if (document.hidden && running) saveGame(); });
  addEventListener('pagehide', () => { if (running) saveGame(); });
}
let _mining = false;

function pickBlock(id) {
  for (let i = 0; i < 9; i++) if (inv[i] && inv[i].id === id) { hotbarSel = i; renderHotbar(); showHeld(); return; }
  if (gameMode === 'creative') { inv[hotbarSel] = { id, count: maxStack(id) }; renderHotbar(); showHeld(); }
}
function dropSelected() {
  const s = heldStack(); if (!s) return;
  const d = camera.getWorldDirection(new THREE.Vector3());
  spawnDrop(player.pos.x + d.x, player.pos.y + 1.2, player.pos.z + d.z, s.id, 1);
  drops[drops.length - 1].vel.set(d.x * 5, 3, d.z * 5); drops[drops.length - 1].age = -0.5;
  s.count--; if (s.count <= 0) inv[hotbarSel] = null; renderHotbar();
}
function showHeld() {
  const s = heldStack(); const el = $('heldName');
  if (s) { el.textContent = displayName(s.id); el.style.opacity = '1'; clearTimeout(el._t); el._t = setTimeout(() => el.style.opacity = '0', 1400); }
}
function ensureAudio() { if (!audioCtx) { try { audioCtx = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) {} } }

// ----------------------------------------------------------------------------
//  Chat / commands
// ----------------------------------------------------------------------------
let chatOpen = false;
const nameToId = {};
for (const k in B) if (B[k]) nameToId[k.toLowerCase()] = B[k];
for (const k in I) nameToId[k.toLowerCase()] = I[k];
function openChat(prefix) { chatOpen = true; document.exitPointerLock(); const ci = $('chatInput'); ci.style.display = 'block'; ci.value = prefix; $('chat').classList.remove('hidden'); ci.focus(); }
function closeChat() { chatOpen = false; const ci = $('chatInput'); ci.style.display = 'none'; ci.value = ''; if (running && !paused && !openScreen) requestLock(); }
function handleChatKey(e) {
  e.stopPropagation();
  if (e.code === 'Escape') { closeChat(); }
  else if (e.code === 'Enter') { const v = $('chatInput').value.trim(); if (v) runCommandOrSay(v); closeChat(); }
}
function chatLog(msg) { const log = $('chatLog'); const d = document.createElement('div'); d.textContent = msg; log.appendChild(d); while (log.children.length > 8) log.removeChild(log.firstChild); setTimeout(() => { if (d.parentNode) d.style.opacity = '0.5'; }, 6000); }
function runCommandOrSay(v) {
  if (!v.startsWith('/')) { chatLog('<you> ' + v); return; }
  const [cmd, ...args] = v.slice(1).split(/\s+/);
  try {
    if (cmd === 'give') { const id = nameToId[args[0]?.toLowerCase()]; if (!id) return chatLog('Unknown item: ' + args[0]); const n = +args[1] || 1; addItem(id, n); renderHotbar(); chatLog(`Gave ${n} ${displayName(id)}`); }
    else if (cmd === 'time') { if (args[0] === 'set') { const m = { day: 0.25, night: 0.75, noon: 0.25, midnight: 0.75 }; timeOfDay = m[args[1]] ?? (parseFloat(args[1]) || 0.25); chatLog('Time set'); } }
    else if (cmd === 'tp') { player.pos.set(+args[0], +args[1], +args[2]); player.vel.set(0, 0, 0); chatLog('Teleported'); }
    else if (cmd === 'gamemode') { gameMode = args[0] === 'creative' || args[0] === 'c' || args[0] === '1' ? 'creative' : 'survival'; player.fly = false; renderStats(); chatLog('Game mode: ' + gameMode); }
    else if (cmd === 'seed') { chatLog('Seed: ' + world.seed); }
    else if (cmd === 'heal') { player.health = 20; player.food = 20; chatLog('Healed'); }
    else if (cmd === 'help') { chatLog('/give /time set /tp /gamemode /seed /heal'); }
    else chatLog('Unknown command: ' + cmd);
  } catch (err) { chatLog('Error: ' + err.message); }
}

// ----------------------------------------------------------------------------
//  Pause / settings
// ----------------------------------------------------------------------------
function togglePause() {
  paused = !paused;
  $('pause').classList.toggle('hidden', !paused);
  if (paused) document.exitPointerLock(); else requestLock();
}
function bindSettings() {
  const bind = (slider, val, fn) => { const s = $(slider), v = $(val); s.oninput = () => { v.textContent = s.value; fn(+s.value); }; };
  bind('rdSlider', 'rdVal', (x) => { settings.renderDistance = x; });
  bind('fovSlider', 'fovVal', (x) => { settings.fov = x; camera.fov = x; camera.updateProjectionMatrix(); });
  bind('sensSlider', 'sensVal', (x) => { settings.sensitivity = x / 100; });
  bind('volSlider', 'volVal', (x) => { settings.volume = x / 100; });
  $('btnResume').onclick = () => togglePause();
  $('btnExport').onclick = exportCurrent;
  $('btnQuit').onclick = quitToTitle;
}

// ----------------------------------------------------------------------------
//  Save / load / world menu
// ----------------------------------------------------------------------------
function collectState() {
  return {
    player: { pos: player.pos.toArray(), yaw: player.yaw, pitch: player.pitch, health: player.health, food: player.food, saturation: player.saturation, air: player.air, xp: player.xp, fly: player.fly },
    inv, hotbarSel, time: timeOfDay, gameMode,
    blockEntities: [...world.blockEntities.entries()],
    settings,
  };
}
async function saveGame() {
  if (!world || !worldMeta) return;
  worldMeta.lastPlayed = Date.now();
  await DB.putWorldMeta(worldMeta);
  await DB.saveState(worldMeta.id, collectState());
  const dirty = [];
  for (const c of world.chunks.values()) if (c.dirty) dirty.push({ cx: c.cx, cz: c.cz, rle: world.serializeChunk(c) });
  if (dirty.length) await DB.saveChunks(worldMeta.id, dirty);
}
let _autosave = 0;

function startWorld(meta, state, savedChunks) {
  worldMeta = meta; gameMode = meta.mode || 'survival';
  world = new World(meta.seed, { size: meta.size });
  // load saved chunks
  if (savedChunks) for (const sc of savedChunks) { const c = world.ensureChunk(sc.cx, sc.cz); World.inflateChunk(c, sc.rle); world.computeLight(c); c.dirty = true; c.meshDirty = true; }
  if (state) {
    player.pos.fromArray(state.player.pos); player.yaw = state.player.yaw; player.pitch = state.player.pitch;
    player.health = state.player.health; player.food = state.player.food; player.saturation = state.player.saturation ?? 5;
    player.air = state.player.air ?? 10; player.xp = state.player.xp || 0; player.fly = state.player.fly || false;
    if (state.inv) { inv = state.inv.map((s) => s ? { ...s } : null); while (inv.length < 36) inv.push(null); }
    hotbarSel = state.hotbarSel || 0; timeOfDay = state.time ?? 0.2;
    if (state.blockEntities) world.blockEntities = new Map(state.blockEntities);
    if (state.settings) Object.assign(settings, state.settings);
  } else {
    // fresh spawn: find safe surface at origin
    world.ensureChunk(0, 0);
    let y = WH - 1; while (y > 0 && !world.getBlock(0, y, 0)) y--;
    player.pos.set(0.5, y + 1.2, 0.5);
    if (gameMode === 'survival') giveStarterKit();
  }
  // apply settings to UI sliders
  $('rdSlider').value = settings.renderDistance; $('rdVal').textContent = settings.renderDistance;
  $('fovSlider').value = settings.fov; $('fovVal').textContent = settings.fov; camera.fov = settings.fov; camera.updateProjectionMatrix();
  $('sensSlider').value = settings.sensitivity * 100; $('sensVal').textContent = Math.round(settings.sensitivity * 100);
  $('volSlider').value = settings.volume * 100; $('volVal').textContent = Math.round(settings.volume * 100);

  // pre-generate spawn area with a loading screen, then go
  showLoading();
  preloadSpawn().then(() => {
    hideLoading();
    $('menu').classList.add('hidden'); $('worlds').classList.add('hidden');
    $('hud').classList.remove('hidden'); $('chat').classList.remove('hidden');
    running = true; paused = false;
    renderHotbar(); renderStats(); showHeld();
    requestLock();
  });
}
function giveStarterKit() {
  addItem(I.WOOD_PICK, 1); addItem(I.WOOD_AXE, 1); addItem(B.TORCH, 16); addItem(B.PLANKS, 16); addItem(I.BREAD, 4);
}
function preloadSpawn() {
  return new Promise((resolve) => {
    const pcx = chunkOf(player.pos.x), pcz = chunkOf(player.pos.z); const rd = Math.min(settings.renderDistance, 5);
    const list = [];
    for (let dz = -rd; dz <= rd; dz++) for (let dx = -rd; dx <= rd; dx++) list.push([pcx + dx, pcz + dz, dx * dx + dz * dz]);
    list.sort((a, b) => a[2] - b[2]);
    let i = 0; const total = list.length;
    function step() {
      const budget = 6;
      for (let k = 0; k < budget && i < total; k++, i++) { const [cx, cz] = list[i]; const c = world.ensureChunk(cx, cz); buildChunkMesh(c); }
      setLoading(i / total);
      if (i < total) requestAnimationFrame(step); else { dropPlayerToGround(); resolve(); }
    }
    step();
  });
}
function dropPlayerToGround() {
  const x = Math.floor(player.pos.x), z = Math.floor(player.pos.z);
  let y = WH - 1; while (y > 1 && !(world.getBlock(x, y, z) && isSolid(world.getBlock(x, y, z)))) y--;
  if (player.pos.y > y + 3 || !world.getBlock(x, Math.floor(player.pos.y) - 1, z)) player.pos.y = y + 1.2;
}

function showLoading() { $('loading').classList.remove('hidden'); setLoading(0); }
function setLoading(f) { $('loadbar').firstElementChild.style.width = Math.round(f * 100) + '%'; $('loadPct').textContent = Math.round(f * 100) + '%'; }
function hideLoading() { $('loading').classList.add('hidden'); }

async function quitToTitle() {
  await saveGame();
  running = false; paused = false; document.exitPointerLock();
  // clear scene chunks
  for (const [k, g] of chunkMeshes) { scene.remove(g); disposeGroup(g); } chunkMeshes.clear();
  for (let i = mobs.length - 1; i >= 0; i--) removeMob(i);
  for (const d of drops) { scene.remove(d.mesh); } drops.length = 0;
  world = null; openScreen = null; cursor = null;
  $('pause').classList.add('hidden'); $('hud').classList.add('hidden'); $('chat').classList.add('hidden'); $('screen').classList.add('hidden');
  $('menu').classList.remove('hidden');
  inv = new Array(36).fill(null); player.health = 20; player.food = 20;
}
async function exportCurrent() {
  await saveGame();
  const data = await DB.exportWorld(worldMeta.id);
  const blob = new Blob([JSON.stringify(data)], { type: 'application/json' });
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = (worldMeta.name || 'world') + '.cubeworld.json'; a.click();
  chatLog('Exported world to file');
}

// ----------------------------------------------------------------------------
//  Menu wiring
// ----------------------------------------------------------------------------
function bindMenu() {
  $('btnCreate').onclick = async () => {
    ensureAudio();
    const name = $('mName').value.trim() || 'New World';
    const seedRaw = $('mSeed').value.trim();
    const seed = seedRaw ? (parseInt(seedRaw, 10) || hashStr(seedRaw)) : (Math.random() * 2e9 | 0);
    const meta = { id: 'w' + Date.now(), name, seed, mode: $('mMode').value, size: +$('mSize').value, created: Date.now(), lastPlayed: Date.now(), version: 1 };
    await DB.putWorldMeta(meta);
    resetRuntime();
    startWorld(meta, null, null);
  };
  $('btnWorlds').onclick = showWorldList;
  $('btnWorldsBack').onclick = () => { $('worlds').classList.add('hidden'); $('menu').classList.remove('hidden'); };
  $('btnImport').onclick = () => $('fileImport').click();
  $('fileImport').onchange = async (e) => {
    const f = e.target.files[0]; if (!f) return;
    try { const obj = JSON.parse(await f.text()); const meta = await DB.importWorld(obj); toast('Imported: ' + meta.name); showWorldList(); }
    catch (err) { toast('Import failed: ' + err.message); }
  };
  $('btnRespawn').onclick = respawn;
  $('btnDeathQuit').onclick = () => { $('death').classList.add('hidden'); quitToTitle(); };
}
function respawn() {
  $('death').classList.add('hidden');
  player.health = 20; player.food = 20; player.saturation = 5; player.air = 10; player.vel.set(0, 0, 0);
  const x = 0, z = 0; let y = WH - 1; world.ensureChunk(0, 0); while (y > 1 && !world.getBlock(x, y, z)) y--;
  player.pos.set(0.5, y + 1.2, 0.5);
  running = true; requestLock();
}
async function showWorldList() {
  $('menu').classList.add('hidden'); $('worlds').classList.remove('hidden');
  const list = await DB.listWorlds(); const wl = $('worldList'); wl.innerHTML = '';
  if (!list.length) { wl.innerHTML = '<div style="opacity:.6;padding:10px">No saved worlds yet.</div>'; return; }
  for (const m of list) {
    const item = document.createElement('div'); item.className = 'worldItem';
    const left = document.createElement('div');
    left.innerHTML = `<div class="name">${escapeHtml(m.name)}</div><div class="meta">${m.mode} · seed ${m.seed} · ${new Date(m.lastPlayed).toLocaleString()}</div>`;
    const right = document.createElement('div'); right.className = 'row';
    const play = document.createElement('button'); play.className = 'btn small'; play.textContent = 'Play';
    play.onclick = async () => { ensureAudio(); resetRuntime(); const state = await DB.loadState(m.id); const chunks = await DB.loadChunks(m.id); startWorld(m, state, chunks); };
    const del = document.createElement('button'); del.className = 'btn small'; del.textContent = 'Delete'; del.style.background = '#5a2a2a';
    del.onclick = async () => { if (confirm('Delete world "' + m.name + '"? This cannot be undone.')) { await DB.deleteWorld(m.id); showWorldList(); } };
    right.appendChild(play); right.appendChild(del);
    item.appendChild(left); item.appendChild(right); wl.appendChild(item);
  }
}
function resetRuntime() {
  inv = new Array(36).fill(null); hotbarSel = 0; cursor = null; openScreen = null;
  player.vel.set(0, 0, 0); player.health = 20; player.food = 20; player.saturation = 5; player.air = 10; player.fly = false; player.fallStart = null;
  _foodTimer = _regenTimer = _starveTimer = _airTimer = _autosave = 0;
}
function hashStr(s) { let h = 0; for (let i = 0; i < s.length; i++) h = (Math.imul(h, 31) + s.charCodeAt(i)) | 0; return h >>> 0; }
function escapeHtml(s) { return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
function toast(msg) { const t = $('toast'); t.textContent = msg; t.style.display = 'block'; clearTimeout(t._t); t._t = setTimeout(() => t.style.display = 'none', 2500); }

// ----------------------------------------------------------------------------
//  Main loop
// ----------------------------------------------------------------------------
function loop(now) {
  requestAnimationFrame(loop);
  const dt = Math.min(0.05, (now - clock.last) / 1000); clock.last = now;
  fpsT += dt; fpsN++; if (fpsT >= 0.5) { fps = Math.round(fpsN / fpsT); fpsT = 0; fpsN = 0; }
  if (running && !paused) {
    clock.acc += dt;
    let steps = 0;
    while (clock.acc >= TICK && steps < 5) { simulate(TICK); clock.acc -= TICK; steps++; }
    // continuous (frame-rate) things
    if (_mining && (pointerLocked || isTouch)) startMining(dt);
    updateDrops(dt); updateParticles(dt);
    updateChunks();
    timeOfDay = (timeOfDay + dt / DAY_LENGTH) % 1;
    updateSky();
    applyCamera();
    updateHighlight();
    updateVignette(dt);
    // autosave
    _autosave += dt; if (_autosave > 45) { _autosave = 0; saveGame(); }
    renderHud();
  }
  renderer.render(scene, camera);
}
function simulate(dt) {
  updatePlayer(dt);
  updateMobs(dt);
  trySpawnMobs(dt);
  updateFurnaces(dt);
}
let _hudT = 0;
function renderHud() { _hudT += 1; if (_hudT % 6 === 0) { renderStats(); renderDebug(); updateTouchVisibility(); } }
function updateTouchVisibility() {
  if (!isTouch) return;
  $('touch').classList.toggle('hidden', !(running && !paused && !openScreen));
  $('tfly').style.display = gameMode === 'creative' ? '' : 'none';
}

// ---------------- Touch / mobile controls ----------------
function setupTouch() {
  // Treat as touch only when the PRIMARY pointer is coarse (phones/tablets) — so a
  // touchscreen laptop with a mouse keeps the desktop controls.
  isTouch = (typeof matchMedia !== 'undefined') ? matchMedia('(pointer: coarse)').matches : (navigator.maxTouchPoints > 0);
  if (!isTouch) return;
  document.body.classList.add('touch');

  const stick = $('tstick'), nub = $('tnub'), look = $('tlook');
  let joyId = null, cx = 0, cy = 0; const R = 56;
  function setJoy(t) { let dx = t.clientX - cx, dy = t.clientY - cy; const d = Math.hypot(dx, dy) || 1; const cl = Math.min(d, R); dx = dx / d * cl; dy = dy / d * cl; nub.style.transform = `translate(${dx}px,${dy}px)`; touchStrafe = dx / R; touchFwd = -dy / R; }
  stick.addEventListener('touchstart', (e) => { ensureAudio(); const t = e.changedTouches[0]; joyId = t.identifier; const r = stick.getBoundingClientRect(); cx = r.left + r.width / 2; cy = r.top + r.height / 2; setJoy(t); e.preventDefault(); }, { passive: false });

  let lookId = null, lx = 0, ly = 0;
  look.addEventListener('touchstart', (e) => { ensureAudio(); const t = e.changedTouches[0]; lookId = t.identifier; lx = t.clientX; ly = t.clientY; e.preventDefault(); }, { passive: false });

  window.addEventListener('touchmove', (e) => {
    for (const t of e.changedTouches) {
      if (t.identifier === joyId) { setJoy(t); e.preventDefault(); }
      else if (t.identifier === lookId) {
        const s = settings.sensitivity * 0.005;
        player.yaw -= (t.clientX - lx) * s; player.pitch -= (t.clientY - ly) * s;
        player.pitch = THREE.MathUtils.clamp(player.pitch, -Math.PI / 2 + 0.01, Math.PI / 2 - 0.01);
        lx = t.clientX; ly = t.clientY; e.preventDefault();
      }
    }
  }, { passive: false });
  window.addEventListener('touchend', (e) => {
    for (const t of e.changedTouches) {
      if (t.identifier === joyId) { joyId = null; touchFwd = 0; touchStrafe = 0; nub.style.transform = ''; }
      if (t.identifier === lookId) lookId = null;
    }
  });

  const press = (id, on, off) => {
    const el = $(id);
    el.addEventListener('touchstart', (e) => { ensureAudio(); on(); e.preventDefault(); }, { passive: false });
    if (off) el.addEventListener('touchend', (e) => { off(); e.preventDefault(); }, { passive: false });
  };
  press('tjump', () => { keys['Space'] = true; }, () => { keys['Space'] = false; });
  press('tbreak', () => { if (!attackMob()) startMining(0.001); _mining = true; }, () => { _mining = false; breakState.target = null; breakState.progress = 0; });
  press('tplace', () => useItem());
  press('tinv', () => { if (openScreen) closeScreen(); else openInventory(); });
  press('tpause', () => togglePause());
  press('tfly', () => { if (gameMode === 'creative') { player.fly = !player.fly; player.vel.y = 0; } });

  // tap a hotbar slot to select it
  $('hotbar').addEventListener('touchstart', (e) => { const s = e.target.closest('.slot'); if (s) { hotbarSel = +s.dataset.i; renderHotbar(); showHeld(); e.preventDefault(); } }, { passive: false });
  // keep the held (cursor) item under the finger inside container screens
  $('screen').addEventListener('touchstart', (e) => { const t = e.touches[0]; if (t && cursor) { const ci = $('cursorItem'); ci.style.left = (t.clientX - 18) + 'px'; ci.style.top = (t.clientY - 18) + 'px'; } });
}
function updateHighlight() {
  const hit = raycastVoxel();
  if (hit) { highlightMesh.visible = true; highlightMesh.position.set(hit.x + 0.5, hit.y + 0.5, hit.z + 0.5); }
  else highlightMesh.visible = false;
}

// ----------------------------------------------------------------------------
//  Boot
// ----------------------------------------------------------------------------
function main() {
  initEngine();
  bindInput(); bindSettings(); bindMenu(); setupTouch();
  requestAnimationFrame(loop);
}

// Test hook — lets headless Node tests drive the real gameplay logic without a browser.
// (Harmless in the browser; only the getters/setters bridge module-private state.)
export const __test = {
  addItem, breakTime, canHarvest, updateFurnaces, heldTool, newBlockEntity,
  player,
  get inv() { return inv; }, set inv(v) { inv = v; },
  get world() { return world; }, set world(v) { world = v; },
  get hotbarSel() { return hotbarSel; }, set hotbarSel(v) { hotbarSel = v; },
  get gameMode() { return gameMode; }, set gameMode(v) { gameMode = v; },
  get openScreen() { return openScreen; }, set openScreen(v) { openScreen = v; },
};

if (typeof window !== 'undefined') main();
