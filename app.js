'use strict';

const TUNINGS = [
  { id: 'standard', name: 'Standard (E A D G B E)', strings: ['E2', 'A2', 'D3', 'G3', 'B3', 'E4'] },
  { id: 'dropD',    name: 'Drop D',                 strings: ['D2', 'A2', 'D3', 'G3', 'B3', 'E4'] },
  { id: 'halfDown', name: 'Half step down (E♭)',    strings: ['Eb2', 'Ab2', 'Db3', 'Gb3', 'Bb3', 'Eb4'] },
  { id: 'fullDown', name: 'Full step down (D)',     strings: ['D2', 'G2', 'C3', 'F3', 'A3', 'D4'] },
  { id: 'dropC',    name: 'Drop C',                 strings: ['C2', 'G2', 'C3', 'F3', 'A3', 'D4'] },
  { id: 'dadgad',   name: 'DADGAD',                 strings: ['D2', 'A2', 'D3', 'G3', 'A3', 'D4'] },
  { id: 'openG',    name: 'Open G',                 strings: ['D2', 'G2', 'D3', 'G3', 'B3', 'D4'] },
  { id: 'openD',    name: 'Open D',                 strings: ['D2', 'A2', 'D3', 'F#3', 'A3', 'D4'] },
  { id: 'openE',    name: 'Open E',                 strings: ['E2', 'B2', 'E3', 'G#3', 'B3', 'E4'] },
];
const CHROMATIC = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'];
const IN_TUNE = 4;   // cents
const NEAR = 15;     // cents

// ---------- helpers ----------
const $ = (id) => document.getElementById(id);
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* ignore */ } },
};
function noteToMidi(name) {
  const m = /^([A-G])([#b]?)(\d)$/.exec(name);
  const base = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 }[m[1]] + (m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0);
  return 12 * (Number(m[3]) + 1) + base;
}
function prettyNote(name) {
  const m = /^([A-G])([#b]?)(\d)$/.exec(name);
  return { letter: m[1] + (m[2] === '#' ? '♯' : m[2] === 'b' ? '♭' : ''), octave: m[3] };
}
const midiToFreq = (m) => state.a4 * Math.pow(2, (m - 69) / 12);
const centsBetween = (f, ref) => 1200 * Math.log2(f / ref);
function chromaticName(f) {
  const midi = Math.round(69 + 12 * Math.log2(f / state.a4));
  return CHROMATIC[((midi % 12) + 12) % 12] + (Math.floor(midi / 12) - 1);
}

// ---------- state ----------
const state = {
  tuning: TUNINGS.find((t) => t.id === store.get('tuning', 'standard')) || TUNINGS[0],
  a4: store.get('a4', 440),
  locked: null,
};
let ctx = null, analyser = null, stream = null, buf = null, raf = 0, running = false, wakeLock = null;
let hist = [], pending = [], lastHeard = 0, noiseFloor = 0.001, lowpass = null;

// ---------- UI setup ----------
const tuningSel = $('tuning');
TUNINGS.forEach((t) => {
  const o = document.createElement('option');
  o.value = t.id; o.textContent = t.name;
  tuningSel.appendChild(o);
});
tuningSel.value = state.tuning.id;
tuningSel.addEventListener('change', () => {
  state.tuning = TUNINGS.find((t) => t.id === tuningSel.value);
  state.locked = null;
  store.set('tuning', state.tuning.id);
  buildStrings();
});

function buildStrings() {
  const wrap = $('strings');
  wrap.innerHTML = '';
  state.tuning.strings.forEach((s, i) => {
    const b = document.createElement('button');
    b.textContent = prettyNote(s).letter;
    b.addEventListener('click', () => {
      state.locked = state.locked === i ? null : i;
      updateMode();
    });
    wrap.appendChild(b);
  });
  updateMode();
}
function updateMode() {
  [...$('strings').children].forEach((b, i) => b.classList.toggle('locked', state.locked === i));
  $('mode').textContent = state.locked === null
    ? 'Auto: play any string · tap a string to lock it'
    : `Locked to ${prettyNote(state.tuning.strings[state.locked]).letter} · tap again for auto`;
}

function updateA4() {
  $('a4val').textContent = `A4 = ${state.a4} Hz`;
  store.set('a4', state.a4);
}
$('a4down').addEventListener('click', () => { state.a4 = Math.max(415, state.a4 - 1); updateA4(); });
$('a4up').addEventListener('click', () => { state.a4 = Math.min(466, state.a4 + 1); updateA4(); });

// Meter drawing: ±50 cents maps to ±45°
const CX = 150, CY = 160;
function pt(cents, r) {
  const a = (cents * 0.9) * Math.PI / 180;
  return [CX + r * Math.sin(a), CY - r * Math.cos(a)];
}
(function drawTicks() {
  let html = '';
  for (let c = -50; c <= 50; c += 5) {
    const major = c % 25 === 0;
    const [x1, y1] = pt(c, major ? 118 : 124);
    const [x2, y2] = pt(c, 134);
    html += `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${c === 0 ? '#f2f3f5' : '#4a4e59'}" stroke-width="${major ? 3 : 1.5}" stroke-linecap="round"/>`;
  }
  [[-50, '−50'], [0, '0'], [50, '+50']].forEach(([c, t]) => {
    const [x, y] = pt(c, 150);
    html += `<text x="${x}" y="${y + 4}" fill="#8a8f9c" font-size="11" text-anchor="middle" font-family="-apple-system,system-ui,sans-serif">${t}</text>`;
  });
  $('ticks').innerHTML = html;
  const [ax, ay] = pt(-IN_TUNE, 141), [bx, by] = pt(IN_TUNE, 141);
  const zone = $('zone');
  zone.setAttribute('d', `M${ax} ${ay} A141 141 0 0 1 ${bx} ${by}`);
  zone.setAttribute('stroke', getComputedStyle(document.documentElement).getPropertyValue('--good').trim());
})();

// ---------- detection ----------
function median(a) { const s = [...a].sort((x, y) => x - y); return s[s.length >> 1]; }

// Returns true when the display should update. Rejects one-off octave glitches.
function pushFreq(f) {
  if (hist.length && Math.abs(centsBetween(f, median(hist))) > 80) {
    if (pending.length && Math.abs(centsBetween(f, pending[0])) > 80) pending = [];
    pending.push(f);
    if (pending.length < 3) return false;
    hist = pending; pending = [];
    return true;
  }
  pending = [];
  hist.push(f);
  if (hist.length > 7) hist.shift();
  return true;
}

function nearestString(f) {
  let best = 0, bestD = Infinity;
  state.tuning.strings.forEach((s, i) => {
    const d = Math.abs(centsBetween(f, midiToFreq(noteToMidi(s))));
    if (d < bestD) { bestD = d; best = i; }
  });
  return best;
}

function render(f) {
  const idx = state.locked !== null ? state.locked : nearestString(f);
  const target = state.tuning.strings[idx];
  const cents = centsBetween(f, midiToFreq(noteToMidi(target)));
  const abs = Math.abs(cents);
  const cls = abs <= IN_TUNE ? 'good' : abs <= NEAR ? 'near' : 'far';

  const p = prettyNote(target);
  $('note').innerHTML = `${p.letter}<sup>${p.octave}</sup>`;
  $('note').className = 'note ' + cls;
  const status = $('status');
  status.className = 'status ' + cls;
  status.textContent = abs <= IN_TUNE ? 'In tune ✓'
    : cents < 0 ? `Tune up ↑  ${Math.round(cents)}¢` : `Tune down ↓  +${Math.round(cents)}¢`;
  $('heard').textContent = `Hearing ${chromaticName(f)} · ${f.toFixed(1)} Hz`;

  const needle = $('needle');
  needle.style.transform = `rotate(${Math.max(-50, Math.min(50, cents)) * 0.9}deg)`;
  needle.style.color = getComputedStyle(status).color;

  [...$('strings').children].forEach((b, i) => {
    b.classList.toggle('active', i === idx);
    b.classList.toggle('intune', i === idx && abs <= IN_TUNE);
  });
  $('display').classList.remove('idle');
}

function loop() {
  if (!running) return;
  analyser.getFloatTimeDomainData(buf);
  const now = performance.now();
  // Track the room's background noise level (follows quiet moments, rises slowly otherwise).
  let sq = 0;
  for (let i = 0; i < buf.length; i++) sq += buf[i] * buf[i];
  const level = Math.sqrt(sq / buf.length);
  noiseFloor = level < noiseFloor ? level : noiseFloor * 1.0005;

  let r = detectPitch(buf, ctx.sampleRate);
  if (!r && hist.length) {
    // Already following a note: keep listening for it (within ±2 semitones, so turning the peg
    // is followed) with a far more sensitive setting, so a fading string keeps registering.
    const f0 = median(hist);
    // Only while the note is still clearly louder than the background noise.
    r = detectPitch(buf, ctx.sampleRate, f0 * 0.89, f0 * 1.12, 0.2, Math.max(0.0008, noiseFloor * 3));
  }
  if (r && r.freq >= 60 && r.freq <= 1100) {
    lastHeard = now;
    if (pushFreq(r.freq)) render(median(hist));
  } else if (now - lastHeard > 1500) {
    $('display').classList.add('idle');
    hist = []; pending = [];
  }
  raf = requestAnimationFrame(loop);
}

// ---------- start / stop ----------
// The microphone is switched fully off whenever you leave the app, and back on when you return.
// (With "Allow" set for this site in Safari, turning it back on happens silently.)
let srcNode = null;
const streamLive = () => !!stream && stream.getAudioTracks().some((t) => t.readyState === 'live');
const withTimeout = (p, ms) => Promise.race([p, new Promise((r) => setTimeout(r, ms))]);

let starting = false;
async function start() {
  if (running || starting) return;
  starting = true;
  $('err').textContent = '';
  try {
    if (!ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      ctx = new AC();
      analyser = ctx.createAnalyser();
      analyser.fftSize = 4096;
      buf = new Float32Array(analyser.fftSize);
      // Remove hiss above the guitar's range so quiet notes stand out from background noise.
      lowpass = ctx.createBiquadFilter();
      lowpass.type = 'lowpass';
      lowpass.frequency.value = 1500;
      lowpass.connect(analyser);
    }
    const resuming = ctx.resume();
    if (!streamLive()) {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      });
      if (srcNode) srcNode.disconnect();
      srcNode = ctx.createMediaStreamSource(stream);
      srcNode.connect(lowpass);
    }
    await withTimeout(resuming, 500);
    if (ctx.state !== 'running') await withTimeout(ctx.resume(), 500);
    if (ctx.state !== 'running') throw { name: 'NeedsTap' };
    running = true;
    $('overlay').classList.add('hidden');
    requestWakeLock();
    loop();
  } catch (e) {
    pause();
    $('overlay').classList.remove('hidden');
    if (e && e.name === 'NeedsTap') return;
    $('err').textContent = e && e.name === 'NotAllowedError'
      ? 'Microphone access was blocked. Allow it in Settings → Apps → Safari → Microphone, then try again.'
      : 'Could not start the microphone: ' + (e && e.message ? e.message : e);
  } finally {
    starting = false;
  }
}
function pause() {
  running = false;
  cancelAnimationFrame(raf);
  if (ctx && ctx.state === 'running') ctx.suspend().catch(() => {});
  if (stream) stream.getTracks().forEach((t) => t.stop());   // turns the mic (and iOS mic indicator) off
  stream = null;
  if (wakeLock) { wakeLock.release().catch(() => {}); wakeLock = null; }
}
async function requestWakeLock() {
  try { if ('wakeLock' in navigator) wakeLock = await navigator.wakeLock.request('screen'); } catch (e) { /* optional */ }
}

// A tap anywhere on the overlay starts the tuner (iOS sometimes requires a touch before audio can run).
$('overlay').addEventListener('click', start);
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    if (running) pause();
  } else if (!running) {
    // Coming back to the app: reuse the existing mic stream, no new permission prompt.
    start();
  }
});

buildStrings();
updateA4();
start(); // try to start straight away; falls back to "tap anywhere" if iOS needs a touch first

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
}
