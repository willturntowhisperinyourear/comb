import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';

// Effects do not run in server rendering, so the page components render their
// empty states; a throw here is a blank dashboard in the browser.
const loc = { hash: '', origin: 'http://127.0.0.1:3000' };
Object.defineProperty(globalThis, 'location', { value: loc, configurable: true });
Object.defineProperty(globalThis, 'window', {
  value: { addEventListener() {}, removeEventListener() {}, location: loc },
  configurable: true,
});

const { renderToString } = await import('react-dom/server');
const { default: App } = await import('./App.tsx');

test('the dashboard shell renders without throwing', () => {
  const html = renderToString(createElement(App));
  assert.match(html, /comb/);
  assert.match(html, /Overview/);
  assert.match(html, /Connectors/);
  assert.match(html, /Upstreams/);
  assert.match(html, /Routing/);
  assert.match(html, /127\.0\.0\.1:3000\/v1/);
});

test('unknown routes fall back to the overview', () => {
  loc.hash = '#nope';
  const html = renderToString(createElement(App));
  assert.match(html, /traffic, health and tool emulation/);
  loc.hash = '';
});
