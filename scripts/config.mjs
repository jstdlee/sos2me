#!/usr/bin/env node
// config.json ⇄ D1. One git-ignored file holds all your settings and credentials.
//
//   node scripts/config.mjs local [--force]    apply config.json to the local dev database
//   node scripts/config.mjs remote [--force]   apply config.json to the Cloudflare D1 database
//   node scripts/config.mjs pull [--remote]    write settings changed in the dashboard back into config.json
//   node scripts/config.mjs dev [vite args]    migrate + apply locally, then start `vp dev`
//
// "apply" only runs when config.json changed since the last apply/pull, and refuses (without --force)
// if the dashboard saved changes that were never pulled — so a deploy can't silently undo them.
// "pull" keeps your comments; passwords/PINs stay as you wrote them if they still match.
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyEdits, modify, parse } from 'jsonc-parser';

const ROOT = new URL('..', import.meta.url).pathname;
const FILE = join(ROOT, 'config.json');
const DB = 'sos2me';
// Your real database id / domain live in the git-ignored wrangler.local.jsonc (template: wrangler.jsonc).
const WRANGLER_CONFIG = existsSync(join(ROOT, 'wrangler.local.jsonc'))
  ? 'wrangler.local.jsonc'
  : 'wrangler.jsonc';
const [mode = 'local', ...rest] = process.argv.slice(2);
const force = rest.includes('--force');
const passThrough = rest.filter((f) => f !== '--force' && f !== '--remote');

export const parseJsonc = (text) => parse(text, [], { allowTrailingComma: true });
const sha = (s) => createHash('sha256').update(s).digest('hex');

function wrangler(args, { input } = {}) {
  const withConfig = args[0] === 'd1' ? [...args, '--config', WRANGLER_CONFIG] : args;
  const r = spawnSync('pnpm', ['exec', 'wrangler', ...withConfig], { cwd: ROOT, encoding: 'utf8', input });
  if (r.status !== 0) {
    process.stderr.write(r.stdout + r.stderr);
    throw new Error(`wrangler ${args.slice(0, 3).join(' ')} failed`);
  }
  return r.stdout;
}
const sql = (target, command) => {
  const out = wrangler([
    'd1',
    'execute',
    DB,
    target === 'remote' ? '--remote' : '--local',
    '--json',
    '--command',
    command,
  ]);
  return JSON.parse(out)[0]?.results ?? [];
};

// ── sync state: what config.json looked like at the last apply/pull, and when ──
const stateFile = (target) => join(ROOT, '.wrangler', `config-sync-${target}.json`);
const readState = (target) =>
  existsSync(stateFile(target)) ? JSON.parse(readFileSync(stateFile(target), 'utf8')) : null;
function writeState(target, fileHash) {
  mkdirSync(join(ROOT, '.wrangler'), { recursive: true });
  writeFileSync(stateFile(target), JSON.stringify({ fileHash, at: new Date().toISOString() }));
}

/** Dashboard saves since our last apply/pull (settings_saved / kid_link_rotated events). */
function dashboardEditsSince(target, at) {
  try {
    const rows = sql(
      target,
      `SELECT COUNT(*) AS n FROM events WHERE kind IN ('settings_saved') AND ts > '${at}'`,
    );
    return Number(rows[0]?.n ?? 0);
  } catch {
    return 0; // first run: tables may not exist yet
  }
}

function apply(target, { soft = false } = {}) {
  if (!existsSync(FILE)) {
    console.log('config.json not found — copy config.example.json to config.json to seed settings.');
    return;
  }
  const raw = readFileSync(FILE, 'utf8');
  const hash = sha(raw);
  const state = readState(target);
  if (!force && state?.fileHash === hash) {
    console.log(`config.json unchanged — not re-applied to ${target}.`);
    return;
  }
  if (!force && state?.at) {
    const edits = dashboardEditsSince(target, state.at);
    if (edits) {
      console.error(
        `✗ The ${target} dashboard saved settings ${edits} time(s) since config.json was last synced.\n` +
          `  Applying now would undo those changes. Run:  node scripts/config.mjs pull${target === 'remote' ? ' --remote' : ''}\n` +
          `  (or add --force to overwrite them).`,
      );
      if (soft) return; // `pnpm dev` keeps running with the dashboard's settings
      process.exit(1);
    }
  }
  const cfg = parseJsonc(raw);

  // Keep the kid page link that already exists, unless config.json sets one.
  try {
    const row = sql(target, "SELECT value FROM settings WHERE key='config'")[0];
    const token = row && JSON.parse(row.value)?.channels?.kidPage?.token;
    if (token && !cfg.channels?.kidPage?.token) {
      cfg.channels ??= {};
      cfg.channels.kidPage = { ...cfg.channels.kidPage, token };
    }
  } catch {
    /* first run */
  }

  const json = JSON.stringify(cfg).replace(/'/g, "''");
  const dir = join(tmpdir(), `sos2me-${process.pid}`);
  mkdirSync(dir, { mode: 0o700, recursive: true });
  const file = join(dir, 'config.sql');
  writeFileSync(
    file,
    `INSERT INTO settings (key, value, updated_at) VALUES ('config', '${json}', datetime('now'))
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at;`,
    { mode: 0o600 },
  );
  try {
    wrangler(['d1', 'execute', DB, target === 'remote' ? '--remote' : '--local', '--yes', '--file', file]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  writeState(target, hash);
  console.log(`✓ config.json applied to the ${target} database.`);
}

// ── pull: database → config.json, keeping comments ──

/** Same derivation as worker/db.ts hashSecret, so we can tell if a plain value in the file still matches. */
function hashSecret(value) {
  const salt = sha(`sos2me-salt:${value}`).slice(0, 12);
  return `h:${salt}:${sha(`${salt}:${value}`)}`;
}

function pull(target) {
  const row = sql(target, "SELECT value FROM settings WHERE key='config'")[0];
  if (!row) {
    console.log(`No settings in the ${target} database yet.`);
    return;
  }
  pullFrom(target, JSON.parse(row.value));
}

/** Merge the live settings object into config.json, keeping comments. Returns the number of changes. */
function pullFrom(target, live, { quiet = false } = {}) {
  let text = existsSync(FILE)
    ? readFileSync(FILE, 'utf8')
    : readFileSync(join(ROOT, 'config.example.json'), 'utf8');
  const file = parseJsonc(text) ?? {};

  // Passwords/PINs are stored hashed: keep the readable value in config.json if it still matches.
  const hashed = [['adminPassword'], ['channels', 'kidPage', 'pin']];
  for (const path of hashed) {
    const plain = path.reduce((o, k) => o?.[k], file);
    const stored = path.reduce((o, k) => o?.[k], live);
    if (typeof plain === 'string' && plain && stored && hashSecret(plain) === stored) {
      path.slice(0, -1).reduce((o, k) => o[k], live)[path.at(-1)] = plain;
    }
  }

  const fmt = { formattingOptions: { insertSpaces: true, tabSize: 2 } };
  let changes = 0;
  const walk = (liveVal, fileVal, path) => {
    const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
    if (isObj(liveVal) && isObj(fileVal)) {
      for (const k of Object.keys(liveVal)) walk(liveVal[k], fileVal[k], [...path, k]);
      return;
    }
    if (JSON.stringify(liveVal) === JSON.stringify(fileVal)) return;
    text = applyEdits(text, modify(text, path, liveVal, fmt));
    changes++;
  };
  walk(live, file, []);

  if (!changes) {
    if (!quiet) console.log(`config.json already matches the ${target} dashboard.`);
  } else {
    writeFileSync(FILE, text, { mode: 0o600 });
    console.log(
      `✓ ${changes} setting(s) from the ${target} dashboard written to config.json (comments kept).`,
    );
  }
  writeState(target, sha(text));
  return changes;
}

// ── dev: write dashboard saves back to config.json automatically ──

/** Read the local D1 database file directly (fast, no wrangler process per check). */
async function localConfigReader() {
  const { DatabaseSync } = await import('node:sqlite');
  const dir = join(ROOT, '.wrangler/state/v3/d1/miniflare-D1DatabaseObject');
  return () => {
    for (const f of existsSync(dir)
      ? readdirSync(dir).filter((x) => x.endsWith('.sqlite') && x !== 'metadata.sqlite')
      : []) {
      const db = new DatabaseSync(join(dir, f), { readOnly: true });
      try {
        const row = db.prepare("SELECT value, updated_at FROM settings WHERE key='config'").get();
        if (row) return row;
      } catch {
        /* not our database */
      } finally {
        db.close();
      }
    }
    return null;
  };
}

async function watchLocalDashboard() {
  process.removeAllListeners('warning'); // node:sqlite prints an "experimental" warning
  const read = await localConfigReader();
  let last = read()?.updated_at;
  setInterval(() => {
    try {
      const row = read();
      if (!row || row.updated_at === last) return;
      last = row.updated_at;
      pullFrom('local', JSON.parse(row.value), { quiet: true });
    } catch (e) {
      console.error('config.json write-back failed:', e.message);
    }
  }, 3000);
  console.log('↺ Dashboard changes are written back to config.json automatically while `pnpm dev` runs.');
}

// ── main ──
if (mode === 'local' || mode === 'remote') {
  if (mode === 'local') wrangler(['d1', 'migrations', 'apply', DB, '--local']);
  apply(mode);
} else if (mode === 'deploy') {
  // build → migrate → apply config.json (guarded) → deploy. The build reads wrangler.local.jsonc.
  const run = (cmd, args) => {
    const r = spawnSync(cmd, args, { cwd: ROOT, stdio: 'inherit' });
    if (r.status !== 0) process.exit(r.status ?? 1);
  };
  if (
    WRANGLER_CONFIG === 'wrangler.jsonc' &&
    readFileSync(join(ROOT, 'wrangler.jsonc'), 'utf8').includes('00000000-0000')
  ) {
    console.error(
      '✗ Set your D1 database id first: copy wrangler.jsonc to wrangler.local.jsonc and fill it in.',
    );
    process.exit(1);
  }
  run('pnpm', ['exec', 'vp', 'build']);
  wrangler(['d1', 'migrations', 'apply', DB, '--remote']);
  apply('remote');
  run('pnpm', ['exec', 'wrangler', 'deploy']);
} else if (mode === 'pull') {
  pull(rest.includes('--remote') ? 'remote' : 'local');
} else if (mode === 'dev') {
  wrangler(['d1', 'migrations', 'apply', DB, '--local']);
  apply('local', { soft: true });
  const child = spawn('pnpm', ['exec', 'vp', 'dev', ...passThrough], { cwd: ROOT, stdio: 'inherit' });
  child.on('exit', (code) => process.exit(code ?? 0));
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => child.kill(sig));
  await watchLocalDashboard();
} else {
  console.error('usage: node scripts/config.mjs local|remote|pull [--remote]|dev|deploy [--force]');
  process.exit(1);
}
