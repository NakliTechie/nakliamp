// R3 software decode, wasm tier: the compressed formats no browser decodes.
//
// NOT YET WIRED IN. Nothing imports this module; the lean build ships only the
// in-house PCM tier. It is committed because the binary it targets is vendored
// and pinned, and this is the shape the adapter takes.
//
// What is blocking it: the custom libav.js variant instantiates and exposes 272
// symbols (`av_dict_*`, `ff_malloc_*`, the AV_* constants) but **not** the
// high-level helpers this file calls — `ff_init_demuxer_file`,
// `ff_read_frame_multi`, `ff_decode_multi` — nor `writeFile`/`unlink`.
// Instantiating through `LibAV.LibAV({base, variant})` without an explicit
// factory yields an instance with no methods at all; passing `factory` yields
// the raw emscripten module instead of the wrapped one. So the frontend is not
// binding its helpers to this variant. Next step is to compare our generated
// config against a stock variant that does work (`default`), since the
// difference is most likely a missing base fragment rather than the API.
//
// WMA (v1, v2, Pro, Lossless) and WavPack, through a custom libav.js build
// configured with exactly those decoders and their demuxers — 176 KB of wasm,
// not a general-purpose ffmpeg. See VENDOR.md for the build and its LGPL terms.
//
// This tier is separate from the in-house PCM tier because it costs a download.
// The lean build ships only the PCM tier; the full build appends this one.
//
// Loading is lazy and happens once: the module is only instantiated when a file
// actually needs it, so a library of MP3s never pays for it.

const WASM_URL = new URL('../../vendor/libav/libav-6.10.9.0-nakliamp.wasm.wasm', import.meta.url);
const GLUE_URL = new URL('../../vendor/libav/libav-6.10.9.0-nakliamp.wasm.mjs', import.meta.url);

/** Containers this tier claims. Sniffed by magic bytes, never by file name. */
const SIGNATURES = [
  // ASF/WMA: the ASF header GUID.
  { container: 'wma', bytes: [0x30, 0x26, 0xb2, 0x75, 0x8e, 0x66, 0xcf, 0x11] },
  // WavPack.
  { container: 'wavpack', bytes: [0x77, 0x76, 0x70, 0x6b] },
];

function startsWith(data, signature) {
  if (data.length < signature.length) return false;
  return signature.every((byte, index) => data[index] === byte);
}

/** Returns the container name this tier can decode, or null. */
export function sniffLibav(data) {
  if (!data || data.length < 8) return null;
  return SIGNATURES.find(entry => startsWith(data, entry.bytes))?.container ?? null;
}

let modulePromise = null;

/**
 * Instantiate libav once and reuse it.
 * Held as a promise rather than a value so concurrent callers share one
 * instantiation instead of racing to build several.
 */
async function libav() {
  modulePromise ??= (async () => {
    const factory = await import(GLUE_URL.href);
    const create = factory.default ?? factory.LibAVFactory ?? factory;
    if (typeof create !== 'function') {
      throw Object.assign(new Error('The libav glue did not export a factory.'), {
        code: 'ERR_NAKLIAMP_LIBAV_GLUE',
      });
    }
    return create({
      // Keep the wasm beside its glue rather than wherever the page happens to
      // be. In the single-file build both are blob URLs and this still holds.
      locateFile: () => WASM_URL.href,
    });
  })();
  return modulePromise;
}

const decodeError = (code, message, cause) => {
  const error = new Error(message);
  error.name = 'LibavDecodeError';
  error.code = code;
  if (cause) error.cause = cause;
  return error;
};

/**
 * Decode a whole file to per-channel Float32Arrays.
 *
 * Whole-file decode matches the in-house tier's contract and suits the sizes
 * involved: these are music tracks, not streams. Interleaved output is
 * deinterleaved here so the caller sees one shape from every R3 decoder.
 */
export async function decodeLibav(data) {
  const container = sniffLibav(data);
  if (!container) {
    throw decodeError('ERR_NAKLIAMP_LIBAV_UNKNOWN', 'This file is not a container the wasm decoder reads.');
  }

  let instance;
  try {
    instance = await libav();
  } catch (error) {
    throw decodeError('ERR_NAKLIAMP_LIBAV_UNAVAILABLE', 'The software decoder could not start.', error);
  }

  const name = `input.${container}`;
  try {
    await instance.writeFile(name, data);
    const [format, streams] = await instance.ff_init_demuxer_file(name);
    const audio = streams.find(stream => stream.codec_type === instance.AVMEDIA_TYPE_AUDIO);
    if (!audio) throw decodeError('ERR_NAKLIAMP_LIBAV_NO_AUDIO', 'This file has no audio stream.');

    const [, context, packet, frame] = await instance.ff_init_decoder(audio.codec_id, audio.codecpar);
    const [, packets] = await instance.ff_read_frame_multi(format, packet, { limit: -1 });
    const frames = await instance.ff_decode_multi(context, packet, frame, packets[audio.index] ?? [], true);
    if (!frames.length) throw decodeError('ERR_NAKLIAMP_LIBAV_EMPTY', 'The software decoder produced no audio.');

    const decoded = collect(frames);
    await instance.ff_free_decoder(context, packet, frame);
    await instance.avformat_close_input_js(format);
    await instance.unlink(name);
    return decoded;
  } catch (error) {
    try { await instance.unlink(name); } catch { /* the file may never have been written */ }
    if (error?.code?.startsWith?.('ERR_NAKLIAMP_')) throw error;
    throw decodeError('ERR_NAKLIAMP_LIBAV_FAILED', `The software decoder could not read this file: ${error?.message ?? error}`, error);
  }
}

/** libav frames arrive planar or packed depending on the codec; normalise both. */
function collect(frames) {
  const first = frames[0];
  const channelCount = first.channels ?? first.channel_layout?.nb_channels ?? 1;
  const sampleRate = first.sample_rate;
  const planar = Array.isArray(first.data) && Array.isArray(first.data[0]);

  let total = 0;
  for (const frame of frames) {
    total += planar ? frame.data[0].length : frame.data.length / channelCount;
  }

  const channels = Array.from({ length: channelCount }, () => new Float32Array(total));
  let offset = 0;
  for (const frame of frames) {
    if (planar) {
      const length = frame.data[0].length;
      for (let channel = 0; channel < channelCount; channel += 1) {
        channels[channel].set(toFloat(frame.data[channel] ?? frame.data[0]), offset);
      }
      offset += length;
    } else {
      const interleaved = toFloat(frame.data);
      const length = interleaved.length / channelCount;
      for (let index = 0; index < length; index += 1) {
        for (let channel = 0; channel < channelCount; channel += 1) {
          channels[channel][offset + index] = interleaved[index * channelCount + channel];
        }
      }
      offset += length;
    }
  }

  return { sampleRate, channels, frames: total };
}

/** Integer sample formats arrive as typed integer arrays; scale them to [-1, 1]. */
function toFloat(samples) {
  if (samples instanceof Float32Array) return samples;
  if (samples instanceof Float64Array) return Float32Array.from(samples);
  const scale = samples instanceof Int16Array ? 32768
    : samples instanceof Int32Array ? 2147483648
    : samples instanceof Uint8Array ? 128
    : 1;
  const out = new Float32Array(samples.length);
  const bias = samples instanceof Uint8Array ? 128 : 0;
  for (let index = 0; index < samples.length; index += 1) out[index] = (samples[index] - bias) / scale;
  return out;
}

/** The decoder entry the engine's `softwareDecoders` list expects. */
export const libavDecoder = Object.freeze({
  name: 'libav wasm',
  sniff: sniffLibav,
  decode: decodeLibav,
});
