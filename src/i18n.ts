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

// i18next initialisation + TypeScript resource type augmentation.
//
// The type augmentation block wires our locale shape into i18next's
// generic `t()` function so that `t('login.signIn')` is type-checked
// against en.ts at compile time — typos and missing keys are caught
// by tsc rather than showing up as blank strings at runtime.
//
// Imported as a side-effect (`import './i18n'`) in main.tsx before the
// React tree mounts, so the instance is ready when the first component
// calls useTranslation().
import i18next from 'i18next';
import { initReactI18next } from 'react-i18next';
import LanguageDetector from 'i18next-browser-languagedetector';
import en from './locales/en';
import de from './locales/de';

i18next
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    fallbackLng: 'en',
    supportedLngs: ['en', 'de'],
    resources: {
      en: { translation: en },
      de: { translation: de },
    },
    interpolation: {
      // React already escapes output — double-escaping would mangle
      // characters like `<` in error messages surfaced from PocketBase.
      escapeValue: false,
    },
    detection: {
      // Check localStorage first (user's explicit choice), then browser
      // navigator.language, then fall back to 'en'.
      order: ['localStorage', 'navigator'],
      // Write the resolved/chosen language back to localStorage so the
      // next page load starts with the correct language immediately.
      caches: ['localStorage'],
    },
  });

export default i18next;

// Augment i18next's generic types so every `t()` call is checked against
// our actual locale shape. This makes `t('login.signIn')` type-safe and
// gives IDE autocomplete for all translation keys.
declare module 'i18next' {
  interface CustomTypeOptions {
    defaultNS: 'translation';
    resources: {
      translation: typeof en;
    };
  }
}
