import type { ExecutorGoal, ExecutorGoalRunRequest } from '../executor/IExecutor';

export const GOAL_USAGE = [
  '/goal - Show the current Codex goal',
  '/goal [--budget <tokens>] <objective> - Start a native goal',
  '/goal pause - Pause the goal and stop its current work',
  '/goal resume [--budget <tokens>] - Resume the existing goal',
  '/goal clear - Remove the goal and stop its current work',
].join('\n');

export type GoalCommand =
  | { kind: 'show' | 'pause' | 'clear' | 'help' }
  | { kind: 'run'; request: ExecutorGoalRunRequest }
  | { kind: 'invalid'; error: string };

/** Parse before approval/input routing so control commands never answer a tool prompt. */
export function parseGoalCommand(content: string): GoalCommand | undefined {
  const match = /^\/goal(?:\s+([\s\S]*))?$/.exec(content.trim());
  if (!match) return undefined;
  const argument = (match[1] ?? '').trim();
  if (!argument || argument === 'status') return { kind: 'show' };
  if (argument === 'pause' || argument === 'clear' || argument === 'help') return { kind: argument };

  const resume = /^resume(?:\s|$)/.test(argument);
  let objective = resume ? argument.slice('resume'.length).trim() : argument;
  let tokenBudget: number | undefined;
  if (/^--budget(?:\s|$)/.test(objective)) {
    const budget = /^--budget\s+([0-9]+)(?:\s+([\s\S]*))?$/.exec(objective);
    if (!budget || !Number.isSafeInteger(Number(budget[1])) || Number(budget[1]) <= 0) {
      return { kind: 'invalid', error: 'Goal token budget must be a positive safe integer.\n' + GOAL_USAGE };
    }
    tokenBudget = Number(budget[1]);
    objective = (budget[2] ?? '').trim();
  }
  if (resume) {
    if (objective) return { kind: 'invalid', error: 'Resume does not accept a new objective.\n' + GOAL_USAGE };
    return { kind: 'run', request: tokenBudget === undefined ? {} : { tokenBudget } };
  }
  if (!objective || objective.startsWith('--') || /^(?:pause|clear|status|help)(?:\s|$)/.test(objective)) {
    return { kind: 'invalid', error: 'Invalid goal command.\n' + GOAL_USAGE };
  }
  if (Array.from(objective).length > 4000) {
    return { kind: 'invalid', error: 'Goal objectives must contain at most 4,000 characters.' };
  }
  return { kind: 'run', request: { objective, ...(tokenBudget === undefined ? {} : { tokenBudget }) } };
}

export function formatGoal(goal: ExecutorGoal | null): string {
  if (!goal) return 'No Codex goal is set for this thread.\n\n' + GOAL_USAGE;
  return [
    'Codex goal',
    `Objective: ${goal.objective}`,
    `Status: ${goal.status}`,
    `Tokens used: ${goal.tokensUsed}${goal.tokenBudget === null ? ' (no explicit budget)' : ` / ${goal.tokenBudget}`}`,
    `Active time: ${goal.timeUsedSeconds}s`,
    '', GOAL_USAGE,
  ].join('\n');
}
