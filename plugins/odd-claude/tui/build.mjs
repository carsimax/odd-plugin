// esbuild driver. Default: bundle the CLI + TUI into ONE file, dist/odd-claude.mjs (node >= 22, no npm install needed
// by the user). `--tests`: bundle each src/*.spec.tsx into dist-test/ with node_modules left external.
import { build } from "esbuild";
import { chmodSync, readdirSync, rmSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const tests = process.argv.includes("--tests");

const common = { bundle: true, platform: "node", target: "node22", format: "esm", jsx: "automatic", logLevel: "warning" };

if (tests) {
  rmSync(join(root, "dist-test"), { recursive: true, force: true });
  const specs = readdirSync(join(root, "src")).filter((f) => f.endsWith(".spec.tsx") || f.endsWith(".spec.ts"));
  await build({
    ...common,
    packages: "external",
    entryPoints: specs.map((f) => join(root, "src", f)),
    outdir: join(root, "dist-test"),
    outExtension: { ".js": ".mjs" },
  });
} else {
  const out = join(root, "dist", "odd-claude.mjs");
  await build({
    ...common,
    entryPoints: [join(root, "src", "main.tsx")],
    outfile: out,
    // ink loads react-devtools-core only when DEV=true; the bundle ships a stub instead of the package.
    alias: { "react-devtools-core": join(root, "src", "devtools-stub.ts") },
    // A CJS dependency inside an ESM bundle needs a working `require`.
    banner: { js: '#!/usr/bin/env node\nimport { createRequire as __oddCreateRequire } from "node:module";\nconst require = __oddCreateRequire(import.meta.url);' },
    legalComments: "none",
  });
  chmodSync(out, 0o755);
  console.log(`${out} ${(statSync(out).size / 1024).toFixed(0)} KiB`);
}
