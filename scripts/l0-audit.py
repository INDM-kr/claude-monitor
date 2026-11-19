#!/usr/bin/env python3
"""Read local JSONL; emit aggregate metadata and content-free schema examples.

No source paths, original identifiers, prompt text, tool arguments or credentials
are written. Run with --source, --report and --fixtures explicitly specified.
"""
import argparse
from collections import Counter
from datetime import datetime, timezone
import json
from pathlib import Path
import re
import time

FIELDS = ('input_tokens', 'output_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens')
TTL_FIELDS = ('ephemeral_5m_input_tokens', 'ephemeral_1h_input_tokens')


def safe_usage(usage):
    out = {k: v for k in FIELDS if isinstance(v := usage.get(k), int) and not isinstance(v, bool) and v >= 0}
    ttl = usage.get('cache_creation')
    if isinstance(ttl, dict):
        out['cache_creation'] = {k: v for k in TTL_FIELDS if isinstance(v := ttl.get(k), int) and not isinstance(v, bool) and v >= 0}
    return out


def main():
    args = argparse.ArgumentParser()
    args.add_argument('--source', type=Path, required=True)
    args.add_argument('--report', type=Path, required=True)
    args.add_argument('--fixtures', type=Path, required=True)
    opts = args.parse_args()
    started = time.monotonic()
    inventory = []
    for path in sorted(opts.source.rglob('*.jsonl')):
        if path.is_symlink():
            continue
        st = path.stat()
        inventory.append((path, st.st_size, st.st_mtime_ns))
    counts, versions, models, types, missing, usage_keys, tiers, speeds, geos = (Counter() for _ in range(9))
    groups = {}
    real_messages = {}
    equal_example = revised_example = child_example = mismatch_example = None
    first_ts = last_ts = None
    counts['files'] = len(inventory)
    counts['bytesAtInventory'] = sum(size for _, size, _ in inventory)
    counts['maxFileBytes'] = max((size for _, size, _ in inventory), default=0)
    for file_index, (path, size, mtime_ns) in enumerate(inventory):
        parts = path.relative_to(opts.source).parts
        child = 'subagents' in parts
        counts['childFiles' if child else 'rootFiles'] += 1
        file_models = set()
        try:
            with path.open('rb') as handle:
                for line_index, line in enumerate(handle, 1):
                    counts['lines'] += 1
                    if not line.endswith(b'\n'):
                        counts['unterminatedLines'] += 1
                    try:
                        obj = json.loads(line)
                    except (ValueError, UnicodeError):
                        counts['malformedLines'] += 1
                        continue
                    if not isinstance(obj, dict):
                        counts['nonObjectLines'] += 1
                        continue
                    kind = obj.get('type', 'missing')
                    types[kind if kind in ('assistant', 'user', 'system', 'progress', 'file-history-snapshot', 'queue-operation', 'summary', 'custom-title', 'last-prompt', 'agent-name') else 'other'] += 1
                    version = obj.get('version')
                    if isinstance(version, str) and re.fullmatch(r'\d+\.\d+\.\d+(?:[-.a-z0-9]+)?', version):
                        versions[version] += 1
                    ts = obj.get('timestamp')
                    if isinstance(ts, str):
                        try:
                            dt = datetime.fromisoformat(ts.replace('Z', '+00:00')).astimezone(timezone.utc)
                            first_ts = dt if first_ts is None else min(first_ts, dt)
                            last_ts = dt if last_ts is None else max(last_ts, dt)
                        except ValueError:
                            counts['invalidTimestamps'] += 1
                    msg = obj.get('message')
                    if not isinstance(msg, dict) or not isinstance(msg.get('usage'), dict):
                        continue
                    counts['usageLines'] += 1
                    counts['assistantUsageLines' if kind == 'assistant' else 'nonAssistantUsageLines'] += 1
                    usage = msg['usage']
                    for k in FIELDS:
                        if k not in usage:
                            missing[k] += 1
                    for k in ('cache_creation', 'service_tier', 'inference_geo', 'speed', 'server_tool_use'):
                        if k in usage:
                            usage_keys[k] += 1
                    tier = usage.get('service_tier')
                    tiers[tier if tier in ('standard', 'priority', 'batch', 'default') else 'missing_or_other'] += 1
                    speed = usage.get('speed')
                    speeds[speed if speed in ('standard', 'fast') else 'missing_or_other'] += 1
                    geo = usage.get('inference_geo')
                    geos[geo if geo in ('global', 'us', 'not_available') else 'missing_or_other'] += 1
                    model = msg.get('model', '')
                    if isinstance(model, str) and (re.fullmatch(r'claude-[a-z0-9.\[\]-]+', model) or model == '<synthetic>'):
                        models[model] += 1
                        file_models.add(model)
                    record = {
                        'type': 'assistant', 'timestamp': '2026-09-18T00:00:00.000Z',
                        'version': version if isinstance(version, str) and re.fullmatch(r'\d+\.\d+\.\d+', version) else 'unknown',
                        'sessionId': 'session-example', 'cwd': '/workspace/example',
                        'uuid': 'record-01', 'requestId': 'request-example',
                        'message': {'id': 'message-example', 'model': 'fixture-model-a', 'content': [], 'usage': safe_usage(usage)},
                    }
                    stop = msg.get('stop_reason')
                    if stop in ('end_turn', 'tool_use', 'max_tokens', 'stop_sequence') or stop is None:
                        record['message']['stop_reason'] = stop
                    rid, mid = obj.get('requestId'), msg.get('id')
                    synthetic = model == '<synthetic>'
                    if synthetic:
                        counts['syntheticUsageLines'] += 1
                    if not rid and not synthetic:
                        counts['realUsageWithoutRequestId'] += 1
                    if any(not isinstance(usage.get(k), int) or isinstance(usage.get(k), bool) or usage[k] < 0 for k in FIELDS):
                        counts['invalidNumericUsageLines'] += 1
                    ttl = usage.get('cache_creation', {})
                    if isinstance(ttl, dict) and all(isinstance(ttl.get(k), int) for k in TTL_FIELDS):
                        if sum(ttl[k] for k in TTL_FIELDS) != usage.get('cache_creation_input_tokens'):
                            counts['cacheSplitMismatchLines'] += 1
                            if mismatch_example is None:
                                mismatch_example = record
                    else:
                        counts['missingCacheSplitLines'] += 1
                    if mid and not synthetic:
                        known = real_messages.setdefault(mid, set())
                        known.add(rid)
                    if not rid:
                        counts['usageWithoutRequestId'] += 1
                    if not mid:
                        counts['usageWithoutMessageId'] += 1
                    if child and child_example is None and all(k in usage for k in FIELDS):
                        child_example = record
                    if child:
                        parent = parts[parts.index('subagents') - 1]
                        if obj.get('sessionId') == parent:
                            counts['childUsageSessionIdEqualsParent'] += 1
                    if kind != 'assistant' or not mid:
                        continue
                    key = (rid, mid)
                    signature = json.dumps(safe_usage(usage), sort_keys=True)
                    prior = groups.get(key)
                    if prior:
                        counts['repeatUsageKeyLines'] += 1
                        if file_index != prior['file']:
                            counts['repeatUsageKeyAcrossFiles'] += 1
                        if signature == prior['signature']:
                            counts['equalUsageRepeats'] += 1
                            if equal_example is None:
                                equal_example = [prior['record'], record]
                        else:
                            counts['revisedUsageRepeats'] += 1
                            old = prior['usage']
                            if all(usage.get(k) == old.get(k) for k in FIELDS if k != 'output_tokens'):
                                counts['outputOnlyRevisions'] += 1
                            if usage.get('output_tokens', 0) < old.get('output_tokens', 0):
                                counts['outputDecreasingRevisions'] += 1
                            if revised_example is None:
                                revised_example = [prior['record'], record]
                    groups[key] = {'file': file_index, 'signature': signature, 'record': record, 'usage': safe_usage(usage)}
            if len(file_models - {'<synthetic>'}) > 1:
                counts['filesWithMultipleModels'] += 1
            after = path.stat()
            if (after.st_size, after.st_mtime_ns) != (size, mtime_ns):
                counts['filesChangedDuringRead'] += 1
        except OSError:
            counts['unreadableFiles'] += 1
    opts.fixtures.mkdir(parents=True, exist_ok=True)
    examples = {}
    for name, rows in [('observed-repeat', equal_example), ('observed-revision', revised_example), ('observed-child', [child_example] if child_example else None), ('observed-cache-mismatch', [mismatch_example] if mismatch_example else None)]:
        if rows is None:
            continue
        # Every value other than numeric usage/approved schema enums is replaced.
        sanitized = json.loads(json.dumps(rows))
        for i, record in enumerate(sanitized):
            record['uuid'] = f'record-{i+1:02d}'
            record['timestamp'] = f'2026-09-18T00:00:{i:02d}.000Z'
        dest = opts.fixtures / f'{name}.jsonl'
        dest.write_text(''.join(json.dumps(row, ensure_ascii=False) + '\n' for row in sanitized))
        examples[name] = {'provenance': 'observed-schema-redacted', 'records': len(rows), 'preserved': 'numeric usage, version, stop_reason; content removed; all identity/time/model/path replaced'}
    report = {
        'auditVersion': 2, 'capturedAt': datetime.now(timezone.utc).isoformat(),
        'scope': 'All *.jsonl under explicitly supplied Claude projects directory; point-in-time read, not a billing reconciliation',
        'counts': dict(counts), 'versions': dict(versions), 'models': dict(models),
        'recordTypes': dict(types), 'missingUsageFields': dict(missing),
        'usageMetadataFields': dict(usage_keys), 'serviceTiers': dict(tiers),
        'speeds': dict(speeds), 'inferenceGeos': dict(geos),
        'uniqueAssistantUsageKeys': len(groups),
        'uniqueNonSyntheticMessageIds': len(real_messages),
        'nonSyntheticMessageIdsWithMultipleRequestIds': sum(len(values) > 1 for values in real_messages.values()),
        'firstRecordAt': first_ts.isoformat() if first_ts else None,
        'lastRecordAt': last_ts.isoformat() if last_ts else None,
        'durationSec': round(time.monotonic()-started, 3), 'examples': examples,
    }
    opts.report.parent.mkdir(parents=True, exist_ok=True)
    opts.report.write_text(json.dumps(report, indent=2, ensure_ascii=False)+'\n')
    print(json.dumps(report, indent=2, ensure_ascii=False))


if __name__ == '__main__':
    main()
