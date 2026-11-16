#!/usr/bin/env python3
"""Version 2: independently check invocation-scoped MCP and exact explicit retirement; no native work."""
import argparse
import collections
import copy
import json
from pathlib import Path
import unittest


def verify(data):
    def check(value, description):
        if not value:
            raise AssertionError(description)
    check(not data.get('error'), 'native case failed')
    check(data.get('namespaceExitCode') == 0, 'namespace runner failed')
    cleanup = data['cleanup']
    check(cleanup['namespaceJoined'] and cleanup['disposableRootRemoved'], 'namespace/root cleanup incomplete')
    check(cleanup['fakeProviderClosed'], 'provider remained open')
    check(cleanup['nativeSurvivorsBeforeNamespaceExit'] == 0, 'native process survived local cleanup')
    check(all(row['code'] == 0 for row in cleanup['frontends']), 'frontend did not detach cleanly')
    check(all(row['groupAbsent'] or row['signal'] == 'SIGKILL' and cleanup['namespaceJoined'] for row in cleanup['nativeParents']), 'native process group not retired by local exit or joined namespace teardown')
    check(not data.get('unexpectedConnect') and not data.get('unexpectedEndpoints'), 'unexpected model traffic')
    check(data['pendingFakeActions'] == 0, 'unconsumed provider plan')
    begin, end = data['transitionStart'], data['transitionEnd']
    check(begin <= data['gapDeadlinePassed'] <= end, 'gap ordering invalid')
    check(not [r for r in data['provider'] if begin <= r['t'] <= end], 'lifecycle model request observed')
    check(not [r for r in data['nativeOperations'] if begin <= r['t'] <= end], 'lifecycle native operation observed')
    hold = [r for r in data['provider'] if r['action'].get('hold')]
    check(len(hold) == 1 and hold[0]['t'] < begin < end <= hold[0]['connectionClosedAt'], 'held original content did not span frontend replacement')
    snapshots = {r['label']: r for r in data['snapshots']}
    before, after = snapshots['before'], snapshots['attached']
    check(before['pid'] == after['pid'] and before['session'] == after['session'], 'native process/session changed')
    check(before['bridgeUrl'] == after['bridgeUrl'], 'native bridge endpoint changed')
    def ids(snapshot):
        return [(r['id'], r['nativeId']) for r in snapshot['definitions']]
    check(len(ids(before)) == 2 and ids(before) == ids(after), 'native definitions replaced or lost')
    created = {r['id']: r for r in data['nativeOperations'] if r['kind'] == 'created'}
    once = next(r for r in created.values() if r['rule']['kind'] == 'once')
    cron = next(r for r in created.values() if r['rule']['kind'] == 'cron')
    terminal = [r for r in data['callbacks'] if r['event']['type'] == 'completed']
    keys = [(r['id'], r['event']['occurrenceId']) for r in terminal]
    check(len(set(keys)) == len(keys), 'duplicate native terminal')
    check(sum(r['id'] == once['id'] for r in terminal) == 1, 'once occurrence lost or replayed')
    check(sum(r['id'] == cron['id'] for r in terminal) >= 2, 'recurring work did not continue')
    check(all(r['event']['success'] for r in terminal), 'native occurrence failed')
    check(any(r['t'] > end and r['id'] == once['id'] for r in terminal), 'due once did not finish after reattach')
    epoch = min(r['timestamp'] - r['t'] for r in data['deliveries'] if 'timestamp' in r)
    check(epoch + data['gapDeadlinePassed'] >= data['onceDueEpochMs'], 'once deadline was not inside frontend gap')
    delivered = [r for r in data['deliveries'] if r['type'] == 'response' and r.get('queueStarted', {}).get('source') == 'schedule']
    original_id = data['retryObservation']['id']
    retried = [r for r in delivered if r['messageId'] == original_id]
    check(len(retried) >= 2, 'lost ACK was not retried')
    check(len({(r.get('output'), r['threadId'], r['openId']) for r in retried}) == 1, 'ACK retry changed output/routing')
    check(all(r['openId'] == 'synthetic-owner' and r['queueStarted']['backend'] == data['backend'] for r in delivered), 'output owner changed')
    check(data['directBridge'].get('error') == 'No admitted native invocation owns this tool request.', 'out-of-turn native tool admission was not rejected')
    check(data['frontendB']['frontendVersion'] == '1.6.249', 'replacement parser was not loaded')
    check(len({r['pid'] for r in cleanup['frontends']}) == 2, 'frontend process was not replaced')
    check(data.get('nativeMcpAttempted') is True, 'real native MCP request was not attempted')
    native_mcp = False
    if data.get('nativeMcpAttempted'):
        for receipt in data['nativeReceipts']:
            if data['backend'] == 'agy' and str(receipt.get('name', '')).endswith('remote_cli_schedule_list'):
                output = receipt.get('response', {}).get('output', '')
                if '{' in output:
                    result = json.loads(output[output.index('{'):])
                    native_mcp |= result.get('status') == 'succeeded' and result.get('requestId') == 'synthetic-native-gap-mcp'
            if data['backend'] == 'claude' and receipt.get('type') == 'tool_result':
                for block in receipt.get('content', []) if isinstance(receipt.get('content'), list) else []:
                    if block.get('type') == 'text' and block.get('text', '').startswith('{'):
                        result = json.loads(block['text'])
                        native_mcp |= result.get('status') == 'succeeded' and result.get('requestId') == 'synthetic-native-gap-mcp'
        check(native_mcp, 'real native MCP result was not successful')
    check(cleanup.get('cleanHostStop') is True and not cleanup.get('productStopError'), 'explicit product stop failed')
    check(all(row['exitCode'] == 0 and row['signal'] is None and row['groupAbsent'] for row in cleanup['nativeParents']), 'exact native group did not exit cleanly')
    stop_begin, stop_end = data['stopStart'], data['stopEnd']
    check(stop_begin <= stop_end and stop_begin > end, 'explicit retirement ordering invalid')
    check(not [row for row in data['provider'] if stop_begin <= row['t'] <= stop_end], 'explicit stop invoked model')
    check(not [row for row in data['nativeOperations'] if stop_begin <= row['t'] <= stop_end], 'explicit stop invoked native management')
    check(data['stopCounts'] == {'provider': 0, 'nativeOperations': 0}, 'stop call counters disagree')
    retired = data['retiredCatalog']
    check(not retired['pending'], 'retired outbox has unacknowledged results')
    check(len(retired['records']) == 2 and all(row['state'] == 'completed' or row['state'] == 'cancelled' and row.get('cancelRequested') is True and row.get('cleanupConfirmed') is True for row in retired['records']), 'retired catalog lacks terminal deletion and cleanup proof')
    check(data['retryObservation']['callsAfterRetry'] == data['retryObservation']['callsBeforeRetry'], 'ACK retry invoked model')
    counts = collections.Counter(r['classification'] for r in data['provider'])
    check(dict(counts) == data['counts']['byClassification'], 'derived provider counts disagree')
    return {'backend': data['backend'], 'lifecycle_ms': end - begin, 'lifecycle_provider_calls': 0,
            'lifecycle_native_operations': 0, 'native_terminals': len(terminal), 'once_terminals': 1,
            'cron_terminals': sum(r['id'] == cron['id'] for r in terminal), 'provider_by_classification': dict(counts),
            'native_mcp_success': native_mcp, 'ack_retry_count': len(retried), 'provider_calls_in_retry_observation': data['retryObservation']['callsAfterRetry'] - data['retryObservation']['callsBeforeRetry'],
            'clean_product_host_stop': cleanup.get('cleanHostStop', False), 'explicit_stop_ms': stop_end - stop_begin,
            'explicit_stop_provider_calls': 0, 'explicit_stop_native_management_calls': 0,
            'local_native_groups_absent': all(row['groupAbsent'] for row in cleanup['nativeParents']), 'namespace_cleanup': True}


class Regression(unittest.TestCase):
    evidence_files = []
    def test_native_evidence(self):
        for file in self.evidence_files:
            with self.subTest(file=file.name):
                verify(json.loads(file.read_text()))
    def test_corruption_rejected(self):
        mutations = [lambda d: d['provider'].append({'t': d['transitionStart'], 'classification': 'scheduled-content'}),
                     lambda d: d['nativeOperations'].append({'t': d['transitionEnd'], 'kind': 'management'}),
                     lambda d: d['cleanup'].update(namespaceJoined=False),
                     lambda d: d['snapshots'][0].update(pid=-1),
                     lambda d: d['callbacks'].append(next(x for x in d['callbacks'] if x['event']['type'] == 'completed')),
                     lambda d: d.update(onceDueEpochMs=10**15),
                     lambda d: d['cleanup'].update(cleanHostStop=False),
                     lambda d: d['cleanup']['nativeParents'][0].update(groupAbsent=False),
                     lambda d: d['directBridge'].update(error='accepted'),
                     lambda d: d.update(nativeMcpAttempted=False),
                     lambda d: d['provider'].append({'t': d['stopStart'], 'classification': 'cleanup', 'action': {}}),
                     lambda d: d['nativeOperations'].append({'t': d['stopStart'], 'kind': 'management'}),
                     lambda d: d['retiredCatalog']['pending'].append({'unacknowledged': True}),
                     lambda d: next(row for row in d['retiredCatalog']['records'] if row['state'] == 'cancelled').update(cleanupConfirmed=False),
                     lambda d: d['retryObservation'].update(callsAfterRetry=1000)]
        for file in self.evidence_files:
            original = json.loads(file.read_text())
            for index, mutate in enumerate(mutations):
                with self.subTest(file=file.name, mutation=index):
                    value = copy.deepcopy(original)
                    mutate(value)
                    with self.assertRaises(AssertionError):
                        verify(value)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('evidence', nargs='+', type=Path)
    parser.add_argument('--self-test', action='store_true')
    args = parser.parse_args()
    if args.self_test:
        Regression.evidence_files = args.evidence
        raise SystemExit(not unittest.TextTestRunner(verbosity=2).run(unittest.defaultTestLoader.loadTestsFromTestCase(Regression)).wasSuccessful())
    for file in args.evidence:
        print(json.dumps(verify(json.loads(file.read_text()))))
