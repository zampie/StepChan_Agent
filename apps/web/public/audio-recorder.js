// Capture PCM on the audio thread. Never connect the microphone audibly to the speakers.
class StepRecorder extends AudioWorkletProcessor {
  constructor() {
    super();
    this.parts = [];
    this.length = 0;
  }
  process(inputs) {
    const channel = inputs[0]?.[0];
    if (channel) {
      this.parts.push(new Float32Array(channel));
      this.length += channel.length;
      if (this.length >= 2048) {
        const samples = new Float32Array(this.length);
        let offset = 0;
        for (const part of this.parts) {
          samples.set(part, offset);
          offset += part.length;
        }
        this.port.postMessage(samples, [samples.buffer]);
        this.parts = [];
        this.length = 0;
      }
    }
    return true;
  }
}
registerProcessor('step-recorder', StepRecorder);
