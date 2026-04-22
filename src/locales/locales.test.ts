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
