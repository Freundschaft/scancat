// Scancat — minimal PDF writer: one JPEG image per page, no dependencies.

const enc = new TextEncoder();

const PAPER = {
  a4: [595.28, 841.89],
  letter: [612, 792],
};

function pageBox(pageSize, w, h) {
  if (pageSize === "a4" || pageSize === "letter") {
    const [s, l] = PAPER[pageSize];
    return h >= w ? [s, l] : [l, s];
  }
  // fit: the page takes the image's aspect; long side = A4 long side
  const k = 841.89 / Math.max(w, h);
  return [w * k, h * k];
}

function pdfDate(d) {
  const p = (n) => String(n).padStart(2, "0");
  return `D:${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function pdfString(s) {
  return "(" + String(s).replace(/[\\()]/g, (c) => "\\" + c).replace(/[^\x20-\x7e]/g, "?") + ")";
}

/**
 * pages: [{ jpeg: Uint8Array, width, height }]
 * opts:  { pageSize: "fit" | "a4" | "letter", title }
 */
export function buildPdf(pages, opts = {}) {
  const pageSize = opts.pageSize || "fit";
  const objs = []; // each: Uint8Array of the object body (without "N 0 obj"/"endobj")
  const add = (body) => { objs.push(body); return objs.length; };
  const text = (s) => enc.encode(s);
  const concat = (...parts) => {
    let n = 0; for (const p of parts) n += p.length;
    const out = new Uint8Array(n); let o = 0;
    for (const p of parts) { out.set(p, o); o += p.length; }
    return out;
  };

  const catalogId = add(null);
  const pagesId = add(null);
  const infoId = add(text(`<< /Title ${pdfString(opts.title || "Scan")} /Producer (Scancat) /Creator (Scancat) /CreationDate (${pdfDate(new Date())}) >>`));
  const pageIds = [];
  for (const p of pages) {
    const [pw, ph] = pageBox(pageSize, p.width, p.height);
    // contain the image in the page box, centered
    const k = Math.min(pw / p.width, ph / p.height);
    const iw = p.width * k, ih = p.height * k;
    const ix = (pw - iw) / 2, iy = (ph - ih) / 2;
    const imgId = add(concat(
      text(`<< /Type /XObject /Subtype /Image /Width ${p.width} /Height ${p.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${p.jpeg.length} >>\nstream\n`),
      p.jpeg,
      text("\nendstream"),
    ));
    const content = text(`q ${iw.toFixed(2)} 0 0 ${ih.toFixed(2)} ${ix.toFixed(2)} ${iy.toFixed(2)} cm /Im0 Do Q`);
    const contentId = add(concat(text(`<< /Length ${content.length} >>\nstream\n`), content, text("\nendstream")));
    const pageId = add(text(`<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${pw.toFixed(2)} ${ph.toFixed(2)}] /Resources << /XObject << /Im0 ${imgId} 0 R >> >> /Contents ${contentId} 0 R >>`));
    pageIds.push(pageId);
  }
  objs[catalogId - 1] = text(`<< /Type /Catalog /Pages ${pagesId} 0 R >>`);
  objs[pagesId - 1] = text(`<< /Type /Pages /Kids [${pageIds.map((i) => `${i} 0 R`).join(" ")}] /Count ${pageIds.length} >>`);

  const parts = [text("%PDF-1.4\n%\xe2\xe3\xcf\xd3\n")];
  let offset = parts[0].length;
  const offsets = [];
  objs.forEach((body, i) => {
    offsets.push(offset);
    const head = text(`${i + 1} 0 obj\n`), tail = text("\nendobj\n");
    parts.push(head, body, tail);
    offset += head.length + body.length + tail.length;
  });
  const xrefAt = offset;
  let xref = `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const o of offsets) xref += `${String(o).padStart(10, "0")} 00000 n \n`;
  xref += `trailer\n<< /Size ${objs.length + 1} /Root ${catalogId} 0 R /Info ${infoId} 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`;
  parts.push(text(xref));
  return concat(...parts);
}
