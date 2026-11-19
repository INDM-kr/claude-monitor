#!/usr/bin/env python3
"""Independent, local-only transcript oracle. No production modules are imported.
Input/output can contain local IDs/cwds; the caller must keep them private and
publish only anonymous aggregate comparisons. Exact Python integers are used.
"""
import argparse, collections, datetime as dt, json, math, os, pathlib, re

MAX_SAFE = 2**53 - 1
FIELDS = ('input_tokens', 'output_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens')
TIME = re.compile(r'^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$')

def nonempty(value):
    return isinstance(value, str) and bool(value.strip())

def number(value):
    if value is None: return 'missing_token'
    if isinstance(value, bool) or not isinstance(value, (int, float)) or value < 0: return 'invalid_token'
    if isinstance(value, float) and (not math.isfinite(value) or not value.is_integer()): return 'invalid_token'
    if value > MAX_SAFE: return 'unsafe_token_integer'
    return None

def calculate(root):
    groups = collections.defaultdict(list)
    diagnostics = collections.Counter()
    counts = collections.Counter()
    for path in sorted(root.rglob('*.jsonl')):
        if path.is_symlink() or not path.is_file(): continue
        source = str(path.relative_to(root)); offset = 0
        with path.open('rb') as stream:
            for raw in stream:
                start = offset; offset += len(raw)
                if not raw.endswith(b'\n'):
                    counts['partialFiles'] += 1; break
                counts['completeLines'] += 1
                try: data = json.loads(raw)
                except (ValueError, UnicodeError): diagnostics['malformed_json'] += 1; continue
                if not isinstance(data, dict): diagnostics['invalid_record'] += 1; continue
                if data.get('type') != 'assistant': counts['ignored'] += 1; continue
                message = data.get('message')
                if not isinstance(message, dict): diagnostics['invalid_record'] += 1; continue
                if message.get('model') == '<synthetic>': counts['synthetic'] += 1; continue
                response = message.get('id'); session = data.get('sessionId'); model = message.get('model')
                failure = next((code for value, code in [(response,'missing_message_id'),(session,'missing_session_id'),(model,'missing_model')] if not nonempty(value)), None)
                if failure: diagnostics[failure] += 1; continue
                timestamp = data.get('timestamp')
                if timestamp is None: diagnostics['missing_timestamp'] += 1; continue
                try:
                    if not isinstance(timestamp, str) or not TIME.match(timestamp): raise ValueError()
                    delta = dt.datetime.fromisoformat(timestamp.replace('Z','+00:00')) - dt.datetime(1970,1,1,tzinfo=dt.timezone.utc)
                    event = delta.days * 86400000 + delta.seconds * 1000 + delta.microseconds // 1000
                except ValueError: diagnostics['invalid_timestamp'] += 1; continue
                usage = message.get('usage')
                if not isinstance(usage, dict): diagnostics['missing_usage'] += 1; continue
                failure = next((number(usage.get(field)) for field in FIELDS if number(usage.get(field))), None)
                if failure: diagnostics[failure] += 1; continue
                tokens = [int(usage[field]) for field in FIELDS]
                split = usage.get('cache_creation'); five = hour = None; cost = 'eligible'
                if 'cache_creation' not in usage:
                    if tokens[3] == 0: five = hour = 0
                    else: cost = 'unknown_cache_split'
                elif not isinstance(split, dict): cost = 'invalid_cache_split'
                else:
                    if not number(split.get('ephemeral_5m_input_tokens')): five = int(split['ephemeral_5m_input_tokens'])
                    if not number(split.get('ephemeral_1h_input_tokens')): hour = int(split['ephemeral_1h_input_tokens'])
                    if five is None or hour is None or five + hour != tokens[3]: cost = 'invalid_cache_split'
                if cost != 'eligible': diagnostics[cost] += 1
                request = data.get('requestId')
                if request is not None and not nonempty(request): diagnostics['invalid_record'] += 1; continue
                segments = path.parts; agent = parent = workflow = None
                if re.match(r'^agent-[^/]+\.jsonl$', path.name, re.I) and 'subagents' in segments:
                    pos = len(segments) - 1 - segments[::-1].index('subagents')
                    if pos > 0:
                        parent = segments[pos-1]; agent = path.stem
                        if len(segments)>pos+2 and segments[pos+1]=='workflows' and segments[pos+2].startswith('wf_'):
                            workflow = segments[pos+2]; agent = workflow + '/' + agent
                cwd = data.get('cwd') if nonempty(data.get('cwd')) else None
                groups[response].append(dict(responseId=response, requestId=request, model=model, event=event, source=source, offset=start, tokens=tokens, cache5m=five, cache1h=hour, cost=cost, cwd=cwd, run=[session,parent,agent,workflow]))
                counts['observations'] += 1
    records=[]
    for response, history in groups.items():
        by_source = {}
        for observation in history:
            previous=by_source.get(observation['source'])
            if previous is None or observation['offset']>previous['offset']: by_source[observation['source']]=observation
        latest=max(row['event'] for row in by_source.values())
        candidates=[row for row in by_source.values() if row['event']==latest]
        candidates.sort(key=lambda row:(row['source'],row['offset']))
        chosen=candidates[0]
        snapshots={tuple(row['tokens']+[row['cache5m'],row['cache1h'],row['cost']]) for row in candidates}
        requests={row['requestId'] for row in history if row['requestId'] is not None}
        models={row['model'] for row in history}
        conflicts=[]
        if len(requests)>1: conflicts.append('request_id_conflict')
        if len(models)>1: conflicts.append('model_conflict')
        if len(snapshots)>1: conflicts.append('ambiguous_snapshot')
        diagnostics.update(conflicts)
        attribution = len({tuple(row['run']) for row in history})>1 or len({row['cwd'] for row in history if row['cwd'] is not None})>1
        if attribution: diagnostics['attribution_conflict'] += 1
        records.append(dict(responseId=response, model=chosen['model'], firstEventAt=min(row['event'] for row in history), snapshotAt=chosen['event'], tokens=[str(t) for t in chosen['tokens']], validity='conflict' if conflicts else 'valid', costEligibility=chosen['cost'], cwd=None if attribution else chosen['cwd'], run=None if attribution else chosen['run']))
    records.sort(key=lambda row:row['responseId'])
    return dict(counts=counts, diagnostics=diagnostics, records=records)

if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('root',type=pathlib.Path);parser.add_argument('output',type=pathlib.Path);args=parser.parse_args()
    result=calculate(args.root)
    descriptor=os.open(args.output,os.O_WRONLY|os.O_CREAT|os.O_TRUNC,0o600)
    with os.fdopen(descriptor,'w') as stream: json.dump(result,stream)
