import assert from "node:assert/strict";
import { buildZip, crc32 } from "../js/zip.js";

assert.equal(crc32(new TextEncoder().encode("123456789")), 0xcbf43926, "standard CRC-32 vector");
const content = new Uint8Array([0xff, 0xd8, 0, 1, 2, 0xff, 0xd9]);
const blob = await buildZip([{ name: "receipt-01.jpg", data: new Blob([content]) }, { name: "Beleg-ä.pdf", data: new Uint8Array() }]);
const bytes = new Uint8Array(await blob.arrayBuffer()), view = new DataView(bytes.buffer);
assert.equal(blob.type, "application/zip");
const end = bytes.length - 22;
assert.equal(view.getUint32(end, true), 0x06054b50);
assert.equal(view.getUint16(end + 10, true), 2);
let pos = view.getUint32(end + 16, true);
for (const [name, data] of [["receipt-01.jpg", content], ["Beleg-ä.pdf", new Uint8Array()]]) {
  assert.equal(view.getUint32(pos, true), 0x02014b50);
  const size = view.getUint32(pos + 24, true), len = view.getUint16(pos + 28, true), local = view.getUint32(pos + 42, true);
  assert.equal(view.getUint16(pos + 8, true), 0x800, "UTF-8 names");
  assert.equal(new TextDecoder().decode(bytes.slice(pos + 46, pos + 46 + len)), name);
  assert.equal(view.getUint32(local, true), 0x04034b50);
  assert.equal(view.getUint32(local + 14, true), crc32(data));
  assert.deepEqual(bytes.slice(local + 30 + len, local + 30 + len + size), data);
  pos += 46 + len;
}
assert.equal(pos, end, "central directory ends at footer");
assert.equal((await buildZip([])).size, 22, "valid empty archive");
await assert.rejects(buildZip(Array(65536).fill({})), /Too many/);
console.log("ZIP: binary bytes, CRC-32, UTF-8 names, empty entries and archive limits passed.");
