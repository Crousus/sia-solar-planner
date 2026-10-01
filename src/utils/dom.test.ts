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

import { describe, it, expect } from 'vitest';
import { isEditableTarget } from './dom';
import { safeHttpUrl, safeDataImageUrl } from './safeUrl';

describe('isEditableTarget', () => {
  it('treats text inputs, textareas and selects as editable', () => {
    const input = document.createElement('input');
    input.type = 'text';
    expect(isEditableTarget(input)).toBe(true);
    expect(isEditableTarget(document.createElement('textarea'))).toBe(true);
    expect(isEditableTarget(document.createElement('select'))).toBe(true);
  });

  it('does not treat button-like inputs as editable', () => {
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    expect(isEditableTarget(cb)).toBe(false);
  });

  it('treats contentEditable elements and their descendants as editable', () => {
    // Mirrors the diagram node label: a contentEditable div whose text
    // may be wrapped in child spans by the browser while typing.
    const host = document.createElement('div');
    host.setAttribute('contenteditable', 'true');
    const child = document.createElement('span');
    host.appendChild(child);
    document.body.appendChild(host);
    expect(isEditableTarget(host)).toBe(true);
    expect(isEditableTarget(child)).toBe(true);
    host.remove();
  });

  it('honours contenteditable="false" opt-outs and plain elements', () => {
    const div = document.createElement('div');
    div.setAttribute('contenteditable', 'false');
    expect(isEditableTarget(div)).toBe(false);
    expect(isEditableTarget(document.createElement('button'))).toBe(false);
  });

  it('treats ARIA textboxes as editable', () => {
    const div = document.createElement('div');
    div.setAttribute('role', 'textbox');
    expect(isEditableTarget(div)).toBe(true);
  });

  it('returns false for null and non-element targets', () => {
    expect(isEditableTarget(null)).toBe(false);
    expect(isEditableTarget(window)).toBe(false);
    expect(isEditableTarget(document)).toBe(false);
  });
});

describe('safeHttpUrl', () => {
  it('accepts absolute http and https URLs', () => {
    expect(safeHttpUrl('https://example.com/ds.pdf')).toBe('https://example.com/ds.pdf');
    expect(safeHttpUrl('  http://example.com  ')).toBe('http://example.com/');
  });

  it('rejects script-capable and other non-http schemes', () => {
    expect(safeHttpUrl('javascript:alert(1)')).toBeNull();
    expect(safeHttpUrl('JaVaScRiPt:alert(1)')).toBeNull();
    expect(safeHttpUrl(' \tjavascript:alert(1)')).toBeNull();
    expect(safeHttpUrl('data:text/html,<script>alert(1)</script>')).toBeNull();
    expect(safeHttpUrl('vbscript:msgbox(1)')).toBeNull();
    expect(safeHttpUrl('file:///etc/passwd')).toBeNull();
  });

  it('rejects relative URLs, empty strings and non-strings', () => {
    expect(safeHttpUrl('/api/collections/users')).toBeNull();
    expect(safeHttpUrl('example.com')).toBeNull();
    expect(safeHttpUrl('')).toBeNull();
    expect(safeHttpUrl(undefined)).toBeNull();
    expect(safeHttpUrl(42)).toBeNull();
  });
});

describe('safeDataImageUrl', () => {
  it('accepts base64 raster data URIs', () => {
    expect(safeDataImageUrl('data:image/png;base64,iVBORw0KGgo=')).toBe('data:image/png;base64,iVBORw0KGgo=');
    expect(safeDataImageUrl('data:image/jpeg;base64,/9j/4AAQ')).not.toBeNull();
  });

  it('rejects external URLs, svg, script schemes and non-strings', () => {
    expect(safeDataImageUrl('https://tracker.example/pixel.png')).toBeNull();
    expect(safeDataImageUrl('data:image/svg+xml;base64,PHN2Zz4=')).toBeNull();
    expect(safeDataImageUrl('javascript:alert(1)')).toBeNull();
    expect(safeDataImageUrl('')).toBeNull();
    expect(safeDataImageUrl(null)).toBeNull();
  });
});
