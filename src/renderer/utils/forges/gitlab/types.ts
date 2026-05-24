/**
 * Subset of GitLab API types for the todos and user endpoints.
 *
 * Field names follow the JSON shape returned by the GitLab REST API v4.
 *
 * @see https://docs.gitlab.com/api/todos/
 * @see https://docs.gitlab.com/api/users/
 */

export type GitLabTodoActionName =
  | 'assigned'
  | 'mentioned'
  | 'build_failed'
  | 'marked'
  | 'approval_required'
  | 'unmergeable'
  | 'directly_addressed'
  | 'merge_train_removed'
  | 'review_requested'
  | 'member_access_requested'
  | 'review_submitted'
  | 'new_epic_added';

export type GitLabTodoTargetType =
  | 'Issue'
  | 'MergeRequest'
  | 'Commit'
  | 'Epic'
  | 'DesignManagement::Design'
  | 'AlertManagement::Alert';

export type GitLabTodoState = 'pending' | 'done';

export interface GitLabUser {
  id: number;
  username: string;
  name: string;
  avatar_url?: string;
  web_url?: string;
}

export interface GitLabNamespace {
  id: number;
  name: string;
  path: string;
  kind: 'user' | 'group';
  avatar_url?: string | null;
}

export interface GitLabProject {
  id: number;
  name: string;
  name_with_namespace: string;
  path: string;
  path_with_namespace: string;
  web_url: string;
  avatar_url?: string | null;
  namespace?: GitLabNamespace;
}

export interface GitLabTodoTarget {
  id: number;
  iid?: number;
  title?: string;
  web_url?: string;
  sha?: string;
}

export interface GitLabProjectNotificationSettings {
  level: 'disabled' | 'participating' | 'watch' | 'global' | 'mention' | 'custom';
  events?: {
    new_issue?: boolean;
  };
}

export interface GitLabIssue {
  id: number;
  iid: number;
  project_id: number;
  title: string;
  state: 'opened' | 'closed';
  draft: boolean;
  web_url: string | null;
  created_at: string;
  updated_at: string;
  author: GitLabUser;
}

export interface GitLabTodo {
  id: number;
  project?: GitLabProject;
  author: GitLabUser;
  action_name: GitLabTodoActionName;
  target_type: GitLabTodoTargetType;
  target: GitLabTodoTarget;
  target_url: string;
  body: string;
  state: GitLabTodoState;
  created_at: string;
  updated_at: string;
}
