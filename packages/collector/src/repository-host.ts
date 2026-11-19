import { execFile } from 'node:child_process';

/** Reads the SSH config only; never connects. */
const SSH_LOOKUP = { timeoutMs: 1000, maxBuffer: 65536 } as const;
export type HostLookup = (alias: string) => Promise<string | null>;

const hosts = new Map<string, Promise<string | null>>();

/** Real host name of an SSH config alias (`ssh -G`), or null when ssh cannot say. Cached per process. */
export function sshHostName(alias: string): Promise<string | null> {
  let pending = hosts.get(alias);
  if (!pending) {
    pending = new Promise(resolve => {
      execFile('ssh', ['-G', alias], { timeout: SSH_LOOKUP.timeoutMs, maxBuffer: SSH_LOOKUP.maxBuffer }, (error, stdout) => {
        if (error) return resolve(null);
        const line = stdout.split('\n').find(l => l.startsWith('hostname '));
        resolve(line ? line.slice('hostname '.length).trim().toLowerCase() || null : null);
      });
    });
    hosts.set(alias, pending);
  }
  return pending;
}

/**
 * One identity per repository: a dot-less host such as `github-work` is an SSH config alias, so it is
 * replaced by the real host it points to. Hosts with a dot are already real names and stay as they are
 * (an SSH config may route `github.com` through another endpoint; that is still the same repository).
 */
export async function canonicalIdentity(identity: string, lookup: HostLookup = sshHostName): Promise<string> {
  const match = identity.match(/^git:([^/]+)\/(.+)$/);
  if (!match || match[1]!.includes('.')) return identity;
  const real = await lookup(match[1]!);
  return real && real !== match[1] ? `git:${real}/${match[2]}` : identity;
}
