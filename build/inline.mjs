import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');

const MODULE_ORDER = [
  'id.js', 'hash.js', 'normalize.js', 'scoring.js', 'urlParser.js',
  'taskKey.js', 'sourceLinks.js', 'discovery.js',
  'storage.js', 'aiClient.js', 'mcpAdapters.js', 'seedMerge.js', 'ui.js', 'app.js', 'main.js',
];

function assertModuleOrderIsComplete() {
  // Real bug, hit twice now: a file gets added to src/ and imported by
  // another module, but someone (repeatedly, apparently) forgets to add it
  // to MODULE_ORDER — the import line still gets stripped "successfully,"
  // but the function bodies it referenced are just absent, leaving dangling
  // references that only throw at runtime. No unit test catches this since
  // tests import src/*.js directly, never the concatenated build. Fail the
  // build loudly instead.
  const actualFiles = readdirSync(join(root, 'src')).filter((f) => f.endsWith('.js'));
  const missing = actualFiles.filter((f) => !MODULE_ORDER.includes(f));
  if (missing.length) {
    throw new Error(
      `build/inline.mjs: MODULE_ORDER is missing file(s) present in src/: ${missing.join(', ')}. ` +
      'Add them to MODULE_ORDER (in dependency order) before building.'
    );
  }
}

const TOP_LEVEL_DECL_RE = /^(?:export\s+)?(?:async\s+)?(?:function|const|let|class)\s+([A-Za-z_$][A-Za-z0-9_$]*)/;

function assertNoDuplicateTopLevelNames(sourcesByFile) {
  // Real bug, hit once already (discovery.js and aiClient.js both privately
  // declared stripCodeFences): this build concatenates every file into one
  // flat script with no module isolation, so two files declaring the same
  // top-level name — even both non-exported "private" helpers — collide.
  // Under a module script that's a hard SyntaxError that kills the *entire*
  // script (not a shadowing warning), which is why it's worth its own check
  // rather than hoping it's caught by the (correctly passing) per-file unit
  // tests, which never see this shared scope.
  const declaredIn = new Map(); // name -> file
  for (const [file, src] of sourcesByFile) {
    for (const line of src.split('\n')) {
      const match = line.match(TOP_LEVEL_DECL_RE);
      if (!match) continue;
      const [, name] = match;
      if (declaredIn.has(name) && declaredIn.get(name) !== file) {
        throw new Error(
          `build/inline.mjs: "${name}" is declared as a top-level identifier in both ` +
          `${declaredIn.get(name)} and ${file}. This build has no module isolation — ` +
          'rename one of them (or share it from a single file) before building.'
        );
      }
      declaredIn.set(name, file);
    }
  }
}

// Matches a whole local import statement as a block, spanning multiple
// lines if needed (`[\s\S]*?` crosses newlines) — NOT line-by-line. A
// line-based regex only catches single-line imports; a real bug (found via
// live testing, not any unit test) was a multi-line `import {\n  a, b,\n}
// from './x.js';` surviving completely untouched because no single line of
// it matched a line-anchored pattern, leaving a duplicate binding against
// the same names inlined from x.js itself — a SyntaxError that kills the
// whole script.
const IMPORT_BLOCK_RE = /import\s*\{[\s\S]*?\}\s*from\s*['"]\.\/[^'"]+['"];?/g;

function stripModuleSyntax(src, name) {
  const importBlocks = src.match(IMPORT_BLOCK_RE) ?? [];
  for (const block of importBlocks) {
    if (/\bas\b/.test(block)) {
      throw new Error(
        `${name}: aliased import ("${block.replace(/\s+/g, ' ').trim()}") cannot be flattened by this ` +
        'concatenation build — the alias binding is silently lost, leaving a ' +
        'dangling reference at runtime. Import the real name directly instead.'
      );
    }
  }
  return src
    .replace(IMPORT_BLOCK_RE, '')
    .replace(/^export\s+(?=(function|const|class|async function))/gm, '');
}

function build() {
  assertModuleOrderIsComplete();

  const rawSources = MODULE_ORDER.map((name) => [name, readFileSync(join(root, 'src', name), 'utf8')]);
  assertNoDuplicateTopLevelNames(rawSources);

  const bodies = rawSources.map(([name, src]) => `// --- ${name} ---\n${stripModuleSyntax(src, name)}`).join('\n\n');

  const shell = readFileSync(join(root, 'build', 'shell.html'), 'utf8');
  const output = shell.replace('/*__TASK_JUGGLER_SCRIPT__*/', bodies);

  mkdirSync(join(root, 'dist'), { recursive: true });
  writeFileSync(join(root, 'dist', 'task-juggler.html'), output);
  console.log(`Built dist/task-juggler.html (${output.length} bytes)`);
}

build();
