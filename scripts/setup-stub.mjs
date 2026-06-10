// Generates a minimal Three.js stub in node_modules so the headless logic tests
// (test_core.mjs) can import world.js without a real WebGL/Three install.
import { mkdirSync, writeFileSync } from 'fs';

mkdirSync('node_modules/three', { recursive: true });
writeFileSync('node_modules/three/package.json',
  JSON.stringify({ name: 'three', version: '0.0.0-stub', type: 'module', main: 'index.js' }, null, 2));
writeFileSync('node_modules/three/index.js', `
export class Float32BufferAttribute {
  constructor(array, itemSize) { this.array = Float32Array.from(array); this.itemSize = itemSize; this.count = this.array.length / itemSize; }
}
export class BufferGeometry {
  constructor() { this.attributes = {}; this.index = null; }
  setAttribute(n, a) { this.attributes[n] = a; }
  setIndex(arr) { this.index = { array: arr.slice(), count: arr.length }; }
  computeVertexNormals() {}
  dispose() {}
}
export class Vector3 {
  constructor(x = 0, y = 0, z = 0) { this.x = x; this.y = y; this.z = z; }
  set(x, y, z) { this.x = x; this.y = y; this.z = z; return this; }
  copy(v) { this.x = v.x; this.y = v.y; this.z = v.z; return this; }
  clone() { return new Vector3(this.x, this.y, this.z); }
  toArray() { return [this.x, this.y, this.z]; }
  fromArray(a) { this.x = a[0]; this.y = a[1]; this.z = a[2]; return this; }
}
export const MathUtils = { clamp: (v, a, b) => v < a ? a : v > b ? b : v };
`);
console.log('three stub ready');
