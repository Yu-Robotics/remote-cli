/**
 * File Read Intent Detection
 *
 * Detects when a user message indicates intent to read/view a file,
 * and injects a system hint telling Claude Code to show only the
 * first 50 lines by default. This optimizes mobile (Feishu) experience
 * by reducing token usage and response length.
 *
 * Users can bypass with `--full` or `全部显示` markers.
 *
 * @example
 * processFileReadContent('读取 config.ts')
 * // Returns: '读取 config.ts\n\n[System hint: ...]'
 *
 * processFileReadContent('读取 config.ts --full')
 * // Returns: '读取 config.ts' (no hint, marker stripped)
 *
 * processFileReadContent('fix the bug')
 * // Returns: 'fix the bug' (unchanged)
 */

const CHINESE_KEYWORDS = /读取|查看|看看|展示|显示|打开文件|文件内容|看下|看一下/
const ENGLISH_PHRASES = /\b(?:read|show|view|display|open|print)\s+(?:the\s+)?file\b|\bshow\s+me\b|\bcat\s+\S/i
const FILE_EXTENSION = /\S+\.\w{1,5}\b/
const ACTION_VERB = /读|看|查|show|read|cat|view|display|open|print/i
const SKIP_MARKER = /--full/i
const SKIP_MARKER_CN = /全部显示/

const SYSTEM_HINT = '[System hint: For files exceeding 50 lines, show only the first 50 lines by default with a summary of remaining content. Ask the user if they want to see more.]'

/**
 * Remove skip markers (--full, 全部显示) from content
 */
function stripSkipMarkers(content: string): string {
  return content
    .replace(SKIP_MARKER, '')
    .replace(SKIP_MARKER_CN, '')
    .trim()
}

/**
 * Check if content contains skip markers (--full or 全部显示)
 *
 * @param content User message content
 * @returns true if content contains skip markers
 */
export function shouldSkipHint(content: string): boolean {
  if (!content) {
    return false
  }
  return SKIP_MARKER.test(content) || SKIP_MARKER_CN.test(content)
}

/**
 * Detect if user message indicates intent to read/view a file
 *
 * Matches three categories:
 * 1. Chinese keywords (读取, 查看, 看看, etc.)
 * 2. English phrases (read file, show me, cat, etc.)
 * 3. File path + action verb combo (show src/index.ts, 看 config.yaml)
 *
 * @param content User message content
 * @returns true if file-reading intent is detected
 */
export function hasFileReadIntent(content: string): boolean {
  if (!content) {
    return false
  }

  if (CHINESE_KEYWORDS.test(content)) {
    return true
  }

  if (ENGLISH_PHRASES.test(content)) {
    return true
  }

  if (FILE_EXTENSION.test(content) && ACTION_VERB.test(content)) {
    return true
  }

  return false
}

/**
 * Append system hint to content for file-reading requests
 *
 * @param content User message content
 * @returns Content with system hint appended
 */
export function injectFileReadHint(content: string): string {
  if (!content) {
    return ''
  }
  return `${content}\n\n${SYSTEM_HINT}`
}

/**
 * Process content for file-reading intent detection
 *
 * Orchestrates the full flow:
 * 1. If skip markers present → strip them, return cleaned content (no hint)
 * 2. If file-reading intent detected → inject hint
 * 3. Otherwise → return content unchanged
 *
 * @param content User message content
 * @returns Processed content (with hint injected, markers stripped, or unchanged)
 */
export function processFileReadContent(content: string): string {
  if (!content) {
    return content
  }

  if (shouldSkipHint(content)) {
    return stripSkipMarkers(content)
  }

  if (hasFileReadIntent(content)) {
    return injectFileReadHint(content)
  }

  return content
}
