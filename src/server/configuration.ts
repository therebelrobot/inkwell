import { resolve } from "node:path";
import { createHash, randomBytes } from "node:crypto";

/**
 * All runtime configuration comes from environment variables so the same image
 * runs unchanged on a Pi and on a desktop. Paths resolve from process.cwd(),
 * never import.meta.url: esbuild flattens everything into one file, so the
 * bundle's own location says nothing about where data or static assets live.
 */
export interface ServerConfiguration {
  listenPort: number;
  listenHost: string;
  projectsDataDirectory: string;
  trashDirectory: string;
  clientStaticDirectory: string;
  /** When empty, the editor is open to anyone who can reach it (put it behind your proxy's auth). */
  editorPassword: string;
  sessionSigningSecret: Buffer;
  sessionLifetimeSeconds: number;
}

export function readServerConfigurationFromEnvironment(): ServerConfiguration {
  const dataDirectory = resolve(process.cwd(), process.env.INKWELL_DATA_DIR ?? "data");
  const editorPassword = process.env.INKWELL_PASSWORD ?? "";
  const explicitSessionSecret = process.env.INKWELL_SESSION_SECRET ?? "";

  // Without an explicit secret, sessions are signed with a key derived from the
  // password, so restarting the container keeps people signed in and changing
  // the password signs everyone out. With no password at all, a random key is fine.
  const sessionSigningSecret = explicitSessionSecret
    ? createHash("sha256").update(explicitSessionSecret).digest()
    : editorPassword
      ? createHash("sha256").update(`inkwell-session:${editorPassword}`).digest()
      : randomBytes(32);

  return {
    listenPort: Number.parseInt(process.env.PORT ?? "3000", 10),
    listenHost: process.env.HOST ?? "0.0.0.0",
    projectsDataDirectory: resolve(dataDirectory, "projects"),
    trashDirectory: resolve(dataDirectory, ".trash"),
    clientStaticDirectory: resolve(process.cwd(), process.env.INKWELL_STATIC_DIR ?? "dist/public"),
    editorPassword,
    sessionSigningSecret,
    sessionLifetimeSeconds: 60 * 60 * 24 * 30,
  };
}
