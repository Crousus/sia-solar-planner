/// <reference types="vite/client" />

// Ambient reference that pulls in Vite's client types (including the
// `ImportMetaEnv` interface with `DEV`, `PROD`, `MODE`, etc.). Without this,
// `import.meta.env.DEV` fails type-checking with TS2339 because the default
// `ImportMeta` lib shim has no `env` property.
//
// Kept deliberately minimal — project-specific env var declarations
// (e.g. `interface ImportMetaEnv { readonly VITE_FOO: string }`) can be
// added here as the app grows. For now, only the standard Vite booleans
// (DEV/PROD/SSR/MODE/BASE_URL) are needed, and the vite/client reference
// alone is enough to type them.
