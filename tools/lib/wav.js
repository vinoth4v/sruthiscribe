// Minimal WAV reader + the same mixdown/resample the browser does.
//
// Deliberately dependency-free: Sanidha ships 16-bit PCM WAV, and anything else
// (Saraga's mp3, 24-bit, whatever) gets normalised to 16-bit 44.1k WAV by
// afconvert -- which is part of macOS -- before it reaches this file. So the
// harness needs no npm install and no ffmpeg.
//
// Reads are range-limited by design. A Sanidha concert track is up to two hours
// long; decoding one whole would cost well over a gigabyte of Float32 for a
// clip we only wanted 60 seconds of, so the header is parsed first and then
// only the requested byte window is pulled off disk.

const fs = require('fs');
const { execFileSync } = require('child_process');
const path = require('path');
const os = require('os');

function parseHeader(fd, fileSize) {
  const head = Buffer.alloc(Math.min(fileSize, 1 << 16));
  fs.readSync(fd, head, 0, head.length, 0);
  if (head.toString('ascii', 0, 4) !== 'RIFF' || head.toString('ascii', 8, 12) !== 'WAVE')
    throw new Error('not a RIFF/WAVE file');

  let pos = 12, fmt = null, dataOff = -1, dataLen = 0;
  while (pos + 8 <= head.length) {
    const id = head.toString('ascii', pos, pos + 4);
    const size = head.readUInt32LE(pos + 4);
    const body = pos + 8;
    if (id === 'fmt ' && body + 16 <= head.length) {
      fmt = {
        format: head.readUInt16LE(body),
        channels: head.readUInt16LE(body + 2),
        sampleRate: head.readUInt32LE(body + 4),
        bits: head.readUInt16LE(body + 14)
      };
      // WAVE_FORMAT_EXTENSIBLE hides the real format in the GUID's first word.
      if (fmt.format === 0xfffe && size >= 40 && body + 26 <= head.length)
        fmt.format = head.readUInt16LE(body + 24);
    } else if (id === 'data') {
      dataOff = body;
      // Some writers leave the size field at 0 or 0xffffffff for streamed files.
      dataLen = (size === 0 || size === 0xffffffff || body + size > fileSize)
        ? fileSize - body : size;
      break; // audio follows; no need to scan further
    }
    pos = body + size + (size & 1); // chunks are word-aligned
  }
  if (!fmt || dataOff < 0) throw new Error('missing fmt or data chunk');
  return { fmt: fmt, dataOff: dataOff, dataLen: dataLen };
}

function sampleReader(format, bits) {
  if (format === 3 && bits === 64) return (b, o) => b.readDoubleLE(o);
  if (format === 3) return (b, o) => b.readFloatLE(o);
  if (bits === 16) return (b, o) => b.readInt16LE(o) / 32768;
  if (bits === 24) return (b, o) => {
    let v = b[o] | (b[o + 1] << 8) | (b[o + 2] << 16);
    if (v & 0x800000) v |= ~0xffffff;   // sign-extend 24 -> 32
    return v / 8388608;
  };
  if (bits === 32) return (b, o) => b.readInt32LE(o) / 2147483648;
  if (bits === 8) return (b, o) => (b[o] - 128) / 128;
  throw new Error('unsupported bit depth ' + bits);
}

// startSec/lenSec are optional; omitting them reads the whole file.
function readWav(file, startSec, lenSec) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const { fmt, dataOff, dataLen } = parseHeader(fd, size);
    const bytes = fmt.bits >> 3, stride = bytes * fmt.channels;
    const totalFrames = Math.floor(dataLen / stride);

    const from = Math.min(totalFrames, Math.max(0, Math.floor((startSec || 0) * fmt.sampleRate)));
    const want = lenSec == null ? totalFrames - from
      : Math.min(totalFrames - from, Math.max(0, Math.ceil(lenSec * fmt.sampleRate)));

    const buf = Buffer.alloc(want * stride);
    if (buf.length) fs.readSync(fd, buf, 0, buf.length, dataOff + from * stride);

    const read = sampleReader(fmt.format, fmt.bits);
    const chans = [];
    for (let c = 0; c < fmt.channels; c++) chans.push(new Float32Array(want));
    for (let i = 0; i < want; i++)
      for (let c = 0; c < fmt.channels; c++)
        chans[c][i] = read(buf, (i * fmt.channels + c) * bytes);

    return {
      channels: chans, sampleRate: fmt.sampleRate, frames: want,
      offsetSec: from / fmt.sampleRate, totalDuration: totalFrames / fmt.sampleRate
    };
  } finally {
    fs.closeSync(fd);
  }
}

// afconvert is a macOS system binary -- no install step. Converts anything
// CoreAudio understands (mp3, m4a, flac, 24-bit wav) to 16-bit PCM WAV.
function toWav(file, outFile) {
  execFileSync('/usr/bin/afconvert', ['-f', 'WAVE', '-d', 'LEI16', file, outFile], {
    stdio: ['ignore', 'ignore', 'pipe']
  });
  return outFile;
}

const CONVERTIBLE = new Set(['.mp3', '.m4a', '.aac', '.flac', '.aif', '.aiff', '.caf', '.ogg']);

// Reads any supported file, converting through a temp WAV when needed. Non-WAV
// input is converted in full first (afconvert has no seek), so prefer WAV
// sources for long files -- fetch-saraga.py caches a converted copy for exactly
// this reason.
function readAudio(file, startSec, lenSec) {
  const ext = path.extname(file).toLowerCase();
  if (ext === '.wav') return readWav(file, startSec, lenSec);
  if (!CONVERTIBLE.has(ext)) throw new Error(file + ': unsupported audio extension ' + ext);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sscribe-'));
  const tmp = path.join(dir, 'a.wav');
  try {
    toWav(file, tmp);
    return readWav(tmp, startSec, lenSec);
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {}
  }
}

// Same contract as the page's trimmed(): a mono Float32Array at the engine's
// working rate. `audio` is assumed to already start at the segment start.
function toMono(audio, engine) {
  return engine.mixdownResample(audio.channels, audio.sampleRate, engine.DEFAULTS.sr);
}

module.exports = { readWav, readAudio, toWav, toMono };
