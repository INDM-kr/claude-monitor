#!/usr/bin/env python3
"""Verify golden fixture consistency/redaction, NOT production normalization."""
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
FIXTURES = ROOT / 'packages/adapter-claude-code/src/__tests__/fixtures/l0'
FIELDS = ('input_tokens', 'output_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens')


def total(records):
    return sum(sum(r['message']['usage'][k] for k in FIELDS) for r in records)


def verify_redaction(record):
    assert set(record) <= {'type', 'uuid', 'requestId', 'sessionId', 'cwd', 'timestamp', 'version', 'message'}
    assert record.get('cwd', '').startswith('/workspace/')
    assert record.get('sessionId', '').startswith('session-')
    assert record.get('uuid', '').startswith('record-')
    assert record.get('requestId', '').startswith('request-')
    msg = record['message']
    assert set(msg) <= {'id', 'model', 'content', 'usage', 'stop_reason'}
    assert msg['content'] == []
    assert msg.get('id', 'message-missing').startswith('message-')
    assert msg['model'].startswith('fixture-model-') or msg['model'] == '<synthetic>'
    usage = msg['usage']
    assert set(usage) <= {*FIELDS, 'cache_creation'}
    assert set(usage.get('cache_creation', {})) <= {'ephemeral_5m_input_tokens', 'ephemeral_1h_input_tokens'}


manifest = json.loads((FIXTURES / 'manifest.json').read_text())
for case in manifest['observed']:
    records = [json.loads(line) for line in (FIXTURES / case['file']).read_text().splitlines()]
    for record in records:
        verify_redaction(record)
    accepted = [records[i] for i in case['acceptedIndexes']]
    assert len(accepted) == case['expectedRequests']
    assert total(accepted) == case['expectedTokens'], case['file']
    if case.get('costEligible') is False:
        u = accepted[0]['message']['usage']
        assert u['cache_creation_input_tokens'] != sum(u['cache_creation'].values())

cases = json.loads((FIXTURES / manifest['syntheticCases']).read_text())
for case in cases:
    for entry in case['entries']:
        verify_redaction(entry['record'])
    accepted = [case['entries'][i]['record'] for i in case['acceptedIndexes']]
    assert len(accepted) == case['expectedRequests']
    assert total(accepted) == case['expectedTokens'], case['name']
    if 'expectedByModel' in case:
        assert sum(case['expectedByModel'].values()) == total(accepted)
    if 'expectedByProject' in case:
        assert sum(case['expectedByProject'].values()) == total(accepted)
        assert sum(case['remapExpected'].values()) == total(accepted)
    if 'fromUtc' in case:
        in_range = [e['record'] for e in case['entries'] if case['fromUtc'] <= e['record']['timestamp'] < case['toUtc']]
        assert in_range == accepted

data = ''
for part, key in zip(manifest['stream']['parts'], ('afterFirst', 'afterSecond')):
    data += (FIXTURES / part).read_text()
    complete, _, pending = data.rpartition('\n')
    records, malformed = [], 0
    for line in complete.splitlines():
        try:
            row = json.loads(line)
            verify_redaction(row)
            records.append(row)
        except json.JSONDecodeError:
            malformed += 1
    expected = manifest['stream'][key]
    assert len(records) == expected['validRecords']
    assert total(records) == expected['tokens']
    assert malformed == expected['malformedLines']
    assert bool(pending) == expected['pendingPartial']

print(f'PASS: {len(manifest["observed"])} observed fixtures, {len(cases)} synthetic cases, 2 stream checkpoints; golden totals and content-free allowlist verified. Production normalizer not exercised.')
