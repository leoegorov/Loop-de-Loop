export function encodeWavMono16(float32, sampleRate) {
  // float32: Float32Array in [-1, 1]
  const numChannels = 1;
  const bitsPerSample = 16;
  const blockAlign = (numChannels * bitsPerSample) / 8;
  const byteRate = sampleRate * blockAlign;
  const dataSize = float32.length * 2;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  let off = 0;
  writeStr(view, off, 'RIFF');
  off += 4;
  view.setUint32(off, 36 + dataSize, true);
  off += 4;
  writeStr(view, off, 'WAVE');
  off += 4;

  writeStr(view, off, 'fmt ');
  off += 4;
  view.setUint32(off, 16, true);
  off += 4;
  view.setUint16(off, 1, true);
  off += 2;
  view.setUint16(off, numChannels, true);
  off += 2;
  view.setUint32(off, sampleRate, true);
  off += 4;
  view.setUint32(off, byteRate, true);
  off += 4;
  view.setUint16(off, blockAlign, true);
  off += 2;
  view.setUint16(off, bitsPerSample, true);
  off += 2;

  writeStr(view, off, 'data');
  off += 4;
  view.setUint32(off, dataSize, true);
  off += 4;

  for (let i = 0; i < float32.length; i++) {
    let s = float32[i];
    if (s > 1) s = 1;
    if (s < -1) s = -1;
    view.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    off += 2;
  }

  return buffer;
}

function writeStr(view, offset, str) {
  for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
}

export function arrayBufferToBase64(buf) {
  const bytes = new Uint8Array(buf);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

export function base64ToArrayBuffer(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}
