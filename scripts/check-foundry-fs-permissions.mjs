import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, normalize } from 'node:path';

function walk(dir) {
  const files = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const stat = statSync(full);
    if (stat.isDirectory()) files.push(...walk(full));
    else if (name.endsWith('.sol')) files.push(full);
  }
  return files;
}

function cleanPath(value) {
  return normalize(value.replace(/^\.\//, '')).replaceAll('\\', '/');
}

const foundry = readFileSync('foundry.toml', 'utf8');
const granted = new Set();
for (const match of foundry.matchAll(/\{[^}]*access\s*=\s*"read-write"[^}]*path\s*=\s*"([^"]+)"[^}]*\}/g)) {
  granted.add(cleanPath(match[1]));
}
for (const match of foundry.matchAll(/\{[^}]*path\s*=\s*"([^"]+)"[^}]*access\s*=\s*"read-write"[^}]*\}/g)) {
  granted.add(cleanPath(match[1]));
}

const required = new Map();
for (const file of walk('script')) {
  const source = readFileSync(file, 'utf8');
  for (const match of source.matchAll(/\.writeJson\s*\(\s*[^,]+,\s*"([^"]+)"\s*\)/g)) {
    const target = cleanPath(match[1]);
    if (!required.has(target)) required.set(target, []);
    required.get(target).push(file);
  }
}

const missing = [...required].filter(([target]) => !granted.has(target));
if (missing.length) {
  const details = missing
    .map(([target, files]) => `${target} (written by ${[...new Set(files)].join(', ')})`)
    .join('\n - ');
  throw new Error(`Foundry write permission missing for deployment manifest(s):\n - ${details}\nAdd an exact read-write fs_permissions entry in foundry.toml.`);
}

console.log(`Foundry fs_permissions PASS · ${required.size} deployment manifest write target(s) covered`);
