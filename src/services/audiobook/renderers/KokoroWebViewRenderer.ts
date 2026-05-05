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
import {
  ITTSRenderer,
  KokoroDtype,
  RendererCapabilities,
  SynthesisRequest,
  SynthesisResult,
} from './types';
import { blendString } from '../voiceCaster';

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
const downloadProgressListeners = new Set<
  (loaded: number, total: number, status: string) => void
>();

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
  return () => {
    downloadProgressListeners.delete(handler);
  };
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

  constructor(private readonly dtype: KokoroDtype = 'q8') {}

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
