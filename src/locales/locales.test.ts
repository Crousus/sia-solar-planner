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
import en from './en';
import de from './de';

// Recursively collect all dot-path leaf keys from a nested object.
function collectLeafKeys(obj: object, prefix = ''): string[] {
  const keys: string[] = [];
  for (const [k, v] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${k}` : k;
    if (typeof v === 'string') {
      keys.push(path);
    } else if (typeof v === 'object' && v !== null) {
      keys.push(...collectLeafKeys(v as object, path));
    }
  }
  return keys;
}

describe('locales', () => {
  it('de has exactly the same leaf keys as en', () => {
    const enKeys = collectLeafKeys(en).sort();
    const deKeys = collectLeafKeys(de).sort();
    expect(deKeys).toEqual(enKeys);
  });

  it('all de values are non-empty strings', () => {
    for (const key of collectLeafKeys(de)) {
      const parts = key.split('.');
      let val: unknown = de;
      for (const part of parts) val = (val as Record<string, unknown>)[part];
      expect(typeof val, `${key} must be a string`).toBe('string');
      expect((val as string).length, `${key} must be non-empty`).toBeGreaterThan(0);
    }
  });
});
