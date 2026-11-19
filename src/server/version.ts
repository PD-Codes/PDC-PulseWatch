import pkg from '../../package.json';
export const VERSION: string = pkg.version;

declare const __PW_BUILD__: string | undefined;
/** Identifies one build (version plus commit or build time, set by scripts/build.mjs); browsers compare it to notice a new deploy even without a version bump. */
export const BUILD: string = typeof __PW_BUILD__ === 'string' ? __PW_BUILD__ : VERSION;
