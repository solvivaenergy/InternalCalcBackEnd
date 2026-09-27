// Compare two captures from capture.mjs. Exit 0 when every scenario and the
// merged parameter objects are identical; otherwise lists the first
// differing path per scenario and exits 1.
//
//   node scripts/engine-parity/compare.mjs <before.json> <after.json>
import { readFileSync } from "node:fs";

const [aPath, bPath] = process.argv.slice(2);
if (!aPath || !bPath) {
  console.error("usage: compare.mjs <before.json> <after.json>");
  process.exit(2);
}
const a = JSON.parse(readFileSync(aPath, "utf8"));
const b = JSON.parse(readFileSync(bPath, "utf8"));

const short = (v) => {
  const s = JSON.stringify(v);
  return s == null ? String(v) : s.length > 80 ? s.slice(0, 77) + "..." : s;
};
function firstDiff(x, y, path) {
  if (Array.isArray(x) !== Array.isArray(y) || typeof x !== typeof y || (x === null) !== (y === null)) {
    return `${path}: ${short(x)} vs ${short(y)}`;
  }
  if (x && typeof x === "object") {
    const keys = [...new Set([...Object.keys(x), ...Object.keys(y)])].sort();
    for (const k of keys) {
      if (!(k in x)) return `${path}.${k}: (absent before) vs ${short(y[k])}`;
      if (!(k in y)) return `${path}.${k}: ${short(x[k])} vs (absent after)`;
      const d = firstDiff(x[k], y[k], `${path}.${k}`);
      if (d) return d;
    }
    return null;
  }
  return x === y ? null : `${path}: ${short(x)} vs ${short(y)}`;
}

let ok = 0, bad = 0;
const diffs = [];
const check = (label, x, y) => {
  const d = firstDiff(x, y, label);
  if (d) { bad++; diffs.push(d); } else ok++;
};
check("runtime", a.runtime, b.runtime);
for (const id of [...new Set([...Object.keys(a.proposals || {}), ...Object.keys(b.proposals || {})])].sort()) {
  check(id, a.proposals?.[id], b.proposals?.[id]);
}
console.log(`${ok} identical, ${bad} different`);
for (const d of diffs.slice(0, 25)) console.log(`  ${d}`);
if (diffs.length > 25) console.log(`  … ${diffs.length - 25} more`);
process.exit(bad ? 1 : 0);
