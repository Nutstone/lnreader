/**
 * Kokoro TTS renderer hosted in a hidden React Native WebView.
 *
 * The actual ONNX inference runs inside the WebView (Chromium has full
 * WASM/WebGPU support, so kokoro-js loads unchanged). The RN side owns
 * the WebView lifecycle, posts synthesis requests, and writes audio
 * files to disk.
 *
 * The WebView component lives in `components/audiobook/KokoroTTSHost`
 * — it calls `setKokoroHost(bridge)` on mount and `setKokoroHost(null)`
 * on unmount. This file talks to whatever host is currently mounted.
 */

import * as FileSystem from 'expo-file-system/legacy';
import NativeFile from '@specs/NativeFile';
import { AudioSegment, BlendedVoice, ChapterAnnotation, VoiceMap } from '../types';
import {
  ITTSRenderer,
  KokoroDtype,
  RendererCapabilities,
  StreamOptions,
  SynthesisRequest,
  SynthesisResult,
  effectiveSpeed,
} from './types';
import { blendString } from '../voiceCaster';
import { getEmotionModulation, pauseTypeToMs } from '../emotionModulation';

// ── Host bridge ─────────────────────────────────────────────────

export interface KokoroHostBridge {
  /** Send a JSON payload into the WebView. */
  post(payload: object): void;
  /** Subscribe to JSON messages from the WebView. */
  onMessage(handler: (msg: KokoroHostMessage) => void): () => void;
  /** Whether the host is currently mounted. */
  isMounted(): boolean;
}

export type KokoroHostMessage =
  | { type: 'ready' }
  | { type: 'progress'; loaded: number; total: number; status?: string }
  | { type: 'audio'; id: string; sampleRate: number; pcmBase64: string; durationMs: number }
  | { type: 'error'; id?: string; message: string };

let activeHost: KokoroHostBridge | null = null;
const downloadProgressListeners = new Set<(loaded: number, total: number, status: string) => void>();

export function setKokoroHost(host: KokoroHostBridge | null) {
  activeHost = host;
}

export function getKokoroHost(): KokoroHostBridge | null {
  return activeHost;
}

export function onKokoroDownloadProgress(
  handler: (loaded: number, total: number, status: string) => void,
): () => void {
  downloadProgressListeners.add(handler);
  return () => downloadProgressListeners.delete(handler);
}

// ── Renderer ────────────────────────────────────────────────────

interface PendingRequest {
  resolve: (r: SynthesisResult) => void;
  reject: (e: Error) => void;
  outputPath: string;
}

export class KokoroWebViewRenderer implements ITTSRenderer {
  private readyPromise: Promise<void> | null = null;
  private resolveReady: (() => void) | null = null;
  private rejectReady: ((e: Error) => void) | null = null;
  private pending = new Map<string, PendingRequest>();
  private unsubscribe: (() => void) | null = null;
  private nextId = 1;

  constructor(private readonly dtype: KokoroDtype = 'q8f16') {}

  capabilities(): RendererCapabilities {
    return {
      requiresDownload: true,
      modelDownloaded: false,
      modelSizeBytes: 86 * 1024 * 1024,
      dtype: this.dtype,
    };
  }

  isReady(): boolean {
    return this.readyPromise !== null && this.resolveReady === null;
  }

  async initialize(): Promise<void> {
    const host = activeHost;
    if (!host) {
      throw new Error(
        'Kokoro WebView host is not mounted. Open the audiobook player to start the WebView.',
      );
    }
    if (this.readyPromise) return this.readyPromise;

    this.readyPromise = new Promise<void>((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
    });
    this.unsubscribe = host.onMessage(msg => this.handleMessage(msg));
    host.post({ type: 'init', modelDtype: this.dtype });
    return this.readyPromise;
  }

  async dispose(): Promise<void> {
    activeHost?.post({ type: 'dispose' });
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.readyPromise = null;
    for (const p of this.pending.values()) {
      p.reject(new Error('Renderer disposed'));
    }
    this.pending.clear();
  }

  async renderSegment(req: SynthesisRequest): Promise<SynthesisResult> {
    if (!this.readyPromise) await this.initialize();
    await this.readyPromise!;
    const host = activeHost;
    if (!host) throw new Error('Kokoro host disappeared during render');

    const id = req.id || `r${this.nextId++}`;
    return new Promise<SynthesisResult>((resolve, reject) => {
      this.pending.set(id, { resolve, reject, outputPath: req.outputPath });
      host.post({
        type: 'synthesize',
        id,
        text: req.text,
        voice: blendString(req.voice),
        speed: req.speed,
      });
    });
  }

  async *streamChapterAudio(
    annotation: ChapterAnnotation,
    voiceMap: VoiceMap,
    options: StreamOptions,
  ): AsyncGenerator<AudioSegment> {
    await this.initialize();

    if (!NativeFile.exists(options.outputDir)) {
      NativeFile.mkdir(options.outputDir);
    }

    const queue: Promise<AudioSegment>[] = [];
    const segments = annotation.segments;

    const renderOne = async (segIndex: number): Promise<AudioSegment> => {
      const seg = segments[segIndex];
      const voice = pickVoice(voiceMap, seg.speaker);
      const id = `seg_${annotation.chapterKey}_${segIndex}`;
      const outputPath = `${options.outputDir}/seg_${segIndex
        .toString()
        .padStart(4, '0')}.wav`;

      const speed = effectiveSpeed(
        voice.speed,
        seg.emotion,
        seg.intensity,
        (e, i) => getEmotionModulation(e, i, seg.speaker).speedMultiplier,
        options.playbackSpeedMultiplier,
      );

      const text = applyPronunciation(seg.text, options.pronunciationMap);

      const result = await this.renderSegment({
        id,
        text,
        voice,
        speed,
        outputPath,
      });

      return {
        index: segIndex,
        pauseBeforeMs: pauseTypeToMs(seg.pauseBefore, options.pauseMultiplier),
        filePath: result.filePath,
        durationMs: result.durationMs,
        speaker: seg.speaker,
        text: seg.text,
        emotion: seg.emotion,
        intensity: seg.intensity,
      };
    };

    let cursor = 0;
    for (let k = 0; k < Math.min(options.lookahead, segments.length); k++) {
      queue.push(renderOne(k));
      cursor = k + 1;
    }

    while (queue.length > 0) {
      const seg = await queue.shift()!;
      yield seg;
      options.events?.onProgress?.(seg.index, segments.length);
      if (cursor < segments.length) {
        queue.push(renderOne(cursor++));
      }
    }
  }

  private handleMessage(msg: KokoroHostMessage) {
    if (msg.type === 'ready') {
      this.resolveReady?.();
      this.resolveReady = null;
      this.rejectReady = null;
      return;
    }
    if (msg.type === 'progress') {
      for (const l of downloadProgressListeners) {
        l(msg.loaded, msg.total, msg.status ?? '');
      }
      return;
    }
    if (msg.type === 'error') {
      if (msg.id && this.pending.has(msg.id)) {
        const p = this.pending.get(msg.id)!;
        this.pending.delete(msg.id);
        p.reject(new Error(`Kokoro: ${msg.message}`));
      } else if (this.rejectReady) {
        this.rejectReady(new Error(`Kokoro init failed: ${msg.message}`));
        this.rejectReady = null;
        this.resolveReady = null;
      }
      return;
    }
    if (msg.type === 'audio') {
      const pending = this.pending.get(msg.id);
      if (!pending) return;
      this.pending.delete(msg.id);
      // base64 → file via expo-file-system (legacy API supports base64).
      const fileUri = pending.outputPath.startsWith('file://')
        ? pending.outputPath
        : `file://${pending.outputPath}`;
      FileSystem.writeAsStringAsync(fileUri, msg.pcmBase64, {
        encoding: FileSystem.EncodingType.Base64,
      })
        .then(() =>
          pending.resolve({
            filePath: pending.outputPath,
            durationMs: msg.durationMs,
            sampleRate: msg.sampleRate,
          }),
        )
        .catch(e =>
          pending.reject(e instanceof Error ? e : new Error(String(e))),
        );
    }
  }
}

// ── Helpers ─────────────────────────────────────────────────────

function pickVoice(map: VoiceMap, speaker: string): BlendedVoice {
  return (
    map.mappings[speaker] ||
    map.mappings.narrator ||
    map.mappings[Object.keys(map.mappings)[0]]
  );
}

function applyPronunciation(
  text: string,
  pronunciationMap?: Record<string, string>,
): string {
  if (!pronunciationMap) return text;
  let out = text;
  for (const [name, pron] of Object.entries(pronunciationMap)) {
    if (!name || !pron || pron === name) continue;
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    out = out.replace(new RegExp(`\\b${escaped}\\b`, 'g'), pron);
  }
  return out;
}
