// A minimal fake AudioContext for the audio unit tests. Records connections
// and parameter automation; plays nothing. Not a test file itself.

export function fakeParam(value = 1) {
  return {
    value,
    calls: [],
    setTargetAtTime(target, time, constant) { this.calls.push(['target', target, time, constant]); this.value = target; },
    setValueAtTime(target, time) { this.calls.push(['set', target, time]); this.value = target; },
    setValueCurveAtTime(curve, time, duration) {
      this.calls.push(['curve', Array.from(curve), time, duration]);
      this.value = curve[curve.length - 1];
    },
    cancelScheduledValues(time) { this.calls.push(['cancel', time]); },
  };
}

function fakeNode(kind, context) {
  return {
    kind,
    context,
    outputs: new Set(),
    connect(target) { this.outputs.add(target); return target; },
    disconnect(target) {
      if (target === undefined) { this.outputs.clear(); return; }
      if (!this.outputs.has(target)) throw new Error('InvalidAccessError: not connected');
      this.outputs.delete(target);
    },
  };
}

export function fakeBuffer(channels, length, sampleRate) {
  const data = Array.from({ length: channels }, () => new Float32Array(length));
  return {
    sampleRate,
    length,
    numberOfChannels: channels,
    duration: length / sampleRate,
    getChannelData: index => data[index],
    copyToChannel(source, index) { data[index].set(source.subarray(0, length)); },
  };
}

export function fakeContext({ sampleRate = 48000, state = 'running', decode = null } = {}) {
  const context = {
    sampleRate,
    currentTime: 0,
    state,
    sources: [],
    gains: [],
    decodeCalls: 0,
    destination: fakeNode('destination'),
    createGain() {
      const node = fakeNode('gain', context);
      node.gain = fakeParam(1);
      context.gains.push(node);
      return node;
    },
    createBiquadFilter() {
      const node = fakeNode('biquad', context);
      node.type = 'lowpass';
      node.frequency = fakeParam(350);
      node.Q = fakeParam(1);
      node.gain = fakeParam(0);
      return node;
    },
    createAnalyser() { return fakeNode('analyser', context); },
    createChannelSplitter() { return fakeNode('splitter', context); },
    createBufferSource() {
      const node = fakeNode('source', context);
      node.buffer = null;
      node.started = null;
      node.stopped = false;
      node.start = (when = 0, offset = 0, duration) => { node.started = { when, offset, duration }; };
      node.stop = () => { node.stopped = true; };
      context.sources.push(node);
      return node;
    },
    createBuffer: (channels, length, rate) => fakeBuffer(channels, length, rate),
    async decodeAudioData(arrayBuffer) {
      context.decodeCalls += 1;
      if (!decode) throw new Error('EncodingError');
      return decode(arrayBuffer, context);
    },
    async resume() { context.state = 'running'; },
    async suspend() { context.state = 'suspended'; },
    async close() { context.state = 'closed'; },
  };
  return context;
}

/** True when `to` is reachable from `from` through connections. */
export function reaches(from, to, seen = new Set()) {
  if (from === to) return true;
  if (!from || seen.has(from)) return false;
  seen.add(from);
  for (const next of from.outputs ?? []) if (reaches(next, to, seen)) return true;
  return false;
}
