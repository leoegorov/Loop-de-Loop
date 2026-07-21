class TapProcessor extends AudioWorkletProcessor {
  process(inputs) {
    const input = inputs[0];
    if (!input || input.length === 0) return true;

    const ch0 = input[0];
    if (!ch0) return true;

    // Copy out of the rendering thread buffer.
    const copy = new Float32Array(ch0.length);
    copy.set(ch0);

    // Transfer to main thread to reduce overhead.
    this.port.postMessage(copy.buffer, [copy.buffer]);
    return true;
  }
}

registerProcessor('tap-processor', TapProcessor);
