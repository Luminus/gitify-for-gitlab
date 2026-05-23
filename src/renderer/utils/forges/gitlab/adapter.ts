import { KeyIcon, ServerIcon } from '@primer/octicons-react';

import type {
  Account,
  Hostname,
  Link,
  RawGitifyNotification,
  SettingsState,
  Token,
} from '../../../types';
import type {
  ForgeAdapter,
  ForgeCapabilities,
  NotificationDisplayHelpers,
  RefreshAccountData,
} from '../types';

import { createNotificationHandler } from '../github/handlers';
import {
  fetchGitLabAuthenticatedUser,
  gitlabGetJson,
  listGitLabTodos,
  markGitLabTodoAsDone,
} from './client';
import { transformGitLabTodos } from './transform';

const GITLAB_DOCS_URL = 'https://docs.gitlab.com/user/profile/personal_access_tokens/' as Link;

const capabilities: ForgeCapabilities = {
  // GitLab todos support a single mark-as-done action.
  markAsDone: () => true,
  unsubscribeThread: () => false,
};

async function fetchAuthenticatedUser(account: Account): Promise<RefreshAccountData> {
  const user = await fetchGitLabAuthenticatedUser(account);
  return {
    user: {
      id: String(user.id),
      login: user.username,
      name: user.name ?? null,
      avatar: user.avatar_url ?? '',
    },
  };
}

async function listNotifications(
  account: Account,
  settings: SettingsState,
): Promise<RawGitifyNotification[]> {
  const raw = await listGitLabTodos(account, settings);
  return transformGitLabTodos(raw, account);
}

function getDisplayHelpers(notification: RawGitifyNotification): NotificationDisplayHelpers {
  const handler = createNotificationHandler(notification);
  return {
    iconType: handler.iconType(notification),
    iconColor: handler.iconColor(notification),
    defaultUrl: handler.defaultUrl(notification),
    defaultUserType: handler.defaultUserType(),
  };
}

export const gitlabAdapter: ForgeAdapter = {
  id: 'gitlab',
  displayName: 'GitLab',
  tagline: 'GitLab.com & Self-Hosted',
  icon: ServerIcon,
  capabilities,

  fetchAuthenticatedUser,
  listNotifications,

  // GitLab todos have no separate "read" state — marking as done is the only
  // action. We alias markThreadAsRead to the same operation so that the app's
  // generic "open & mark read" flow works without a no-op.
  markThreadAsRead: (account, threadId) => markGitLabTodoAsDone(account, threadId),
  markThreadAsDone: (account, threadId) => markGitLabTodoAsDone(account, threadId),
  unsubscribeThread: () => {
    throw new Error(
      'Unsubscribing from threads is not supported for GitLab accounts; check capabilities.unsubscribeThread before calling.',
    );
  },

  followUrl<T>(account: Account, url: Link): Promise<T> {
    return gitlabGetJson<T>(account, url);
  },
  getDisplayHelpers,

  pullRequestTerm: 'merge request',
  getNotificationsUrl: (account: Account) => `https://${account.hostname}/dashboard/todos` as Link,
  getIssuesUrl: (account: Account) =>
    `https://${account.hostname}/dashboard/work_items?assignee_username=${account.user?.login}` as Link,
  getPullRequestsUrl: (account: Account) =>
    `https://${account.hostname}/dashboard/merge_requests` as Link,

  defaultHostname: 'gitlab.com' as Hostname,
  // GitLab PATs: new format is glpat- + 20 chars; legacy format is 20 plain chars.
  // Accept either form — and any future prefix variants — by requiring only that
  // the token is non-empty and at least 20 characters long.
  validateToken: (token: Token) => token.trim().length >= 20,
  getPersonalAccessTokenSettingsUrl: (hostname: Hostname) =>
    `https://${hostname}/-/user_settings/personal_access_tokens` as Link,
  getAccountSettingsUrl: (account: Account) =>
    `https://${account.hostname}/-/user_settings/personal_access_tokens` as Link,
  documentationUrl: GITLAB_DOCS_URL,
  getAuthMethodIcon: () => KeyIcon,

  loginMethods: [
    {
      testId: 'login-gitlab-pat',
      icon: KeyIcon,
      label: 'Personal Access Token',
      route: '/login-personal-access-token',
      state: { forge: 'gitlab' },
    },
  ],
};
