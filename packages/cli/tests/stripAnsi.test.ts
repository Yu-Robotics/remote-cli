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

  describe('color codes', () => {
    it('should strip red color code', () => {
      expect(stripAnsi('\x1B[31mRed Text\x1B[0m')).toBe('Red Text');
    });

    it('should strip green color code', () => {
      expect(stripAnsi('\x1B[32mGreen Text\x1B[0m')).toBe('Green Text');
    });

    it('should strip yellow color code', () => {
      expect(stripAnsi('\x1B[33mYellow Text\x1B[0m')).toBe('Yellow Text');
    });

    it('should strip blue color code', () => {
      expect(stripAnsi('\x1B[34mBlue Text\x1B[0m')).toBe('Blue Text');
    });

    it('should strip magenta color code', () => {
      expect(stripAnsi('\x1B[35mMagenta Text\x1B[0m')).toBe('Magenta Text');
    });

    it('should strip cyan color code', () => {
      expect(stripAnsi('\x1B[36mCyan Text\x1B[0m')).toBe('Cyan Text');
    });

    it('should strip white color code', () => {
      expect(stripAnsi('\x1B[37mWhite Text\x1B[0m')).toBe('White Text');
    });

    it('should strip bright color codes', () => {
      expect(stripAnsi('\x1B[91mBright Red\x1B[0m')).toBe('Bright Red');
      expect(stripAnsi('\x1B[92mBright Green\x1B[0m')).toBe('Bright Green');
    });
  });

  describe('formatting codes', () => {
    it('should strip bold code', () => {
      expect(stripAnsi('\x1B[1mBold Text\x1B[0m')).toBe('Bold Text');
    });

    it('should strip dim code', () => {
      expect(stripAnsi('\x1B[2mDim Text\x1B[0m')).toBe('Dim Text');
    });

    it('should strip italic code', () => {
      expect(stripAnsi('\x1B[3mItalic Text\x1B[0m')).toBe('Italic Text');
    });

    it('should strip underline code', () => {
      expect(stripAnsi('\x1B[4mUnderlined Text\x1B[0m')).toBe('Underlined Text');
    });

    it('should strip blink code', () => {
      expect(stripAnsi('\x1B[5mBlink Text\x1B[0m')).toBe('Blink Text');
    });

    it('should strip reverse/inverse code', () => {
      expect(stripAnsi('\x1B[7mReverse Text\x1B[0m')).toBe('Reverse Text');
    });

    it('should strip hidden code', () => {
      expect(stripAnsi('\x1B[8mHidden Text\x1B[0m')).toBe('Hidden Text');
    });

    it('should strip strikethrough code', () => {
      expect(stripAnsi('\x1B[9mStrikethrough Text\x1B[0m')).toBe('Strikethrough Text');
    });
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
