import type { Account, Hostname, SettingsState } from '../../../types';
import type {
  GitLabIssue,
  GitLabProject,
  GitLabProjectNotificationSettings,
  GitLabTodo,
  GitLabUser,
} from './types';

import { isValidHostname } from '../../auth/utils';
import { HttpError } from '../../core/httpError';
import { decryptValue } from '../../system/comms';

const PAGE_SIZE = 100;

export function getGitLabApiBaseUrl(hostname: Hostname): URL {
  if (!isValidHostname(hostname)) {
    throw new Error('Refusing to build a GitLab API URL for invalid hostname.');
  }
  return new URL(`https://${hostname}/api/v4/`);
}

async function authHeaders(account: Account): Promise<HeadersInit> {
  const { token } = await decryptValue(account.token);
  return {
    Accept: 'application/json',
    'PRIVATE-TOKEN': token,
  };
}

function apiError(status: number, statusText: string): HttpError {
  return new HttpError(status, statusText);
}

async function gitlabRequest<T>(
  account: Account,
  pathname: string,
  init?: RequestInit,
): Promise<T> {
  const base = getGitLabApiBaseUrl(account.hostname);
  const url = new URL(pathname.replace(/^\//, ''), base);

  const response = await fetch(url.toString(), {
    ...init,
    headers: {
      ...(await authHeaders(account)),
      ...init?.headers,
    },
  });

  if (!response.ok) {
    throw apiError(response.status, response.statusText);
  }

  if (response.status === 204 || response.status === 205) {
    return undefined as T;
  }

  return response.json() as Promise<T>;
}

function buildTodoQuery(settings: SettingsState): URLSearchParams {
  const params = new URLSearchParams();
  params.set('per_page', String(PAGE_SIZE));
  if (!settings.fetchReadNotifications) {
    params.set('state', 'pending');
  }
  return params;
}

export async function listGitLabTodos(
  account: Account,
  settings: SettingsState,
): Promise<GitLabTodo[]> {
  const params = buildTodoQuery(settings);

  if (!settings.fetchAllNotifications) {
    params.set('page', '1');
    return gitlabRequest<GitLabTodo[]>(account, `todos?${params.toString()}`);
  }

  const all: GitLabTodo[] = [];
  let page = 1;

  while (true) {
    params.set('page', String(page));
    const batch = await gitlabRequest<GitLabTodo[]>(account, `todos?${params.toString()}`);
    if (!batch.length) {
      break;
    }
    all.push(...batch);
    if (batch.length < PAGE_SIZE) {
      break;
    }
    page += 1;
  }

  return all;
}

export function fetchGitLabAuthenticatedUser(account: Account): Promise<GitLabUser> {
  return gitlabRequest<GitLabUser>(account, 'user');
}

export async function markGitLabTodoAsDone(account: Account, todoId: string): Promise<void> {
  await gitlabRequest<void>(account, `todos/${todoId}/mark_as_done`, { method: 'POST' });
}

// Limit to the most-recently-active projects to avoid paginating through the
// thousands of inherited memberships that large GitLab orgs create. Users
// whose watched projects fall outside this window can increase their GitLab
// notification frequency via the GitLab UI.
const MEMBER_PROJECTS_LIMIT = 3;

export async function listGitLabMemberProjects(account: Account): Promise<GitLabProject[]> {
  const all: GitLabProject[] = [];
  for (let page = 1; page <= MEMBER_PROJECTS_LIMIT; page++) {
    const batch = await gitlabRequest<GitLabProject[]>(
      account,
      `projects?membership=true&archived=false&order_by=last_activity_at&per_page=${PAGE_SIZE}&page=${page}`,
    );
    all.push(...batch);
    if (batch.length < PAGE_SIZE) {
      break;
    }
  }
  return all;
}

export function getGitLabProjectNotificationSettings(
  account: Account,
  projectId: number,
): Promise<GitLabProjectNotificationSettings> {
  return gitlabRequest<GitLabProjectNotificationSettings>(
    account,
    `projects/${projectId}/notification_settings`,
  );
}

export function listGitLabProjectIssues(
  account: Account,
  projectId: number,
  createdAfter: string,
): Promise<GitLabIssue[]> {
  const params = new URLSearchParams({
    state: 'opened',
    created_after: createdAfter,
    per_page: String(PAGE_SIZE),
  });
  return gitlabRequest<GitLabIssue[]>(account, `projects/${projectId}/issues?${params}`);
}

/**
 * Returns open issues across all accessible projects where the authenticated
 * user has added any emoji reaction. Used for "participating only" mode to
 * surface issues the user has interacted with but that may not appear as todos.
 */
export function listGitLabInteractedIssues(account: Account): Promise<GitLabIssue[]> {
  const params = new URLSearchParams({
    scope: 'all',
    state: 'opened',
    my_reaction_emoji: 'any',
    per_page: String(PAGE_SIZE),
  });
  return gitlabRequest<GitLabIssue[]>(account, `issues?${params}`);
}

/**
 * GET an arbitrary GitLab API URL. The URL must point at the same origin as
 * the authenticated account — we never send the PAT to a different host.
 */
export async function gitlabGetJson<T>(account: Account, url: string): Promise<T> {
  const expected = getGitLabApiBaseUrl(account.hostname);
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error('Refusing to follow malformed GitLab URL.');
  }
  if (parsed.protocol !== 'https:' || parsed.host !== expected.host) {
    throw new Error(
      `Refusing to follow cross-origin GitLab URL for account on ${account.hostname}.`,
    );
  }

  const response = await fetch(parsed.toString(), {
    headers: await authHeaders(account),
  });
  if (!response.ok) {
    throw apiError(response.status, response.statusText);
  }
  return response.json() as Promise<T>;
}
