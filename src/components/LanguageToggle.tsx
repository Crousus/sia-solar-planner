// EN / DE language toggle for the Toolbar right section.
//
// Reads the active language from i18next and calls changeLanguage() on
// click. The detector plugin writes the choice back to localStorage
// automatically — no manual persistence needed here.
//
// Visually: two monospaced language codes separated by a dim slash.
// The active code is lighter + underlined; the inactive one is muted.
import React from 'react';
import { useTranslation } from 'react-i18next';

const LANGS = ['en', 'de'] as const;
type Lang = typeof LANGS[number];

export default function LanguageToggle() {
  const { i18n } = useTranslation();
  // Slice to 2 chars because navigator.language can return 'en-US' etc.
  const active = (i18n.language.slice(0, 2) as Lang);

  return (
    <div className="flex items-center font-mono text-[11px] select-none">
      {LANGS.map((lang, i) => (
        <React.Fragment key={lang}>
          {i > 0 && (
            <span
              className="px-0.5"
              style={{ color: 'var(--ink-500)' }}
              aria-hidden
            >
              /
            </span>
          )}
          <button
            onClick={() => i18n.changeLanguage(lang)}
            className="px-0.5 transition-colors"
            aria-pressed={active === lang}
            style={{
              color: active === lang ? 'var(--ink-100)' : 'var(--ink-400)',
              textDecoration: active === lang ? 'underline' : 'none',
              textUnderlineOffset: '3px',
            }}
          >
            {lang.toUpperCase()}
          </button>
        </React.Fragment>
      ))}
    </div>
  );
}
