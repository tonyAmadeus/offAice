/** What the user is running: the build that was packaged and the deployment that put it here. */
export interface RunningVersion {
  development: boolean;
  sourceCommit?: string; builtAt?: string; sourceDirty?: boolean;
  deployedAt?: string;
  /** The user's own confirmation that this deployed version works for them. */
  acceptance?: 'pending' | 'accepted'; acceptedAt?: string;
  /** The deployment record belongs to a different build than the one running (e.g. a copy started by hand). */
  mismatch?: boolean;
}
