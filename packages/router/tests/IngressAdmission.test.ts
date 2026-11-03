import { afterEach, describe, expect, it, vi } from 'vitest';
import { IngressAdmission, INGRESS_LIMITS, PendingFrameBudget } from '../src/security/IngressAdmission';

afterEach(() => vi.useRealTimers());
describe('bounded ingress admission', () => {
  it('allows NAT reconnect bursts and independently bounds each peer and the global pending set', () => {
    const guard = new IngressAdmission();
    const leases = Array.from({ length: 64 }, () => guard.admit('192.0.2.1')!);
    expect(leases.every(Boolean)).toBe(true);
    expect(guard.admit('192.0.2.1')).toBeUndefined();
    for (let peer = 2; peer <= 8; peer++) for (let n = 0; n < 64; n++) {
      expect(guard.admit(`192.0.2.${peer}`)).toBeDefined();
    }
    expect(guard.admit('198.51.100.1')).toBeUndefined();
    leases[0].release(); leases[0].release();
    expect(guard.admit('198.51.100.1')).toBeDefined();
    expect(guard.admit('198.51.100.2')).toBeUndefined();
  });
  it('limits churn even after release and resets rate budgets only after expiry', () => {
    vi.useFakeTimers();
    const guard = new IngressAdmission();
    for (let n = 0; n < 256; n++) guard.admit('192.0.2.1')!.release();
    expect(guard.admit('192.0.2.1')).toBeUndefined();
    vi.advanceTimersByTime(60_000);
    expect(guard.admit('192.0.2.1')).toBeDefined();
  });
  it('keeps a fixed deadline and bounds size, rate and total messages', () => {
    vi.useFakeTimers();
    const guard = new IngressAdmission();
    const size = guard.admit('size')!;
    expect(size.receive(INGRESS_LIMITS.preauthBytes + 1)).toBe(false);
    const rate = guard.admit('rate')!;
    for (let i = 0; i < 16; i++) expect(rate.receive(0)).toBe(true);
    expect(rate.receive(0)).toBe(false);
    const total = guard.admit('total')!;
    for (let i = 0; i < 64; i++) {
      vi.advanceTimersByTime(100);
      expect(total.receive(1)).toBe(true);
    }
    expect(total.receive(1)).toBe(false);
    vi.advanceTimersByTime(30_000);
    expect(total.active()).toBe(false);
    expect(total.receive(0)).toBe(false);
    total.release(); expect(total.active()).toBe(false);
  });
  it('does not let a rejected peer spend other peers global connection or binding allowances', () => {
    const guard = new IngressAdmission();
    for (let i = 0; i < INGRESS_LIMITS.connectionsPerPeerMinute; i++) {
      guard.admit('192.0.2.1')!.release();
    }
    for (let i = 0; i < INGRESS_LIMITS.bindingsPerPeer; i++) {
      expect(guard.bindingPeer('192.0.2.1')).toBe(true);
    }
    for (let i = 0; i < INGRESS_LIMITS.bindings; i++) {
      expect(guard.admit('192.0.2.1')).toBeUndefined();
      expect(guard.bindingPeer('192.0.2.1')).toBe(false);
    }
    const unrelated = guard.admit('198.51.100.1');
    expect(unrelated).toBeDefined();
    unrelated!.release();
    expect(guard.bindingPeer('198.51.100.1')).toBe(true);
  });
  it('bounds binding peers, targets, global attempts and live counter state without eviction', () => {
    vi.useFakeTimers();
    const guard = new IngressAdmission();
    for (let i = 0; i < 128; i++) expect(guard.bindingPeer('192.0.2.1')).toBe(true);
    expect(guard.bindingPeer('192.0.2.1')).toBe(false);
    for (let i = 0; i < 3; i++) expect(guard.bindingDevice('device')).toBe(true);
    expect(guard.bindingDevice('device')).toBe(false);
    for (let i = 0; i < 10_000; i++) guard.bindingDevice(`device-${i}`);
    expect((guard as any).rates.entries.size).toBe(8192);
    expect(guard.bindingDevice('new-target')).toBe(false);
    expect(guard.bindingDevice('device')).toBe(false);
    vi.advanceTimersByTime(300_000);
    expect(guard.bindingDevice('device')).toBe(true);
    const global = new IngressAdmission();
    for (let i = 0; i < 4096; i++) expect(global.bindingPeer(`peer-${i}`)).toBe(true);
    expect(global.bindingPeer('another-peer')).toBe(false);
  });
});

describe('preauthentication wire frame budget', () => {
  it('counts coalesced and split frame headers without retaining payload bytes', () => {
    const take = vi.fn(() => true);
    const frames = new PendingFrameBudget(take);
    const wire = Buffer.from([0x01, 0x82, 0, 0, 0, 0, 65, 66, 0x80, 0x80, 0, 0, 0, 0]);
    for (const byte of wire) expect(frames.receive(Buffer.from([byte]))).toBe(true);
    expect(take.mock.calls).toEqual([[2], [0]]);
    expect(frames.receive(wire)).toBe(true);
    expect(take).toHaveBeenCalledTimes(4);
  });
  it.each([126, 127])('checks extended payload lengths before payload arrival (%s)', marker => {
    const take = vi.fn(() => true);
    const frames = new PendingFrameBudget(take);
    const header = Buffer.alloc(marker === 126 ? 8 : 14);
    header[0] = 0x81; header[1] = 128 | marker;
    if (marker === 126) header.writeUInt16BE(16_385, 2); else header.writeBigUInt64BE(2n ** 63n, 2);
    expect(frames.receive(header)).toBe(false); expect(take).not.toHaveBeenCalled();
  });
  it('refuses a wire frame when its budget is exhausted', () => {
    const frames = new PendingFrameBudget(() => false);
    expect(frames.receive(Buffer.from([0x89, 0]))).toBe(false);
  });
});
