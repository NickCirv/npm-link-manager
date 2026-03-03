#!/usr/bin/env node
// npm-link-manager — zero-dependency CLI for managing npm link relationships
// Node 18+ ES modules

import { execFileSync, spawnSync } from 'child_process';
import { existsSync, readdirSync, lstatSync, realpathSync, readFileSync, writeFileSync, rmSync } from 'fs';
import { join, resolve, dirname } from 'path';
import { homedir } from 'os';
import { createInterface } from 'readline';

// ─── ANSI Colors ────────────────────────────────────────────────────────────
const c = {
  reset:  '\x1b[0m',
  bold:   '\x1b[1m',
  dim:    '\x1b[2m',
  red:    '\x1b[31m',
  green:  '\x1b[32m',
  yellow: '\x1b[33m',
  blue:   '\x1b[34m',
  magenta:'\x1b[35m',
  cyan:   '\x1b[36m',
  white:  '\x1b[37m',
};

const paint = (color, text) => `${c[color]}${text}${c.reset}`;
const bold  = (text) => `${c.bold}${text}${c.reset}`;

// ─── Config / State ──────────────────────────────────────────────────────────
const CONFIG_PATH = join(homedir(), '.npm-link-manager.json');

function loadConfig() {
  if (!existsSync(CONFIG_PATH)) return { trackedProjects: [] };
  try {
    return JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
  } catch {
    return { trackedProjects: [] };
  }
}

function saveConfig(cfg) {
  writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2), 'utf8');
}

// ─── npm helpers ─────────────────────────────────────────────────────────────
function getNpmGlobalRoot() {
  try {
    const result = execFileSync('npm', ['root', '-g'], { encoding: 'utf8' });
    return result.trim();
  } catch (err) {
    console.error(paint('red', 'Error: could not determine npm global root.'));
    process.exit(1);
  }
}

function getNpmPrefix() {
  try {
    const result = execFileSync('npm', ['prefix', '-g'], { encoding: 'utf8' });
    return result.trim();
  } catch {
    return null;
  }
}

function runNpm(args, cwd) {
  const opts = { stdio: 'inherit', ...(cwd ? { cwd } : {}) };
  const result = spawnSync('npm', args, opts);
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

// ─── Link discovery ──────────────────────────────────────────────────────────
function discoverLinks() {
  const globalRoot = getNpmGlobalRoot();
  const links = [];

  if (!existsSync(globalRoot)) return links;

  const entries = readdirSync(globalRoot, { withFileTypes: true });

  for (const entry of entries) {
    // Handle scoped packages (@org/pkg)
    if (entry.name.startsWith('@') && entry.isDirectory()) {
      const scopeDir = join(globalRoot, entry.name);
      try {
        const scoped = readdirSync(scopeDir, { withFileTypes: true });
        for (const se of scoped) {
          const pkgPath = join(scopeDir, se.name);
          const link = inspectLink(pkgPath, `${entry.name}/${se.name}`);
          if (link) links.push(link);
        }
      } catch { /* skip unreadable dirs */ }
      continue;
    }

    const pkgPath = join(globalRoot, entry.name);
    const link = inspectLink(pkgPath, entry.name);
    if (link) links.push(link);
  }

  return links;
}

function inspectLink(pkgPath, name) {
  let stat;
  try {
    stat = lstatSync(pkgPath);
  } catch { return null; }

  if (!stat.isSymbolicLink()) return null;

  let target = null;
  let broken = false;

  try {
    target = realpathSync(pkgPath);
  } catch {
    broken = true;
    // Try to get the raw symlink destination even if broken
    try {
      const raw = spawnSync('readlink', [pkgPath], { encoding: 'utf8' });
      target = raw.stdout?.trim() || null;
    } catch { /* ignore */ }
  }

  let version = null;
  if (!broken && target) {
    const pkgJsonPath = join(target, 'package.json');
    if (existsSync(pkgJsonPath)) {
      try {
        const pkg = JSON.parse(readFileSync(pkgJsonPath, 'utf8'));
        version = pkg.version || null;
        name = pkg.name || name; // use declared name
      } catch { /* ignore */ }
    }
  }

  return {
    name,
    version,
    target,
    broken,
    mtime: stat.mtime,
  };
}

// ─── Read project package.json ───────────────────────────────────────────────
function readPackageJson(dir) {
  const pkgPath = join(dir, 'package.json');
  if (!existsSync(pkgPath)) return null;
  try {
    return JSON.parse(readFileSync(pkgPath, 'utf8'));
  } catch {
    return null;
  }
}

function allDeps(pkg) {
  return {
    ...pkg.dependencies,
    ...pkg.devDependencies,
    ...pkg.peerDependencies,
    ...pkg.optionalDependencies,
  };
}

// ─── Commands ────────────────────────────────────────────────────────────────

// nlm list
function cmdList() {
  const links = discoverLinks();

  if (links.length === 0) {
    console.log(paint('dim', 'No npm-linked packages found.'));
    return;
  }

  const title = bold(`\n  Active npm links  (${links.length} found)`);
  console.log(title);
  console.log(paint('dim', '  ' + '─'.repeat(70)));

  const now = Date.now();

  for (const lk of links) {
    const nameStr = lk.broken
      ? paint('red', `  ✖  ${lk.name}`)
      : paint('green', `  ✔  ${lk.name}`);

    const verStr  = lk.version ? paint('cyan', `v${lk.version}`) : paint('dim', 'unknown');
    const tgtStr  = lk.target  ? paint('dim', lk.target) : paint('red', '(broken — target missing)');

    const ageMs  = now - (lk.mtime?.getTime() ?? now);
    const ageDays = Math.floor(ageMs / 86400000);
    const ageStr  = ageDays > 0 ? paint('dim', `${ageDays}d ago`) : paint('dim', 'today');

    console.log(`${nameStr}  ${verStr}`);
    console.log(`       ${tgtStr}  ${ageStr}`);
    if (lk.broken) {
      console.log(paint('red', '       ⚠  Broken link — target no longer exists'));
    }
    console.log();
  }
}

// nlm link <package-dir>
function cmdLink(pkgDir) {
  if (!pkgDir) {
    console.error(paint('red', 'Usage: nlm link <package-dir>'));
    process.exit(1);
  }
  const absDir = resolve(pkgDir);
  if (!existsSync(absDir)) {
    console.error(paint('red', `Directory not found: ${absDir}`));
    process.exit(1);
  }
  const pkg = readPackageJson(absDir);
  const name = pkg?.name ?? absDir;
  console.log(paint('cyan', `Linking ${name} from ${absDir}...`));
  runNpm(['link'], absDir);
  console.log(paint('green', `✔ Linked: ${name}`));
}

// nlm unlink <package-name>
function cmdUnlink(pkgName) {
  if (!pkgName) {
    console.error(paint('red', 'Usage: nlm unlink <package-name>'));
    process.exit(1);
  }
  console.log(paint('cyan', `Unlinking ${pkgName}...`));
  runNpm(['unlink', '-g', pkgName]);
  console.log(paint('green', `✔ Unlinked: ${pkgName}`));
}

// nlm use <package-name> [--in <project-dir>]
function cmdUse(args) {
  const pkgName = args[0];
  if (!pkgName) {
    console.error(paint('red', 'Usage: nlm use <package-name> [--in <project-dir>]'));
    process.exit(1);
  }

  let projectDir = process.cwd();
  const inIdx = args.indexOf('--in');
  if (inIdx !== -1 && args[inIdx + 1]) {
    projectDir = resolve(args[inIdx + 1]);
  }

  if (!existsSync(projectDir)) {
    console.error(paint('red', `Project directory not found: ${projectDir}`));
    process.exit(1);
  }

  // Verify the link exists globally
  const links = discoverLinks();
  const found = links.find(l => l.name === pkgName);
  if (!found) {
    console.error(paint('red', `Package not linked globally: ${pkgName}`));
    console.error(paint('dim', `Run: nlm link <path-to-${pkgName}> first`));
    process.exit(1);
  }
  if (found.broken) {
    console.error(paint('red', `Global link for ${pkgName} is broken. Fix it first.`));
    process.exit(1);
  }

  console.log(paint('cyan', `Using linked ${pkgName} in ${projectDir}...`));
  runNpm(['link', pkgName], projectDir);
  console.log(paint('green', `✔ ${pkgName} is now linked in ${projectDir}`));
}

// nlm status [<project-dir>]
function cmdStatus(projectDir) {
  const dir = projectDir ? resolve(projectDir) : process.cwd();
  const pkg = readPackageJson(dir);

  if (!pkg) {
    console.error(paint('red', `No package.json found in: ${dir}`));
    process.exit(1);
  }

  const deps = allDeps(pkg);
  if (Object.keys(deps).length === 0) {
    console.log(paint('dim', 'No dependencies in package.json.'));
    return;
  }

  const links = discoverLinks();
  const linkMap = new Map(links.map(l => [l.name, l]));

  console.log(bold(`\n  Dependency link status for ${paint('cyan', pkg.name ?? dir)}`));
  console.log(paint('dim', '  ' + '─'.repeat(70)));

  for (const [dep, specifier] of Object.entries(deps)) {
    const linked = linkMap.get(dep);
    const nodeModulesPath = join(dir, 'node_modules', dep);
    let isLinkedLocally = false;
    try {
      isLinkedLocally = lstatSync(nodeModulesPath).isSymbolicLink();
    } catch { /* not installed */ }

    if (linked && isLinkedLocally) {
      const ver = linked.version ? `v${linked.version}` : 'unknown';
      console.log(`  ${'🔗'} ${paint('green', dep.padEnd(40))} ${paint('cyan', ver.padEnd(12))} ${paint('dim', linked.target ?? '')}`);
    } else if (isLinkedLocally) {
      console.log(`  ${'🔗'} ${paint('yellow', dep.padEnd(40))} ${paint('dim', '(local symlink, not via nlm)')}`);
    } else {
      console.log(`  ${'  '} ${paint('dim', dep.padEnd(40))} ${paint('dim', specifier)}`);
    }
  }
  console.log();
}

// nlm doctor
function cmdDoctor() {
  console.log(bold('\n  Running npm-link-manager doctor...\n'));
  const links = discoverLinks();
  const cfg   = loadConfig();
  const issues = [];

  // 1. Broken symlinks
  const brokenLinks = links.filter(l => l.broken);
  if (brokenLinks.length > 0) {
    for (const lk of brokenLinks) {
      issues.push({
        type: 'broken',
        severity: 'error',
        msg: `Broken symlink: ${paint('bold', lk.name)} — target no longer exists`,
        hint: `Run: nlm clean`,
      });
    }
  }

  // 2. Version mismatches across tracked projects
  const linkMap = new Map(links.filter(l => !l.broken).map(l => [l.name, l]));

  for (const projDir of cfg.trackedProjects) {
    if (!existsSync(projDir)) {
      issues.push({
        type: 'missing-project',
        severity: 'warning',
        msg: `Tracked project no longer exists: ${paint('dim', projDir)}`,
        hint: `Remove from config manually or re-create the directory`,
      });
      continue;
    }

    const pkg  = readPackageJson(projDir);
    if (!pkg) continue;
    const deps = allDeps(pkg);

    for (const [dep, specifier] of Object.entries(deps)) {
      const linked = linkMap.get(dep);
      if (!linked) continue;

      // Basic semver range check (no external deps — we do a simple check)
      const reqVersion = specifier.replace(/^[\^~>=<*]/, '').trim();
      if (reqVersion && linked.version && reqVersion !== linked.version) {
        const match = simpleVersionSatisfies(linked.version, specifier);
        if (!match) {
          issues.push({
            type: 'version-mismatch',
            severity: 'warning',
            msg: `Version mismatch: ${paint('bold', dep)} linked as v${linked.version} but ${paint('cyan', projDir)} requires ${specifier}`,
            hint: `Update the linked package or adjust the specifier`,
          });
        }
      }
    }
  }

  // 3. Orphaned links (not used in any tracked project)
  const usedPackages = new Set();
  for (const projDir of cfg.trackedProjects) {
    if (!existsSync(projDir)) continue;
    const pkg = readPackageJson(projDir);
    if (!pkg) continue;
    for (const dep of Object.keys(allDeps(pkg))) {
      usedPackages.add(dep);
    }
  }

  for (const lk of links.filter(l => !l.broken)) {
    if (cfg.trackedProjects.length > 0 && !usedPackages.has(lk.name)) {
      issues.push({
        type: 'orphaned',
        severity: 'info',
        msg: `Orphaned link: ${paint('bold', lk.name)} is globally linked but not used in any tracked project`,
        hint: `Run: nlm unlink ${lk.name}`,
      });
    }
  }

  // Report
  if (issues.length === 0) {
    console.log(paint('green', '  ✔ No issues found. Everything looks healthy!'));
  } else {
    const errors   = issues.filter(i => i.severity === 'error');
    const warnings = issues.filter(i => i.severity === 'warning');
    const infos    = issues.filter(i => i.severity === 'info');

    if (errors.length)   console.log(paint('red',    `  ✖  ${errors.length} error(s)`));
    if (warnings.length) console.log(paint('yellow', `  ⚠  ${warnings.length} warning(s)`));
    if (infos.length)    console.log(paint('blue',   `  ℹ  ${infos.length} info`));
    console.log();

    for (const issue of issues) {
      const icon = issue.severity === 'error' ? paint('red', '✖') :
                   issue.severity === 'warning' ? paint('yellow', '⚠') :
                   paint('blue', 'ℹ');
      console.log(`  ${icon}  ${issue.msg}`);
      console.log(paint('dim', `     Hint: ${issue.hint}`));
      console.log();
    }
  }
}

// Minimal semver satisfaction (handles ^, ~, >=, exact)
function simpleVersionSatisfies(version, specifier) {
  if (!specifier || specifier === '*' || specifier === 'latest') return true;
  const spec = specifier.trim();

  const toNum = (v) => {
    const parts = v.replace(/[^0-9.]/g, '').split('.').map(Number);
    return parts;
  };

  const cmp = (a, b) => {
    const pa = toNum(a), pb = toNum(b);
    for (let i = 0; i < 3; i++) {
      const x = pa[i] ?? 0, y = pb[i] ?? 0;
      if (x !== y) return x - y;
    }
    return 0;
  };

  if (spec.startsWith('^')) {
    const min = spec.slice(1);
    const minParts = toNum(min);
    const verParts = toNum(version);
    // Same major, version >= min
    return verParts[0] === minParts[0] && cmp(version, min) >= 0;
  }
  if (spec.startsWith('~')) {
    const min = spec.slice(1);
    const minParts = toNum(min);
    const verParts = toNum(version);
    return verParts[0] === minParts[0] && verParts[1] === minParts[1] && cmp(version, min) >= 0;
  }
  if (spec.startsWith('>=')) {
    return cmp(version, spec.slice(2).trim()) >= 0;
  }
  if (spec.startsWith('>')) {
    return cmp(version, spec.slice(1).trim()) > 0;
  }
  if (spec.startsWith('<=')) {
    return cmp(version, spec.slice(2).trim()) <= 0;
  }
  if (spec.startsWith('<')) {
    return cmp(version, spec.slice(1).trim()) < 0;
  }
  // Exact match
  return version === spec;
}

// nlm clean
function cmdClean() {
  const links = discoverLinks();
  const broken = links.filter(l => l.broken);

  if (broken.length === 0) {
    console.log(paint('green', '✔ No broken links found. Nothing to clean.'));
    return;
  }

  console.log(paint('yellow', `Found ${broken.length} broken link(s):`));
  for (const lk of broken) {
    console.log(paint('red', `  ✖  ${lk.name}`));
  }
  console.log();

  const globalRoot = getNpmGlobalRoot();

  let removed = 0;
  for (const lk of broken) {
    const linkPath = join(globalRoot, lk.name);
    try {
      rmSync(linkPath, { recursive: true, force: true });
      console.log(paint('green', `  ✔ Removed: ${lk.name}`));
      removed++;
    } catch (err) {
      console.error(paint('red', `  ✖ Could not remove ${lk.name}: ${err.message}`));
    }
  }

  console.log();
  console.log(paint('green', `Cleaned ${removed}/${broken.length} broken link(s).`));
}

// nlm track <project-dir>
function cmdTrack(projectDir) {
  if (!projectDir) {
    console.error(paint('red', 'Usage: nlm track <project-dir>'));
    process.exit(1);
  }
  const absDir = resolve(projectDir);
  if (!existsSync(absDir)) {
    console.error(paint('red', `Directory not found: ${absDir}`));
    process.exit(1);
  }
  const pkg = readPackageJson(absDir);
  if (!pkg) {
    console.error(paint('red', `No package.json in ${absDir}`));
    process.exit(1);
  }

  const cfg = loadConfig();
  if (cfg.trackedProjects.includes(absDir)) {
    console.log(paint('yellow', `Already tracking: ${absDir}`));
    return;
  }
  cfg.trackedProjects.push(absDir);
  saveConfig(cfg);
  console.log(paint('green', `✔ Now tracking: ${paint('cyan', pkg.name ?? absDir)} at ${absDir}`));
  console.log(paint('dim', `  Config saved to: ${CONFIG_PATH}`));
}

// nlm untrack-all
function cmdUntrackAll(projectDir) {
  const dir = projectDir ? resolve(projectDir) : process.cwd();
  const pkg = readPackageJson(dir);

  if (!pkg) {
    console.error(paint('red', `No package.json found in: ${dir}`));
    process.exit(1);
  }

  const deps = allDeps(pkg);
  const linkedNames = Object.keys(deps);

  if (linkedNames.length === 0) {
    console.log(paint('dim', 'No dependencies to restore.'));
    return;
  }

  // Find which deps are currently linked
  const links = discoverLinks();
  const linkMap = new Map(links.map(l => [l.name, l]));
  const toRestore = [];

  for (const dep of linkedNames) {
    const nodeModulesPath = join(dir, 'node_modules', dep);
    let isLinkedLocally = false;
    try {
      isLinkedLocally = lstatSync(nodeModulesPath).isSymbolicLink();
    } catch { /* not installed */ }
    if (isLinkedLocally) {
      toRestore.push(dep);
    }
  }

  if (toRestore.length === 0) {
    console.log(paint('green', '✔ No linked dependencies found in this project.'));
    return;
  }

  console.log(paint('cyan', `Restoring ${toRestore.length} linked package(s) to registry versions...`));
  for (const dep of toRestore) {
    console.log(paint('dim', `  → Unlinking ${dep}`));
    runNpm(['unlink', dep], dir);
  }

  console.log(paint('cyan', 'Re-installing from registry...'));
  runNpm(['install'], dir);
  console.log(paint('green', `✔ Restored all ${toRestore.length} package(s) from registry.`));
}

// ─── Help ────────────────────────────────────────────────────────────────────
function printHelp() {
  const t = paint('cyan', 'npm-link-manager');
  console.log(`
  ${bold(t)} ${paint('dim', 'v1.0.0')} — Manage npm link relationships across local packages

  ${bold('Usage:')}
    ${paint('cyan', 'nlm')} <command> [options]

  ${bold('Commands:')}
    ${paint('green', 'list')}                              Show all active npm links
    ${paint('green', 'link')} ${paint('yellow', '<package-dir>')}                Link a local package (wraps npm link)
    ${paint('green', 'unlink')} ${paint('yellow', '<package-name>')}             Unlink a package (wraps npm unlink -g)
    ${paint('green', 'use')} ${paint('yellow', '<package-name>')} ${paint('dim', '[--in <dir>]')}    Use a linked package in a project
    ${paint('green', 'status')} ${paint('dim', '[<project-dir>]')}              Show link status for a project
    ${paint('green', 'doctor')}                            Detect and report issues
    ${paint('green', 'clean')}                             Remove all broken links
    ${paint('green', 'track')} ${paint('yellow', '<project-dir>')}               Register a project to track
    ${paint('green', 'untrack-all')} ${paint('dim', '[<project-dir>]')}         Restore all links to registry versions

  ${bold('Options:')}
    ${paint('green', '--help')}, ${paint('green', '-h')}                          Show this help
    ${paint('green', '--version')}, ${paint('green', '-v')}                       Show version

  ${bold('Examples:')}
    ${paint('dim', '# Link a local package globally')}
    nlm link ../my-library

    ${paint('dim', '# Use linked package in a project')}
    nlm use my-library --in ./my-app

    ${paint('dim', '# Check status of current project')}
    nlm status

    ${paint('dim', '# Run health check')}
    nlm doctor

    ${paint('dim', '# Remove broken links')}
    nlm clean

    ${paint('dim', '# Track a project')}
    nlm track ./my-app

  ${bold('Config:')} ~/.npm-link-manager.json
`);
}

// ─── Main ────────────────────────────────────────────────────────────────────
function main() {
  const argv = process.argv.slice(2);

  if (argv.length === 0 || argv[0] === '--help' || argv[0] === '-h') {
    printHelp();
    return;
  }

  if (argv[0] === '--version' || argv[0] === '-v') {
    console.log('1.0.0');
    return;
  }

  const cmd = argv[0];
  const rest = argv.slice(1);

  switch (cmd) {
    case 'list':
      cmdList();
      break;
    case 'link':
      cmdLink(rest[0]);
      break;
    case 'unlink':
      cmdUnlink(rest[0]);
      break;
    case 'use':
      cmdUse(rest);
      break;
    case 'status':
      cmdStatus(rest[0]);
      break;
    case 'doctor':
      cmdDoctor();
      break;
    case 'clean':
      cmdClean();
      break;
    case 'track':
      cmdTrack(rest[0]);
      break;
    case 'untrack-all':
      cmdUntrackAll(rest[0]);
      break;
    default:
      console.error(paint('red', `Unknown command: ${cmd}`));
      console.error(paint('dim', 'Run: nlm --help'));
      process.exit(1);
  }
}

main();
