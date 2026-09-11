/**
 * @jest-environment node
 */

/**
 * #1067 — the pre-join meter has now failed in two opposite directions, and
 * this suite exists to stop it oscillating between them.
 *
 * First it opened its own `getUserMedia({ audio: true })` and only closed the
 * AudioContext on teardown, which does not stop a MediaStreamTrack: a second,
 * un-owned capture stayed live for the life of the tab, one per mic toggle.
 *
 * Then, reading Stream's own stream, it detected speech — the caption flipped
 * to "We can hear you" — but the bar never visibly moved. It averaged
 * `getByteFrequencyData` across all 128 bins of a 24 kHz spectrum and divided
 * by 128; speech occupies the first handful of bins, so ~122 near-zero bins
 * dragged the mean to roughly 0.06–0.20. That is a 6–20% bar, which reads as
 * a static sliver.
 *
 * So the assertions are: the level is sampled CONTINUOUSLY, it is normalised
 * so ordinary speech uses most of the bar, and no capture is opened or
 * stopped by the meter.
 */

import { readFileSync } from "fs";
import { join } from "path";
import {
  createMicLevelMeter,
  micLevelFromRms,
  rmsFromTimeDomain,
  smoothMicLevel,
  SPEAKING_THRESHOLD,
} from "@/lib/stream/audio-level";

/**
 * One frame of `getByteTimeDomainData`: a sine at `amplitude` (0..1) around
 * the 128 midpoint, which is what silence reads as.
 */
function frameAtAmplitude(amplitude: number, length = 1024): Uint8Array {
  const samples = new Uint8Array(length);
  for (let i = 0; i < length; i += 1) {
    samples[i] = Math.round(
      128 + Math.sin((i / length) * Math.PI * 2 * 8) * amplitude * 127,
    );
  }
  return samples;
}

describe("measuring loudness", () => {
  it("reads silence as zero", () => {
    // getByteTimeDomainData centres silence on 128, not on 0 — reading the
    // raw byte instead of its deviation would call silence full scale.
    expect(rmsFromTimeDomain(new Uint8Array(1024).fill(128))).toBeCloseTo(0, 5);
    expect(micLevelFromRms(0)).toBe(0);
  });

  it("gives ordinary speech most of the bar", () => {
    // THE regression pin. A sine at 0.05 amplitude is ordinary speech; the old
    // frequency-bin average put it near 0.06, a 6% bar. Anything under ~0.3
    // here is a sliver the user cannot see move.
    const level = micLevelFromRms(rmsFromTimeDomain(frameAtAmplitude(0.05)));
    expect(level).toBeGreaterThan(0.3);
    expect(level).toBeLessThan(1);
  });

  it("still separates a quiet room from a voice", () => {
    const room = micLevelFromRms(rmsFromTimeDomain(frameAtAmplitude(0.002)));
    const voice = micLevelFromRms(rmsFromTimeDomain(frameAtAmplitude(0.05)));

    expect(room).toBeLessThan(SPEAKING_THRESHOLD);
    expect(voice).toBeGreaterThan(SPEAKING_THRESHOLD);
  });

  it("rises monotonically with loudness and never leaves 0..1", () => {
    const levels = [0, 0.005, 0.02, 0.05, 0.2, 0.9, 1].map((amplitude) =>
      micLevelFromRms(rmsFromTimeDomain(frameAtAmplitude(amplitude))),
    );

    for (let i = 1; i < levels.length; i += 1) {
      expect(levels[i]).toBeGreaterThanOrEqual(levels[i - 1]);
    }
    expect(Math.min(...levels)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...levels)).toBeLessThanOrEqual(1);
  });

  it("rises fast and falls gently", () => {
    // Symmetric smoothing flickers once per frame, which reads as broken in
    // its own way.
    const rise = smoothMicLevel(0, 1);
    const fall = 1 - smoothMicLevel(1, 0);

    expect(rise).toBeGreaterThan(fall);
    expect(rise).toBeGreaterThan(0);
    expect(fall).toBeGreaterThan(0);
  });
});

/** An AnalyserNode that always reports the amplitude the test asks for. */
function fakeAudioGraph(amplitude: () => number) {
  const connect = jest.fn();
  const source = { connect };
  const analyser = {
    fftSize: 0,
    frequencyBinCount: 0,
    getByteTimeDomainData: jest.fn((target: Uint8Array) => {
      target.set(frameAtAmplitude(amplitude(), target.length));
    }),
    getByteFrequencyData: jest.fn(),
  };
  const audioContext = {
    createAnalyser: jest.fn(() => analyser),
    createMediaStreamSource: jest.fn(() => source),
    resume: jest.fn(() => Promise.resolve()),
    close: jest.fn(() => Promise.resolve()),
  };
  return { audioContext, analyser, source, connect };
}

/** A hand-driven frame loop, so "continuous" is observable in a test. */
function manualFrames() {
  let pending: FrameRequestCallback | null = null;
  let handle = 0;
  return {
    requestFrame: jest.fn((cb: FrameRequestCallback) => {
      pending = cb;
      return ++handle;
    }),
    cancelFrame: jest.fn(() => {
      pending = null;
    }),
    /** Runs `count` more frames. */
    advance(count: number) {
      for (let i = 0; i < count; i += 1) {
        const next = pending;
        pending = null;
        next?.(performance.now());
      }
    },
    get isRunning() {
      return pending !== null;
    },
  };
}

describe("the meter observes the call's stream and nothing else", () => {
  const stopTrack = jest.fn();
  const stream = {
    getTracks: () => [{ stop: stopTrack, kind: "audio" }],
    getAudioTracks: () => [{ stop: stopTrack, kind: "audio" }],
  } as unknown as MediaStream;

  beforeEach(() => {
    stopTrack.mockClear();
  });

  it("never opens a capture of its own", () => {
    // The original leak. `navigator.mediaDevices` is absent in this
    // environment, so any getUserMedia call would throw rather than pass.
    const graph = fakeAudioGraph(() => 0.05);
    const frames = manualFrames();

    const stop = createMicLevelMeter(stream, () => {}, {
      audioContextFactory: () => graph.audioContext as unknown as AudioContext,
      requestFrame: frames.requestFrame,
      cancelFrame: frames.cancelFrame,
    });

    // It reads the stream it was handed, and only that one.
    expect(graph.audioContext.createMediaStreamSource).toHaveBeenCalledTimes(1);
    expect(graph.audioContext.createMediaStreamSource).toHaveBeenCalledWith(
      stream,
    );
    stop();
  });

  it("samples continuously rather than once", () => {
    // The bar freezing after a single read is the other way this breaks.
    const graph = fakeAudioGraph(() => 0.05);
    const frames = manualFrames();
    const levels: number[] = [];

    const stop = createMicLevelMeter(stream, (l) => levels.push(l), {
      audioContextFactory: () => graph.audioContext as unknown as AudioContext,
      requestFrame: frames.requestFrame,
      cancelFrame: frames.cancelFrame,
    });

    expect(levels).toHaveLength(1);
    frames.advance(30);

    expect(levels).toHaveLength(31);
    expect(graph.analyser.getByteTimeDomainData).toHaveBeenCalledTimes(31);
    // Still asking for the next frame — the loop has not quietly stopped.
    expect(frames.isRunning).toBe(true);
    stop();
  });

  it("tracks a level that changes while speaking", () => {
    let amplitude = 0.001;
    const graph = fakeAudioGraph(() => amplitude);
    const frames = manualFrames();
    const levels: number[] = [];

    const stop = createMicLevelMeter(stream, (l) => levels.push(l), {
      audioContextFactory: () => graph.audioContext as unknown as AudioContext,
      requestFrame: frames.requestFrame,
      cancelFrame: frames.cancelFrame,
    });

    frames.advance(10);
    const quiet = levels[levels.length - 1];

    amplitude = 0.2;
    frames.advance(10);
    const loud = levels[levels.length - 1];

    amplitude = 0.001;
    frames.advance(60);
    const quietAgain = levels[levels.length - 1];

    expect(quiet).toBeLessThan(SPEAKING_THRESHOLD);
    expect(loud).toBeGreaterThan(0.5);
    // A meter that only ever climbs is as wrong as one that never moves.
    expect(quietAgain).toBeLessThan(loud);
    stop();
  });

  it("stops the loop and the context, but never the microphone", () => {
    // The stream belongs to Stream's MicrophoneManager. Stopping its tracks
    // here would mute the user the instant they joined.
    const graph = fakeAudioGraph(() => 0.05);
    const frames = manualFrames();

    const stop = createMicLevelMeter(stream, () => {}, {
      audioContextFactory: () => graph.audioContext as unknown as AudioContext,
      requestFrame: frames.requestFrame,
      cancelFrame: frames.cancelFrame,
    });
    frames.advance(3);
    stop();

    expect(graph.audioContext.close).toHaveBeenCalledTimes(1);
    expect(frames.cancelFrame).toHaveBeenCalledTimes(1);
    expect(stopTrack).not.toHaveBeenCalled();
  });

  it("does not keep sampling after it is stopped", () => {
    const graph = fakeAudioGraph(() => 0.05);
    const frames = manualFrames();
    const levels: number[] = [];

    const stop = createMicLevelMeter(stream, (l) => levels.push(l), {
      audioContextFactory: () => graph.audioContext as unknown as AudioContext,
      requestFrame: frames.requestFrame,
      cancelFrame: frames.cancelFrame,
    });
    frames.advance(2);
    const settled = levels.length;
    stop();
    frames.advance(5);

    expect(levels).toHaveLength(settled);
  });

  it("degrades to a dead meter rather than a broken lobby", () => {
    // No AudioContext (older Safari, or an autoplay policy that refuses one)
    // must not take the join screen down with it. The console.error is the
    // point of the path, so it is silenced rather than left to look like noise.
    const logged = jest.spyOn(console, "error").mockImplementation(() => {});
    const stop = createMicLevelMeter(stream, () => {}, {
      audioContextFactory: () => {
        throw new Error("AudioContext unavailable");
      },
    });

    expect(typeof stop).toBe("function");
    expect(() => stop()).not.toThrow();
    expect(logged).toHaveBeenCalled();
    logged.mockRestore();
  });
});

describe("the lobby does not reach for a second microphone", () => {
  it("has no getUserMedia call in MeetingSetup", () => {
    // Belt and braces: the leak was reintroduced once by a well-meaning fix
    // for a dead meter, so the source itself is pinned.
    const source = readFileSync(
      join(process.cwd(), "app/meetings/[id]/components/MeetingSetup.tsx"),
      "utf8",
    );

    // Only the prohibitions: those are the regressions. A positive match on
    // one exact expression would fail on a harmless destructuring change.
    expect(source).not.toMatch(/getUserMedia/);
    expect(source).not.toMatch(/new AudioContext/);
  });
});
