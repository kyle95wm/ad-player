#!/usr/bin/env node
// Test tool only, not part of the deployed player (excluded from GitHub Pages).
//
// Compares the player's AudioWorklet DSP (dsp-processor.js) with:
//   1. the real FFmpeg filter chain Plezy uses (acompressor + alimiter), and
//   2. the reference C++ port, AndroidDSP.h (fixed mode, programme mode off).
// All three get identical float32 PCM, sample rate and channel count.
//
// Requirements: Node 18+, ffmpeg on PATH, clang++ (C++20), and the reference
// project. Point REFERENCE_SRC at its src/ directory:
//
//   REFERENCE_SRC=/path/to/android_normalize_plugin/src node tests/compare-dsp.mjs
//
// The reference project is only read. Build products and PCM go to a temp dir.

import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const referenceSrc = process.env.REFERENCE_SRC;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ad-player-dsp-'));

const CHAIN = 'acompressor=threshold=-34dB:ratio=4:knee=6dB:attack=30:release=300:makeup=15dB:link=maximum,' +
  'alimiter=limit=-3dB:attack=1:release=60:level=false';
const LIMIT = Math.pow(10, -3 / 20);
const JS_BLOCKS = [1, 127, 128, 512, 4096];

// ---------------------------------------------------------------------------
// JavaScript worklet renderer (runs dsp-processor.js in a sandbox)
// ---------------------------------------------------------------------------

// The worklet is evaluated once in this realm with the AudioWorklet globals
// stubbed. (A vm sandbox also works, but cross-realm typed arrays make it
// about 25 times slower.) The processor reads `sampleRate` when it first
// sees audio, so setting the global before each render is enough.
const workletSource = fs.readFileSync(path.join(root, 'dsp-processor.js'), 'utf8');
let Processor;
globalThis.AudioWorkletProcessor = class { constructor() { this.port = { postMessage() {} }; } };
globalThis.registerProcessor = (_name, cls) => { Processor = cls; };
globalThis.sampleRate = 48000;
(0, eval)(workletSource);

function renderJS(pcm, rate, channels, block) {
  globalThis.sampleRate = rate;
  const proc = new Processor({});
  const frames = pcm.length / channels;
  const out = new Float32Array(pcm.length);
  const inBlock = Array.from({ length: channels }, () => new Float32Array(block));
  const outBlock = Array.from({ length: channels }, () => new Float32Array(block));
  for (let start = 0; start < frames; start += block) {
    const count = Math.min(block, frames - start);
    const ins = inBlock.map((b) => (count === block ? b : b.subarray(0, count)));
    const outs = outBlock.map((b) => (count === block ? b : b.subarray(0, count)));
    for (let c = 0; c < channels; c++) for (let n = 0; n < count; n++) ins[c][n] = pcm[(start + n) * channels + c];
    proc.process([ins], [outs]);
    for (let c = 0; c < channels; c++) for (let n = 0; n < count; n++) out[(start + n) * channels + c] = outs[c][n];
  }
  return { out, latency: proc.dsp.latencySamples() };
}

// ---------------------------------------------------------------------------
// FFmpeg and reference renderers
// ---------------------------------------------------------------------------

function writePcm(name, pcm) {
  const file = path.join(tmp, name);
  fs.writeFileSync(file, Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength));
  return file;
}
function readPcm(file) {
  const buf = fs.readFileSync(file);
  return new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
}

function renderFFmpeg(inFile, rate, channels) {
  const outFile = path.join(tmp, 'ffmpeg.f32');
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'f32le', '-ar', String(rate), '-ac', String(channels), '-i', inFile,
    '-af', CHAIN, '-c:a', 'pcm_f32le', '-f', 'f32le', outFile]);
  return readPcm(outFile);
}

let referenceBin = null;
function buildReference() {
  if (!referenceSrc) return;
  referenceBin = path.join(tmp, 'render-reference');
  execFileSync('clang++', ['-std=c++20', '-O2', '-I' + referenceSrc,
    path.join(here, 'render-reference.cpp'), '-o', referenceBin], { stdio: 'inherit' });
}
function renderReference(inFile, rate, channels, block) {
  const outFile = path.join(tmp, 'reference.f32');
  const latency = Number(execFileSync(referenceBin,
    [String(rate), String(channels), String(block), inFile, outFile]).toString().trim());
  return { out: readPcm(outFile), latency };
}

// ---------------------------------------------------------------------------
// Test signals (deterministic)
// ---------------------------------------------------------------------------

function rng(seed) {
  let s = seed >>> 0;
  return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296 * 2 - 1; };
}
const db = (x) => Math.pow(10, x / 20);

function build(rate, channels, seconds, fn) {
  const frames = Math.round(rate * seconds);
  const pcm = new Float32Array(frames * channels);
  for (let n = 0; n < frames; n++) for (let c = 0; c < channels; c++) pcm[n * channels + c] = fn(n, c, n / rate);
  return pcm;
}

const fixtures = {
  // Sustained 1 kHz tones from well below to above threshold, 1.5 s each.
  tones: (rate, ch) => {
    const levels = [-60, -46, -40, -37, -34, -31, -28, -20, -10, -3, 0, 3];
    return build(rate, ch, levels.length * 1.5, (n, c, t) =>
      db(levels[Math.floor(t / 1.5)]) * Math.sin(2 * Math.PI * 1000 * t));
  },
  // Level steps exercising attack and release: -40 -> -10 -> -40 -> -20 -> -50 dBFS.
  steps: (rate, ch) => {
    const levels = [-40, -10, -40, -20, -50];
    return build(rate, ch, levels.length * 2, (n, c, t) =>
      db(levels[Math.floor(t / 2)]) * Math.sin(2 * Math.PI * 440 * t));
  },
  // Quiet floor with isolated single-sample peaks, short bursts and a square burst.
  transients: (rate, ch) => {
    const r = rng(7);
    return build(rate, ch, 6, (n, c, t) => {
      let v = db(-50) * r();
      const ms = Math.floor(t * 1000);
      if (n === Math.round(rate * 0.5)) v = 0.5;
      if (n === Math.round(rate * 1.0)) v = 1.0;
      if (n === Math.round(rate * 1.5) && c === 0) v = 2.0;
      if (n === Math.round(rate * 2.0) + c) v = -4.0;
      if (n >= Math.round(rate * 2.5) && n < Math.round(rate * 2.5) + 3) v = 0.95; // 3-sample cluster
      if (ms >= 3000 && ms < 3005) v = 0.9 * Math.sin(2 * Math.PI * 3000 * t);   // 5 ms burst
      if (ms >= 3500 && ms < 3600) v = (Math.floor(n / 24) % 2 ? 1 : -1);        // full-scale square
      if (ms >= 4000 && ms < 4300) v = 0.7 * r();                                // noise burst
      for (let k = 0; k < 8; k++) if (n === Math.round(rate * (4.6 + k * 0.05)) && c === (k % ch)) v = 1.5;
      return v;
    });
  },
  // Unequal channels: linking must apply one shared gain to all of them.
  unequal: (rate, ch) => build(rate, ch, 8, (n, c, t) => {
    const seg = Math.floor(t / 2);
    const loud = db(-10) * Math.sin(2 * Math.PI * 440 * t);
    const quiet = db(-40) * Math.sin(2 * Math.PI * (660 + 110 * c) * t);
    if (seg === 0) return c === 0 ? loud : quiet;          // loud only on channel 0
    if (seg === 1) return c === 0 ? loud : 0;              // other channels silent
    if (seg === 2) return c === ch - 1 ? loud : quiet;     // loud moves to last channel
    return db(-20 - 6 * c) * Math.sin(2 * Math.PI * 500 * t); // graded levels
  }),
  silence: (rate, ch) => new Float32Array(Math.round(rate * 2) * ch),
  // Synthetic programme: room tone, dialogue-like envelopes, bursts, overloads,
  // DC offset and gated silence (same shape as the reference project's fixture).
  programme: (rate, ch) => {
    const r = rng(2832);
    const prev = new Float64Array(ch);
    return build(rate, ch, 5, (n, c, t) => {
      const section = Math.floor(t / 0.5) % 10;
      const amp = [0.0001, 0.02, 0.06, 0.25, 0.7, 0.03, 1.7, 0.1, 0, 0.01][section];
      prev[c] = 0.7 * prev[c] + 0.3 * r();
      let v = amp * (0.8 * Math.sin(2 * Math.PI * (173 + 81 * c) * t) + 0.2 * prev[c]);
      if (section === 6 && n % 137 === c) v = 3 * (c % 2 ? -1 : 1);
      if (section === 7) v += 0.09 / (c + 1);
      if (section === 9) v *= ((Math.floor(n / 127) + c) % 3 === 0) ? 1 : 0;
      return v;
    });
  },
};

// Real recorded-style programme: macOS text-to-speech dialogue over a music bed.
let speechCache = new Map();
function speech(rate, ch) {
  if (process.platform !== 'darwin') return null;
  if (!speechCache.has('aiff')) {
    const aiff = path.join(tmp, 'speech.aiff');
    const text = 'Previously on the programme. The detective crossed the empty platform, ' +
      'listening for footsteps. Somewhere a train door slammed. Then, very quietly, someone whispered her name.';
    const r = spawnSync('say', ['-o', aiff, text]);
    speechCache.set('aiff', r.status === 0 ? aiff : null);
  }
  const aiff = speechCache.get('aiff');
  if (!aiff) return null;
  const mono = path.join(tmp, `speech-${rate}.f32`);
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', aiff,
    '-ac', '1', '-ar', String(rate), '-f', 'f32le', mono]);
  const voice = readPcm(mono);
  const frames = voice.length;
  const pcm = new Float32Array(frames * ch);
  for (let n = 0; n < frames; n++) {
    const t = n / rate;
    const bed = 0.04 * (Math.sin(2 * Math.PI * 110 * t) + 0.6 * Math.sin(2 * Math.PI * 164.8 * t) +
      0.5 * Math.sin(2 * Math.PI * 220 * t)) * (0.6 + 0.4 * Math.sin(2 * Math.PI * 0.25 * t));
    const hit = (n % Math.round(rate * 0.75)) < rate * 0.01 ? 0.6 * Math.sin(2 * Math.PI * 60 * t) : 0;
    for (let c = 0; c < ch; c++) {
      const pan = c === 0 ? 1 : 1 - 0.12 * c;
      pcm[n * ch + c] = voice[n] * 0.9 * pan + bed * (c % 2 ? 0.8 : 1) + hit;
    }
  }
  return pcm;
}

// ---------------------------------------------------------------------------
// Comparison
// ---------------------------------------------------------------------------

function compare(a, b, offset = 0) {
  // offset: b is delayed by `offset` frames relative to a (already in samples).
  let maxErr = 0, diffs = 0;
  const n = Math.min(a.length, b.length - offset);
  for (let i = 0; i < n; i++) {
    const e = Math.abs(a[i] - b[i + offset]);
    if (e > 0) diffs++;
    if (e > maxErr) maxErr = e;
  }
  return { maxErr, diffs, compared: n };
}

function measureLatency(render, rate, ch) {
  const frames = Math.round(rate * 0.2);
  const pcm = new Float32Array(frames * ch);
  const at = 1000;
  for (let c = 0; c < ch; c++) pcm[at * ch + c] = 0.01;
  const out = render(pcm);
  for (let i = 0; i < out.length; i++) if (out[i] !== 0) return Math.floor(i / ch) - at;
  return NaN;
}

function peak(pcm) { let m = 0; for (const v of pcm) m = Math.max(m, Math.abs(v)); return m; }

buildReference();
if (!referenceBin) console.log('REFERENCE_SRC not set: comparing with FFmpeg only.');

const cases = [
  { rate: 44100, ch: 1 }, { rate: 44100, ch: 2 },
  { rate: 48000, ch: 1 }, { rate: 48000, ch: 2 }, { rate: 48000, ch: 6 }, { rate: 48000, ch: 8 },
  { rate: 96000, ch: 2 }, { rate: 22050, ch: 2 }, { rate: 192000, ch: 2 },
];
const heavy = new Set(['192000/2']); // keep run time sensible at very high rates

const results = [];
let worst = { ffmpeg: 0, reference: 0 };
let failures = 0;

for (const { rate, ch } of cases) {
  const key = `${rate}/${ch}`;
  const latJS = measureLatency((p) => renderJS(p, rate, ch, 128).out, rate, ch);
  const latFF = measureLatency((p) => renderFFmpeg(writePcm('lat.f32', p), rate, ch), rate, ch);
  const latRef = referenceBin ? measureLatency((p) => renderReference(writePcm('lat.f32', p), rate, ch, 128).out, rate, ch) : null;
  const reported = renderJS(new Float32Array(ch * 128), rate, ch, 128).latency;
  console.log(`\n${rate} Hz, ${ch} ch: latency JS ${latJS} (reported ${reported}), FFmpeg ${latFF}` +
    (latRef !== null ? `, reference ${latRef}` : '') + ` samples = ${(latJS / rate * 1000).toFixed(3)} ms`);
  if (latJS !== latFF || (latRef !== null && latJS !== latRef) || latJS !== reported) {
    console.log('  FAIL latency mismatch'); failures++;
  }
  // Delays are equal, so the alignment offset between implementations is
  // latFF - latJS (0 when they match).
  const offFF = (latFF - latJS) * ch;
  const offRef = latRef !== null ? (latRef - latJS) * ch : 0;

  const names = Object.keys(fixtures).filter((f) => !(heavy.has(key) && f === 'tones'));
  const signals = names.map((name) => [name, fixtures[name](rate, ch)]);
  const sp = (rate === 48000 && ch <= 2) || (rate === 44100 && ch === 2) ? speech(rate, ch) : null;
  if (sp) signals.push(['speech+music', sp]);

  for (const [name, pcm] of signals) {
    const inFile = writePcm('in.f32', pcm);
    const ff = renderFFmpeg(inFile, rate, ch);
    const ref = referenceBin ? renderReference(inFile, rate, ch, 128).out : null;
    let base = null, blockIndependent = true;
    const row = { rate, channels: ch, signal: name, seconds: +(pcm.length / ch / rate).toFixed(2), blocks: {} };
    for (const block of JS_BLOCKS) {
      if (heavy.has(key) && block === 1) continue;
      const { out } = renderJS(pcm, rate, ch, block);
      const vsFF = compare(out, ff, offFF);
      const vsRef = ref ? compare(out, ref, offRef) : null;
      if (!base) base = out;
      else if (Buffer.compare(Buffer.from(base.buffer), Buffer.from(out.buffer)) !== 0) blockIndependent = false;
      row.blocks[block] = { vsFFmpeg: vsFF, vsReference: vsRef };
      worst.ffmpeg = Math.max(worst.ffmpeg, vsFF.maxErr);
      if (vsRef) worst.reference = Math.max(worst.reference, vsRef.maxErr);
    }
    row.blockIndependent = blockIndependent;
    row.outputPeak = peak(base);
    row.withinCeiling = row.outputPeak <= Math.fround(LIMIT);
    const b128 = row.blocks[128];
    const ok = blockIndependent && row.withinCeiling && b128.vsFFmpeg.maxErr <= 2e-6 &&
      (!b128.vsReference || b128.vsReference.maxErr <= 2e-6);
    if (!ok) failures++;
    const fmt = (r) => r ? `max err ${r.maxErr.toExponential(2)} (${r.diffs}/${r.compared} differ)` : 'n/a';
    console.log(`  ${ok ? 'PASS' : 'FAIL'} ${name.padEnd(13)} vs FFmpeg ${fmt(b128.vsFFmpeg)}; vs reference ${fmt(b128.vsReference)}; ` +
      `blocks ${blockIndependent ? 'identical' : 'DIFFER'}; peak ${(20 * Math.log10(row.outputPeak || 1e-12)).toFixed(3)} dBFS`);
    results.push(row);
  }
}

// Malformed input: NaN and infinities must not escape.
{
  const pcm = build(48000, 2, 1, (n, c, t) => 0.5 * Math.sin(2 * Math.PI * 300 * t));
  pcm[1000] = NaN; pcm[2001] = Infinity; pcm[3000] = -Infinity;
  const { out } = renderJS(pcm, 48000, 2, 128);
  const finite = out.every(Number.isFinite) && peak(out) <= Math.fround(LIMIT);
  console.log(`\n${finite ? 'PASS' : 'FAIL'} NaN/Infinity input gives finite output within the ceiling`);
  if (!finite) failures++;
}

console.log(`\nWorst max error at any block size: vs FFmpeg ${worst.ffmpeg.toExponential(3)}, vs reference ${worst.reference.toExponential(3)}`);
fs.writeFileSync(path.join(here, 'dsp-comparison-results.json'), JSON.stringify({
  generated: new Date().toISOString(),
  ffmpeg: execFileSync('ffmpeg', ['-version']).toString().split('\n')[0],
  node: process.version,
  chain: CHAIN,
  worst,
  results,
}, null, 1));
fs.rmSync(tmp, { recursive: true, force: true });
console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PASS');
process.exit(failures ? 1 : 0);
