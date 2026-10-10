# Janitor Import for Lumiverse

A Spindle extension for Lumiverse 1.2.5 or newer. Connect an authenticated [JAR companion](https://github.com/alpha-omicron/JAR) to inspect JanitorAI characters, review definitions and captured lore, and import characters with avatars and World Books. Lumi can organize captured lore using your existing model connection. Conversation exports and JAR's full workspace remain available.

## Install

In Lumiverse's owner account, open **Extensions → Add Extension → Install from Source** and enter:

```text
https://github.com/lunchberrymail-cmyk/lumiverse-jar
```

Approve `cors_proxy`, `characters`, `world_books`, and `generation`, then enable **Janitor Import**. Open **Janitor** in the sidebar. The repository includes prebuilt bundles, so installation requires no dependency build or Lumiverse core patch. An existing local installation with identifier `jar_companion` needs a separate migration before installing the same identifier from GitHub.

## Use with JAR

Install JAR and its Node dependencies on the companion device. Install Playwright Chromium with `PLAYWRIGHT_BROWSERS_PATH` set to JAR's `browsers` folder. From this extension repository, start the companion:

```text
node companion/start.cjs PATH_TO_JAR
```

Keep its console running. It prints a companion token; enter that token and a reachable **Companion URL** under **Optional JAR connection** in Lumiverse, then choose **Save and test connection**. Complete JanitorAI sign-in and any browser challenge in JAR's Chromium. Inspect a character URL, review the received fields and lore, then import. Capture and Lumi reconstruction can send prompts using your existing Janitor or Lumi connection; review them before starting.

For a phone running Lumiverse and a Windows PC running JAR, see [PHONE-SETUP.md](PHONE-SETUP.md). The PC stays running for JAR features. Installing the extension from GitHub itself does not require SSH.

## Current limits

No-JAR URL fetching requires a usable Janitor session in Lumiverse's backend. This version has no supported native Janitor login connector, so signing into Janitor in another browser tab does not enable that fetch button. Public definitions remain subject to Janitor's access controls; missing content is reported without invention.

**Open JanitorAI website** opens Janitor's sign-in page. Website links request navigation in the current tab so app browsers that block new windows can follow them; some app browsers hand external websites to a separate browser. Return to Lumiverse afterward. The character-page and full-workspace links follow the same behavior. These website links do not connect a Janitor session to Lumiverse. For a new import in this version, connect JAR first.

Conversation exports are downloaded for Lumiverse's existing chat importer; the extension does not directly create chats. Captured lore reconstruction is approximate and may miss untriggered content. Cross-device networking and actual phone execution still need a live check.

## Development

The runtime is `spindle.json` plus tracked `dist/` files. Corresponding source, tests, dependency manifest and lockfile are under `source/`; the companion implementation is under `companion/`. Builds write back to the root `dist/` directory.

```bash
cd source
npm ci --ignore-scripts
npm run typecheck
npm run build
JAR_HOME=/path/to/JAR bun test test
```

`JAR_HOME` must refer to a JAR checkout with dependencies installed for the companion tests. On PowerShell, set it with `$env:JAR_HOME = 'PATH_TO_JAR'` before running `bun test test`.

Local validation passed 73 tests with 686 assertions, TypeScript checking, and both production builds. Authentication tests use simulated responses; they do not establish a working native Janitor login.

This bridge is provided under [AGPL-3.0](LICENSE.md). [UPSTREAM.json](UPSTREAM.json) records the reviewed upstream versions. JAR and Lumiverse keep their own licensing and source.
