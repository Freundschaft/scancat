// ZIP store entries: JPEGs and PDFs already contain compressed image data.
// Avoid recompression and preserve the exact scan bytes. No external runtime.
const encoder = new TextEncoder();
const table = Uint32Array.from({ length: 256 }, (_, n) => {
  for (let i = 0; i < 8; i++) n = n & 1 ? 0xedb88320 ^ (n >>> 1) : n >>> 1;
  return n >>> 0;
});

export function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = table[(crc ^ byte) & 255] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** entries: [{ name: string, data: Blob | Uint8Array }], in tray order. */
export async function buildZip(entries) {
  if (entries.length > 65535) throw new Error("Too many receipts for one ZIP");
  const parts = [], directory = [];
  let offset = 0, directorySize = 0;
  for (const entry of entries) {
    const name = encoder.encode(entry.name);
    const data = entry.data instanceof Uint8Array ? entry.data : new Uint8Array(await entry.data.arrayBuffer());
    if (name.length > 65535 || offset + 30 + name.length + data.length > 0xffffffff) throw new Error("ZIP exceeds the 4 GB limit");
    const crc = crc32(data);
    const local = new Uint8Array(30), l = new DataView(local.buffer);
    l.setUint32(0, 0x04034b50, true); l.setUint16(4, 20, true); l.setUint16(6, 0x800, true);
    l.setUint16(12, 33, true); // 1980-01-01, valid DOS date
    l.setUint32(14, crc, true); l.setUint32(18, data.length, true); l.setUint32(22, data.length, true);
    l.setUint16(26, name.length, true);
    const central = new Uint8Array(46), c = new DataView(central.buffer);
    c.setUint32(0, 0x02014b50, true); c.setUint16(4, 20, true); c.setUint16(6, 20, true); c.setUint16(8, 0x800, true);
    c.setUint16(14, 33, true); c.setUint32(16, crc, true);
    c.setUint32(20, data.length, true); c.setUint32(24, data.length, true); c.setUint16(28, name.length, true);
    c.setUint32(42, offset, true);
    parts.push(local, name, data); directory.push(central, name);
    offset += local.length + name.length + data.length; directorySize += central.length + name.length;
  }
  if (offset + directorySize + 22 > 0xffffffff) throw new Error("ZIP exceeds the 4 GB limit");
  const end = new Uint8Array(22), e = new DataView(end.buffer);
  e.setUint32(0, 0x06054b50, true); e.setUint16(8, entries.length, true); e.setUint16(10, entries.length, true);
  e.setUint32(12, directorySize, true); e.setUint32(16, offset, true);
  return new Blob([...parts, ...directory, end], { type: "application/zip" });
}
