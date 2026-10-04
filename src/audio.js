// Sylph — microphone capture + WAV encoding.
//
// Whistle wants 16 kHz mono 16-bit PCM. Browsers usually capture at 44.1/48 kHz,
// so we record raw Float32 via a ScriptProcessor (works everywhere, incl. the
// macOS WKWebView Tauri uses) and downsample to 16 kHz ourselves on stop.

export const TARGET_RATE = 16000;

export function createRecorder({ onLevel } = {}) {
  let audioCtx = null;
  let stream = null;
  let source = null;
  let processor = null;
  let chunks = [];
  let srcRate = 48000;
  let recording = false;

  async function start() {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    srcRate = audioCtx.sampleRate;
    source = audioCtx.createMediaStreamSource(stream);
    processor = audioCtx.createScriptProcessor(4096, 1, 1);
    chunks = [];
    recording = true;

    processor.onaudioprocess = (e) => {
      if (!recording) return;
      const input = e.inputBuffer.getChannelData(0);
      chunks.push(new Float32Array(input));
      if (onLevel) {
        let sum = 0;
        for (let i = 0; i < input.length; i += 64) sum += input[i] * input[i];
        onLevel(Math.min(1, Math.sqrt(sum / (input.length / 64)) * 4));
      }
    };
    source.connect(processor);
    processor.connect(audioCtx.destination);
  }

  async function stop() {
    recording = false;
    try { processor && processor.disconnect(); } catch {}
    try { source && source.disconnect(); } catch {}
    try { stream && stream.getTracks().forEach((t) => t.stop()); } catch {}
    try { audioCtx && (await audioCtx.close()); } catch {}

    const merged = mergeChunks(chunks);
    const down = downsample(merged, srcRate, TARGET_RATE);
    const wav = encodeWav(down, TARGET_RATE);
    const durationSec = down.length / TARGET_RATE;
    return { wavBase64: bytesToBase64(new Uint8Array(wav)), durationSec };
  }

  return { start, stop };
}

function mergeChunks(chunks) {
  let len = 0;
  for (const c of chunks) len += c.length;
  const out = new Float32Array(len);
  let off = 0;
  for (const c of chunks) { out.set(c, off); off += c.length; }
  return out;
}

function downsample(buffer, from, to) {
  if (to >= from) return buffer;
  const ratio = from / to;
  const newLen = Math.round(buffer.length / ratio);
  const out = new Float32Array(newLen);
  let pos = 0;
  for (let i = 0; i < newLen; i++) {
    const next = Math.round((i + 1) * ratio);
    let sum = 0, count = 0;
    for (let j = Math.round(i * ratio); j < next && j < buffer.length; j++) { sum += buffer[j]; count++; }
    out[i] = count ? sum / count : 0;
    pos = next;
  }
  return out;
}

function encodeWav(samples, rate) {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  const writeStr = (off, s) => { for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i)); };

  writeStr(0, "RIFF");
  view.setUint32(4, 36 + samples.length * 2, true);
  writeStr(8, "WAVE");
  writeStr(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);          // PCM
  view.setUint16(22, 1, true);          // mono
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * 2, true);   // byte rate
  view.setUint16(32, 2, true);          // block align
  view.setUint16(34, 16, true);         // bits per sample
  writeStr(36, "data");
  view.setUint32(40, samples.length * 2, true);

  let off = 44;
  for (let i = 0; i < samples.length; i++, off += 2) {
    let s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return buffer;
}

function bytesToBase64(bytes) {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}
