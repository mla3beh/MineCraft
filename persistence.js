// persistence.js — IndexedDB save/load for worlds (meta, chunks, player/state) + export/import.
const DB_NAME = 'cubeworld_v1';
const VERSION = 1;
let _db = null;

function open() {
  if (_db) return Promise.resolve(_db);
  return new Promise((res, rej) => {
    const req = indexedDB.open(DB_NAME, VERSION);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains('worlds')) db.createObjectStore('worlds', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('chunks')) db.createObjectStore('chunks', { keyPath: 'k' });
      if (!db.objectStoreNames.contains('state')) db.createObjectStore('state', { keyPath: 'worldId' });
    };
    req.onsuccess = () => { _db = req.result; res(_db); };
    req.onerror = () => rej(req.error);
  });
}
function tx(store, mode) { return open().then((db) => db.transaction(store, mode).objectStore(store)); }
function reqP(r) { return new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); }); }

export async function listWorlds() {
  const st = await tx('worlds', 'readonly');
  const all = await reqP(st.getAll());
  return all.sort((a, b) => (b.lastPlayed || 0) - (a.lastPlayed || 0));
}
export async function getWorld(id) { const st = await tx('worlds', 'readonly'); return reqP(st.get(id)); }
export async function putWorldMeta(meta) { const st = await tx('worlds', 'readwrite'); return reqP(st.put(meta)); }

export async function saveState(worldId, state) {
  const st = await tx('state', 'readwrite');
  return reqP(st.put(Object.assign({ worldId }, state)));
}
export async function loadState(worldId) { const st = await tx('state', 'readonly'); return reqP(st.get(worldId)); }

// chunks: write many in one transaction
export async function saveChunks(worldId, list) {
  const db = await open();
  return new Promise((res, rej) => {
    const t = db.transaction('chunks', 'readwrite');
    const store = t.objectStore('chunks');
    for (const ch of list) store.put({ k: worldId + ':' + ch.cx + ',' + ch.cz, cx: ch.cx, cz: ch.cz, rle: ch.rle });
    t.oncomplete = () => res(); t.onerror = () => rej(t.error);
  });
}
export async function loadChunks(worldId) {
  const db = await open();
  return new Promise((res, rej) => {
    const out = [];
    const range = IDBKeyRange.bound(worldId + ':', worldId + ';');
    const cur = db.transaction('chunks', 'readonly').objectStore('chunks').openCursor(range);
    cur.onsuccess = (e) => { const c = e.target.result; if (c) { out.push(c.value); c.continue(); } else res(out); };
    cur.onerror = () => rej(cur.error);
  });
}

export async function deleteWorld(id) {
  const db = await open();
  await new Promise((res) => { const t = db.transaction('worlds', 'readwrite'); t.objectStore('worlds').delete(id); t.oncomplete = res; });
  await new Promise((res) => { const t = db.transaction('state', 'readwrite'); t.objectStore('state').delete(id); t.oncomplete = res; });
  await new Promise((res) => {
    const range = IDBKeyRange.bound(id + ':', id + ';');
    const t = db.transaction('chunks', 'readwrite'); const store = t.objectStore('chunks');
    const cur = store.openCursor(range);
    cur.onsuccess = (e) => { const c = e.target.result; if (c) { store.delete(c.primaryKey); c.continue(); } };
    t.oncomplete = res;
  });
}

export async function exportWorld(id) {
  const meta = await getWorld(id);
  const state = await loadState(id);
  const chunks = await loadChunks(id);
  return { format: 'cubeworld', version: VERSION, meta, state, chunks: chunks.map((c) => ({ cx: c.cx, cz: c.cz, rle: c.rle })) };
}
export async function importWorld(obj) {
  if (!obj || obj.format !== 'cubeworld') throw new Error('Not a Cubeworld save file');
  const meta = obj.meta; meta.id = 'w' + Date.now();
  meta.lastPlayed = Date.now();
  await putWorldMeta(meta);
  if (obj.state) await saveState(meta.id, obj.state);
  if (obj.chunks) await saveChunks(meta.id, obj.chunks);
  return meta;
}

export async function storageEstimate() {
  if (navigator.storage && navigator.storage.estimate) { const e = await navigator.storage.estimate(); return e; }
  return null;
}
