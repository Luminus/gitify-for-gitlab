/**
 * Fetches GitLab issues beyond the Todos API for two notification modes:
 *
 *  "Participating and watching" (!settings.participating):
 *    New issues in projects where the user's notification level is "watch" or
 *    "custom" with new_issue enabled. These are the same projects that send
 *    new-issue emails.
 *
 *  "Participating only" (settings.participating):
 *    Open issues across all projects where the user has added an emoji reaction.
 *    Todos already cover assigned/mentioned; emoji reactions are the only
 *    "interacted with" signal exposed by the GitLab Issues API.
 *
 * State (last-seen cursor, last-fetch time, project cache, visible issues) is
 * persisted to localStorage so it survives app restarts. Both modes keep
 * independent cursors so switching modes always triggers a fresh fetch for the
 * new mode.
 */

import type { Account } from '../../../types';
import type { GitLabIssue, GitLabProject, GitLabProjectNotificationSettings } from './types';

import { rendererLogInfo } from '../../core/logger';
import {
  getGitLabProjectNotificationSettings,
  listGitLabInteractedIssues,
  listGitLabMemberProjects,
  listGitLabProjectIssues,
} from './client';

const PROJECTS_CACHE_TTL_MS = 60 * 60 * 1000;
const POLL_INTERVAL_MS = 60 * 60 * 1000;
const STARTUP_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000;

type Mode = 'watch' | 'participate';

// Maps notificationId ("issue-<id>") → {createdAt, mode} so mark-as-read
// can advance the correct cursor.
const issueTimestamps = new Map<string, { createdAt: string; mode: Mode }>();

interface IssueResult {
  issues: GitLabIssue[];
  projectMap: Map<number, GitLabProject>;
}

// Serialised form stored in localStorage (Map is not JSON-serialisable).
interface PersistedIssueCache {
  issues: GitLabIssue[];
  projectEntries: Array<[number, GitLabProject]>;
}

function lsKey(account: Account, suffix: string): string {
  return `gitify:gitlab:watched:${account.hostname}:${account.user?.login ?? 'unknown'}:${suffix}`;
}

function getLastSeenTimestamp(account: Account, mode: Mode): string {
  return (
    localStorage.getItem(lsKey(account, `lastSeen:${mode}`)) ??
    new Date(Date.now() - STARTUP_LOOKBACK_MS).toISOString()
  );
}

function setLastSeenTimestamp(account: Account, mode: Mode, ts: string): void {
  localStorage.setItem(lsKey(account, `lastSeen:${mode}`), ts);
}

function getLastFetchMs(account: Account, mode: Mode): number {
  return Number(localStorage.getItem(lsKey(account, `lastFetch:${mode}`)) ?? '0');
}

function setLastFetchMs(account: Account, mode: Mode): void {
  localStorage.setItem(lsKey(account, `lastFetch:${mode}`), String(Date.now()));
}

// ---------------------------------------------------------------------------
// Persisted issue cache (survives page refreshes / app restarts)
// ---------------------------------------------------------------------------

function getPersistedIssues(account: Account, mode: Mode): IssueResult {
  const raw = localStorage.getItem(lsKey(account, `issues:${mode}`));
  if (!raw) {
    return { issues: [], projectMap: new Map() };
  }
  try {
    const parsed: PersistedIssueCache = JSON.parse(raw);
    return {
      issues: parsed.issues,
      projectMap: new Map(parsed.projectEntries),
    };
  } catch {
    return { issues: [], projectMap: new Map() };
  }
}

function setPersistedIssues(account: Account, mode: Mode, result: IssueResult): void {
  const data: PersistedIssueCache = {
    issues: result.issues,
    projectEntries: Array.from(result.projectMap.entries()),
  };
  localStorage.setItem(lsKey(account, `issues:${mode}`), JSON.stringify(data));
}

function removePersistedIssue(account: Account, mode: Mode, issueId: number): void {
  const current = getPersistedIssues(account, mode);
  const updated: IssueResult = {
    issues: current.issues.filter((i) => i.id !== issueId),
    projectMap: current.projectMap,
  };
  setPersistedIssues(account, mode, updated);
}

// ---------------------------------------------------------------------------
// Merge helper — combines a fresh API result with previously persisted issues
// ---------------------------------------------------------------------------

function mergeAndPersist(
  account: Account,
  mode: Mode,
  freshIssues: GitLabIssue[],
  freshProjectMap: Map<number, GitLabProject>,
): IssueResult {
  const persisted = getPersistedIssues(account, mode);
  const nonDraftFresh = freshIssues.filter((i) => !isExcludedIssue(i));
  const freshIds = new Set(nonDraftFresh.map((i) => i.id));
  // Keep persisted issues not present in the fresh batch, dropping any drafts
  // that may have been cached before this filter was introduced.
  const retained = persisted.issues.filter((i) => !freshIds.has(i.id) && !isExcludedIssue(i));
  const mergedIssues = [...nonDraftFresh, ...retained];
  const mergedProjectMap = new Map([...persisted.projectMap, ...freshProjectMap]);
  const result: IssueResult = { issues: mergedIssues, projectMap: mergedProjectMap };
  setPersistedIssues(account, mode, result);
  // Re-register all visible issues in the timestamp map so mark-as-done works
  // for issues that were restored from localStorage.
  for (const issue of mergedIssues) {
    issueTimestamps.set(`issue-${issue.id}`, { createdAt: issue.created_at, mode });
  }
  return result;
}

// ---------------------------------------------------------------------------
// Project data cache (notification settings)
// ---------------------------------------------------------------------------

interface ProjectsCache {
  projects: GitLabProject[];
  watchedIds: number[];
  fetchedAt: number;
}

function getCachedProjectData(account: Account): ProjectsCache | null {
  const raw = localStorage.getItem(lsKey(account, 'projectsCache'));
  if (!raw) {
    return null;
  }
  try {
    const parsed: ProjectsCache = JSON.parse(raw);
    if (Date.now() - parsed.fetchedAt < PROJECTS_CACHE_TTL_MS) {
      return parsed;
    }
  } catch {
    // corrupted — fall through to re-fetch
  }
  return null;
}

function setCachedProjectData(account: Account, data: ProjectsCache): void {
  localStorage.setItem(lsKey(account, 'projectsCache'), JSON.stringify(data));
}

async function resolveProjectData(
  account: Account,
): Promise<{ projects: GitLabProject[]; watchedIds: number[] }> {
  const cached = getCachedProjectData(account);
  if (cached) {
    rendererLogInfo(
      'resolveProjectData',
      `cache hit: projects=${cached.projects.length} watched=${cached.watchedIds.length}`,
    );
    return cached;
  }
  rendererLogInfo('resolveProjectData', 'cache miss — fetching member projects');

  const projects = await listGitLabMemberProjects(account);

  // Fetch notification settings in small batches to avoid exhausting GitLab's
  // rate limit when the user is a member of many projects.
  const BATCH_SIZE = 5;
  const settingsResults: PromiseSettledResult<GitLabProjectNotificationSettings>[] = [];
  for (let i = 0; i < projects.length; i += BATCH_SIZE) {
    const batch = await Promise.allSettled(
      projects
        .slice(i, i + BATCH_SIZE)
        .map((p) => getGitLabProjectNotificationSettings(account, p.id)),
    );
    settingsResults.push(...batch);
  }

  // "watch" level = all project activity (includes new issues).
  // "custom" + new_issue = true = granular opt-in for new issues specifically.
  const watchedIds = projects
    .filter((_, i) => {
      const result = settingsResults[i];
      if (result.status !== 'fulfilled') {
        return false;
      }
      const { level, events } = result.value;
      return level === 'watch' || (level === 'custom' && events?.new_issue === true);
    })
    .map((p) => p.id);

  rendererLogInfo(
    'resolveProjectData',
    `projects=${projects.length} watched=${watchedIds.length} settingsFailed=${settingsResults.filter((r) => r.status === 'rejected').length}`,
  );

  const cache: ProjectsCache = { projects, watchedIds, fetchedAt: Date.now() };
  setCachedProjectData(account, cache);
  return cache;
}

// Matches "Draft:", "Draft -", "Draft ", "[Draft]", etc. — all common GitLab
// title conventions for issues not yet ready for action.
const DRAFT_TITLE_RE = /^(\[draft\]|draft[\s\W])/i;

// Matches automated weekly digest issues that aren't actionable notifications.
const EXCLUDED_TITLE_RE = /^week ending\b/i;

function isExcludedIssue(issue: GitLabIssue): boolean {
  return (
    issue.draft === true || DRAFT_TITLE_RE.test(issue.title) || EXCLUDED_TITLE_RE.test(issue.title)
  );
}

function recordIssues(issues: GitLabIssue[], mode: Mode, account: Account): void {
  // Advance the cursor past the most recently seen issue so the next hourly
  // fetch only returns issues created after these. Previously-seen issues are
  // kept visible via the persisted issue cache.
  if (issues.length > 0) {
    const latest = issues.reduce(
      (max, issue) => (issue.created_at > max ? issue.created_at : max),
      '',
    );
    setLastSeenTimestamp(account, mode, latest);
  }
}

/**
 * "Participating and watching" mode (!settings.participating).
 * Returns new issues from projects the user is watching for new-issue events.
 */
export async function listGitLabWatchedIssues(account: Account): Promise<{
  issues: GitLabIssue[];
  projectMap: Map<number, GitLabProject>;
}> {
  const lastFetch = getLastFetchMs(account, 'watch');
  const elapsed = Date.now() - lastFetch;
  rendererLogInfo(
    'listGitLabWatchedIssues',
    `called: elapsed=${Math.round(elapsed / 1000)}s cooldown=${Math.round(POLL_INTERVAL_MS / 1000)}s`,
  );

  if (elapsed < POLL_INTERVAL_MS) {
    rendererLogInfo('listGitLabWatchedIssues', 'cooldown active — returning persisted result');
    return getPersistedIssues(account, 'watch');
  }

  // Arm the cooldown before any async work so a failure still prevents a
  // repeated burst on every subsequent poll cycle.
  setLastFetchMs(account, 'watch');

  const { projects, watchedIds } = await resolveProjectData(account);

  if (watchedIds.length === 0) {
    return getPersistedIssues(account, 'watch');
  }

  const projectMap = new Map(projects.map((p) => [p.id, p]));
  const since = getLastSeenTimestamp(account, 'watch');

  const issueResults = await Promise.allSettled(
    watchedIds.map((id) => listGitLabProjectIssues(account, id, since)),
  );

  const allIssues = issueResults
    .filter((r): r is PromiseFulfilledResult<GitLabIssue[]> => r.status === 'fulfilled')
    .flatMap((r) => r.value);

  rendererLogInfo(
    'listGitLabWatchedIssues',
    `found ${allIssues.length} new issues across ${watchedIds.length} watched projects since ${since}`,
  );
  recordIssues(allIssues, 'watch', account);
  return mergeAndPersist(account, 'watch', allIssues, projectMap);
}

/**
 * "Participating only" mode (settings.participating).
 * Returns open issues the user has emoji-reacted on — the only "interacted with"
 * signal available via the GitLab Issues API without per-issue lookups.
 * Todos already cover assigned/mentioned/review-requested interactions.
 */
export async function listGitLabParticipatingIssues(account: Account): Promise<{
  issues: GitLabIssue[];
  projectMap: Map<number, GitLabProject>;
}> {
  if (Date.now() - getLastFetchMs(account, 'participate') < POLL_INTERVAL_MS) {
    return getPersistedIssues(account, 'participate');
  }

  // Arm the cooldown before any async work so a failure still prevents a
  // repeated burst on every subsequent poll cycle.
  setLastFetchMs(account, 'participate');

  // Reuse the member project list as best-effort project metadata.
  const { projects } = await resolveProjectData(account);

  const projectMap = new Map(projects.map((p) => [p.id, p]));
  const allIssues = await listGitLabInteractedIssues(account);

  recordIssues(allIssues, 'participate', account);
  return mergeAndPersist(account, 'participate', allIssues, projectMap);
}

/**
 * Advances the last-seen cursor for the mode this notification was fetched in,
 * and removes the issue from both the in-memory and persisted caches so it
 * disappears from the UI immediately.
 *
 * Called when the user marks a watched-issue notification as read/done.
 */
export function advanceTimestampForIssue(account: Account, notificationId: string): void {
  const info = issueTimestamps.get(notificationId);
  if (!info) {
    return;
  }
  const { createdAt, mode } = info;

  const current = getLastSeenTimestamp(account, mode);
  if (createdAt > current) {
    setLastSeenTimestamp(account, mode, createdAt);
  }

  const issueId = Number(notificationId.replace('issue-', ''));
  removePersistedIssue(account, mode, issueId);
  issueTimestamps.delete(notificationId);
}
