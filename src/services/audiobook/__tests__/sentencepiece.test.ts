import * as fs from 'fs';
import * as path from 'path';
import { SentencePieceProcessor } from '../pocketTTS/sentencepiece';

const FIXTURES = path.join(__dirname, 'fixtures');

describe('SentencePieceProcessor', () => {
  const modelBytes = new Uint8Array(
    fs.readFileSync(path.join(FIXTURES, 'tokenizer.model')),
  );
  const parity: Array<{ text: string; ids: number[]; decoded: string }> =
    JSON.parse(
      fs.readFileSync(path.join(FIXTURES, 'tokenizerParity.json'), 'utf8'),
    );
  const sp = new SentencePieceProcessor(modelBytes);

  it('loads the Pocket TTS vocabulary', () => {
    expect(sp.vocabSize).toBe(4000);
  });

  it.each(parity.map(p => [p.text, p] as const))(
    'encodes %j identically to Python sentencepiece',
    (_text, fixture) => {
      expect(sp.encode(fixture.text)).toEqual(fixture.ids);
    },
  );

  it.each(parity.map(p => [p.text, p] as const))(
    'decodes %j identically to Python sentencepiece',
    (_text, fixture) => {
      expect(sp.decode(fixture.ids)).toEqual(fixture.decoded);
    },
  );
});
