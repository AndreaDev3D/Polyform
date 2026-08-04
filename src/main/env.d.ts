// Build-time constants injected by electron-vite (see electron.vite.config.ts).

/** Product version, read from package.json when the main bundle is built. */
declare const __APP_VERSION__: string

/**
 * The installer's `build.appId`, from the same package.json. Used as the
 * Windows AppUserModelID so the running app and the installed shortcut are one
 * identity to the shell.
 */
declare const __APP_ID__: string
