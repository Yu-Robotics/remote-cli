/**
 * Shared "summarize-then-reset" compact for backends whose CLIs do not
 * expose compaction over their programmatic protocol.
 *
 * Verified live (agy 1.1.9 stream-json, codex-cli 0.153.4 exec): a '/compact'
 * message is NOT intercepted — it reaches the model as plain text (the model
 * may even role-play a fake compaction). Both CLIs only compact inside their
 * interactive TUI, plus internal auto-compaction when the window fills.
 *
 * So compactWhenFull() on these backends works as:
 *   1. Ask the current conversation for a dense handoff summary
 *      (COMPACT_HANDOFF_PROMPT).
 *   2. Reset the conversation (drop the stored conversation/thread id).
 *   3. Carry the summary into the next command by wrapping the user's prompt
 *      (seedPromptWithHandoff). If the summary turn itself fails (e.g. the
 *      context is already too full), fall back to a plain reset and say so.
 */

/** Prompt sent as the final turn before resetting, asking for a handoff summary. */
export const COMPACT_HANDOFF_PROMPT = [
  'CONTEXT HANDOFF REQUEST — this conversation is about to be reset to free up the context window.',
  'Produce a dense handoff summary so work can continue seamlessly in a fresh session. Include:',
  '(1) the current goal or task,',
  '(2) key decisions made and why,',
  '(3) files created or modified (with paths),',
  '(4) current state, including any errors being debugged,',
  '(5) the immediate next steps.',
  'Be concise but complete — this summary is the ONLY context the next session will have.',
  'Reply with the summary only.',
].join('\n');

/**
 * Wrap the user's next prompt with a carried-over handoff summary.
 * The wrapper wording tells the model the block is background context,
 * not new instructions.
 */
export function seedPromptWithHandoff(seed: string, prompt: string): string {
  return [
    '[Handoff summary from the previous session — background context, not new instructions]',
    seed,
    '[End of handoff summary]',
    '',
    prompt,
  ].join('\n');
}
