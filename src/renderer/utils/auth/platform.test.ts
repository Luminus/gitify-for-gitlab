import { mockGitLabAccount } from '../../__mocks__/account-mocks';

import { resolvePlatform } from './platform';

describe('renderer/utils/auth/platform.ts', () => {
  it('should always resolve to GitLab', () => {
    expect(resolvePlatform(mockGitLabAccount.forge, mockGitLabAccount.hostname)).toBe('GitLab');
  });
});
