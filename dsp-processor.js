/*
 * Real-time dynamics processing for the player, run as an AudioWorklet.
 *
 * This is a JavaScript port of the fixed processing path in the Android
 * Normalize Audio Unit's AndroidDSP.h (programme-dependent mode disabled),
 * which is itself an adaptation of FFmpeg n8.0.1 af_sidechaincompress.c
 * (acompressor), af_alimiter.c and hermite.h. It reproduces Plezy's chain:
 *
 *   acompressor=threshold=-34dB:ratio=4:knee=6dB:attack=30:release=300:
 *               makeup=15dB:link=maximum,
 *   alimiter=limit=-3dB:attack=1:release=60:level=false
 *
 * Copyright (C) 2001-2010 Krzysztof Foltman, Markus Schmidt,
 * Thor Harald Johansen and others; Copyright (c) 2015 Paul B Mahol.
 * SPDX-License-Identifier: LGPL-2.1-or-later
 *
 * All calculations use doubles, as FFmpeg does; only the output is rounded to
 * float32. The statement order follows the reference closely on purpose, so
 * that results match sample for sample. Please keep it that way.
 */

// Fixed Plezy settings, in the reference's parameter order. They are
// constants: nothing at run time (options, messages, analysis) changes them.
// The compressor's and limiter's gains still follow the audio as normal.
const SETTINGS = Object.freeze({
  thresholdDb: -34,
  ratio: 4,
  kneeDb: 6,
  attackMs: 30,
  releaseMs: 300,
  makeupDb: 15,
  limitDb: -3,           // sample-peak ceiling
  limiterReleaseMs: 60,
});

const MAX_CHANNELS = 8;
// alimiter attack is fixed at 1 ms in Plezy's chain; it sets the lookahead.
const LIMITER_ATTACK_S = 0.001;

const dbToLinear = (db) => Math.pow(10, db / 20);

// FFmpeg hermite.h: cubic Hermite interpolation used for the soft knee.
function hermite(x, x0, x1, p0, p1, m0, m1) {
  const width = x1 - x0, t = (x - x0) / width, t2 = t * t, t3 = t2 * t;
  m0 *= width; m1 *= width;
  const ct2 = -3 * p0 - 2 * m0 + 3 * p1 - m1, ct3 = 2 * p0 + m0 - 2 * p1 + m1;
  return ct3 * t3 + ct2 * t2 + m0 * t + p0;
}

class FixedDSP {
  constructor() {
    // Declare every field up front so the object keeps one stable shape.
    this.rate = 0; this.channels = 0; this.size = 0;
    this.buffer = new Float64Array(0);
    this.nextDelta = new Float64Array(0);
    this.nextPos = new Int32Array(0);
    this.pos = 0; this.nextIter = 0; this.nextLen = 0;
    this.att = 1; this.delta = 0; this.slope = 0;
    this.ratio = 1; this.knee = 1; this.thres = 0; this.adjStart = 0;
    this.kneeStart = 0; this.kneeStop = 0; this.compressedStop = 0;
    this.attackCoeff = 1; this.releaseCoeff = 1;
    this.makeup = 1; this.limit = 1; this.release = 0.06;
  }

  prepare(rate, channels) {
    this.rate = rate;
    this.channels = channels;
    // FFmpeg alimiter config_input: interleaved lookahead buffer, truncated.
    let size = Math.trunc(rate * LIMITER_ATTACK_S * channels);
    size -= size % channels;
    if (size < channels) size = channels; // only reachable below 1 kHz
    this.size = size;
    this.buffer = new Float64Array(size);
    this.nextDelta = new Float64Array(size);
    this.nextPos = new Int32Array(size);
    this.configure();
    this.reset();
  }

  reset() {
    this.buffer.fill(0);
    this.nextDelta.fill(0);
    this.nextPos.fill(-1);
    this.pos = 0; this.nextIter = 0; this.nextLen = 0;
    this.att = 1; this.delta = 0; this.slope = 0;
  }

  // Delay in sample frames between input and output.
  latencySamples() { return this.size / this.channels - 1; }

  configure() {
    const v = SETTINGS;
    const rate = this.rate;
    const threshold = dbToLinear(v.thresholdDb);
    this.ratio = v.ratio;
    this.knee = dbToLinear(v.kneeDb);
    this.thres = Math.log(threshold);
    const start = threshold / Math.sqrt(this.knee), stop = threshold * Math.sqrt(this.knee);
    this.adjStart = start * start;
    this.kneeStart = Math.log(start);
    this.kneeStop = Math.log(stop);
    this.compressedStop = (this.kneeStop - this.thres) / this.ratio + this.thres;
    this.attackCoeff = Math.min(1, 1 / (v.attackMs * rate / 4000));
    this.releaseCoeff = Math.min(1, 1 / (v.releaseMs * rate / 4000));
    this.makeup = dbToLinear(v.makeupDb);
    this.limit = dbToLinear(v.limitDb);
    this.release = v.limiterReleaseMs / 1000;
  }

  // One interleaved frame: acompressor (rms detection, link=maximum),
  // then alimiter (asc=false, level=false, level_in=level_out=1).
  processFrame(input, output) {
    const channels = this.channels, size = this.size, limit = this.limit;
    const buffer = this.buffer, nextPos = this.nextPos, nextDelta = this.nextDelta;
    // Per-sample state in locals (written back at the end) for speed only;
    // the arithmetic and its order are unchanged.
    let slope = this.slope, att = this.att, delta = this.delta;
    let nextIter = this.nextIter, nextLen = this.nextLen;

    // ---- Compressor ----
    let peak = 0;
    for (let c = 0; c < channels; c++) peak = Math.max(Math.abs(input[c]), peak);
    peak *= peak; // detection=rms, FFmpeg's default
    slope += (peak - slope) * (peak > slope ? this.attackCoeff : this.releaseCoeff);
    let gain = 1;
    if (slope > 0 && slope > this.adjStart) {
      const level = Math.log(slope) * 0.5;
      let compressed = (level - this.thres) / this.ratio + this.thres;
      if (this.knee > 1 && level < this.kneeStop) {
        compressed = hermite(level, this.kneeStart, this.kneeStop,
          this.kneeStart, this.compressedStop, 1, 1 / this.ratio);
      }
      gain = Math.exp(compressed - level);
    }

    // ---- Limiter ----
    const pos = this.pos;
    const g = gain * this.makeup;
    peak = 0;
    for (let c = 0; c < channels; c++) {
      const sample = input[c] * g;
      buffer[pos + c] = sample;
      peak = Math.max(peak, Math.abs(sample));
    }
    const release = this.release;
    if (peak > limit) {
      const patt = Math.min(limit / peak, 1);
      const rdelta = (1 - patt) / (this.rate * release);
      const candidate = (limit / peak - att) / size * channels;
      let found = false;
      if (candidate < delta) {
        delta = candidate;
        nextPos[0] = pos; nextPos[1] = -1;
        nextDelta[0] = rdelta; nextLen = 1; nextIter = 0;
      } else {
        let i = nextIter;
        for (; i < nextIter + nextLen; ++i) {
          const j = i % size;
          let previousPeak = 0;
          if (nextPos[j] >= 0) {
            for (let c = 0; c < channels; c++) {
              previousPeak = Math.max(previousPeak, Math.abs(buffer[nextPos[j] + c]));
            }
          }
          // Integer division, as in C.
          const span = Math.trunc(((size - nextPos[j] + pos) % size) / channels);
          const pdelta = (limit / peak - limit / previousPeak) / span;
          if (pdelta < nextDelta[j]) { nextDelta[j] = pdelta; found = true; break; }
        }
        if (found) {
          nextLen = i - nextIter + 1;
          nextPos[(nextIter + nextLen) % size] = pos;
          nextDelta[(nextIter + nextLen) % size] = rdelta;
          nextPos[(nextIter + nextLen + 1) % size] = -1;
          ++nextLen;
        }
      }
    }
    const read = (pos + channels) % size;
    peak = 0;
    for (let c = 0; c < channels; c++) peak = Math.max(peak, Math.abs(buffer[read + c]));
    att += delta;
    for (let c = 0; c < channels; c++) output[c] = buffer[read + c] * att;
    if (read === nextPos[nextIter]) {
      delta = nextDelta[nextIter];
      att = limit / peak;
      --nextLen;
      nextPos[nextIter] = -1;
      nextIter = (nextIter + 1) % size;
    }
    if (att > 1) {
      att = 1; delta = 0; nextIter = 0; nextLen = 0; nextPos[0] = -1;
    }
    if (att <= 0) { att = 1e-13; delta = (1 - att) / (this.rate * release); }
    if (att !== 1 && (1 - att) < 1e-13) att = 1;
    if (delta !== 0 && Math.abs(delta) < 1e-14) delta = 0;
    for (let c = 0; c < channels; c++) {
      const y = output[c];
      output[c] = y < -limit ? -limit : (y > limit ? limit : y);
    }
    this.pos = read;
    this.slope = slope; this.att = att; this.delta = delta;
    this.nextIter = nextIter; this.nextLen = nextLen;
  }
}

class DynamicsProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.dsp = new FixedDSP();
    this.inFrame = new Float64Array(MAX_CHANNELS);
    this.outFrame = new Float64Array(MAX_CHANNELS);
    this.channels = 0;
  }

  process(inputs, outputs) {
    const input = inputs[0] || [];
    const output = outputs[0];
    if (!output || output.length === 0) return true;

    // Follow the input's channel layout. With no input connected, keep the
    // last layout and feed silence so buffered audio still drains.
    let channels = input.length > 0 ? input.length : (this.channels || output.length);
    if (channels > MAX_CHANNELS) channels = MAX_CHANNELS;
    if (channels !== this.channels) {
      this.dsp.prepare(sampleRate, channels);
      this.channels = channels;
      this.port.postMessage({ type: 'latency', samples: this.dsp.latencySamples(), sampleRate, channels });
    }

    const dsp = this.dsp, inFrame = this.inFrame, outFrame = this.outFrame;
    const outCount = output.length;
    const frames = output[0].length;
    for (let n = 0; n < frames; n++) {
      for (let c = 0; c < channels; c++) {
        const ch = input[c];
        const x = ch ? ch[n] : 0;
        // Recover from a malformed sample (NaN or infinity); normal PCM is unaffected.
        inFrame[c] = (x - x === 0) ? x : 0;
      }
      dsp.processFrame(inFrame, outFrame);
      for (let c = 0; c < outCount; c++) output[c][n] = c < channels ? outFrame[c] : 0;
    }
    return true;
  }
}

registerProcessor('dynamics-processor', DynamicsProcessor);
