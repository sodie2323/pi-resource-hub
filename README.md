# pi-resource-center

[![Version](https://img.shields.io/badge/version-0.1.1-blue.svg)](https://github.com/sodie2323/pi-resource-hub/releases)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](./LICENSE)
[![Pi Package](https://img.shields.io/badge/pi-package-purple.svg)](https://github.com/sodie2323/pi-resource-hub)

A `pi-package` for [Pi](https://github.com/mariozechner/pi-coding-agent) that adds a `/resource` command for browsing, discovering, and managing:

- packages
- skills
- extensions
- prompts
- themes

It provides a keyboard-driven TUI resource browser, resource discovery across project and user scope, and command-based actions for enabling, disabling, removing, updating, and applying resources.

## Highlights

- Unified browser for packages, skills, extensions, prompts, and themes
- Fast search and keyboard navigation in a dedicated TUI
- Discovery across project settings, user settings, conventional folders, and package sources
- Enable/disable top-level resources and package-contained resources from the browser or command line
- Apply built-in and custom themes from the browser or command line
- Remove configured resources from settings
- Add package sources via `/resource add ...`
- Update remote packages directly from the browser
- Argument completions for `/resource` subcommands

## Quick start

This package registers:

```text
/resource
```

Running `/resource` opens the browser on the `packages` tab by default.

## Installation

### Install from npm

```bash
pi install npm:pi-resource-center
```

### Install from GitHub

```bash
pi install https://github.com/sodie2323/pi-resource-hub
```

### Install from a local path

From the package directory:

```bash
pi install .
```

Or with an absolute path:

```bash
pi install E:/code/pi-resource-hub
```

### Important note about local installs

For local paths, Pi does **not** copy the package into a separate install directory. It stores the path in Pi settings and loads the package directly from that folder.

That means after changing the source during development, you usually just need:

```bash
/reload
```

If you are iterating on this package itself, local install + `/reload` is the fastest workflow.

## Usage

### Open the browser

```bash
/resource
/resource packages
/resource skills
/resource extensions
/resource prompts
/resource themes
```

### Re-run discovery

```bash
/resource sync
```

### Core command groups

- `add` — register a package source in project or user settings
- `enable` / `disable` — toggle packages or resources
- `remove` — remove configured resources from settings
- `expose` / `hide` — show or hide package-contained resources in top-level categories
- `sync` — re-run discovery and refresh the current resource index

### Add a package source

```bash
/resource add <package-source>
/resource add <package-source> project
/resource add <package-source> user
```

Examples:

```bash
/resource add npm:@scope/some-pi-package
/resource add git:https://github.com/user/some-pi-package.git user
/resource add ../local-pi-package project
```

### Enable, disable, remove, expose, or hide resources

```bash
/resource enable [category] <name-or-source>
/resource disable [category] <name-or-source>
/resource remove [category] <name-or-source>
/resource expose [category] <name-or-source>
/resource hide [category] <name-or-source>
```

Supported category aliases:

- `package`
- `skill`
- `extension`
- `prompt`
- `theme`

Examples:

```bash
/resource disable package npm:@scope/some-pi-package
/resource enable extension resource-center/index.ts
/resource remove theme my-theme
/resource expose prompt prompts/review.md
/resource hide extension my-package/index.ts
```

Package-contained resources can also be toggled. These are matched by name, source, path, and package-relative path when available.

`/resource expose` and `/resource hide` apply to package-contained extensions, skills, and prompts only.

Their argument completion is scoped to package-contained resources, so exposing common package assets is easier from the command line.

## Theme behavior

Themes are handled a little differently from other resources.

- Built-in Pi themes `dark` and `light` are discovered and shown in the browser
- Custom themes discovered from files are also listed
- Applying a theme updates Pi settings and switches the UI immediately
- Themes are **applied**, not traditionally enabled/disabled
- Custom themes can be removed from settings
- Built-in themes cannot be removed

Examples:

```bash
/resource enable theme dark
/resource enable theme light
/resource remove theme my-theme
```

## TUI controls

### Browser view

- `Left/Right` or `Tab` — switch categories
- `Up/Down` — move selection
- `PageUp/PageDown` — jump through the list
- `Enter` — open resource details
- `Space` — enable/disable or apply the selected item
- `Esc` — close or go back

Items from local packages may show a package marker and package-relative path in the list and detail view.

### Detail view

- `Up/Down` — choose an action
- `Enter` — confirm action
- `Esc` — return to the list

For packages, the detail view includes a **Manage Resources** action that opens contained extensions, skills, prompts, and themes for that package.

For package-contained extensions, skills, and prompts, the detail view also includes a **Show in Category** / **Hide from Category** action.

## Discovery model

The package discovers resources in both **project** and **user** scope.

### Project scope

- `.pi/settings.json`
- conventional folders under `.pi/agent/`
  - `extensions/`
  - `skills/`
  - `prompts/`
  - `themes/`

### User scope

- `~/.pi/agent/settings.json`
- conventional folders under `~/.pi/agent/`
  - `extensions/`
  - `skills/`
  - `prompts/`
  - `themes/`

### Package sources

Configured package sources are read from Pi settings. For local package sources, the browser also inspects contained resources and shows counts for:

- extensions
- skills
- prompts
- themes

By default, `extensions`, `skills`, and `prompts` focus on top-level resources. Package-contained resources for those categories are managed from the package detail view instead.

From a package-contained extension, skill, or prompt detail view, you can explicitly show or hide that resource in its top-level category. Exposed package resources keep a package marker so their origin stays visible.

Themes are the exception: package-provided themes are still surfaced in the `themes` category by default so they remain easy to discover and apply.

Supported remote source prefixes:

- `npm:`
- `git:`
- `http://`
- `https://`

## Repository structure

Entry point:

- `extensions/resource-center/index.ts`

Core implementation:

- `src/index.ts` — command registration and command actions
- `src/browser.ts` — TUI resource browser
- `src/discovery.ts` — resource discovery logic
- `src/settings.ts` — Pi settings read/write helpers
- `src/types.ts` — shared resource types

## Requirements

Peer dependencies:

- `@mariozechner/pi-coding-agent`
- `@mariozechner/pi-tui`

## Publishing

This package is intended to be installable as an npm-hosted Pi package:

```bash
npm publish
```

After publishing, users can install it with:

```bash
pi install npm:pi-resource-center
```

## Notes

- The npm package name is `pi-resource-center`
- The repository is hosted at `sodie2323/pi-resource-hub`
- The `/resource` browser defaults to the `packages` category

## License

MIT
