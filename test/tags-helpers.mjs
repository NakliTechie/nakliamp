// Shared helpers for the tags tests: locate the audio payload of each
// container so a test can assert a tag write left it byte-identical.

import { readFile } from 'node:fs/promises';

export const FIXTURES = new URL('./fixtures/', import.meta.url);

export async function fixture(name) {
  return new Uint8Array(await readFile(new URL(name, FIXTURES)));
}

export async function blobBytes(blob) {
  return new Uint8Array(await blob.arrayBuffer());
}

export function u32be(bytes, offset) {
  return ((bytes[offset] << 24) | (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3]) >>> 0;
}

export function ascii(bytes, offset, length) {
  return String.fromCharCode(...bytes.subarray(offset, offset + length));
}

export function equalBytes(left, right) {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) if (left[index] !== right[index]) return false;
  return true;
}

export function syncsafeSize(bytes, offset) {
  return ((bytes[offset] & 0x7f) << 21) | ((bytes[offset + 1] & 0x7f) << 14) | ((bytes[offset + 2] & 0x7f) << 7) | (bytes[offset + 3] & 0x7f);
}

/** MP3: everything after the leading ID3v2 tag (and its padding). */
export function mp3Audio(bytes) {
  if (ascii(bytes, 0, 3) !== 'ID3') return bytes;
  const footer = bytes[3] === 4 && (bytes[5] & 0x10) ? 10 : 0;
  return bytes.subarray(10 + syncsafeSize(bytes, 6) + footer);
}

/** FLAC: everything after the last metadata block, plus the STREAMINFO body. */
export function flacAudio(bytes) {
  let cursor = 4;
  let streaminfo = null;
  for (;;) {
    const last = (bytes[cursor] & 0x80) !== 0;
    const type = bytes[cursor] & 0x7f;
    const length = (bytes[cursor + 1] << 16) | (bytes[cursor + 2] << 8) | bytes[cursor + 3];
    if (type === 0) streaminfo = bytes.subarray(cursor + 4, cursor + 4 + length);
    cursor += 4 + length;
    if (last) break;
  }
  return { streaminfo, frames: bytes.subarray(cursor) };
}

export function flacBlockTypes(bytes) {
  const types = [];
  let cursor = 4;
  for (;;) {
    const last = (bytes[cursor] & 0x80) !== 0;
    types.push(bytes[cursor] & 0x7f);
    cursor += 4 + ((bytes[cursor + 1] << 16) | (bytes[cursor + 2] << 8) | bytes[cursor + 3]);
    if (last) return types;
  }
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index << 24;
    for (let bit = 0; bit < 8; bit += 1) value = (value & 0x80000000) ? ((value << 1) ^ 0x04c11db7) : (value << 1);
    table[index] = value >>> 0;
  }
  return table;
})();

export function oggCrc(page) {
  let crc = 0;
  for (let index = 0; index < page.length; index += 1) {
    const byte = index >= 22 && index < 26 ? 0 : page[index];
    crc = ((crc << 8) ^ CRC_TABLE[((crc >>> 24) ^ byte) & 0xff]) >>> 0;
  }
  return crc >>> 0;
}

/** Split an Ogg stream into pages with their fields. */
export function oggPages(bytes) {
  const pages = [];
  let cursor = 0;
  while (cursor + 27 <= bytes.length && ascii(bytes, cursor, 4) === 'OggS') {
    const segments = bytes[cursor + 26];
    const lacing = bytes.subarray(cursor + 27, cursor + 27 + segments);
    const bodyLength = lacing.reduce((sum, value) => sum + value, 0);
    const length = 27 + segments + bodyLength;
    const raw = bytes.subarray(cursor, cursor + length);
    const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
    pages.push({
      raw,
      granule: view.getBigInt64(6, true),
      serial: view.getUint32(14, true),
      sequence: view.getUint32(18, true),
      crc: view.getUint32(22, true),
      headerType: raw[5],
      lacing,
      body: raw.subarray(27 + segments),
    });
    cursor += length;
  }
  return { pages, trailing: bytes.length - cursor };
}

/** The pages after the header packets (Vorbis: 3, Opus: 2). */
export function oggAudioPages(bytes, headerPackets) {
  const { pages } = oggPages(bytes);
  let packets = 0;
  let index = 0;
  for (; index < pages.length && packets < headerPackets; index += 1) {
    for (const value of pages[index].lacing) if (value < 255) packets += 1;
  }
  return { headerPages: pages.slice(0, index), audioPages: pages.slice(index), allPages: pages };
}

/** Walk MP4 boxes in `bytes[start, end)`. */
export function mp4Boxes(bytes, start = 0, end = bytes.length) {
  const boxes = [];
  let cursor = start;
  while (cursor + 8 <= end) {
    let size = u32be(bytes, cursor);
    const type = ascii(bytes, cursor + 4, 4);
    let header = 8;
    if (size === 1) { size = Number(new DataView(bytes.buffer, bytes.byteOffset).getBigUint64(cursor + 8)); header = 16; }
    if (size === 0) size = end - cursor;
    if (size < header) break;
    boxes.push({ type, start: cursor, size, body: cursor + header, end: cursor + size });
    cursor += size;
  }
  return boxes;
}

export function mp4Find(bytes, path, start = 0, end = bytes.length) {
  const [head, ...rest] = path;
  const found = [];
  for (const box of mp4Boxes(bytes, start, end)) {
    if (box.type !== head) continue;
    if (!rest.length) found.push(box);
    else found.push(...mp4Find(bytes, rest, box.body + (head === 'meta' ? 4 : 0), box.end));
  }
  return found;
}

/** Chunk offsets from every stco/co64 table, as { box, entryOffset, value }. */
export function mp4ChunkOffsets(bytes) {
  const out = [];
  const stbls = mp4Find(bytes, ['moov', 'trak', 'mdia', 'minf', 'stbl']);
  for (const stbl of stbls) {
    for (const box of mp4Boxes(bytes, stbl.body, stbl.end)) {
      if (box.type !== 'stco' && box.type !== 'co64') continue;
      const count = u32be(bytes, box.body + 4);
      const width = box.type === 'stco' ? 4 : 8;
      for (let index = 0; index < count; index += 1) {
        const entryOffset = box.body + 8 + index * width;
        const value = width === 4 ? u32be(bytes, entryOffset) : Number(new DataView(bytes.buffer, bytes.byteOffset).getBigUint64(entryOffset));
        out.push({ type: box.type, entryOffset, value });
      }
    }
  }
  return out;
}

export function mp4Mdat(bytes) {
  const mdat = mp4Boxes(bytes).find((box) => box.type === 'mdat');
  return bytes.subarray(mdat.body, mdat.end);
}

/**
 * Rebuild an MP4 with moov before mdat ("fast start"), fixing stco offsets,
 * so the writer's offset rewrite is exercised.
 */
export function fastStart(bytes) {
  const boxes = mp4Boxes(bytes);
  const ftyp = boxes.find((box) => box.type === 'ftyp');
  const moov = boxes.find((box) => box.type === 'moov');
  const mdat = boxes.find((box) => box.type === 'mdat');
  const moovBytes = bytes.slice(moov.start, moov.end);
  const newMdatStart = ftyp.size + moov.size;
  const delta = newMdatStart - mdat.start;
  const out = new Uint8Array(ftyp.size + moov.size + mdat.size);
  out.set(bytes.subarray(ftyp.start, ftyp.end), 0);
  out.set(moovBytes, ftyp.size);
  out.set(bytes.subarray(mdat.start, mdat.end), newMdatStart);
  const view = new DataView(out.buffer);
  for (const entry of mp4ChunkOffsets(out)) {
    if (entry.type === 'stco') view.setUint32(entry.entryOffset, entry.value + delta);
    else view.setBigUint64(entry.entryOffset, BigInt(entry.value + delta));
  }
  return out;
}

/** Build an ID3v2.3 or 2.2 tag from [id, body] frames. */
export function id3Tag(major, frames, flags = 0) {
  const parts = frames.map(([id, body]) => {
    const header = new Uint8Array(major === 2 ? 6 : 10);
    for (let index = 0; index < id.length; index += 1) header[index] = id.charCodeAt(index);
    if (major === 2) header.set([(body.length >> 16) & 0xff, (body.length >> 8) & 0xff, body.length & 0xff], 3);
    else header.set([(body.length >>> 24) & 0xff, (body.length >> 16) & 0xff, (body.length >> 8) & 0xff, body.length & 0xff], 4);
    return [header, body];
  }).flat();
  let body = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let cursor = 0;
  for (const part of parts) { body.set(part, cursor); cursor += part.length; }
  if (flags & 0x80) {
    const out = [];
    for (let index = 0; index < body.length; index += 1) {
      out.push(body[index]);
      if (body[index] === 0xff && (index + 1 === body.length || body[index + 1] >= 0xe0 || body[index + 1] === 0)) out.push(0);
    }
    body = new Uint8Array(out);
  }
  const tag = new Uint8Array(10 + body.length);
  tag.set([0x49, 0x44, 0x33, major, 0, flags]);
  const size = body.length;
  tag.set([(size >> 21) & 0x7f, (size >> 14) & 0x7f, (size >> 7) & 0x7f, size & 0x7f], 6);
  tag.set(body, 10);
  return tag;
}

export function latin1(text) {
  return new Uint8Array([0, ...Array.from(text, (char) => char.charCodeAt(0))]);
}

export function utf16(text) {
  const out = [1, 0xff, 0xfe];
  for (const char of text) { const code = char.charCodeAt(0); out.push(code & 0xff, code >> 8); }
  return new Uint8Array(out);
}

export function concat(...parts) {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let cursor = 0;
  for (const part of parts) { out.set(part, cursor); cursor += part.length; }
  return out;
}

/** A tiny but valid-looking PNG payload (signature plus junk) for picture tests. */
export const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 1, 2, 3, 0xff, 0xe0, 4]);
export const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0, 0xff, 0xd9]);
