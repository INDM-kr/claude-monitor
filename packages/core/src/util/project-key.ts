export interface ProjectIdentity {
  key: string;
  label: string;
  owner: string;
}

const HOME_RE = /^\/Users\/([^/]+)(?:\/|$)/;
const CONDUCTOR_RE = /\/conductor\/workspaces\/([^/]+)\/[^/]+\/?$/;
const WORKTREE_RE = /^(.*)\/\.worktrees\/[^/]+\/?$/;

export function projectIdentityFromCwd(cwd: string): ProjectIdentity {
  const owner = ownerFromPath(cwd);

  const cm = cwd.match(CONDUCTOR_RE);
  if (cm) return { key: `conductor/${cm[1]}`, label: cm[1]!, owner };

  const wm = cwd.match(WORKTREE_RE);
  if (wm) {
    const repo = stripTrailingSlash(wm[1]!);
    return { key: repo, label: basename(repo), owner };
  }

  const key = stripTrailingSlash(cwd);
  return { key, label: basename(key), owner };
}

function ownerFromPath(p: string): string {
  const m = p.match(HOME_RE);
  return m ? m[1]! : "unknown";
}

function stripTrailingSlash(p: string): string {
  return p.replace(/\/+$/, "");
}

function basename(p: string): string {
  const t = stripTrailingSlash(p);
  const i = t.lastIndexOf("/");
  return i >= 0 ? t.slice(i + 1) : t;
}
