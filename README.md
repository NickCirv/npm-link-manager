<div align="center">

# npm-link-manager

**Track, audit, and clean up `npm link` relationships across local packages — no dependencies.**

[![License: MIT](https://img.shields.io/badge/License-MIT-green?labelColor=0B0A09)](LICENSE)
[![Zero dependencies](https://img.shields.io/badge/dependencies-0-brightgreen?labelColor=0B0A09)](package.json)
[![Node >=18](https://img.shields.io/badge/node-%3E%3D18-blue?labelColor=0B0A09)](package.json)

</div>

## Install

```bash
npx github:NickCirv/npm-link-manager --help
```

Or install globally:

```bash
npm install -g github:NickCirv/npm-link-manager
```

Both `npm-link-manager` and the shorter alias `nlm` are available after global install.

## Usage

```bash
nlm list                          # Show all active npm links (version, path, age)
nlm doctor                        # Detect broken links, version mismatches, orphans
nlm link ../my-library            # Link a local package globally
nlm use my-library --in ./my-app  # Use a globally linked package in a project
nlm status                        # Show link status for the current project
nlm clean                         # Remove all broken symlinks
nlm track ./my-app                # Register a project for doctor checks
nlm untrack-all                   # Restore all linked deps back to registry versions
```

| Flag | Description |
|------|-------------|
| `--in <dir>` | Target project directory (used with `use`) |
| `--help`, `-h` | Show help |
| `--version`, `-v` | Show version |

## What it does

`npm link` is great for local development but becomes hard to track across multiple packages — stale symlinks accumulate silently, versions drift, and linked packages get forgotten. `npm-link-manager` wraps the core `npm link` / `npm unlink` workflow with a layer of visibility: scan your global npm prefix for all symlinks, detect broken or mismatched ones, and restore projects to registry versions in one command. Config is stored in `~/.npm-link-manager.json`.

---
<sub>Zero dependencies · Node ≥18 · MIT · by <a href="https://github.com/NickCirv">NickCirv</a></sub>
