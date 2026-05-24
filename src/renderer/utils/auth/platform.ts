import type { Forge, Hostname } from '../../types';
import type { PlatformType } from './types';

export function resolvePlatform(_forge: Forge, _hostname: Hostname): PlatformType {
  return 'GitLab';
}
