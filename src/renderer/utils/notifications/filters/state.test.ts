import type { DeepPartial } from '../../../__helpers__/test-utils';

import type { FilterStateType, GitifyNotification, GitifyNotificationState } from '../../../types';

import { stateFilter } from './state';

describe('renderer/utils/notifications/filters/state.ts', () => {
  describe('can filter by notification states', () => {
    const mockNotification = {
      subject: { state: 'OPEN' },
    } satisfies DeepPartial<GitifyNotification> as GitifyNotification;

    const cases = {
      OPEN: 'open',
      REOPENED: 'open',

      CLOSED: 'closed',
      COMPLETED: 'closed',
      DUPLICATE: 'closed',
      NOT_PLANNED: 'closed',
      RESOLVED: 'closed',

      MERGE_QUEUE: 'merged',
      MERGED: 'merged',
      DRAFT: 'draft',

      ANSWERED: 'other',
      OUTDATED: 'other',
    } satisfies Record<GitifyNotificationState, FilterStateType>;

    it.each(Object.entries(cases) as Array<[GitifyNotificationState, FilterStateType]>)(
      'filter notification with state %s as %s',
      (notificationState, expectedFilter) => {
        mockNotification.subject.state = notificationState;
        expect(stateFilter.filterNotification(mockNotification, expectedFilter)).toBe(true);
      },
    );
  });
});
