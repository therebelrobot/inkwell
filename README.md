# inkwell

A self-hosted editor for [ink](https://github.com/inkle/ink) stories that works the same on a desktop browser and an iPad. One small container; your stories stay plain `.ink` files on disk.

- **Multi-file projects.** Each project is a folder of `.ink` files with a main file. `INCLUDE`s resolve the way inklecate resolves them (relative to the main file's folder). New files get an `INCLUDE` added to the main file automatically; renames update it.
- **Live compile** with the real inkjs 2.4 compiler, in a Web Worker so typing never stutters. Errors land on the right file and line, inline and in a Problems list.
- **Linter for the hazards the compiler accepts:** loops that run out of choices, tunnels that never return, threads that `-> END` the story, `{x = 2: …}` used as a comparison, and more (rules INK001–INK007, ported from the ink-narrative skill's `check-ink.ts` and tested for identical output).
- **Play preview** with tags, a variable inspector, back-one-choice, and start-at-any-knot. Like Inky, it replays your choices on every recompile, so editing deep in a branch keeps you where you were.
- **Knot map.** Knots laid out on a loom by distance from the start; diverts are threads (dashed for tunnels, dotted for threads, looping for backward diverts). Knots nothing reaches are dashed amber at the far end. Tap one to open it or play from it. Pinch, drag and trackpad-zoom all work. The map orients itself to the pane, so it goes vertical on a portrait iPad.
- **Export** a project as a `.zip` (sources plus a compiled `story.json` when the story compiles) or just the `story.json` for an inkjs runtime.
- **Desktop and iPad at once.** Autosave on a short pause. Every save names the version it was based on, so if you edit the same file on both devices the second save becomes a visible conflict with *Keep mine* / *Use the other version*. Nothing merges silently. Clean files follow edits made elsewhere when you switch back to the tab, and every 15 s while it's visible.

## Run it

```bash
cp .env.example .env    # set INKWELL_PASSWORD
docker compose up -d
```

Open `http://<docker-host>:3000`. On the iPad, use Safari's **Share → Add to Home Screen** for a full-screen app.

### Configuration

| Variable | Default | Purpose |
|---|---|---|
| `INKWELL_PASSWORD` | *(empty)* | Single shared password. Empty means no sign-in, so only do that behind a proxy that authenticates. |
| `INKWELL_SESSION_SECRET` | derived from the password | Signs the session cookie. Sessions last 30 days and survive restarts; changing the password signs everyone out. |
| `INKWELL_DATA_DIR` | `/app/data` | Projects live in `projects/<name>/`, deleted things in `.trash/`. |
| `PORT` / `HOST` | `3000` / `0.0.0.0` | Listen address. |

**Behind a reverse proxy** (Nginx Proxy Manager etc.): forward as usual. The session cookie gets the `Secure` flag only when the request arrived over HTTPS (it reads `X-Forwarded-Proto`), so signing in still works if you hit the container directly by LAN IP over plain HTTP. Browsers silently drop `Secure` cookies on plain HTTP, which would otherwise make sign-in loop.

**Bind-mount ownership:** the container runs as uid 1000 (`node`). If the host folder belongs to another user, `sudo chown -R 1000:1000 ./inkwell-data`, or set `user:` in compose.

**Deleting is recoverable.** Trashing a file or project moves it to `data/.trash/` with a timestamp. Empty that folder yourself when you're sure.

### Your files on disk

Projects are ordinary folders you can commit to git, open in Inky, or sync into a game repo. The only extra file is an optional `.inkwell.json` recording which file is the main one. Edits made outside inkwell (a `git pull`, Inky) show up in the editor within 15 seconds, or when you return to the tab, as long as you have no unsaved edits to that file there. If you do, you get the conflict banner.

## iPad notes

- **Symbol bar.** While the on-screen keyboard is up, a row of ink symbols (`->` `*` `+` `-` `[ ]` `{ }` `|` `~` `#` `===` …) sits above it. With a hardware keyboard it stays out of the way.
- **Smart punctuation.** iOS turns `"` into curly quotes and `--` into an em dash. inkwell straightens these only where ink reads them as syntax (inside `{…}`, on `~` lines, and at the start of a line before choice and gather marks), and leaves your prose alone.
- **Layout.** Landscape iPad and desktop get files, editor and tools side by side. Portrait and Split View get one pane at a time with tabs along the bottom. Rotating keeps undo history and your playthrough.
- **Exports** go through the share sheet (choose *Save to Files*) where iPadOS allows it, and fall back to a normal download.

## Develop

```bash
npm install
npm run dev:server    # API on :3000 with ./data
npm run dev:client    # Vite on :5173, proxies /api to :3000
npm test              # compiler, linter parity, map layout, player, storage, zip
npm run typecheck
npm run build         # dist/public (client) + dist/server.mjs (single bundled server)
```

Set `INK_SKILL_DIR=/path/to/ink-narrative` when running tests to include the check that the ported linter matches the skill's CLI finding-for-finding.

### Layout of the code

```
src/shared/      used by both sides: path rules, the project compiler, the ported linter, API types
src/server/      Hono app, file storage with version checks, auth, zip writer
src/client/      React app: workspace (buffers + autosave + sync), CodeMirror editor, worker, player, map
tests/           node:test suite and a multi-file fixture story
```

Runtime dependencies are `hono`, `@hono/node-server` and `inkjs`, all inlined into `dist/server.mjs`, so the image ships no `node_modules`. The zip writer uses `node:zlib`; nothing else is needed for exports.

## Release

`npm run release:patch` (or `minor` / `major`) bumps the version, tags `vX.Y.Z` and pushes. The `release` workflow then builds `linux/amd64` + `linux/arm64`, pushes to `ghcr.io/therebelrobot/inkwell` with `X.Y.Z`, `X.Y` and `sha-…` tags, and attaches signed build provenance and an SPDX SBOM. Every action is pinned to a commit SHA; Dependabot keeps the pins, npm packages and the Node base image current.

The Dockerfile builds on the runner's own architecture and its runtime stage has no `RUN`, so the arm64 image needs no QEMU emulation.

Verify a published image:

```bash
gh attestation verify oci://ghcr.io/therebelrobot/inkwell:0.1.0 --owner therebelrobot
```

The first push creates the GHCR package as **private**. Make it public, or grant your Pi pull access, under the package's settings.

## Manual test checklist

Automated runs covered desktop Chromium plus iPad-sized touch viewports. These need a real iPad:

1. **Home Screen app:** Add to Home Screen; it opens full screen with the icon, no Safari chrome, and content clears the status bar and home indicator.
2. **Symbol bar:** Tap into the editor; the bar appears directly above the keyboard. Tapping `{ }` leaves the caret between the braces and the keyboard stays up. Scroll the bar sideways to reach `->->`.
3. **Hardware keyboard:** With a Magic Keyboard attached, the symbol bar does not appear. ⌘S saves, ⌘F opens search, ⌘Z undoes.
4. **Smart punctuation:** In prose, type `"hello"`; the quotes stay curly. Inside `{ }`, type `"a"`; they come out straight. At the start of a line, type `--`; you get `- -`, not an em dash.
5. **Rotation:** Mid-playthrough, rotate portrait → landscape → portrait. The transcript and choices survive, and so does undo in the editor.
6. **Map gestures:** Pinch to zoom around your fingers, drag to pan, tap a knot, then *Play from here*.
7. **Two devices:** Open the same file on desktop and iPad. Edit and pause on the iPad. Then type on the desktop: you get the conflict banner. *Show the other version* displays the iPad's text. Pick one, and the other device follows within 15 s.
8. **Clean follow:** Edit on the desktop only. Switch to the iPad app; the change is already there or appears within 15 s.
9. **Network drop:** Turn Wi-Fi off, type, and see *Not saved*. Turn it back on; it saves within a few seconds without losing text.
10. **Leaving mid-edit:** Type, then immediately swipe home. Reopen: the edit was saved.
11. **Export:** *Export project (.zip)* opens the share sheet; *Save to Files* produces a zip that opens in Files with `story.json` inside.
12. **Sign-in over plain HTTP:** Open `http://<lan-ip>:3000` directly. Signing in works and doesn't loop back to the sign-in screen.
