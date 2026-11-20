/*
 * Real-time dynamics processing for the player, run as an AudioWorklet.
 *
 * Signal chain: compressor -> makeup gain -> lookahead brick-wall limiter.
 *
 * The browser's built-in DynamicsCompressorNode can't be used: it applies its
 * own automatic makeup gain, has a fixed lookahead, and has no limiter. This
 * processor implements the exact settings instead.
 */

const DEFAULTS = {
  // Compressor
  thresholdDb: -34,
  ratio: 4,
  kneeDb: 6,
  attackMs: 30,
  releaseMs: 300,
  makeupDb: 15,
  // Limiter
  ceilingDb: -3,
  limiterReleaseMs: 60,
  lookaheadMs: 5,
  // Testing only: turns off the final hard clip so the limiter's own
  // envelope can be checked on its own.
  safetyClip: true,
};

const MAX_CHANNELS = 8;
const MIN_DB = -200;

class DynamicsProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const p = { ...DEFAULTS, ...(options && options.processorOptions) };
    const fs = sampleRate;

    // --- Compressor ---
    this.threshold = p.thresholdDb;
    this.ratio = p.ratio;
    this.knee = p.kneeDb;
    this.attackCoef = Math.exp(-1 / ((p.attackMs / 1000) * fs));
    this.releaseCoef = Math.exp(-1 / ((p.releaseMs / 1000) * fs));
    this.makeupDb = p.makeupDb;
    // Level detector state (linear). A peak detector with release, followed
    // by attack smoothing ("smooth decoupled" design), so steady tones are
    // measured at their true peak level.
    this.peakEnv = 0;
    this.levelEnv = 0;

    // --- Limiter ---
    // Gain needed for each sample is held as a minimum over the lookahead
    // window, released exponentially, then averaged over the same window.
    // With the audio delayed by (L - 1) samples, every gain value applied is
    // guaranteed to be no larger than what the delayed sample needs, so the
    // output never goes over the ceiling, and gain changes ramp smoothly
    // instead of stepping.
    this.ceiling = Math.pow(10, p.ceilingDb / 20);
    this.limReleaseCoef = Math.exp(-1 / ((p.limiterReleaseMs / 1000) * fs));
    this.safetyClip = p.safetyClip;
    const L = Math.max(1, Math.round((p.lookaheadMs / 1000) * fs));
    this.L = L;

    this.delay = [];
    for (let c = 0; c < MAX_CHANNELS; c++) this.delay.push(new Float32Array(L));
    this.delayPos = 0;

    // Monotonic deque for the sliding-window minimum.
    this.dqVal = new Float64Array(L + 1);
    this.dqIdx = new Float64Array(L + 1);
    this.dqHead = 0;
    this.dqLen = 0;
    this.n = 0;

    this.released = 1; // limiter gain after release smoothing
    this.box = new Float64Array(L).fill(1);
    this.boxPos = 0;
    this.boxSum = L;
  }

  // Static compression curve with soft knee: input level (dB) -> output level (dB).
  curve(x) {
    const T = this.threshold;
    const W = this.knee;
    const R = this.ratio;
    const over = x - T;
    if (2 * over < -W) return x;
    if (W > 0 && 2 * Math.abs(over) <= W) {
      const k = over + W / 2;
      return x + ((1 / R - 1) * k * k) / (2 * W);
    }
    return T + over / R;
  }

  slidingMin(v) {
    const cap = this.L + 1;
    const n = this.n;
    // Drop entries from the back that are no smaller than the new value.
    while (this.dqLen > 0) {
      const back = (this.dqHead + this.dqLen - 1) % cap;
      if (this.dqVal[back] >= v) this.dqLen--;
      else break;
    }
    const slot = (this.dqHead + this.dqLen) % cap;
    this.dqVal[slot] = v;
    this.dqIdx[slot] = n;
    this.dqLen++;
    // Drop entries that have left the window.
    while (this.dqIdx[this.dqHead] <= n - this.L) {
      this.dqHead = (this.dqHead + 1) % cap;
      this.dqLen--;
    }
    return this.dqVal[this.dqHead];
  }

  process(inputs, outputs) {
    const input = inputs[0] || [];
    const output = outputs[0];
    const nCh = Math.min(output.length, MAX_CHANNELS);
    if (nCh === 0) return true;
    const frames = output[0].length;
    const L = this.L;
    const ceiling = this.ceiling;
    const makeupDb = this.makeupDb;
    const samples = new Float64Array(nCh);

    // Recompute the running sum once per block so rounding error can't build up.
    let sum = 0;
    for (let k = 0; k < L; k++) sum += this.box[k];
    this.boxSum = sum;

    for (let i = 0; i < frames; i++) {
      // ---- Compressor (stereo-linked peak detection) ----
      let peak = 0;
      for (let c = 0; c < nCh; c++) {
        const ch = input[c];
        const s = ch ? ch[i] : 0;
        samples[c] = s;
        const a = s < 0 ? -s : s;
        if (a > peak) peak = a;
      }
      const rel = this.releaseCoef;
      const decayed = rel * this.peakEnv + (1 - rel) * peak;
      this.peakEnv = peak > decayed ? peak : decayed;
      this.levelEnv = this.attackCoef * this.levelEnv + (1 - this.attackCoef) * this.peakEnv;
      const level = this.levelEnv;
      const xDb = level > 1e-10 ? 20 * Math.log10(level) : MIN_DB;
      const gainDb = this.curve(xDb) - xDb;
      const compGain = Math.pow(10, (gainDb + makeupDb) / 20);

      // ---- Limiter ----
      let limPeak = 0;
      for (let c = 0; c < nCh; c++) {
        const s = samples[c] * compGain;
        samples[c] = s;
        const a = s < 0 ? -s : s;
        if (a > limPeak) limPeak = a;
      }
      const need = limPeak > ceiling ? ceiling / limPeak : 1;
      const held = this.slidingMin(need);
      if (held < this.released) this.released = held;
      else this.released = this.limReleaseCoef * this.released + (1 - this.limReleaseCoef) * held;

      this.boxSum += this.released - this.box[this.boxPos];
      this.box[this.boxPos] = this.released;
      this.boxPos = (this.boxPos + 1) % L;
      const limGain = this.boxSum / L;

      // Delay line of L - 1 samples.
      const wp = this.delayPos;
      const rp = (wp + 1) % L;
      for (let c = 0; c < nCh; c++) {
        const buf = this.delay[c];
        buf[wp] = samples[c];
        let y = buf[rp] * limGain;
        if (this.safetyClip) {
          if (y > ceiling) y = ceiling;
          else if (y < -ceiling) y = -ceiling;
        }
        output[c][i] = y;
      }
      this.delayPos = rp;
      this.n++;
    }
    return true;
  }
}

registerProcessor('dynamics-processor', DynamicsProcessor);
