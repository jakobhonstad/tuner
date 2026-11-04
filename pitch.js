// YIN pitch detection (de Cheveigné & Kawahara, 2002).
// Returns { freq, clarity, rms } or null when no clear pitch is found.
(function (root) {
  'use strict';

  // minRms: how loud the sound must be. Lower = more sensitive (used to follow a fading string).
  function detectPitch(buf, sampleRate, minFreq, maxFreq, threshold, minRms) {
    minFreq = minFreq || 60;
    maxFreq = maxFreq || 1100;
    threshold = threshold || 0.12;

    const n = buf.length;

    // Silence gate
    let rms = 0;
    for (let i = 0; i < n; i++) rms += buf[i] * buf[i];
    rms = Math.sqrt(rms / n);
    if (rms < (minRms || 0.006)) return null;

    const maxTau = Math.min(Math.floor(sampleRate / minFreq), Math.floor(n / 2));
    const minTau = Math.max(2, Math.floor(sampleRate / maxFreq));
    const W = n - maxTau;

    // Difference function + cumulative mean normalised difference
    const c = new Float32Array(maxTau + 1);
    c[0] = 1;
    let running = 0;
    for (let tau = 1; tau <= maxTau; tau++) {
      let s = 0;
      for (let i = 0; i < W; i++) {
        const x = buf[i] - buf[i + tau];
        s += x * x;
      }
      running += s;
      c[tau] = running > 0 ? (s * tau) / running : 1;
    }

    // First dip below threshold, then walk to its local minimum
    let tau = -1;
    for (let t = minTau; t <= maxTau; t++) {
      if (c[t] < threshold) {
        while (t + 1 <= maxTau && c[t + 1] < c[t]) t++;
        tau = t;
        break;
      }
    }
    if (tau < 0) return null;

    // Parabolic interpolation for sub-sample accuracy
    let better = tau;
    if (tau > 1 && tau < maxTau) {
      const a = c[tau - 1], b = c[tau], g = c[tau + 1];
      const den = a - 2 * b + g;
      if (den !== 0) better = tau + (a - g) / (2 * den);
    }

    return { freq: sampleRate / better, clarity: 1 - c[tau], rms: rms };
  }

  if (typeof module !== 'undefined' && module.exports) module.exports = { detectPitch };
  else root.detectPitch = detectPitch;
})(this);
