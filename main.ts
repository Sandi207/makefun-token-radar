// Node 22, standard library only. The snapshot is the sole data source.
// Production writes a complete deterministic artifact. Dev mode omits images
// and dossier so a browser can first capture the generated, populated page.
import { copyFileSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { boardIssue, buildRadar, dataScript, parseSnapshot } from './lib/model.ts';
import { buildDossier } from './vendor/makefun-board.ts';

const ROOT = fileURLToPath(new URL('.', import.meta.url));
const TEXT_CAP = 65_536;
const SAFE_NAME = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;

function options(args: string[]): { input: string; output: string } {
  const result = { input: '/input', output: process.env.MAKEFUN_OUTPUT_DIR || '/output' };
  const seen = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    const match = /^--(input|output)(?:=(.*))?$/.exec(args[i]);
    if (!match) throw new Error(`Unknown argument ${args[i]}; use --input <snapshot.json|dir> and --output <dir>`);
    const key = match[1] as 'input' | 'output';
    if (seen.has(key)) throw new Error(`--${key} was supplied twice`);
    seen.add(key);
    const value = match[2] ?? args[++i];
    if (!value || value.startsWith('--')) throw new Error(`--${key} requires a nonempty path`);
    result[key] = value;
  }
  return result;
}

/** Stable path order, plain files only; no hidden files or symlink traversal. */
function inventory(dir: string, prefix = ''): { source: string; path: string; bytes: number }[] {
  const files: { source: string; path: string; bytes: number }[] = [];
  for (const name of readdirSync(dir).sort()) {
    if (name.startsWith('.')) continue;
    if (!SAFE_NAME.test(name)) throw new Error(`Invalid artifact filename: ${name}`);
    const source = join(dir, name), path = prefix ? `${prefix}/${name}` : name;
    const info = lstatSync(source);
    if (info.isSymbolicLink()) throw new Error(`Artifact must not be a symlink: ${path}`);
    if (info.isDirectory()) files.push(...inventory(source, path));
    else if (info.isFile()) files.push({ source, path, bytes: info.size });
    else throw new Error(`Artifact must be a regular file: ${path}`);
  }
  return files;
}

function dashboardIssue(files: ReturnType<typeof inventory>): string | null {
  if (!files.some(f => f.path === 'index.html') || !files.some(f => f.path.endsWith('.css')) || !files.some(f => f.path.endsWith('.js'))) return 'index.html plus CSS and JavaScript are required';
  if (files.length > 400 || files.reduce((n, f) => n + f.bytes, 0) > 4_194_304) return 'dashboard exceeds 400 files or 4 MiB';
  const textBytes = files.filter(f => /\.(html|css|js)$/.test(f.path)).reduce((n, f) => n + f.bytes, 0);
  // Room for the dossier headings as well as every line of dashboard source.
  if (textBytes > 55_000) return `dashboard source is ${textBytes} bytes; this entry's budget is 55000`;
  for (const f of files) {
    if (!/\.(html|css|js)$/.test(f.path)) continue;
    if (/https?:\/\//i.test(readFileSync(f.source, 'utf8'))) return `${f.path} contains a network address`;
  }
  return null;
}

function copyInventory(files: ReturnType<typeof inventory>, destination: string): void {
  rmSync(destination, { recursive: true, force: true });
  mkdirSync(destination, { recursive: true });
  for (const f of files) {
    const target = join(destination, f.path);
    mkdirSync(resolve(target, '..'), { recursive: true });
    copyFileSync(f.source, target);
  }
}

function run(): void {
  const args = options(process.argv.slice(2));
  const input = statSync(args.input).isDirectory() ? join(args.input, 'snapshot.json') : args.input;
  const output = resolve(args.output), within = relative(ROOT, output);
  if (within === '' || (!isAbsolute(within) && !within.startsWith('..') && ['dashboard', 'screenshots', 'lib', 'vendor', '.git', '.makefun'].includes(within.split(/[\\/]/)[0]))) {
    throw new Error('Output directory would overlap repository source; choose out/ or a separate output directory');
  }
  const snapshot = parseSnapshot(readFileSync(input, 'utf8'));
  const { board, radar } = buildRadar(snapshot);
  const invalid = boardIssue(board, snapshot);
  if (invalid) throw new Error(`Board gate failed: ${invalid}`);
  const dashboard = inventory(join(ROOT, 'dashboard'));
  const badDashboard = dashboardIssue(dashboard);
  if (badDashboard) throw new Error(`Dashboard gate failed: ${badDashboard}`);
  const skip = process.env.MAKEFUN_SKIP_SCREENSHOTS === '1';
  const screenshots = skip ? [] : inventory(join(ROOT, 'screenshots'));
  if (!skip && (screenshots.length !== 3 || screenshots.some(f => !/\.(png|jpe?g)$/i.test(f.path) || f.bytes > 524_288))) {
    throw new Error('Screenshot gate failed: provide exactly three PNG/JPEG images, each at most 512 KiB');
  }
  mkdirSync(output, { recursive: true });
  writeFileSync(join(output, 'board.json'), JSON.stringify({ rows: board }) + '\n');
  writeFileSync(join(output, 'data.js'), dataScript(radar));
  copyInventory(dashboard, join(output, 'dashboard'));
  rmSync(join(output, 'dossier.json'), { force: true });
  rmSync(join(output, 'screenshots'), { recursive: true, force: true });
  if (!skip) {
    copyInventory(screenshots, join(output, 'screenshots'));
    const dossier = buildDossier(output, { text_max_bytes: TEXT_CAP });
    if (Buffer.byteLength(dossier) > 1_572_864) throw new Error('Dossier gate failed: dossier exceeds 1.5 MiB');
    writeFileSync(join(output, 'dossier.json'), dossier);
  }
  process.stdout.write(`Token Radar: ${radar.stats.scanned} scanned · ${board.length} ranked · ${radar.stats.covered}/${radar.stats.watchlist} watchlist · ${radar.stats.early} early\n`);
  process.stdout.write(`Wrote board.json, data.js and dashboard/ (${dashboard.length} files)${skip ? '; dev mode: screenshots and dossier omitted' : ', screenshots/ (3 images) and dossier.json'}\n`);
}

try { run(); }
catch (error) {
  process.stderr.write(`Token Radar failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
