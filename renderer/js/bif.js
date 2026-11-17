// Reader for Plex's BIF preview index (a header, an index table, then JPEG frames).
export async function loadBif(plex, partId) {
  const res = await fetch(plex.url(`/library/parts/${partId}/indexes/sd`, { interval: 10000 }));
  if (!res.ok) throw new Error(`BIF HTTP ${res.status}`);
  const buf = await res.arrayBuffer();
  const view = new DataView(buf);
  const magic = [0x89, 0x42, 0x49, 0x46, 0x0d, 0x0a, 0x1a, 0x0a];
  if (!magic.every((b, i) => view.getUint8(i) === b)) throw new Error('Not a BIF file');
  const count = view.getUint32(12, true);
  const interval = view.getUint32(16, true) || 1000;
  const entries = [];
  for (let i = 0; i <= count; i++) {
    const at = 64 + i * 8;
    entries.push({ ts: view.getUint32(at, true), offset: view.getUint32(at + 4, true) });
  }
  const urls = new Map();
  return {
    frameAt(sec) {
      const i = Math.min(count - 1, Math.max(0, Math.floor((sec * 1000) / interval)));
      if (!urls.has(i)) {
        const { offset } = entries[i];
        const end = entries[i + 1].offset;
        urls.set(i, URL.createObjectURL(new Blob([buf.slice(offset, end)], { type: 'image/jpeg' })));
      }
      return urls.get(i);
    },
    dispose() {
      urls.forEach((u) => URL.revokeObjectURL(u));
      urls.clear();
    },
  };
}
