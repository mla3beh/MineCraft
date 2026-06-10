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
`);
console.log('three stub ready');
