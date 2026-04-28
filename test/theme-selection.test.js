import test from 'node:test';
import assert from 'node:assert/strict';

import { getSelectedTheme } from '../src/settings/shared.ts';

const settingsFile = (theme) => ({
  path: '/tmp/settings.json',
  dir: '/tmp',
  settings: theme === undefined ? {} : { theme },
});

test('falls back to the current Pi UI theme when settings do not contain an explicit theme', () => {
  assert.equal(getSelectedTheme(settingsFile(undefined), settingsFile(undefined), 'dark'), 'dark');
});

test('project theme setting takes precedence over current Pi UI theme', () => {
  assert.equal(getSelectedTheme(settingsFile('project-theme'), settingsFile('user-theme'), 'dark'), 'project-theme');
});

test('user theme setting takes precedence over current Pi UI theme when project theme is unset', () => {
  assert.equal(getSelectedTheme(settingsFile(undefined), settingsFile('user-theme'), 'dark'), 'user-theme');
});
