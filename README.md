# pi-resource-center

[![npm version](https://img.shields.io/npm/v/pi-resource-center.svg)](https://www.npmjs.com/package/pi-resource-center)
[![Version](https://img.shields.io/badge/version-0.2.3-blue.svg)](https://github.com/sodie2323/pi-resource-center/releases)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](./LICENSE)
[![Pi Package](https://img.shields.io/badge/pi-package-purple.svg)](https://github.com/sodie2323/pi-resource-center)

> Questions, feedback, or bug reports? [Join the discussion on Discord](https://discord.com/channels/1456806362351669492/1489814646679666821).

A `pi-package` for [Pi](https://github.com/mariozechner/pi-coding-agent) that adds a `/resource` command and TUI for browsing, discovering, and managing:

- packages
- skills
- extensions
- prompts
- themes

It provides a keyboard-driven TUI resource browser, resource discovery across project and user scope, and command-based actions for enabling, disabling, removing, pinning, exposing, updating, and applying resources.

## Table of contents

- [Highlights](#highlights)
- [Quick start](#quick-start)
- [Common commands](#common-commands)
- [Installation](#installation)
  - [Install from npm](#install-from-npm)
  - [Install from GitHub](#install-from-github)
  - [Install from a local path](#install-from-a-local-path)
  - [Important note about local installs](#important-note-about-local-installs)
- [Usage](#usage)
  - [Open the browser](#open-the-browser)
  - [Re-run discovery](#re-run-discovery)
  - [Core command groups](#core-command-groups)
  - [Add a package source](#add-a-package-source)
  - [Enable, disable, remove, expose, or hide resources](#enable-disable-remove-expose-or-hide-resources)
- [Theme behavior](#theme-behavior)
- [TUI controls](#tui-controls)
  - [Browser view](#browser-view)
  - [Detail view](#detail-view)
  - [Add view](#add-view)
  - [Settings view](#settings-view)
- [Plugin settings](#plugin-settings)
- [Discovery model](#discovery-model)
  - [Project scope](#project-scope)
  - [User scope](#user-scope)
  - [Package sources](#package-sources)
- [Requirements](#requirements)
- [Notes](#notes)
- [License](#license)

## Highlights

- Unified browser for packages, skills, extensions, prompts, and themes
- Fast search and keyboard navigation in a dedicated TUI
- Discovery across project settings, user settings, conventional folders, and package sources
- Enable/disable top-level resources and package-contained resources from the browser or command line
- Pin resources to keep them at the top of sorted lists
- Apply built-in and custom themes from the browser or command line
- Remove configured resources from settings
- Add package sources and local resources via `/resource add ...`
- Update remote packages directly from the browser
- Argument completions for `/resource` subcommands
- Built-in settings UI (`Shift+S`) with persistent preferences
- External skill source management for Claude, Codex, OpenCode, and multiple custom directories
- Inline integrations editing with keyboard shortcuts for add/remove and quick on/off toggling
- Add view defaults scope from the current context and offers inline source suggestions for local paths, npm, git, and GitHub URLs
- Add and update operations show a live status widget above the editor while work is in progress
- Package lists and detail views display installed package versions
- Source labels prefer configured external source names such as Codex or custom source labels when available
- Local package sources use shorter `local:<name>` labels instead of full absolute paths in the browser
- Manually added top-level path resources keep a stable on/off state instead of disappearing when toggled
- Prompt detail views surface frontmatter metadata such as `argument-hint`

## Quick start

Install the package and open the browser:

```bash
pi install npm:pi-resource-center
```

```text
/resource
```

Running `/resource` opens the browser on the `packages` tab by default.

## Common commands

```text
/resource
/resource add npm:pi-resource-center project
/resource enable extension resource-center/index.ts
/resource remove theme my-theme
/resource sync
```

## Installation

### Install from npm

```bash
pi install npm:pi-resource-center
```

### Install from GitHub

```bash
pi install https://github.com/sodie2323/pi-resource-center
```

### Install from a local path

From the package directory:

```bash
pi install .
```

Or with an absolute path:

```bash
pi install E:/code/pi-resource-center
```

### Important note about local installs

For local paths, Pi loads the package directly from that folder instead of copying it elsewhere.

If you update the local package after installing it, run:

```bash
/reload
```

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

- `add` — register a package source or local resource path in project or user settings
- `enable` / `disable` — toggle packages or resources
- `remove` — remove configured resources from settings
- `expose` / `hide` — show or hide package-contained resources in top-level categories
- `sync` — re-run discovery and refresh the current resource index

### Add a package source or local resource

The browser `A` flow and `/resource add` both support:

- remote package sources such as `npm:`, `git:`, and full GitHub URLs
- local package directories
- local extensions, skills, prompts, and themes

In the browser Add view, the default scope now follows the current selection context instead of always defaulting to project scope.

```bash
/resource add <source-or-path>
/resource add <source-or-path> project
/resource add <source-or-path> user
/resource add [category] <source-or-path> [project|user]
```

Examples:

```bash
/resource add npm:@scope/some-pi-package
/resource add git:https://github.com/user/some-pi-package.git user
/resource add https://github.com/user/some-pi-package
/resource add ../local-pi-package project
/resource add extension ./extensions/resource-center/index.ts
/resource add skill ./skills/my-skill
/resource add prompt ./prompts/review.md
/resource add theme ./themes/my-theme.json
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

Package-contained resources can also be toggled. Matching works across common fields such as name, source, path, and package-relative path when available.

`/resource expose` and `/resource hide` apply to package-contained extensions, skills, and prompts only.

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
- `A` — add a package source or local resource
- `P` — pin or unpin the selected item
- `Shift+S` — open Resource Center settings
- `Esc` — close or go back

Pinned resources are kept at the top of sorted lists.

### Detail view

- `Up/Down` — choose an action
- `Enter` — confirm action
- `A` — add a package source or local resource
- `P` — pin or unpin the current item
- `Shift+S` — open Resource Center settings
- `Esc` — return to the list

For packages, the detail view includes a **Manage Resources** action that opens the package contents view, where you can browse contained extensions, skills, prompts, and themes, search within the package, and manage them directly.

For package-contained extensions, skills, and prompts, the detail view also includes a **Show in Category** / **Hide from Category** action.

### Add view

Open from browser or detail views with `A`.

- Default scope follows the current resource context (`project` or `user`)
- `Tab` — switch scope
- Type to enter a source or local path
- Inline suggestions appear for local paths and common source prefixes
- `Up/Down` — choose a suggestion or disambiguation candidate
- `Enter` — accept the selected suggestion or add the current source
- Long-running add/install operations show a widget above the editor and continue even if you leave the Resource Center view
- `Esc` — close the Add view

### Settings view

Open from anywhere in the Resource Center TUI via `Shift+S`.

- `Left/Right` or `Tab` — switch settings tabs (`All`, `Display`, `Packages`, `Search`, `Integrations`)
- Type to filter settings (search matches setting labels and descriptions)
- `Up/Down` — move selection
- `Enter` — change the selected setting or edit an integration path inline
- `Space` — toggle the selected integration on/off
- `Reload behavior` setting supports three modes: `Only show /reload hint`, `Ask before reload`, and `Reload automatically`
- `A` — add a custom external skill source in the `Integrations` tab
- `R` — remove the selected custom external skill source in the `Integrations` tab
- `Esc` — close settings or cancel inline editing

## Plugin settings

Resource Center stores its own UI preferences and "exposed" package resource state in a separate file (not in Pi's `settings.json`):

- Windows: `C:\\Users\\<you>\\.pi\\agent\\pi-resource-center-settings.json`
- macOS/Linux: `~/.pi/agent/pi-resource-center-settings.json`

This file stores the Resource Center's own UI preferences together with pinned resources, exposed package-resource state, configured external skill sources, and the reload behavior used after settings changes.

Stale `pinned` and `exposedResources` entries are pruned automatically when the plugin refreshes and before settings are saved.

> Older versions used `resource-hub.json`. It is safe to delete legacy `resource-hub.json` files once you've confirmed your `exposedResources` are present in the settings file.

## Discovery model

The package discovers resources in both **project** and **user** scope.

### Project scope

- `.pi/settings.json`
- conventional folders under `.pi/`
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
- external skill source directories configured in Resource Center settings (Claude/Codex/OpenCode/custom)

### Package sources

Configured package sources are read from Pi settings. For local package sources, the browser also inspects contained resources and shows counts for:

- extensions
- skills
- prompts
- themes

By default, `extensions`, `skills`, and `prompts` focus on top-level resources. Package-contained resources for those categories are managed from the package detail view instead.

From a package-contained extension, skill, or prompt detail view, you can explicitly show or hide that resource in its top-level category. Exposed package resources keep a package marker so their origin stays visible.

Enabled external skill sources are synchronized into Pi core `settings.json` `skills` entries so Pi handles directory discovery and per-skill disable rules consistently.

Themes are the exception: package-provided themes are still surfaced in the `themes` category by default so they remain easy to discover and apply.

Supported remote source prefixes:

- `npm:`
- `git:`
- `http://`
- `https://`

## Requirements

Peer dependencies:

- `@mariozechner/pi-coding-agent`
- `@mariozechner/pi-tui`

## Notes

- The npm package name is `pi-resource-center`
- The `/resource` browser defaults to the `packages` category

## License

MIT
