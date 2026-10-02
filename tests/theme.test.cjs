const test = require('node:test');
const assert = require('node:assert/strict');
const { chooseTheme } = require('../assets/theme.js');
test('automatic theme changes exactly at 06:00 and 18:00', () => {
  for (const hour of [0, 5, 18, 23]) assert.equal(chooseTheme('auto', hour, 6, 18), 'dusk');
  for (const hour of [6, 12, 17]) assert.equal(chooseTheme('auto', hour, 6, 18), 'day');
});
test('manual selection overrides time, including midnight', () => {
  assert.equal(chooseTheme('day', 0, 6, 18), 'day');
  assert.equal(chooseTheme('dusk', 12, 6, 18), 'dusk');
});
test('custom daytime boundaries are honored', () => {
  assert.equal(chooseTheme('auto', 6, 7, 19), 'dusk');
  assert.equal(chooseTheme('auto', 18, 7, 19), 'day');
  assert.equal(chooseTheme('auto', 19, 7, 19), 'dusk');
});
