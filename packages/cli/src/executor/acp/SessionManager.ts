import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

export interface SessionEntry {
  role: 'user' | 'assistant';
  text: string;
  ts: number;
}

/**
 * Persists Gemini conversation history as JSONL files for multi-turn context replay.
 *
 * Storage: ~/.remote-cli/gemini-sessions/{sessionId}.jsonl
 * Each line: {"role":"user"|"assistant","text":"...","ts":1234567890}
 *
 * ACP's session/resume is experimental, so we use history replay instead —
 * the same approach used by vibe-kanban.
 */
export class SessionManager {
  private baseDir: string;

  constructor(baseDir?: string) {
    this.baseDir = baseDir ?? path.join(os.homedir(), '.remote-cli', 'gemini-sessions');
    fs.mkdirSync(this.baseDir, { recursive: true });
  }

  private filePath(sessionId: string): string {
    return path.join(this.baseDir, `${sessionId}.jsonl`);
  }

  append(sessionId: string, role: 'user' | 'assistant', text: string): void {
    const entry: SessionEntry = { role, text, ts: Date.now() };
    fs.appendFileSync(this.filePath(sessionId), JSON.stringify(entry) + '\n', 'utf8');
  }

  /**
   * Build a context prefix that replays prior conversation history.
   * Returns empty string if no history exists yet.
   */
  buildResumeContext(sessionId: string): string {
    const file = this.filePath(sessionId);
    if (!fs.existsSync(file)) return '';

    const lines = fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean);
    if (lines.length === 0) return '';

    const entries: SessionEntry[] = lines.map((l) => JSON.parse(l) as SessionEntry);

    const formatted = entries
      .map((e) => (e.role === 'user' ? `[User]: ${e.text}` : `[Assistant]: ${e.text}`))
      .join('\n');

    return `=== PREVIOUS CONVERSATION ===\n${formatted}\n=== NEW REQUEST ===\n`;
  }

  clear(sessionId: string): void {
    const file = this.filePath(sessionId);
    if (fs.existsSync(file)) {
      fs.writeFileSync(file, '', 'utf8');
    }
  }

  /**
   * Truncate session history to the most recent `keepCount` entries.
   * Used by GeminiExecutor's compactWhenFull to reduce context size while
   * preserving recent conversation turns.
   *
   * @returns The number of entries removed.
   */
  truncate(sessionId: string, keepCount: number): number {
    const file = this.filePath(sessionId);
    if (!fs.existsSync(file)) return 0;

    const lines = fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean);
    if (lines.length <= keepCount) return 0;

    const kept = lines.slice(lines.length - keepCount);
    fs.writeFileSync(file, kept.join('\n') + '\n', 'utf8');
    return lines.length - keepCount;
  }

  remove(sessionId: string): void {
    const file = this.filePath(sessionId);
    if (fs.existsSync(file)) {
      fs.unlinkSync(file);
    }
  }
}
