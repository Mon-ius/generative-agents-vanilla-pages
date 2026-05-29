// check-all.mjs — run `node --check` over every js/**/*.js (excluding js/vendor).
// Dev-only; verifies all modules parse without a browser. Exits non-zero on any error.
import { readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const JS = join(ROOT, "js");

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) {
      if (name === "vendor") continue; // skip the vendored Pixi bundle
      walk(p, out);
    } else if (name.endsWith(".js")) {
      out.push(p);
    }
  }
  return out;
}

let fail = 0;
for (const f of walk(JS).sort()) {
  try {
    execFileSync(process.execPath, ["--check", f], { stdio: "pipe" });
    console.log("PASS", relative(ROOT, f));
  } catch (e) {
    fail++;
    console.log("FAIL", relative(ROOT, f));
    process.stderr.write((e.stderr || e.stdout || String(e)).toString() + "\n");
  }
}
console.log(`\n${fail ? fail + " FILE(S) FAILED" : "all files parse"}`);
process.exit(fail ? 1 : 0);
