/**
 * FASTER SPEECH, SAME VOICE (owner, 2026-11-04: "that hello sir should be
 * played fast"). gpt-4o-mini-tts ignores `speed`, and simply playing the
 * clip faster raises the pitch. WSOLA (waveform-similarity overlap-add)
 * shortens the audio while keeping its pitch: short Hann-windowed frames
 * are re-laid closer together, each nudged to the position that best
 * continues the previous one, so the joins stay smooth.
 *
 *   speedUp(pcm16le Buffer, 1.25) → a Buffer about 1/1.25 as long
 *   trimSilence(pcm16le Buffer, { keepMs }) → leading/trailing quiet cut
 */
const FRAME = 960; // 40 ms at 24 kHz
const HOP = FRAME / 2;
const SEARCH = 240; // ±10 ms to find the best continuation

function toSamples(buf) {
  const n = Math.floor(buf.length / 2);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = buf.readInt16LE(i * 2);
  return out;
}

function toBuffer(samples) {
  const b = Buffer.alloc(samples.length * 2);
  for (let i = 0; i < samples.length; i++) {
    const v = Math.max(-32768, Math.min(32767, Math.round(samples[i])));
    b.writeInt16LE(v, i * 2);
  }
  return b;
}

function speedUp(pcm, rate = 1.25) {
  const x = toSamples(pcm);
  if (rate <= 1.001 || x.length < FRAME * 4) return pcm;
  const win = new Float32Array(FRAME);
  for (let i = 0; i < FRAME; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / FRAME);
  const ha = HOP * rate; // analysis hop: how far the input moves per frame
  const frames = Math.floor((x.length - FRAME - SEARCH) / ha);
  const y = new Float32Array(frames * HOP + FRAME);
  const norm = new Float32Array(y.length);
  let prev = 0; // where the last frame was taken from in the input
  for (let k = 0; k < frames; k++) {
    const ideal = Math.round(k * ha);
    let best = ideal;
    if (k > 0) {
      // The natural continuation of the previous frame, HOP samples on.
      const nat = prev + HOP;
      let bestScore = -Infinity;
      const lo = Math.max(0, ideal - SEARCH);
      const hi = Math.min(x.length - FRAME, ideal + SEARCH);
      for (let c = lo; c <= hi; c += 2) {
        let s = 0;
        for (let i = 0; i < HOP; i += 2) s += x[c + i] * x[nat + i];
        if (s > bestScore) { bestScore = s; best = c; }
      }
    }
    const at = k * HOP;
    for (let i = 0; i < FRAME; i++) {
      y[at + i] += x[best + i] * win[i];
      norm[at + i] += win[i];
    }
    prev = best;
  }
  for (let i = 0; i < y.length; i++) if (norm[i] > 1e-3) y[i] /= norm[i];
  return toBuffer(y);
}

/** Cut quiet at both ends, keeping [keepMs] so the clip never clicks. */
function trimSilence(pcm, { threshold = 500, keepMs = 60, rate = 24000 } = {}) {
  const n = Math.floor(pcm.length / 2);
  let a = 0, b = n - 1;
  while (a < n && Math.abs(pcm.readInt16LE(a * 2)) < threshold) a++;
  while (b > a && Math.abs(pcm.readInt16LE(b * 2)) < threshold) b--;
  if (a >= b) return pcm;
  const keep = Math.round((keepMs / 1000) * rate);
  const s = Math.max(0, a - keep), e = Math.min(n, b + keep);
  // A short fade at each end.
  const out = Buffer.from(pcm.subarray(s * 2, e * 2));
  const fade = Math.min(240, Math.floor((e - s) / 4));
  for (let i = 0; i < fade; i++) {
    const g = i / fade;
    out.writeInt16LE(Math.round(out.readInt16LE(i * 2) * g), i * 2);
    const j = (e - s - 1 - i) * 2;
    out.writeInt16LE(Math.round(out.readInt16LE(j) * g), j);
  }
  return out;
}

module.exports = { speedUp, trimSilence };
