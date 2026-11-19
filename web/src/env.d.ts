/** Build version from package.json, injected by Vite (see vite.config.ts). */
declare const __APP_VERSION__: string;
/** Build id (PW_BUILD_ID at build time, else the version); differs between two builds of the same version. */
declare const __APP_BUILD__: string;
