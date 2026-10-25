/**
 * Captures audio for a tab from a chrome.tabCapture stream ID (offscreen document only).
 *
 * Pipeline: MediaStream -> AudioWorklet (mono batches) -> StreamingResampler (-> 16 kHz)
 *           -> PCM16 -> 100 ms frames -> onFrame
 *
 * The captured stream is also routed back to the speakers: Chrome mutes a captured tab for the
 * user unless the audio is played out again. Nothing is recorded or stored.
 *
 * Microphone input is intentionally not mixed in: a future mic source should use its own
 * AudioCapture instance and its own STT stream so the user's speech stays separate from tab audio.
 */
import { AUDIO_CHUNK_SAMPLES, AUDIO_FORMAT } from '@meeting-copilot/shared';
import { elapsedMs, monotonicNow, type Logger } from '@meeting-copilot/shared';
import { floatToPcm16, Pcm16Framer, StreamingResampler } from './resampler.js';

export interface CaptureCallbacks {
  onFrame(pcm16: ArrayBuffer): void;
  /** The capture ended without stop() being called (tab closed, capture revoked). */
  onEnded(reason: string): void;
}

export class AudioCapture {
  private stream: MediaStream | null = null;
  private context: AudioContext | null = null;
  private node: AudioWorkletNode | null = null;
  private framer: Pcm16Framer | null = null;
  private stopped = false;
  private frames = 0;
  private startedAt = 0;

  constructor(private readonly log?: Logger) {}

  async start(streamId: string, cb: CaptureCallbacks): Promise<void> {
    const t0 = monotonicNow();
    // Legacy `mandatory` constraints are what Chrome requires for tab-capture stream IDs.
    const constraints = {
      audio: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: streamId } },
      video: false,
    } as unknown as MediaStreamConstraints;
    try {
      this.stream = await navigator.mediaDevices.getUserMedia(constraints);
    } catch (err) {
      const name = (err as DOMException).name;
      this.log?.error('start_failed', { stage: 'getUserMedia', err, duration_ms: elapsedMs(t0) });
      throw new Error(
        name === 'NotAllowedError' || name === 'AbortError'
          ? 'Chrome did not allow capturing this tab. Click the extension icon on the meeting tab and press Start again.'
          : `Could not access tab audio (${name || (err as Error).message}).`,
        { cause: err },
      );
    }
    const track = this.stream.getAudioTracks()[0];
    if (!track) throw new Error('The captured tab has no audio track.');
    track.addEventListener('ended', () => {
      if (this.stopped) return;
      this.log?.warn('track_ended', { frames: this.frames, recovery: 'session_stopped' });
      cb.onEnded('The captured tab stopped providing audio (tab closed or capture ended).');
    });

    const context = new AudioContext();
    this.context = context;
    const source = context.createMediaStreamSource(this.stream);
    // Keep the meeting audible to the user.
    source.connect(context.destination);

    await context.audioWorklet.addModule(chrome.runtime.getURL('capture-worklet.js'));
    const node = new AudioWorkletNode(context, 'pcm-capture', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] });
    this.node = node;
    // A muted sink keeps the worklet in the rendering graph without doubling the audio.
    const sink = context.createGain();
    sink.gain.value = 0;
    source.connect(node);
    node.connect(sink).connect(context.destination);

    const resampler = new StreamingResampler(context.sampleRate, AUDIO_FORMAT.sampleRate);
    this.framer = new Pcm16Framer(AUDIO_CHUNK_SAMPLES, (frame) => {
      this.frames++;
      cb.onFrame(frame);
    });
    node.port.onmessage = (e: MessageEvent<{ type: string; samples?: Float32Array }>) => {
      if (this.stopped || e.data.type !== 'audio' || !e.data.samples) return;
      this.framer?.push(floatToPcm16(resampler.process(e.data.samples)));
    };
    if (context.state === 'suspended') await context.resume();
    this.startedAt = monotonicNow();
    const settings = track.getSettings();
    this.log?.info('started', {
      input_rate_hz: context.sampleRate,
      input_channels: settings.channelCount ?? undefined,
      output: `${AUDIO_FORMAT.encoding}/${AUDIO_FORMAT.sampleRate}Hz/mono`,
      frame_ms: (AUDIO_CHUNK_SAMPLES / AUDIO_FORMAT.sampleRate) * 1000,
      context_state: context.state,
      duration_ms: elapsedMs(t0),
    });
  }

  get inputSampleRate(): number | null {
    return this.context?.sampleRate ?? null;
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.framer?.flush();
    this.framer = null;
    if (this.node) {
      this.node.port.onmessage = null;
      this.node.disconnect();
    }
    this.node = null;
    for (const t of this.stream?.getTracks() ?? []) t.stop();
    this.stream = null;
    await this.context?.close().catch((err: unknown) => this.log?.warn('context_close_failed', { err }));
    this.context = null;
    this.log?.info('stopped', { frames: this.frames, captured_s: this.startedAt ? Math.round(elapsedMs(this.startedAt) / 1000) : 0 });
  }
}
