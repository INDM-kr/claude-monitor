/** Ledger projects as managed on /projects (merge, rename, archive), shared by the collector and the web app. */
export interface ManagedProject {
  id: string;
  label: string;
  archivedAt: number | null;
  workspaceCount: number;
  requestCount: number;
  workItemCount: number;
  repositoryIdentities: string[];
  /** Linked session folders, most requests first; empty when no folder is linked. */
  workspacePaths: string[];
}
/** Why a merge is suggested for a project whose repository is unknown. */
export type CandidateReason = "same_label" | "conductor_repo" | "parent_folder";
export interface MergeCandidate {
  /** Stable id of this suggestion; dismissing stores it. */
  key: string;
  reason: CandidateReason;
  sourceId: string;
  /** Suggested targets, most used first; the first is the default. */
  targetIds: string[];
}
export interface ProjectOverview {
  projects: ManagedProject[];
  archived: ManagedProject[];
  candidates: MergeCandidate[];
}
/** Live-monitor grouping for one ledger project. */
export interface MonitorProject {
  key: string;
  label: string;
}
export interface MonitorProjectMap {
  /** Canonical session folder → its project. */
  workspaces: Record<string, MonitorProject>;
  /** Repository identity (`git:host/path`) → its project, for folders the ledger has not seen. */
  identities: Record<string, MonitorProject>;
}
