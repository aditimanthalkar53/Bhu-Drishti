/**
 * Photo hygiene for citizen uploads, without image libraries: detect the real type from the file's bytes (never trust
 * the declared MIME type) and remove metadata that can identify a person or a device (EXIF incl. GPS, XMP, IPTC,
 * comments, text chunks). Pixels are not touched. The website also re-encodes photos before upload, which drops metadata
 * a second time.
 */
export type ImageMime = "image/jpeg" | "image/png" | "image/webp";
export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

export function sniffImage(b: Buffer): ImageMime | null {
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b.length > 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (b.length > 12 && b.toString("ascii", 0, 4) === "RIFF" && b.toString("ascii", 8, 12) === "WEBP") return "image/webp";
  return null;
}

/** JPEG: drop APP1 (EXIF/XMP), APP13 (IPTC) and COM segments; keep everything else (APP0, ICC in APP2, tables, scan). */
export function stripJpeg(b: Buffer): Buffer {
  const out: Buffer[] = [b.subarray(0, 2)];
  let i = 2;
  while (i < b.length) {
    if (b[i] !== 0xff) return b;                         // not a marker where one must be: leave the file as it was
    let m = b[i + 1];
    while (m === 0xff && i + 2 < b.length) { i++; m = b[i + 1]; }   // fill bytes
    if (m === 0xda) { out.push(b.subarray(i)); break; }  // start of scan: the rest is image data
    if ((m >= 0xd0 && m <= 0xd7) || m === 0x01 || m === 0xd8) { out.push(b.subarray(i, i + 2)); i += 2; continue; }
    if (m === 0xd9) { out.push(b.subarray(i, i + 2)); break; }
    if (i + 4 > b.length) return b;
    const len = b.readUInt16BE(i + 2);
    const seg = b.subarray(i, i + 2 + len);
    if (m !== 0xe1 && m !== 0xed && m !== 0xfe) out.push(seg);
    i += 2 + len;
  }
  return Buffer.concat(out);
}

/** PNG: drop eXIf, tEXt, iTXt, zTXt and tIME chunks. */
export function stripPng(b: Buffer): Buffer {
  const drop = new Set(["eXIf", "tEXt", "iTXt", "zTXt", "tIME"]);
  const out: Buffer[] = [b.subarray(0, 8)];
  let i = 8;
  while (i + 12 <= b.length) {
    const len = b.readUInt32BE(i);
    const type = b.toString("ascii", i + 4, i + 8);
    const end = i + 12 + len;
    if (end > b.length) return b;
    if (!drop.has(type)) out.push(b.subarray(i, end));
    i = end;
    if (type === "IEND") break;
  }
  return Buffer.concat(out);
}

/** WebP: drop EXIF and XMP chunks, clear their flags in VP8X, fix the RIFF size. */
export function stripWebp(b: Buffer): Buffer {
  const chunks: Buffer[] = [];
  let i = 12;
  while (i + 8 <= b.length) {
    const id = b.toString("ascii", i, i + 4);
    const size = b.readUInt32LE(i + 4);
    const end = i + 8 + size + (size & 1);
    if (i + 8 + size > b.length) return b;
    if (id !== "EXIF" && id !== "XMP ") {
      const c = Buffer.from(b.subarray(i, Math.min(end, b.length)));
      if (id === "VP8X" && c.length > 8) c[8] &= ~(0x08 | 0x04);
      chunks.push(c);
    }
    i = end;
  }
  const body = Buffer.concat(chunks);
  const head = Buffer.alloc(12);
  head.write("RIFF", 0, "ascii");
  head.writeUInt32LE(body.length + 4, 4);
  head.write("WEBP", 8, "ascii");
  return Buffer.concat([head, body]);
}

export function stripMetadata(b: Buffer, mime: ImageMime): Buffer {
  return mime === "image/jpeg" ? stripJpeg(b) : mime === "image/png" ? stripPng(b) : stripWebp(b);
}

/** Decode a data URL or bare base64 string, check its real type and size, strip metadata. */
export function cleanImage(input: string): { ok: true; mime: ImageMime; data: Buffer } | { ok: false; error: string } {
  const m = /^data:([^;,]+)?;base64,(.*)$/s.exec(input);
  const b64 = (m ? m[2] : input).replace(/\s+/g, "");
  if (!/^[A-Za-z0-9+/]+=*$/.test(b64)) return { ok: false, error: "photo is not valid base64" };
  if (b64.length * 0.75 > MAX_IMAGE_BYTES + 4) return { ok: false, error: "photo is larger than 8 MB" };
  const raw = Buffer.from(b64, "base64");
  if (raw.length > MAX_IMAGE_BYTES) return { ok: false, error: "photo is larger than 8 MB" };
  const mime = sniffImage(raw);
  if (!mime) return { ok: false, error: "only JPEG, PNG or WebP photos are accepted" };
  return { ok: true, mime, data: stripMetadata(raw, mime) };
}

export const extFor = (mime: ImageMime) => (mime === "image/jpeg" ? "jpg" : mime === "image/png" ? "png" : "webp");
