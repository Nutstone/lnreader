import { htmlToText } from '../htmlToText';

describe('htmlToText', () => {
  it('strips tags and preserves paragraph breaks', () => {
    const html = '<p>First paragraph.</p><p>Second paragraph.</p>';
    expect(htmlToText(html)).toBe('First paragraph.\n\nSecond paragraph.');
  });

  it('drops script and style content', () => {
    const html =
      '<style>.a{color:red}</style><p>Text</p><script>alert(1)</script>';
    expect(htmlToText(html)).toBe('Text');
  });

  it('decodes entities and normalizes non-breaking spaces', () => {
    const html = '<p>Sword&nbsp;&amp;&nbsp;Shield</p>';
    expect(htmlToText(html)).toBe('Sword & Shield');
  });

  it('treats <br> as a line break', () => {
    const html = '<p>Line one<br>Line two</p>';
    expect(htmlToText(html)).toBe('Line one\n\nLine two');
  });

  it('collapses runs of blank lines', () => {
    const html = '<div><p></p><p></p><p>Content</p></div>';
    expect(htmlToText(html)).toBe('Content');
  });

  it('returns plain text unchanged', () => {
    expect(htmlToText('Just plain text.')).toBe('Just plain text.');
  });
});
