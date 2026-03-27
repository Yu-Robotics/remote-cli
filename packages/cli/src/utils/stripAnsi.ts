/**
 * Strip ANSI escape sequences from a string
 *
 * Handles all modern terminal escape sequences including:
 * - CSI sequences: \x1B[...X  (colors, cursor, formatting)
 * - DEC private modes: \x1B[?...X  (e.g., \x1B[?2026h synchronized update)
 * - OSC sequences: \x1B]...BEL or \x1B]...\x1B\\  (title, hyperlinks)
 * - Charset sequences: \x1B(X, \x1B)X  (character set selection)
 * - Single-char ESC sequences: \x1Bc, \x1B=, \x1B>, etc.
 *
 * @param text Text that may contain ANSI escape sequences
 * @returns Text with ANSI escape sequences removed
 *
 * @example
 * stripAnsi('\x1B[31mRed Text\x1B[0m') // Returns: "Red Text"
 * stripAnsi('\x1B[?2026hHello')         // Returns: "Hello"
 */
export function stripAnsi(text: string): string {
  if (!text) {
    return text;
  }

  return text
    // OSC sequences: ESC ] ... (terminated by BEL or ST)
    .replace(/\x1B\][^\x07\x1B]*(?:\x07|\x1B\\)/g, '')
    // CSI sequences: ESC [ (with optional ? > = intermediates) params finalByte
    .replace(/\x1B\[[?>=!]?[0-9;]*[ -/]*[A-Za-z@-~]/g, '')
    // Charset sequences: ESC ( X  or  ESC ) X
    .replace(/\x1B[()][A-Za-z0-9]/g, '')
    // Other single-character ESC sequences: ESC followed by one char in [=>Nc7-~]
    .replace(/\x1B[=>Nc78DMHEFGIJKLMOPQRSTUVWXYZdefgh\x7f]/g, '');
}
