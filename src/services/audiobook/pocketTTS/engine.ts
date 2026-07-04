/**
 * PocketTTSEngine — a TypeScript port of the reference Python runtime
 * for the Pocket TTS ONNX export (KevinAHM/pocket-tts-onnx, MIT).
 *
 * The bundle contains five graphs; this engine drives four of them:
 *
 *   text_conditioner:  token_ids [1,T] i64 → text embeddings [*,T,1024]
 *   flow_lm_main:      {sequence [1,S,32], text_embeddings [1,T,1024],
 *                       state_0..N} → [conditioning, eos_logit, states...]
 *   flow_lm_flow:      {c, s [1,1], t [1,1], x [1,32]} → flow step
 *   mimi_decoder:      {latent [1,F,32], state_0..M} → [audio, states...]
 *   (mimi_encoder is used only for voice cloning from reference audio)
 *
 * Generation: condition the flow-LM state with a voice prompt (either
 * a precomputed safetensors state or mimi-encoded reference audio),
 * feed text embeddings, then autoregressively sample latents — each
 * step integrates the flow field over `lsdSteps` Euler steps from
 * Gaussian noise — until the EOS logit fires, and finally stream the
 * latents through the stateful mimi decoder in chunks.
 *
 * The engine is runtime-agnostic: pass onnxruntime-react-native or
 * onnxruntime-node as `ort`. All model/bundle bytes are supplied by a
 * caller-provided file reader, so the engine itself performs no I/O.
 */

import { SentencePieceProcessor } from './sentencepiece';
import {
  parseNpy,
  parseSafetensors,
  parseWav,
  resampleLinear,
  SafeTensor,
} from './binaryFormats';

// ── Runtime interfaces ──────────────────────────────────────────

export interface OrtTensor {
  readonly data: unknown;
  readonly dims: readonly number[];
  readonly type: string;
}

export interface OrtSession {
  run(feeds: Record<string, OrtTensor>): Promise<Record<string, OrtTensor>>;
  release?(): Promise<void> | void;
  readonly outputNames: readonly string[];
}

export interface OrtModule {
  InferenceSession: {
    create(path: string, options?: unknown): Promise<OrtSession>;
  };
  Tensor: new (
    type: string,
    data: unknown,
    dims: readonly number[],
  ) => OrtTensor;
}

/** Reads a file into bytes; RN backs this with base64 reads. */
export type FileReader = (path: string) => Promise<Uint8Array>;

// ── Bundle metadata (bundle.json) ───────────────────────────────

interface StateManifestEntry {
  dtype: 'float32' | 'float16' | 'int64' | 'bool';
  fill: 'nan' | 'zeros' | 'ones' | 'empty';
  index: number;
  input_name: string;
  output_name: string;
  module: string;
  key: string;
  shape: number[];
}

export interface BundleMetadata {
  sample_rate: number;
  frame_rate: number;
  samples_per_frame: number;
  latent_dim: number;
  conditioning_dim: number;
  max_token_per_chunk: number;
  insert_bos_before_voice: boolean;
  bos_before_voice_file?: string;
  tokenizer_file: string;
  pad_with_spaces_for_short_inputs?: boolean;
  remove_semicolons?: boolean;
  model_recommended_frames_after_eos?: number | null;
  predefined_voices?: string[];
  flow_lm_state_manifest: StateManifestEntry[];
  mimi_state_manifest: StateManifestEntry[];
}

export interface EngineModelPaths {
  flowLmMain: string;
  flowLmFlow: string;
  mimiDecoder: string;
  mimiEncoder?: string;
  textConditioner: string;
}

export interface EngineOptions {
  temperature?: number;
  lsdSteps?: number;
  /** Uniform RNG in [0,1); injectable for deterministic tests. */
  random?: () => number;
  /** mimi decode chunk size in frames. */
  decodeChunkFrames?: number;
}

const TOKENS_PER_SECOND_ESTIMATE = 3.0;
const GEN_SECONDS_PADDING = 2.0;
const EOS_THRESHOLD = -4.0;

type State = Record<string, OrtTensor>;

export class PocketTTSEngine {
  readonly metadata: BundleMetadata;
  readonly sampleRate: number;

  private ort: OrtModule;
  private tokenizer: SentencePieceProcessor;
  private bosBeforeVoice: { shape: number[]; data: Float32Array } | null = null;

  private flowLmMain: OrtSession;
  private flowLmFlow: OrtSession;
  private mimiDecoder: OrtSession;
  private mimiEncoder: OrtSession | null;
  private textConditioner: OrtSession;

  private temperature: number;
  private lsdSteps: number;
  private random: () => number;
  private decodeChunkFrames: number;

  private constructor(
    ort: OrtModule,
    metadata: BundleMetadata,
    tokenizer: SentencePieceProcessor,
    sessions: {
      flowLmMain: OrtSession;
      flowLmFlow: OrtSession;
      mimiDecoder: OrtSession;
      mimiEncoder: OrtSession | null;
      textConditioner: OrtSession;
    },
    options: EngineOptions,
  ) {
    this.ort = ort;
    this.metadata = metadata;
    this.sampleRate = metadata.sample_rate;
    this.tokenizer = tokenizer;
    this.flowLmMain = sessions.flowLmMain;
    this.flowLmFlow = sessions.flowLmFlow;
    this.mimiDecoder = sessions.mimiDecoder;
    this.mimiEncoder = sessions.mimiEncoder;
    this.textConditioner = sessions.textConditioner;
    this.temperature = options.temperature ?? 0.7;
    this.lsdSteps = options.lsdSteps ?? 1;
    this.random = options.random ?? Math.random;
    this.decodeChunkFrames = options.decodeChunkFrames ?? 12;
  }

  static async load(
    ort: OrtModule,
    metadata: BundleMetadata,
    modelPaths: EngineModelPaths,
    readFile: FileReader,
    tokenizerPath: string,
    bosBeforeVoicePath?: string,
    options: EngineOptions = {},
  ): Promise<PocketTTSEngine> {
    const tokenizer = new SentencePieceProcessor(await readFile(tokenizerPath));

    const [flowLmMain, flowLmFlow, mimiDecoder, textConditioner, mimiEncoder] =
      await Promise.all([
        ort.InferenceSession.create(modelPaths.flowLmMain),
        ort.InferenceSession.create(modelPaths.flowLmFlow),
        ort.InferenceSession.create(modelPaths.mimiDecoder),
        ort.InferenceSession.create(modelPaths.textConditioner),
        modelPaths.mimiEncoder
          ? ort.InferenceSession.create(modelPaths.mimiEncoder)
          : Promise.resolve(null),
      ]);

    const engine = new PocketTTSEngine(
      ort,
      metadata,
      tokenizer,
      { flowLmMain, flowLmFlow, mimiDecoder, mimiEncoder, textConditioner },
      options,
    );

    if (metadata.insert_bos_before_voice && bosBeforeVoicePath) {
      const npy = parseNpy(await readFile(bosBeforeVoicePath));
      engine.bosBeforeVoice = { shape: npy.shape, data: npy.data };
    }
    return engine;
  }

  async release(): Promise<void> {
    await this.flowLmMain.release?.();
    await this.flowLmFlow.release?.();
    await this.mimiDecoder.release?.();
    await this.mimiEncoder?.release?.();
    await this.textConditioner.release?.();
  }

  // ── Voice conditioning ──────────────────────────────────────

  /** Builds a reusable voice state from a predefined-voice safetensors file. */
  async voiceStateFromSafetensors(bytes: Uint8Array): Promise<State> {
    const tensors = parseSafetensors(bytes);
    const byModule = new Map<string, Map<string, SafeTensor>>();
    for (const [key, tensor] of tensors) {
      const slash = key.indexOf('/');
      const module = key.slice(0, slash);
      const field = key.slice(slash + 1);
      if (!byModule.has(module)) {
        byModule.set(module, new Map());
      }
      byModule.get(module)!.set(field, tensor);
    }
    return this.stateFromModuleTensors(byModule);
  }

  /**
   * Builds a voice state by mimi-encoding 16-bit PCM WAV reference
   * audio. Long clips are truncated to `maxSeconds` — voice identity
   * is captured within the first several seconds, and encoding cost
   * scales with length.
   */
  async voiceStateFromWav(
    bytes: Uint8Array,
    maxSeconds?: number,
  ): Promise<State> {
    if (!this.mimiEncoder) {
      throw new Error('mimi encoder graph not loaded; cannot clone voices');
    }
    const wav = parseWav(bytes);
    let samples = resampleLinear(wav.samples, wav.sampleRate, this.sampleRate);
    if (maxSeconds && samples.length > maxSeconds * this.sampleRate) {
      samples = samples.subarray(0, maxSeconds * this.sampleRate);
    }
    const audio = new this.ort.Tensor('float32', samples, [
      1,
      1,
      samples.length,
    ]);
    const result = await this.mimiEncoder.run({ audio });
    const embeddings = result[this.mimiEncoder.outputNames[0]];
    return this.conditionWithVoiceEmbeddings(embeddings);
  }

  private async conditionWithVoiceEmbeddings(
    embeddings: OrtTensor,
  ): Promise<State> {
    let data = embeddings.data as Float32Array;
    let dims = [...embeddings.dims];
    while (dims.length > 3 && dims[0] === 1) {
      dims = dims.slice(1);
    }
    if (dims.length === 2) {
      dims = [1, ...dims];
    }

    if (this.metadata.insert_bos_before_voice && this.bosBeforeVoice) {
      const bos = this.bosBeforeVoice;
      const bosFrames = bos.shape.length === 3 ? bos.shape[1] : 1;
      const dim = dims[2];
      const joined = new Float32Array(bos.data.length + data.length);
      joined.set(bos.data, 0);
      joined.set(data, bos.data.length);
      data = joined;
      dims = [1, bosFrames + dims[1], dim];
    }

    const state = this.initState(this.metadata.flow_lm_state_manifest);
    const feeds: Record<string, OrtTensor> = {
      sequence: this.emptyFloat32([1, 0, this.metadata.latent_dim]),
      text_embeddings: new this.ort.Tensor('float32', data, dims),
      ...state,
    };
    const result = await this.flowLmMain.run(feeds);
    this.updateState(
      state,
      result,
      this.flowLmMain.outputNames,
      this.metadata.flow_lm_state_manifest,
      2,
    );
    return state;
  }

  private stateFromModuleTensors(
    byModule: Map<string, Map<string, SafeTensor>>,
  ): State {
    const state = this.initState(this.metadata.flow_lm_state_manifest);
    for (const entry of this.metadata.flow_lm_state_manifest) {
      const moduleTensors = byModule.get(entry.module);
      if (!moduleTensors) {
        continue;
      }
      const tensor = moduleTensors.get(entry.key) ?? null;
      let data: Float32Array | BigInt64Array | null = tensor?.data ?? null;
      let shape = tensor?.shape ?? null;
      if (!tensor && entry.key === 'step') {
        data = this.deriveStep(moduleTensors);
        shape = [1];
      }
      if (data === null || shape === null) {
        continue;
      }
      state[entry.input_name] = this.adaptStateTensor(data, shape, entry);
    }
    return state;
  }

  private deriveStep(moduleTensors: Map<string, SafeTensor>): BigInt64Array {
    const offset = moduleTensors.get('offset');
    if (offset && !moduleTensors.has('end_offset')) {
      return BigInt64Array.from([
        BigInt(Number((offset.data as BigInt64Array)[0] ?? 0)),
      ]);
    }
    const currentEnd = moduleTensors.get('current_end');
    if (currentEnd) {
      return BigInt64Array.from([BigInt(currentEnd.shape[0] ?? 0)]);
    }
    return BigInt64Array.from([0n]);
  }

  private adaptStateTensor(
    source: Float32Array | BigInt64Array,
    sourceShape: number[],
    entry: StateManifestEntry,
  ): OrtTensor {
    const targetShape = entry.shape;
    const targetSize = targetShape.reduce((a, b) => a * b, 1);

    if (shapesEqual(sourceShape, targetShape) || source.length === targetSize) {
      return this.makeTensor(entry.dtype, copyTyped(source), targetShape);
    }

    // Copy the overlapping hyper-rectangle into a fresh filled tensor
    // (voice caches are stored at their true length, e.g. 126, and
    // must land inside the manifest's fixed-capacity buffer, e.g. 1000).
    const target = this.filledArray(entry);
    if (sourceShape.length === targetShape.length) {
      const overlap = targetShape.map((dim, axis) =>
        Math.min(dim, sourceShape[axis]),
      );
      copyHyperRect(source, sourceShape, target, targetShape, overlap);
    }
    return this.makeTensor(entry.dtype, target, targetShape);
  }

  // ── Text handling ───────────────────────────────────────────

  private prepareTextPrompt(text: string): { text: string; eosGuess: number } {
    let prepared = text.trim();
    if (!prepared) {
      throw new Error('Text cannot be empty');
    }
    prepared = prepared
      .replace(/\n/g, ' ')
      .replace(/\r/g, ' ')
      .replace(/ {2}/g, ' ');
    if (this.metadata.remove_semicolons) {
      prepared = prepared.replace(/;/g, ',');
    }
    const wordCount = prepared.split(' ').filter(Boolean).length;
    const eosGuess = wordCount <= 4 ? 3 : 1;
    if (!/[A-Z]/.test(prepared[0]) && /[a-z]/.test(prepared[0])) {
      prepared = prepared[0].toUpperCase() + prepared.slice(1);
    }
    if (/[a-zA-Z0-9]/.test(prepared[prepared.length - 1])) {
      prepared = prepared + '.';
    }
    if (
      this.metadata.pad_with_spaces_for_short_inputs &&
      prepared.split(' ').filter(Boolean).length < 5
    ) {
      prepared = ' '.repeat(8) + prepared;
    }
    return { text: prepared, eosGuess };
  }

  /** Mirrors the reference runtime's sentence-aware chunk splitting. */
  splitIntoChunks(text: string): string[] {
    const { text: prepared } = this.prepareTextPrompt(text);
    const tokens = this.tokenizer.encode(prepared.trim());
    const maxTokens = this.metadata.max_token_per_chunk;

    const eosTokens = new Set(this.tokenizer.encode('.!...?').slice(1));
    const boundaries = findBoundaryIndices(tokens, eosTokens);
    let segments = segmentsFromBoundaries(this.tokenizer, tokens, boundaries);

    const fallbackTokens = new Set(this.tokenizer.encode(',;:').slice(1));
    const refined: Array<[number, string]> = [];
    for (const [count, segmentText] of segments) {
      if (count <= maxTokens) {
        refined.push([count, segmentText]);
        continue;
      }
      const subTokens = this.tokenizer.encode(segmentText.trim());
      const subBoundaries = findBoundaryIndices(subTokens, fallbackTokens);
      const subSegments = segmentsFromBoundaries(
        this.tokenizer,
        subTokens,
        subBoundaries,
      );
      if (subSegments.length > 1) {
        refined.push(...subSegments);
      } else {
        refined.push([count, segmentText]);
      }
    }
    segments = refined;

    const chunks: string[] = [];
    let currentChunk = '';
    let currentCount = 0;
    for (const [count, segmentText] of segments) {
      if (!currentChunk) {
        currentChunk = segmentText;
        currentCount = count;
        continue;
      }
      if (currentCount + count > maxTokens) {
        chunks.push(currentChunk.trim());
        currentChunk = segmentText;
        currentCount = count;
      } else {
        currentChunk += ' ' + segmentText;
        currentCount += count;
      }
    }
    if (currentChunk) {
      chunks.push(currentChunk.trim());
    }
    return chunks;
  }

  // ── Generation ──────────────────────────────────────────────

  /**
   * Synthesizes `text` with the given voice state. The state is not
   * mutated — it is cloned per text chunk, matching the reference
   * runtime. Returns mono float32 samples at `sampleRate`.
   */
  async synthesize(text: string, voiceState: State): Promise<Float32Array> {
    const audioChunks: Float32Array[] = [];
    for (const chunk of this.splitIntoChunks(text)) {
      const { text: prepared, eosGuess } = this.prepareTextPrompt(chunk);
      const framesAfterEos =
        this.metadata.model_recommended_frames_after_eos ?? eosGuess + 2;
      const tokenIds = this.tokenizer.encode(prepared);
      const latents = await this.runFlowLmChunk(
        voiceState,
        tokenIds,
        framesAfterEos,
      );
      if (latents.length) {
        audioChunks.push(await this.decodeLatents(latents));
      }
    }
    return concatFloat32(audioChunks);
  }

  private async runFlowLmChunk(
    baseState: State,
    tokenIds: number[],
    framesAfterEos: number,
  ): Promise<Float32Array[]> {
    const latentDim = this.metadata.latent_dim;
    const state = this.cloneState(baseState);

    const tokenTensor = new this.ort.Tensor(
      'int64',
      BigInt64Array.from(tokenIds, id => BigInt(id)),
      [1, tokenIds.length],
    );
    const conditionerOut = await this.textConditioner.run({
      token_ids: tokenTensor,
    });
    const textEmbeddings = this.ensure3d(
      conditionerOut[this.textConditioner.outputNames[0]],
    );

    let result = await this.flowLmMain.run({
      sequence: this.emptyFloat32([1, 0, latentDim]),
      text_embeddings: textEmbeddings,
      ...state,
    });
    this.updateState(
      state,
      result,
      this.flowLmMain.outputNames,
      this.metadata.flow_lm_state_manifest,
      2,
    );

    const emptyText = this.emptyFloat32([1, 0, this.metadata.conditioning_dim]);
    let curr = new this.ort.Tensor(
      'float32',
      Float32Array.from({ length: latentDim }, () => NaN),
      [1, 1, latentDim],
    );

    const frameLimit = Math.ceil(
      (tokenIds.length / TOKENS_PER_SECOND_ESTIMATE + GEN_SECONDS_PADDING) *
        this.metadata.frame_rate,
    );
    const dt = 1.0 / this.lsdSteps;
    const latents: Float32Array[] = [];
    let eosStep: number | null = null;

    for (let step = 0; step < frameLimit; step++) {
      result = await this.flowLmMain.run({
        sequence: curr,
        text_embeddings: emptyText,
        ...state,
      });
      const outputNames = this.flowLmMain.outputNames;
      const conditioning = result[outputNames[0]];
      const eosLogit = (result[outputNames[1]].data as Float32Array)[0];
      this.updateState(
        state,
        result,
        outputNames,
        this.metadata.flow_lm_state_manifest,
        2,
      );

      if (eosLogit > EOS_THRESHOLD && eosStep === null) {
        eosStep = step;
      }
      if (eosStep !== null && step >= eosStep + framesAfterEos) {
        break;
      }

      const x = this.sampleNoise(latentDim);
      for (let j = 0; j < this.lsdSteps; j++) {
        const s = j / this.lsdSteps;
        const flowOut = await this.flowLmFlow.run({
          c: conditioning,
          s: new this.ort.Tensor('float32', Float32Array.from([s]), [1, 1]),
          t: new this.ort.Tensor(
            'float32',
            Float32Array.from([s + dt]),
            [1, 1],
          ),
          x: new this.ort.Tensor('float32', x, [1, latentDim]),
        });
        const flow = flowOut[this.flowLmFlow.outputNames[0]]
          .data as Float32Array;
        for (let k = 0; k < latentDim; k++) {
          x[k] += flow[k] * dt;
        }
      }

      latents.push(x);
      curr = new this.ort.Tensor('float32', copyTyped(x) as Float32Array, [
        1,
        1,
        latentDim,
      ]);
    }
    return latents;
  }

  /**
   * Streams latent frames (one Float32Array of `latent_dim` per frame)
   * through the stateful mimi decoder. Public so decoder parity can be
   * validated in isolation against reference latents.
   */
  async decodeLatents(latents: Float32Array[]): Promise<Float32Array> {
    const latentDim = this.metadata.latent_dim;
    const state = this.initState(this.metadata.mimi_state_manifest);
    const audio: Float32Array[] = [];

    for (
      let index = 0;
      index < latents.length;
      index += this.decodeChunkFrames
    ) {
      const chunk = latents.slice(index, index + this.decodeChunkFrames);
      const joined = new Float32Array(chunk.length * latentDim);
      chunk.forEach((frame, i) => joined.set(frame, i * latentDim));

      const result = await this.mimiDecoder.run({
        latent: new this.ort.Tensor('float32', joined, [
          1,
          chunk.length,
          latentDim,
        ]),
        ...state,
      });
      const outputNames = this.mimiDecoder.outputNames;
      audio.push(
        copyTyped(result[outputNames[0]].data as Float32Array) as Float32Array,
      );
      this.updateState(
        state,
        result,
        outputNames,
        this.metadata.mimi_state_manifest,
        1,
      );
    }
    return concatFloat32(audio);
  }

  // ── State plumbing ──────────────────────────────────────────

  private initState(manifest: StateManifestEntry[]): State {
    const state: State = {};
    for (const entry of manifest) {
      state[entry.input_name] = this.makeTensor(
        entry.dtype,
        this.filledArray(entry),
        entry.shape,
      );
    }
    return state;
  }

  private cloneState(state: State): State {
    const clone: State = {};
    for (const [name, tensor] of Object.entries(state)) {
      clone[name] = new this.ort.Tensor(
        tensor.type,
        copyTyped(tensor.data as Float32Array | BigInt64Array | Uint8Array),
        [...tensor.dims],
      );
    }
    return clone;
  }

  private updateState(
    state: State,
    result: Record<string, OrtTensor>,
    outputNames: readonly string[],
    manifest: StateManifestEntry[],
    outputOffset: number,
  ): void {
    for (const entry of manifest) {
      const name = outputNames[outputOffset + entry.index];
      const tensor = result[name];
      if (tensor) {
        state[entry.input_name] = tensor;
      }
    }
  }

  private filledArray(
    entry: StateManifestEntry,
  ): Float32Array | BigInt64Array | Uint8Array {
    const size = entry.shape.reduce((a, b) => a * b, 1);
    switch (entry.dtype) {
      case 'int64': {
        const arr = new BigInt64Array(size);
        if (entry.fill === 'ones') {
          arr.fill(1n);
        }
        return arr;
      }
      case 'bool': {
        const arr = new Uint8Array(size);
        if (entry.fill === 'ones') {
          arr.fill(1);
        }
        return arr;
      }
      default: {
        const arr = new Float32Array(size);
        if (entry.fill === 'nan') {
          arr.fill(NaN);
        } else if (entry.fill === 'ones') {
          arr.fill(1);
        }
        return arr;
      }
    }
  }

  private makeTensor(
    dtype: StateManifestEntry['dtype'],
    data: Float32Array | BigInt64Array | Uint8Array,
    shape: readonly number[],
  ): OrtTensor {
    const type =
      dtype === 'int64' ? 'int64' : dtype === 'bool' ? 'bool' : 'float32';
    return new this.ort.Tensor(type, data, shape);
  }

  private emptyFloat32(shape: number[]): OrtTensor {
    return new this.ort.Tensor('float32', new Float32Array(0), shape);
  }

  private ensure3d(tensor: OrtTensor): OrtTensor {
    if (tensor.dims.length === 3) {
      return tensor;
    }
    if (tensor.dims.length === 2) {
      return new this.ort.Tensor('float32', tensor.data, [
        1,
        tensor.dims[0],
        tensor.dims[1],
      ]);
    }
    return tensor;
  }

  private sampleNoise(dim: number): Float32Array {
    const out = new Float32Array(dim);
    if (this.temperature <= 0) {
      return out;
    }
    const std = Math.sqrt(this.temperature);
    for (let i = 0; i < dim; i += 2) {
      // Box–Muller
      const u1 = Math.max(this.random(), 1e-12);
      const u2 = this.random();
      const mag = Math.sqrt(-2.0 * Math.log(u1));
      out[i] = mag * Math.cos(2 * Math.PI * u2) * std;
      if (i + 1 < dim) {
        out[i + 1] = mag * Math.sin(2 * Math.PI * u2) * std;
      }
    }
    return out;
  }
}

// ── helpers ─────────────────────────────────────────────────────

function shapesEqual(a: readonly number[], b: readonly number[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

function copyTyped<T extends Float32Array | BigInt64Array | Uint8Array>(
  source: T,
): T {
  return source.slice() as T;
}

function copyHyperRect(
  source: Float32Array | BigInt64Array,
  sourceShape: number[],
  target: Float32Array | BigInt64Array | Uint8Array,
  targetShape: number[],
  overlap: number[],
): void {
  const rank = targetShape.length;
  const sourceStrides = strides(sourceShape);
  const targetStrides = strides(targetShape);
  const index = new Array<number>(rank).fill(0);

  for (;;) {
    let src = 0;
    let dst = 0;
    for (let axis = 0; axis < rank; axis++) {
      src += index[axis] * sourceStrides[axis];
      dst += index[axis] * targetStrides[axis];
    }
    (target as Float32Array)[dst] = (source as Float32Array)[src];

    let axis = rank - 1;
    for (;;) {
      index[axis]++;
      if (index[axis] < overlap[axis]) {
        break;
      }
      index[axis] = 0;
      axis--;
      if (axis < 0) {
        return;
      }
    }
  }
}

function strides(shape: number[]): number[] {
  const out = new Array<number>(shape.length);
  let acc = 1;
  for (let i = shape.length - 1; i >= 0; i--) {
    out[i] = acc;
    acc *= shape[i];
  }
  return out;
}

function concatFloat32(chunks: Float32Array[]): Float32Array {
  const total = chunks.reduce((sum, c) => sum + c.length, 0);
  const out = new Float32Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

function findBoundaryIndices(
  tokens: number[],
  boundaryTokens: Set<number>,
): number[] {
  const indices = [0];
  let previousWasBoundary = false;
  for (let index = 0; index < tokens.length; index++) {
    if (boundaryTokens.has(tokens[index])) {
      previousWasBoundary = true;
    } else {
      if (previousWasBoundary) {
        indices.push(index);
      }
      previousWasBoundary = false;
    }
  }
  indices.push(tokens.length);
  return indices;
}

function segmentsFromBoundaries(
  tokenizer: SentencePieceProcessor,
  tokens: number[],
  boundaries: number[],
): Array<[number, string]> {
  const segments: Array<[number, string]> = [];
  for (let i = 0; i < boundaries.length - 1; i++) {
    const start = boundaries[i];
    const end = boundaries[i + 1];
    segments.push([end - start, tokenizer.decode(tokens.slice(start, end))]);
  }
  return segments;
}
