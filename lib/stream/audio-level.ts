/**
 * Microphone level metering for the pre-join lobby.
 *
 * The lobby's meter detected speech — the caption flipped to "We can hear you"
 * — but its bar never visibly moved. The cause was neither a missing stream
 * nor a stalled loop: it was the measurement.
 *
 * It averaged `getByteFrequencyData` across all 128 bins of a 24 kHz spectrum
 * and divided by 128. Speech energy lives in roughly the first half-dozen
 * bins, so ~122 near-zero bins dragged the mean down: ordinary speech landed
 * around 0.06–0.20, which is a 6–20% bar with a 2% floor under it. It moved,
 * but only within a sliver at the far left, which reads as a static segment.
 *
 * The right measure of loudness is RMS over the TIME-domain waveform, mapped
 * through decibels — human loudness is logarithmic, so a linear amplitude bar
 * spends most of its travel on sounds nobody makes.
 *
 * None of this opens a capture. The stream belongs to Stream's
 * `MicrophoneManager` (`useMicrophoneState().mediaStream`) and is never
 * stopped here; a second `getUserMedia` is what leaked a live microphone for
 * the life of the tab, and `__tests__/stream/mic-level-meter.test.ts` pins
 * that it does not come back.
 */

/**
 * Quietest level the bar acknowledges. Room tone sits near -50 dBFS, so
 * anything below this is silence as far as a user is concerned.
 */
const FLOOR_DB = -50;
/** Level that fills the bar. Normal speech peaks around -14 dBFS. */
const CEILING_DB = -10;

/** Below this the meter is reporting a room, not a voice. */
export const SPEAKING_THRESHOLD = 0.12;

/**
 * Rises almost immediately, falls gently. A meter that tracks both directions
 * at the same rate flickers once per frame and reads as broken in its own way.
 */
const ATTACK = 0.5;
const RELEASE = 0.12;

/**
 * Root-mean-square amplitude of one time-domain frame, in 0..1.
 *
 * `getByteTimeDomainData` centres silence on 128, so each sample is read as
 * its deviation from that midpoint rather than its absolute value.
 */
export function rmsFromTimeDomain(samples: Uint8Array): number {
  if (samples.length === 0) return 0;
  let sumOfSquares = 0;
  for (const sample of samples) {
    const deviation = (sample - 128) / 128;
    sumOfSquares += deviation * deviation;
  }
  return Math.sqrt(sumOfSquares / samples.length);
}

/**
 * RMS to the fraction of the bar to fill, through a dB mapping so that the
 * range a person actually speaks in occupies most of the meter's travel.
 */
export function micLevelFromRms(rms: number): number {
  // Written this way on purpose: `rms <= 0` is false for NaN, which would put
  // NaN through log10 and set the bar width to "NaN%". This form rejects NaN
  // along with zero and negatives.
  if (!(rms > 0)) return 0;
  const db = 20 * Math.log10(rms);
  const level = (db - FLOOR_DB) / (CEILING_DB - FLOOR_DB);
  return Math.min(Math.max(level, 0), 1);
}

/** One step of the asymmetric smoothing described above. */
export function smoothMicLevel(previous: number, next: number): number {
  const coefficient = next > previous ? ATTACK : RELEASE;
  return previous + (next - previous) * coefficient;
}

export interface MicLevelMeterOptions {
  /** Injected in tests; defaults to the browser's. */
  audioContextFactory?: () => AudioContext;
  requestFrame?: (cb: FrameRequestCallback) => number;
  cancelFrame?: (handle: number) => void;
}

/**
 * Samples `stream` continuously and reports a smoothed 0..1 level.
 *
 * @returns a stop function. It closes the AudioContext and cancels the loop,
 *   and deliberately does NOT stop the stream's tracks — they belong to the
 *   call, and stopping them would mute the user the moment they join.
 */
export function createMicLevelMeter(
  stream: MediaStream,
  onLevel: (level: number) => void,
  options: MicLevelMeterOptions = {},
): () => void {
  // Referenced lazily rather than as destructuring defaults: reading
  // `requestAnimationFrame` eagerly throws wherever there is no browser, which
  // would take the whole lobby down instead of leaving the meter flat.
  const { audioContextFactory = () => new AudioContext() } = options;
  const requestFrame =
    options.requestFrame ??
    ((cb: FrameRequestCallback) => requestAnimationFrame(cb));
  const cancelFrame =
    options.cancelFrame ?? ((handle: number) => cancelAnimationFrame(handle));

  // The WHOLE graph is guarded, not just the context: `createMediaStreamSource`
  // throws when the stream carries no audio track, which is exactly what the
  // SDK hands over mid device-switch. Escaping into the lobby's effect would
  // take the join screen down — and leak the context, which browsers cap per
  // tab.
  let audioContext: AudioContext;
  let analyser: AnalyserNode;
  try {
    audioContext = audioContextFactory();
  } catch (error) {
    console.error("Error metering microphone:", error);
    return () => {};
  }
  try {
    analyser = audioContext.createAnalyser();
    // Small enough to stay responsive, large enough for a stable RMS.
    analyser.fftSize = 1024;
    audioContext.createMediaStreamSource(stream).connect(analyser);
  } catch (error) {
    console.error("Error metering microphone:", error);
    void audioContext.close().catch(() => {});
    return () => {};
  }

  const samples = new Uint8Array(analyser.fftSize) as Uint8Array<ArrayBuffer>;
  let level = 0;
  let frame: number | undefined;
  let stopped = false;

  // A context created before the page has seen a gesture starts suspended, and
  // a suspended analyser reports silence — which reads as a dead microphone.
  void audioContext.resume().catch(() => {});

  const tick = () => {
    if (stopped) return;
    analyser.getByteTimeDomainData(samples);
    level = smoothMicLevel(level, micLevelFromRms(rmsFromTimeDomain(samples)));
    onLevel(level);
    frame = requestFrame(tick);
  };
  tick();

  return () => {
    stopped = true;
    if (frame !== undefined) cancelFrame(frame);
    void audioContext.close().catch(() => {});
  };
}
