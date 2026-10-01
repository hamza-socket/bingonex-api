import assert from 'node:assert/strict';
import test from 'node:test';

import { issueToken } from '../src/lib/auth.ts';

test('issueToken falls back to a dev secret when JWT secret is missing', () => {
  const token = issueToken({} as any, 'user-123');
  assert.match(token, /^[A-Za-z0-9._-]+$/);
});
