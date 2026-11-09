import { expect, it } from 'vitest';
import { APP_TITLE } from '@/appTitle';

it('has an app title', () => {
  expect(APP_TITLE).toBe('Secure Call');
});
