class RecorderProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.recording = false;
    this.port.onmessage = (e) => {
      if (e.data === 'start') this.recording = true;
      else if (e.data === 'stop') this.recording = false;
    };
  }

  process(inputs) {
    const input = inputs[0];
    if (this.recording && input && input[0] && input[0].length) {
      this.port.postMessage(input[0].slice(0));
    }
    return true;
  }
}

registerProcessor('recorder-processor', RecorderProcessor);
