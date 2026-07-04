/**
 * Minimal SentencePiece (unigram) tokenizer.
 *
 * Parses the binary `tokenizer.model` protobuf directly (only the
 * `pieces` field is needed) and implements Viterbi segmentation with
 * byte fallback. The Pocket TTS English tokenizer was verified to use
 * an identity normalizer with no precompiled charsmap, so the only
 * normalization required is the dummy-space prefix and the space→▁
 * substitution — which this implements exactly.
 */

/* eslint-disable no-bitwise -- binary protobuf/UTF-8 parsing */

const WHITESPACE_PIECE = '▁'; // ▁

const enum PieceType {
  Normal = 1,
  Unknown = 2,
  Control = 3,
  UserDefined = 4,
  Unused = 5,
  Byte = 6,
}

interface Piece {
  piece: string;
  score: number;
  type: PieceType;
}

export class SentencePieceProcessor {
  private pieces: Piece[];
  private pieceToId = new Map<string, number>();
  private byteToId = new Map<number, number>();
  private maxPieceLength = 1;
  private unkId = 0;
  private unkScore: number;

  constructor(modelBytes: Uint8Array) {
    this.pieces = parseModelProto(modelBytes);
    let minScore = 0;
    for (let id = 0; id < this.pieces.length; id++) {
      const entry = this.pieces[id];
      if (entry.type === PieceType.Byte) {
        // Byte pieces look like "<0x0A>"
        const value = parseInt(entry.piece.slice(3, 5), 16);
        this.byteToId.set(value, id);
        continue;
      }
      if (entry.type === PieceType.Unknown) {
        this.unkId = id;
        continue;
      }
      if (entry.type === PieceType.Control) {
        continue;
      }
      this.pieceToId.set(entry.piece, id);
      if (entry.piece.length > this.maxPieceLength) {
        this.maxPieceLength = entry.piece.length;
      }
      if (entry.score < minScore) {
        minScore = entry.score;
      }
    }
    this.unkScore = minScore - 10;
  }

  get vocabSize(): number {
    return this.pieces.length;
  }

  idToPiece(id: number): string {
    return this.pieces[id]?.piece ?? '';
  }

  /** Matches sentencepiece's Encode() for this model's settings. */
  encode(text: string): number[] {
    const normalized = this.normalize(text);
    if (!normalized) {
      return [];
    }
    return this.viterbi(normalized);
  }

  decode(ids: number[]): string {
    let out = '';
    let pendingBytes: number[] = [];
    const flushBytes = () => {
      if (pendingBytes.length) {
        out += utf8Decode(Uint8Array.from(pendingBytes));
        pendingBytes = [];
      }
    };
    for (const id of ids) {
      const entry = this.pieces[id];
      if (!entry) {
        continue;
      }
      if (entry.type === PieceType.Byte) {
        pendingBytes.push(parseInt(entry.piece.slice(3, 5), 16));
        continue;
      }
      flushBytes();
      if (
        entry.type === PieceType.Control ||
        entry.type === PieceType.Unknown
      ) {
        continue;
      }
      out += entry.piece;
    }
    flushBytes();
    out = out.split(WHITESPACE_PIECE).join(' ');
    return out.startsWith(' ') ? out.slice(1) : out;
  }

  private normalize(text: string): string {
    // add_dummy_prefix=true, escape_whitespaces=true, identity
    // normalizer, remove_extra_whitespaces=false.
    if (!text) {
      return '';
    }
    return (' ' + text).split(' ').join(WHITESPACE_PIECE);
  }

  private viterbi(text: string): number[] {
    const n = text.length;
    const bestScore = new Array<number>(n + 1).fill(-Infinity);
    const bestPrev = new Array<number>(n + 1).fill(-1);
    const bestIds = new Array<number[] | undefined>(n + 1);
    bestScore[0] = 0;

    for (let i = 0; i < n; i++) {
      if (bestScore[i] === -Infinity) {
        continue;
      }
      // Skip low surrogate positions — pieces are matched on whole
      // code points, and fallback consumes surrogate pairs together.
      const codePoint = text.codePointAt(i)!;
      const charLength = codePoint > 0xffff ? 2 : 1;

      const limit = Math.min(n, i + this.maxPieceLength);
      for (let j = i + 1; j <= limit; j++) {
        const id = this.pieceToId.get(text.slice(i, j));
        if (id === undefined) {
          continue;
        }
        const score = bestScore[i] + this.pieces[id].score;
        if (score > bestScore[j]) {
          bestScore[j] = score;
          bestPrev[j] = i;
          bestIds[j] = [id];
        }
      }

      // SentencePiece inserts a fallback (byte-piece / unk) node at a
      // position only when no single-codepoint piece exists there —
      // byte pieces score 0 and would otherwise beat real pieces.
      const singleChar = text.slice(i, i + charLength);
      if (!this.pieceToId.has(singleChar)) {
        const fallback = this.charFallback(singleChar);
        const fallbackScore = bestScore[i] + fallback.score;
        if (fallbackScore > bestScore[i + charLength]) {
          bestScore[i + charLength] = fallbackScore;
          bestPrev[i + charLength] = i;
          bestIds[i + charLength] = fallback.ids;
        }
      }
    }

    const ids: number[] = [];
    let pos = n;
    while (pos > 0) {
      const prev = bestPrev[pos];
      const segment = bestIds[pos];
      if (prev < 0 || !segment) {
        return [this.unkId];
      }
      for (let k = segment.length - 1; k >= 0; k--) {
        ids.push(segment[k]);
      }
      pos = prev;
    }
    ids.reverse();
    return ids;
  }

  private charFallback(char: string): { ids: number[]; score: number } {
    const bytes = utf8Encode(char);
    const ids: number[] = [];
    let score = 0;
    for (const byte of bytes) {
      const id = this.byteToId.get(byte);
      if (id === undefined) {
        return { ids: [this.unkId], score: this.unkScore };
      }
      ids.push(id);
      score += this.pieces[id].score;
    }
    return { ids, score };
  }
}

// ── Protobuf parsing (just ModelProto.pieces) ───────────────────

class ProtoReader {
  private bytes: Uint8Array;
  offset = 0;

  constructor(bytes: Uint8Array) {
    this.bytes = bytes;
  }

  get done(): boolean {
    return this.offset >= this.bytes.length;
  }

  varint(): number {
    let result = 0;
    let shift = 0;
    for (;;) {
      const byte = this.bytes[this.offset++];
      result += (byte & 0x7f) * 2 ** shift;
      if ((byte & 0x80) === 0) {
        return result;
      }
      shift += 7;
    }
  }

  bytesField(): Uint8Array {
    const length = this.varint();
    const view = this.bytes.subarray(this.offset, this.offset + length);
    this.offset += length;
    return view;
  }

  float32(): number {
    const value = new DataView(
      this.bytes.buffer,
      this.bytes.byteOffset + this.offset,
      4,
    ).getFloat32(0, true);
    this.offset += 4;
    return value;
  }

  skip(wire: number): void {
    switch (wire) {
      case 0:
        this.varint();
        return;
      case 1:
        this.offset += 8;
        return;
      case 2: {
        // Read the length BEFORE touching offset — `offset += varint()`
        // would snapshot offset before varint() advances it.
        const length = this.varint();
        this.offset += length;
        return;
      }
      case 5:
        this.offset += 4;
        return;
      default:
        throw new Error(`Unsupported protobuf wire type ${wire}`);
    }
  }
}

function parseModelProto(bytes: Uint8Array): Piece[] {
  const reader = new ProtoReader(bytes);
  const pieces: Piece[] = [];
  while (!reader.done) {
    const tag = reader.varint();
    const field = Math.floor(tag / 8);
    const wire = tag % 8;
    if (field === 1 && wire === 2) {
      pieces.push(parsePiece(reader.bytesField()));
    } else {
      reader.skip(wire);
    }
  }
  return pieces;
}

function parsePiece(bytes: Uint8Array): Piece {
  const reader = new ProtoReader(bytes);
  let piece = '';
  let score = 0;
  let type = PieceType.Normal;
  while (!reader.done) {
    const tag = reader.varint();
    const field = Math.floor(tag / 8);
    const wire = tag % 8;
    if (field === 1 && wire === 2) {
      piece = utf8Decode(reader.bytesField());
    } else if (field === 2 && wire === 5) {
      score = reader.float32();
    } else if (field === 3 && wire === 0) {
      type = reader.varint();
    } else {
      reader.skip(wire);
    }
  }
  return { piece, score, type };
}

// ── UTF-8 helpers ───────────────────────────────────────────────

export function utf8Encode(text: string): number[] {
  const out: number[] = [];
  for (let i = 0; i < text.length; i++) {
    let code = text.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length) {
      const low = text.charCodeAt(i + 1);
      if (low >= 0xdc00 && low <= 0xdfff) {
        code = (code - 0xd800) * 0x400 + (low - 0xdc00) + 0x10000;
        i++;
      }
    }
    if (code < 0x80) {
      out.push(code);
    } else if (code < 0x800) {
      out.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
    } else if (code < 0x10000) {
      out.push(
        0xe0 | (code >> 12),
        0x80 | ((code >> 6) & 0x3f),
        0x80 | (code & 0x3f),
      );
    } else {
      out.push(
        0xf0 | (code >> 18),
        0x80 | ((code >> 12) & 0x3f),
        0x80 | ((code >> 6) & 0x3f),
        0x80 | (code & 0x3f),
      );
    }
  }
  return out;
}

export function utf8Decode(bytes: Uint8Array): string {
  let out = '';
  let i = 0;
  while (i < bytes.length) {
    const b0 = bytes[i++];
    if (b0 < 0x80) {
      out += String.fromCharCode(b0);
    } else if (b0 < 0xe0) {
      out += String.fromCharCode(((b0 & 0x1f) << 6) | (bytes[i++] & 0x3f));
    } else if (b0 < 0xf0) {
      out += String.fromCharCode(
        ((b0 & 0x0f) << 12) | ((bytes[i++] & 0x3f) << 6) | (bytes[i++] & 0x3f),
      );
    } else {
      const code =
        ((b0 & 0x07) << 18) |
        ((bytes[i++] & 0x3f) << 12) |
        ((bytes[i++] & 0x3f) << 6) |
        (bytes[i++] & 0x3f);
      out += String.fromCodePoint(code);
    }
  }
  return out;
}
