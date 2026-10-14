import { useEffect, useRef, useState } from 'react';
import { pcmWav } from '../../../../shared/audio';
import type { PetController } from '../pet/PetController';
import { SpeechPlayer } from './SpeechPlayer';

type Capture = {
  stream: MediaStream;
  context: AudioContext;
  source?: MediaStreamAudioSourceNode;
  node?: AudioWorkletNode;
  gain?: GainNode;
  chunks: Float32Array[];
  length: number;
  timer?: ReturnType<typeof setTimeout>;
};
export function useVoice(controller: PetController) {
  const [enabled, setEnabled] = useState(false),
    [configured, setConfigured] = useState(false);
  const [status, setStatus] = useState<'idle' | 'loading' | 'playing'>('idle');
  const [mic, setMic] = useState<'idle' | 'requesting' | 'recording' | 'transcribing'>('idle');
  const [error, setError] = useState(''),
    [transcript, setTranscript] = useState('');
  const on = useRef(false),
    turn = useRef<string | null>(null),
    version = useRef(0),
    mounted = useRef(true);
  const capture = useRef<Capture | null>(null),
    recognition = useRef<AbortController | null>(null);
  const playerRef = useRef<SpeechPlayer | null>(null);
  const player = () =>
    (playerRef.current ??= new SpeechPlayer(setStatus, setError, (value) => {
      controller.audioLevel = value;
    }));
  const release = () => {
    const current = capture.current;
    capture.current = null;
    if (current) {
      clearTimeout(current.timer);
      current.stream.getTracks().forEach((track) => track.stop());
      if (current.node) current.node.port.onmessage = null;
      current.source?.disconnect();
      current.node?.disconnect();
      current.gain?.disconnect();
      void current.context.close();
    }
    return current;
  };
  const cancelRecording = () => {
    version.current++;
    recognition.current?.abort();
    recognition.current = null;
    release();
    setMic('idle');
  };
  const stop = () => {
    setError('');
    turn.current = null;
    playerRef.current?.stop();
    cancelRecording();
  };
  useEffect(() => {
    mounted.current = true;
    const hide = () => {
      if (document.hidden) stop();
    };
    const blur = () => {
      cancelRecording();
    };
    document.addEventListener('visibilitychange', hide);
    window.addEventListener('blur', blur);
    return () => {
      mounted.current = false;
      stop();
      playerRef.current?.destroy();
      playerRef.current = null;
      document.removeEventListener('visibilitychange', hide);
      window.removeEventListener('blur', blur);
    };
  }, []);
  async function toggle() {
    if (on.current) {
      on.current = false;
      controller.audioDriven = false;
      turn.current = null;
      setEnabled(false);
      playerRef.current?.stop();
      return;
    }
    const id = version.current;
    try {
      await player().unlock();
      if (id !== version.current || !mounted.current) return;
      on.current = true;
      controller.audioDriven = true;
      setEnabled(true);
      setError('');
    } catch {
      setError('浏览器未允许播放，请再点一次声音开关。');
    }
  }
  async function preview() {
    stop();
    setError('');
    const id = version.current;
    try {
      await player().unlock();
      if (id !== version.current || !mounted.current) return;
      player().enqueue('嘿，你来啦！我是Step酱。今天也一起发现点新东西吧！');
    } catch {
      setError('浏览器未允许播放，请再点一次试听。');
    }
  }
  async function endRecording() {
    const recorded = release();
    if (!recorded) {
      if (!recognition.current) cancelRecording();
      return;
    }
    const id = version.current;
    if (recorded.length < recorded.context.sampleRate * 0.2) {
      cancelRecording();
      setError('录音太短啦，按住说完一句再松开。');
      return;
    }
    setMic('transcribing');
    const abort = new AbortController();
    recognition.current = abort;
    try {
      const samples = new Float32Array(recorded.length);
      let offset = 0;
      for (const chunk of recorded.chunks) {
        samples.set(chunk, offset);
        offset += chunk.length;
      }
      const wav = new Uint8Array(pcmWav(samples, recorded.context.sampleRate));
      let binary = '';
      for (let i = 0; i < wav.length; i += 8192)
        binary += String.fromCharCode(...wav.subarray(i, i + 8192));
      const response = await fetch('/api/audio/asr', {
        method: 'POST',
        signal: abort.signal,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ audio: btoa(binary) }),
      });
      const data = await response.json();
      if (!response.ok) throw Error(data.message || '识别失败，请重试。');
      if (typeof data.text !== 'string' || !data.text.trim() || data.text.length > 4000)
        throw Error('没有听清，请重试。');
      if (id === version.current && mounted.current) setTranscript(data.text);
    } catch (e) {
      if (id === version.current && mounted.current)
        setError(e instanceof Error ? e.message : '识别失败，请重试。');
    } finally {
      if (id === version.current && mounted.current) {
        recognition.current = null;
        setMic('idle');
      }
    }
  }
  async function startRecording() {
    stop();
    setError('');
    setTranscript('');
    const id = version.current;
    setMic('requesting');
    try {
      if (!navigator.mediaDevices?.getUserMedia)
        throw Error('当前浏览器不支持录音，请使用本机地址或 HTTPS。');
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
        video: false,
      });
      if (id !== version.current || !mounted.current) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      let context: AudioContext;
      try {
        context = new AudioContext({ sampleRate: 24000 });
      } catch (e) {
        stream.getTracks().forEach((track) => track.stop());
        throw e;
      }
      const record: Capture = { stream, context, chunks: [], length: 0 };
      capture.current = record;
      await context.audioWorklet.addModule('/audio-recorder.js');
      await context.resume();
      if (id !== version.current) return;
      record.source = context.createMediaStreamSource(stream);
      record.node = new AudioWorkletNode(context, 'step-recorder');
      record.gain = context.createGain();
      record.gain.gain.value = 0;
      record.node.port.onmessage = (event) => {
        if (id !== version.current || capture.current !== record) return;
        const remaining = context.sampleRate * 30 - record.length;
        const samples = (event.data as Float32Array).slice(0, remaining);
        record.chunks.push(samples);
        record.length += samples.length;
        if (record.length >= context.sampleRate * 30) void endRecording();
      };
      record.source.connect(record.node);
      record.node.connect(record.gain);
      record.gain.connect(context.destination);
      record.timer = setTimeout(() => void endRecording(), 30000);
      setMic('recording');
    } catch (e) {
      if (id !== version.current || !mounted.current) return;
      release();
      setMic('idle');
      setError(
        e instanceof DOMException && e.name === 'NotAllowedError'
          ? '麦克风未获授权；允许浏览器使用麦克风后再试，也可以继续打字。'
          : e instanceof Error
            ? e.message
            : '无法开启麦克风。',
      );
    }
  }
  return {
    enabled,
    configured,
    setConfigured,
    status,
    mic,
    error,
    transcript,
    setTranscript,
    toggle,
    preview,
    stop,
    cancelRecording,
    startRecording,
    endRecording,
    begin(id: string, live: boolean) {
      turn.current = on.current && live ? id : null;
    },
    append(id: string, text: string) {
      if (turn.current === id) player().append(text);
    },
    finish(id: string, success: boolean) {
      if (turn.current !== id) return;
      if (success) player().append('', true);
      else player().stop();
      turn.current = null;
    },
  };
}
