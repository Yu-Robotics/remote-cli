import { describe, it, expect } from 'vitest';
import { stripAnsi } from '../src/utils/stripAnsi';

describe('stripAnsi', () => {
  describe('basic functionality', () => {
    it('should return empty string for empty input', () => {
      expect(stripAnsi('')).toBe('');
    });

    it('should return null for null input', () => {
      expect(stripAnsi(null as unknown as string)).toBe(null);
    });

    it('should return undefined for undefined input', () => {
      expect(stripAnsi(undefined as unknown as string)).toBe(undefined);
    });

    it('should return text unchanged if no ANSI codes', () => {
      expect(stripAnsi('Hello World')).toBe('Hello World');
    });

    it('should preserve whitespace', () => {
      expect(stripAnsi('  hello  world  ')).toBe('  hello  world  ');
    });

    it('should preserve newlines', () => {
      expect(stripAnsi('line1\nline2\nline3')).toBe('line1\nline2\nline3');
    });
  });

  it.each([
    ['foreground', [31, 32, 33, 34, 35, 36, 37]],
    ['bright foreground', [91, 92]],
    ['style', [1, 2, 3, 4, 5, 7, 8, 9]],
  ] as const)('strips %s SGR parameters and preserves the enclosed text', (_group, codes) => {
    for (const code of codes) {
      expect(stripAnsi(`\x1b[${code}mText\x1b[0m`)).toBe('Text');
    }
  });

  describe('combined codes', () => {
    it('should strip multiple color codes in a row', () => {
      expect(stripAnsi('\x1B[31m\x1B[1mRed Bold\x1B[0m')).toBe('Red Bold');
    });

    it('should strip combined parameter codes', () => {
      expect(stripAnsi('\x1B[1;31mBold Red\x1B[0m')).toBe('Bold Red');
    });

    it('should strip multiple combined codes', () => {
      expect(stripAnsi('\x1B[1;4;31mBold Underline Red\x1B[0m')).toBe('Bold Underline Red');
    });

    it('should handle text with mixed ANSI and plain content', () => {
      expect(stripAnsi('Hello \x1B[31mRed\x1B[0m World')).toBe('Hello Red World');
    });

    it('should handle multiple color sections', () => {
      expect(stripAnsi('\x1B[31mRed\x1B[0m and \x1B[32mGreen\x1B[0m')).toBe('Red and Green');
    });
  });

  describe('background colors', () => {
    it('should strip background color codes', () => {
      expect(stripAnsi('\x1B[41mRed Background\x1B[0m')).toBe('Red Background');
      expect(stripAnsi('\x1B[42mGreen Background\x1B[0m')).toBe('Green Background');
      expect(stripAnsi('\x1B[43mYellow Background\x1B[0m')).toBe('Yellow Background');
    });

    it('should strip bright background color codes', () => {
      expect(stripAnsi('\x1B[101mBright Red BG\x1B[0m')).toBe('Bright Red BG');
      expect(stripAnsi('\x1B[102mBright Green BG\x1B[0m')).toBe('Bright Green BG');
    });

    it('should strip combined foreground and background', () => {
      expect(stripAnsi('\x1B[31;42mRed on Green\x1B[0m')).toBe('Red on Green');
    });
  });

  describe('reset codes', () => {
    it('should strip simple reset code', () => {
      expect(stripAnsi('\x1B[0m')).toBe('');
    });

    it('should strip reset at different positions', () => {
      expect(stripAnsi('\x1B[0mStart')).toBe('Start');
      expect(stripAnsi('End\x1B[0m')).toBe('End');
      expect(stripAnsi('Mid\x1B[0mdle')).toBe('Middle');
    });
  });

  describe('cursor and screen codes', () => {
    it('should strip cursor movement codes', () => {
      expect(stripAnsi('\x1B[1A')).toBe(''); // Move up
      expect(stripAnsi('\x1B[2B')).toBe(''); // Move down
      expect(stripAnsi('\x1B[3C')).toBe(''); // Move forward
      expect(stripAnsi('\x1B[4D')).toBe(''); // Move backward
    });

    it('should strip cursor position codes', () => {
      expect(stripAnsi('\x1B[10;20H')).toBe(''); // Set position
      expect(stripAnsi('\x1B[5;10f')).toBe(''); // Set position (alternate)
    });

    it('should strip erase codes', () => {
      expect(stripAnsi('\x1B[2J')).toBe(''); // Clear screen
      expect(stripAnsi('\x1B[K')).toBe(''); // Clear line
    });
  });

  describe('real-world examples', () => {
    it('should handle npm output style', () => {
      const input = '\x1B[32m+\x1B[39m \x1B[32mpackage@1.0.0\x1B[39m';
      expect(stripAnsi(input)).toBe('+ package@1.0.0');
    });

    it('should handle vitest output style', () => {
      const input = '[7m[1m[36m RUN [39m[22m[27m';
      // Note: This format uses [ without ESC prefix, so only ESC sequences are stripped
      expect(stripAnsi(input)).toBe('[7m[1m[36m RUN [39m[22m[27m');
    });

    it('should handle actual ANSI vitest output', () => {
      const input = '\x1B[7m\x1B[1m\x1B[36m RUN \x1B[39m\x1B[22m\x1B[27m';
      expect(stripAnsi(input)).toBe(' RUN ');
    });

    it('should handle git status output', () => {
      const input = '\x1B[31mmodified:   file.txt\x1B[0m';
      expect(stripAnsi(input)).toBe('modified:   file.txt');
    });

    it('should handle complex terminal output', () => {
      const input = '\x1B[1m\x1B[32m✓\x1B[39m\x1B[22m tests/example.test.ts \x1B[2m(5 tests)\x1B[22m';
      expect(stripAnsi(input)).toBe('✓ tests/example.test.ts (5 tests)');
    });

    it('should handle error output with colors', () => {
      const input = '\x1B[31mError:\x1B[0m Something went \x1B[33mwrong\x1B[0m';
      expect(stripAnsi(input)).toBe('Error: Something went wrong');
    });
  });

  describe('DEC private mode sequences', () => {
    it('should strip synchronized update mode', () => {
      expect(stripAnsi('\x1B[?2026hHello')).toBe('Hello');
      expect(stripAnsi('\x1B[?2026lWorld')).toBe('World');
    });

    it('should strip cursor visibility sequences', () => {
      expect(stripAnsi('\x1B[?25hVisible')).toBe('Visible');
      expect(stripAnsi('\x1B[?25lHidden')).toBe('Hidden');
    });

    it('should strip alternate screen buffer', () => {
      expect(stripAnsi('\x1B[?1049hContent\x1B[?1049l')).toBe('Content');
    });

    it('should strip bracketed paste mode', () => {
      expect(stripAnsi('\x1B[?2004hPaste\x1B[?2004l')).toBe('Paste');
    });
  });

  describe('OSC sequences', () => {
    it('should strip window title sequences (BEL terminated)', () => {
      expect(stripAnsi('\x1B]0;My Title\x07Content')).toBe('Content');
    });

    it('should strip window title sequences (ST terminated)', () => {
      expect(stripAnsi('\x1B]0;My Title\x1B\\Content')).toBe('Content');
    });

    it('should strip hyperlink sequences', () => {
      expect(stripAnsi('\x1B]8;;https://example.com\x07Link\x1B]8;;\x07')).toBe('Link');
    });
  });

  describe('charset sequences', () => {
    it('should strip charset selection sequences', () => {
      expect(stripAnsi('\x1B(BText')).toBe('Text');
      expect(stripAnsi('\x1B(0Line\x1B(B')).toBe('Line');
    });
  });

  describe('Claude Code TUI rendering', () => {
    it('preserves all visible characters in a styled TUI header', () => {
      // Simulated TUI output with private mode + colors
      const tui = '\x1B[?2026h\x1B[32m▐▛███▜▌\x1B[1mClaude Code\x1B[0mv2.1.59';
      const result = stripAnsi(tui);
      expect(result).toBe('▐▛███▜▌Claude Codev2.1.59');
    });

    it('should strip mixed escape sequences from TUI prompt line', () => {
      const promptLine = '\x1B[?25l\x1B[36m❯\x1B[0m Try "create a util logging.py..."';
      const result = stripAnsi(promptLine);
      expect(result).toBe('❯ Try "create a util logging.py..."');
    });
  });

  describe('edge cases', () => {
    it('should handle incomplete ANSI sequences', () => {
      // These are malformed and should be left as-is or partially stripped
      expect(stripAnsi('\x1B[')).toBe('\x1B[');
      expect(stripAnsi('\x1B[31')).toBe('\x1B[31');
    });

    it('should handle ANSI codes without text', () => {
      expect(stripAnsi('\x1B[31m\x1B[0m')).toBe('');
    });

    it('should handle very long parameter sequences', () => {
      expect(stripAnsi('\x1B[38;2;255;100;50mTrueColor\x1B[0m')).toBe('TrueColor');
    });

    it('should handle unicode content with ANSI codes', () => {
      expect(stripAnsi('\x1B[32m你好世界\x1B[0m')).toBe('你好世界');
      expect(stripAnsi('\x1B[31m🎉 Success!\x1B[0m')).toBe('🎉 Success!');
    });

    it('should handle tab characters with ANSI codes', () => {
      expect(stripAnsi('\x1B[32m\tIndented\x1B[0m')).toBe('\tIndented');
    });
  });
});
