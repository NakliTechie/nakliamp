// Build a long stereo DSF from the one-second mono fixture, at runtime.
//
// DSD is one bit per sample and compresses nothing, so a multi-minute fixture
// would weigh hundreds of megabytes in the repository. Instead the short
// fixture's header is rewritten and its data blocks repeated. The result is a
// list of parts: `new Blob(parts)` holds each repeated unit by reference.
//
// Used by test/pending-dsd-stream.test.mjs (Node) and test/wasm-decode.html.

const le32 = (data, at) => (data[at] | (data[at + 1] << 8) | (data[at + 2] << 16) | (data[at + 3] << 24)) >>> 0;

function put32(data, at, value) {
  for (let index = 0; index < 4; index += 1) data[at + index] = (value >>> (8 * index)) & 0xff;
}

function put64(data, at, value) {
  put32(data, at, value % 2 ** 32);
  put32(data, at + 4, Math.floor(value / 2 ** 32));
}

/**
 * Parts of a stereo DSF lasting at least `seconds`, made from a mono DSF.
 *
 * The right channel is the left one shifted by half the fixture, so the two
 * channels differ. Returns `{ parts, size, seconds, groups, blockSize, dsdRate }`.
 */
export function makeLongDsf(mono, seconds) {
  const fmtAt = le32(mono, 4);
  const fmtSize = le32(mono, fmtAt + 4);
  const dsdRate = le32(mono, fmtAt + 28);
  const blockSize = le32(mono, fmtAt + 44);
  const dataAt = fmtAt + fmtSize;
  const headerBytes = dataAt + 12;
  if (le32(mono, fmtAt + 24) !== 1) throw new Error('makeLongDsf expects a mono DSF.');
  const blocks = Math.floor((mono.length - headerBytes) / blockSize);

  // One unit: every block of the fixture, as left/right block pairs.
  const unit = new Uint8Array(blocks * blockSize * 2);
  for (let index = 0; index < blocks; index += 1) {
    const left = headerBytes + index * blockSize;
    const right = headerBytes + ((index + Math.floor(blocks / 2)) % blocks) * blockSize;
    unit.set(mono.subarray(left, left + blockSize), index * blockSize * 2);
    unit.set(mono.subarray(right, right + blockSize), index * blockSize * 2 + blockSize);
  }

  const groups = Math.ceil((seconds * dsdRate) / (blockSize * 8));
  const dataBytes = groups * blockSize * 2;
  const header = mono.slice(0, headerBytes);
  put64(header, 12, headerBytes + dataBytes);
  put64(header, 20, 0);
  put32(header, fmtAt + 20, 2); // channel type: stereo
  put32(header, fmtAt + 24, 2); // channel count
  put64(header, fmtAt + 36, groups * blockSize * 8);
  put64(header, dataAt + 4, dataBytes + 12);

  const parts = [header];
  let left = dataBytes;
  while (left >= unit.length) { parts.push(unit); left -= unit.length; }
  if (left) parts.push(unit.subarray(0, left));
  return { parts, size: headerBytes + dataBytes, seconds: (groups * blockSize * 8) / dsdRate, groups, blockSize, dsdRate };
}
