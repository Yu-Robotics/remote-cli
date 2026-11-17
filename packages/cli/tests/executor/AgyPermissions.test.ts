import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgyPermissions } from '../../src/executor/agy/AgyPermissions';
const choices = [{ kind: 'allow_once' as const, optionId: 'yes' }, { kind: 'reject_once' as const, optionId: 'no' },
  { kind: 'allow_always' as const, optionId: 'always' }];
afterEach(() => vi.useRealTimers());
describe('AGY local approval lifecycle', () => {
  it('auto-allows only a current tool request and never grants always', async () => {
    const p = new AgyPermissions();
    expect(await p.request('tool', choices, {}, true)).toBe(0);
    expect(await p.request('tool', choices, undefined, true)).toBe(-1);
    expect(await p.request('tool', [choices[2]], {}, true)).toBe(-1);
  });
  it.each(['approve', 'deny'] as const)('routes a current card %s and rejects stale identity', async action => {
    const p = new AgyPermissions(), card = vi.fn(() => true), resolved = vi.fn(), text = vi.fn();
    const pending = p.request('synthetic tool', choices, { onApprovalRequest: card, onApprovalResolved: resolved, onStream: text }, false);
    const request = card.mock.calls[0][0] as any;
    expect(request.canRemember).toBe(false); expect(text).not.toHaveBeenCalled();
    expect(p.respond('stale', action)).toBe(false);
    expect(p.respond(request.requestId, action)).toBe(true);
    expect(await pending).toBe(action === 'approve' ? 0 : 1);
    expect(resolved).toHaveBeenCalledWith(request.requestId, action === 'approve' ? 'approved' : 'denied');
    expect(p.waiting).toBe(false);
  });
  it.each(['yes', 'no', 'cancel', 'skip'])('supports text fallback %s', async input => {
    const p = new AgyPermissions(), text = vi.fn();
    const pending = p.request('tool', choices, { onApprovalRequest: () => false, onStream: text }, false);
    expect(text).toHaveBeenCalled(); expect(p.input('always')).toBe(false); expect(p.input('unknown')).toBe(false);
    expect(p.input(input)).toBe(true); expect(await pending).toBe(input === 'yes' ? 0 : input === 'no' ? 1 : -1);
  });
  it('does not auto-answer native questions and validates the selected option', async () => {
    const p = new AgyPermissions();
    const pending = p.request('Choose', [{ kind: 'allow_once', optionId: 'q0_yes', name: 'First' }], {}, true);
    expect(p.waiting).toBe(true); expect(p.input('2')).toBe(false); expect(p.input('First')).toBe(true); expect(await pending).toBe(0);
  });
  it('cancels the prior request on replacement, abort/disconnect, and timeout', async () => {
    vi.useFakeTimers(); const p = new AgyPermissions();
    const first = p.request('one', choices, {}, false), second = p.request('two', choices, {}, false);
    expect(await first).toBe(-1); p.cancel(); expect(await second).toBe(-1);
    const third = p.request('three', choices, {}, false); await vi.advanceTimersByTimeAsync(120_000);
    expect(await third).toBe(-1); expect(p.input('yes')).toBe(false);
  });
});
