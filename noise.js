// noise.js — deterministic, seeded value-noise + fbm (2D & 3D). Same seed => same world.

function hash2(seed, x, y) {
  let h = (seed ^ Math.imul(x, 374761393) ^ Math.imul(y, 668265263)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}
function hash3(seed, x, y, z) {
  let h = (seed ^ Math.imul(x, 374761393) ^ Math.imul(y, 668265263) ^ Math.imul(z, 2147483647)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h = Math.imul(h ^ (h >>> 11), 2246822519);
  return ((h ^ (h >>> 15)) >>> 0) / 4294967295;
}
const lerp = (a, b, t) => a + (b - a) * t;
const smooth = (t) => t * t * (3 - 2 * t);

export function makeNoise(seed) {
  seed = (seed | 0) || 1;

  function value2(x, y) {
    const xi = Math.floor(x), yi = Math.floor(y);
    const xf = x - xi, yf = y - yi;
    const u = smooth(xf), v = smooth(yf);
    const tl = hash2(seed, xi, yi), tr = hash2(seed, xi + 1, yi);
    const bl = hash2(seed, xi, yi + 1), br = hash2(seed, xi + 1, yi + 1);
    return lerp(lerp(tl, tr, u), lerp(bl, br, u), v);
  }

  function value3(x, y, z) {
    const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
    const xf = x - xi, yf = y - yi, zf = z - zi;
    const u = smooth(xf), v = smooth(yf), w = smooth(zf);
    function c(dz) {
      const z0 = zi + dz;
      const x0y0 = hash3(seed, xi, yi, z0), x1y0 = hash3(seed, xi + 1, yi, z0);
      const x0y1 = hash3(seed, xi, yi + 1, z0), x1y1 = hash3(seed, xi + 1, yi + 1, z0);
      return lerp(lerp(x0y0, x1y0, u), lerp(x0y1, x1y1, u), v);
    }
    return lerp(c(0), c(1), w);
  }

  function fbm2(x, y, oct = 4, lac = 2, gain = 0.5) {
    let amp = 1, freq = 1, sum = 0, norm = 0;
    for (let i = 0; i < oct; i++) { sum += value2(x * freq, y * freq) * amp; norm += amp; amp *= gain; freq *= lac; }
    return sum / norm;
  }
  function fbm3(x, y, z, oct = 3, lac = 2, gain = 0.5) {
    let amp = 1, freq = 1, sum = 0, norm = 0;
    for (let i = 0; i < oct; i++) { sum += value3(x * freq, y * freq, z * freq) * amp; norm += amp; amp *= gain; freq *= lac; }
    return sum / norm;
  }

  return { value2, value3, fbm2, fbm3, rand: (x, y) => hash2(seed, x, y) };
}
