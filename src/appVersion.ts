/** Build-time app version, injected by Vite/Vitest `define` from
 *  package.json (vite.config.ts / vitest.config.ts). Single source so
 *  the Settings footer can never drift from the shipped build — the
 *  ambiguity that made an updater test session confusing. */
export const APP_VERSION: string = __APP_VERSION__;
