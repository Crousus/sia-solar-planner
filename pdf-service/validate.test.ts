// Solar Planner - Frontend web application for designing and planning rooftop solar panel installations
// Copyright (C) 2026  Johannes Wenz github.com/Crousus
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as
// published by the Free Software Foundation, either version 3 of the
// License, or (at your option) any later version.
//
// This program is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
// GNU Affero General Public License for more details.
//
// You should have received a copy of the GNU Affero General Public License
// along with this program.  If not, see <https://www.gnu.org/licenses/>.

// Plain-assert tests for the /render payload validator (`npm test`).
// Deliberately dependency-free (node:assert + tsx) so the service doesn't
// need a test framework. The important cases are the SSRF / local-file
// vectors react-pdf would otherwise happily resolve.

import assert from 'node:assert/strict';
import { validateRenderPayload } from './server';

// 1×1 PNG and a minimal JPEG header (only the magic bytes are checked).
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const JPEG = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAEBAQEBAQEBAQEBAQEBAQEBAQEBAQEB';

const run = {
  text: 'Hello', x: 1, y: 2, width: 30, height: 10, fontSize: 12,
  fontFamily: 'sans', bold: false, color: 'rgb(0, 0, 0)', textAlign: 'left', letterSpacing: 0,
};
const capture = (image: unknown) => ({ image, texts: [run], captureWidth: 1122, captureHeight: 794 });

const cases: Array<[string, () => void]> = [
  ['accepts a realistic payload', () => {
    const p = validateRenderPayload({
      planFrameCapture: capture(PNG),
      planImageDataUrl: JPEG,
      planImageRectPt: { x: 10, y: 10, w: 500, h: 300 },
      diagramCapture: capture(PNG),
    });
    assert.equal(p.planImageDataUrl, JPEG);
    assert.equal(p.diagramCapture?.texts.length, 1);
  }],
  ['drops unknown keys', () => {
    const p = validateRenderPayload({ diagramCapture: { ...capture(PNG), evil: 1 }, extra: 'x' }) as Record<string, unknown>;
    assert.equal('extra' in p, false);
    assert.equal('evil' in (p.diagramCapture as object), false);
  }],
  ['rejects object src (react-pdf remote fetch)', () => {
    assert.throws(() => validateRenderPayload({
      diagramCapture: capture({ uri: 'http://backend:8090/api/', method: 'POST', headers: {}, body: 'x' }),
    }));
  }],
  ['rejects http URL', () => {
    assert.throws(() => validateRenderPayload({ diagramCapture: capture('http://169.254.169.254/latest/meta-data') }));
  }],
  ['rejects local path', () => {
    assert.throws(() => validateRenderPayload({ diagramCapture: capture('/proc/self/environ') }));
    assert.throws(() => validateRenderPayload({ planFrameCapture: capture(PNG), planImageDataUrl: 'file:///etc/passwd' }));
  }],
  ['rejects svg data URI', () => {
    assert.throws(() => validateRenderPayload({ diagramCapture: capture('data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=') }));
  }],
  ['rejects mislabeled content', () => {
    assert.throws(() => validateRenderPayload({ diagramCapture: capture(PNG.replace('image/png', 'image/jpeg')) }));
  }],
  ['rejects non-base64 garbage after prefix', () => {
    assert.throws(() => validateRenderPayload({ diagramCapture: capture('data:image/png;base64,iVBORw0KGgo"><x') }));
  }],
  ['requires at least one capture', () => {
    assert.throws(() => validateRenderPayload({ planImageDataUrl: PNG }));
    assert.throws(() => validateRenderPayload(null));
    assert.throws(() => validateRenderPayload([]));
  }],
  ['rejects bad text runs', () => {
    assert.throws(() => validateRenderPayload({ diagramCapture: { ...capture(PNG), texts: [{ ...run, x: null }] } }));
    assert.throws(() => validateRenderPayload({ diagramCapture: { ...capture(PNG), texts: [{ ...run, fontFamily: 'Comic' }] } }));
    assert.throws(() => validateRenderPayload({ diagramCapture: { ...capture(PNG), texts: [{ ...run, color: 'url(http://x)' }] } }));
    assert.throws(() => validateRenderPayload({ diagramCapture: { ...capture(PNG), captureWidth: 0 } }));
  }],
];

let failed = 0;
for (const [name, fn] of cases) {
  try {
    fn();
    console.log(`ok   ${name}`);
  } catch (err) {
    failed++;
    console.error(`FAIL ${name}:`, err);
  }
}
if (failed) {
  console.error(`${failed} test(s) failed`);
  process.exit(1);
}
console.log(`all ${cases.length} tests passed`);
