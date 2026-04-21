// Vitest jsdom environment already provides localStorage, but zustand's
// persist middleware triggers a sync read at module load. This file is
// reserved for future setup (e.g., resetting stored state between tests).
// Keeping the file present so vitest.config.ts resolves cleanly.
