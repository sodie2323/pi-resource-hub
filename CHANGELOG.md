# Changelog

All notable changes to this project will be documented in this file.

## [0.2.2] - 2026-04-20

### Added
- Added a dedicated Add view with inline source suggestions for local paths, `npm:`, `git:`, and full GitHub URLs.
- Added above-editor operation status widgets for add and update flows so long-running package installs and updates stay visible outside the Resource Center view.
- Added installed package version display in package lists and package detail views.

### Changed
- Add view now defaults its scope from the current resource context instead of always starting at project scope.
- Package add operations now run through the Pi CLI install flow so npm output is captured more cleanly and behaves consistently with package updates.
- Resource source labels now prefer configured external source names, including custom source labels, when paths match configured source roots.
- Simplified Add view copy and removed low-value detection/status text to keep focus on the input field.
- Refactored Add view state/suggestions and resource operation status handling into dedicated modules to reduce browser coupling.
- Reduced duplication in add target detection logic by consolidating shared sync/async path handling helpers.

### Fixed
- Add view now supports `S` to open settings consistently with other browser modes.
- Accepting an Add suggestion now places the cursor at the end of the accepted value.
- Detail action result messages no longer leak across resources when switching to a different detail view.
- Footer framing now keeps action hints visually inside the browser frame.
- Configured Codex and other external resource directories now show their configured source labels instead of a generic `settings` source.

## [0.2.1] - 2026-04-18

### Added
- Added first-class external skill source management for built-in Claude, Codex, and OpenCode directories plus multiple custom external skill source directories.
- Added inline editing for external skill source paths directly in the integrations settings list.
- Added keyboard shortcuts for integrations management: `A` to add custom external skill sources and `R` to remove the currently selected custom source.
- Added prompt `argument-hint` metadata display in prompt detail views.
- Prompt and skill resources now prefer real frontmatter descriptions when available.

### Changed
- External skill sources now sync into Pi core `settings.json` so directory-level enablement and per-skill disable entries work correctly together.
- Integrations settings now merge each source's on/off state and path into a single row with inline editing.
- Simplified integrations hints and removed extra add/remove rows from the UI.

### Fixed
- Resource browser selection now wraps around at the top and bottom.
- Inline settings editing no longer steals left/right cursor movement for settings section switching.
- Toggling an external skill source no longer jumps focus back to the first row.
- Skill resources no longer fall back to generic path-only descriptions when `SKILL.md` provides a real description.

## [0.2.0] - 2026-04-12

### Added
- Added a built-in Resource Center settings UI (`Shift+S`) with persistent browser preferences.
- Added pin/unpin support so resources can be kept at the top of sorted lists.
- Added persistent cleanup for stale pinned and exposed resource state.

### Changed
- Expanded package browsing so package contents can be searched and managed more directly from the browser.
- Improved detail labels and package path visibility for package-provided resources.
- Reorganized the source tree into `browser/`, `resource/`, and `settings/` modules.
- Split browser logic into focused modules for actions, input handling, navigation, rendering, and selectors.
- Centralized resource capability, identity, and user-message helpers for more consistent behavior.
- Updated the README to better reflect the current user-facing workflow.

## [0.1.6] - 2026-04-08

### Fixed
- Corrected `/resource` command argument completion replacement values so accepting suggestions no longer overwrites the leading subcommand.
- Improved `/resource add` scope validation and refreshed completion caches after `/resource sync`.

### Changed
- Enhanced `/resource add` completions with source-prefix suggestions and local directory completions.
- Prioritized category suggestions for `/resource enable`, `/resource disable`, `/resource remove`, `/resource expose`, and `/resource hide`.
- Ranked local directory completions to prefer likely package folders and de-prioritize common tooling directories.

## [0.1.5] - 2026-04-07

### Fixed
- `/resource remove` now supports convention-discovered file resources by deleting the underlying file.
- Improved remove behavior and messages for settings-backed vs convention resources.

## [0.1.4] - 2026-04-03

### Changed
- Updated resource toggle indicators from `[on]/[off]` to `[x]/[ ]` for a more compact checkbox-style UI

## [0.1.3] - 2026-04-03

### Fixed
- Fixed theme selection state in the resource browser so the active theme correctly shows as enabled

## [0.1.2] - 2026-04-03

### Changed
- Improved resource browser information hierarchy and reduced duplicated path/source details
- Added package-aware search separation between the main list and package contents views
- Added package preview interactions, lightweight caching, and precomputed package enablement summaries for better performance
- Improved error reporting for settings/resource operations with more contextual details
- Package descriptions now prefer `package.json.description`, with a fallback hint when missing

## [0.1.0] - 2026-03-31

### Added
- Initial release of `pi-resource-center`
- `/resource` command for browsing packages, skills, extensions, prompts, and themes
- TUI resource browser with category tabs, search, and keyboard navigation
- Discovery of project and user scoped resources
- Command and UI flows for adding, enabling, disabling, and removing resources
- Remote package update support from the browser
- Argument completions for `/resource` subcommands
