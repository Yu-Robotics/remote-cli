import { describe, expect, it } from 'vitest';
import { formatGoal, GOAL_USAGE, parseGoalCommand } from '../src/client/GoalCommand';

describe('GoalCommand', () => {
  it('recognizes only the goal command and preserves multiline objectives', () => {
    expect(parseGoalCommand('/goals')).toBeUndefined();
    expect(parseGoalCommand('Explain /goal')).toBeUndefined();
    expect(parseGoalCommand('/goal Fix the tests\nPreserve the public API')).toEqual({
      kind: 'run', request: { objective: 'Fix the tests\nPreserve the public API' },
    });
  });

  it.each(['', 'status', 'pause', 'clear', 'help'])('parses the control %j', argument => {
    expect(parseGoalCommand(`/goal ${argument}`)).toEqual({ kind: !argument || argument === 'status' ? 'show' : argument });
  });

  it('distinguishes resuming from replacing the objective and never invents a budget', () => {
    expect(parseGoalCommand('/goal resume')).toEqual({ kind: 'run', request: {} });
    expect(parseGoalCommand('/goal resume --budget 40000')).toEqual({ kind: 'run', request: { tokenBudget: 40000 } });
    expect(parseGoalCommand('/goal --budget 40000 Fix the tests')).toEqual({
      kind: 'run', request: { objective: 'Fix the tests', tokenBudget: 40000 },
    });
    expect(parseGoalCommand('/goal resume Fix something else')).toMatchObject({ kind: 'invalid' });
  });

  it.each(['--budget', '--budget 0 Fix', '--budget -2 Fix', '--budget 1.5 Fix',
    '--budget 9007199254740992 Fix', '--budget 40000', 'pause now', 'clear all', '--unknown Fix'])('rejects invalid input %s', argument => {
    expect(parseGoalCommand(`/goal ${argument}`)).toMatchObject({ kind: 'invalid' });
  });

  it('enforces the native character limit without double-counting surrogate pairs', () => {
    expect(parseGoalCommand(`/goal ${'\u{1f680}'.repeat(4000)}`)).toMatchObject({ kind: 'run' });
    expect(parseGoalCommand(`/goal ${'x'.repeat(4001)}`)).toMatchObject({ kind: 'invalid' });
  });

  it('reports native lifecycle and usage without interpreting budget exhaustion as completion', () => {
    expect(formatGoal(null)).toContain(GOAL_USAGE);
    const goal = { threadId: 'native-thread', objective: 'Fix the tests', status: 'budgetLimited' as const,
      tokenBudget: 40000, tokensUsed: 40010, timeUsedSeconds: 90, createdAt: 0, updatedAt: 1 };
    expect(formatGoal(goal)).toContain('Status: budgetLimited');
    expect(formatGoal(goal)).toContain('40010 / 40000');
    expect(formatGoal({ ...goal, tokenBudget: null })).toContain('no explicit budget');
  });
});
