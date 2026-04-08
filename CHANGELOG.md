# Changelog

All notable changes to this project will be documented in this file.

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
