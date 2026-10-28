import { build } from "esbuild";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkg = path.join(root, "packages/client"),
  out = path.join(pkg, "dist"),
  types = path.join(out, ".types");
await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });
await build({
  entryPoints: [path.join(pkg, "src/index.ts"), path.join(pkg, "src/config.ts")],
  outdir: out,
  format: "esm",
  platform: "neutral",
  target: "es2022",
  bundle: true,
  external: ["zod"],
  alias: {
    "@workers-workload-identity/contracts": path.join(root, "packages/contracts/src/index.ts"),
  },
  legalComments: "eof",
});
const config = path.join(out, "tsconfig.build.json");
await writeFile(
  config,
  JSON.stringify({
    extends: path.join(root, "tsconfig.base.json"),
    compilerOptions: {
      noEmit: false,
      declaration: true,
      emitDeclarationOnly: true,
      rootDir: path.join(root, "packages"),
      outDir: types,
    },
    files: [
      path.join(pkg, "src/index.ts"),
      path.join(pkg, "src/config.ts"),
      path.join(root, "packages/contracts/src/index.ts"),
    ],
    include: [],
  }),
);
try {
  execFileSync(
    process.execPath,
    [path.join(root, "node_modules/typescript/bin/tsc"), "-p", config],
    { cwd: root, stdio: "inherit" },
  );
  for (const [source, target] of [
    ["client/src/index.d.ts", "index.d.ts"],
    ["client/src/config.d.ts", "config.d.ts"],
    ["contracts/src/index.d.ts", "contracts.d.ts"],
  ]) {
    const content = await readFile(path.join(types, source), "utf8");
    await writeFile(
      path.join(out, target),
      content.replaceAll('"@workers-workload-identity/contracts"', '"./contracts.js"'),
    );
  }
  const source = JSON.parse(await readFile(path.join(pkg, "package.json"), "utf8"));
  await writeFile(
    path.join(out, "package.json"),
    JSON.stringify(
      {
        name: source.name,
        version: source.version,
        private: true,
        license: source.license,
        author: source.author,
        homepage: source.homepage,
        repository: source.repository,
        bugs: source.bugs,
        type: "module",
        exports: {
          ".": { types: "./index.d.ts", import: "./index.js" },
          "./config": { types: "./config.d.ts", import: "./config.js" },
        },
        dependencies: { zod: source.dependencies.zod },
        files: ["*.js", "*.d.ts", "README.md", "LICENSE"],
      },
      null,
      2,
    ),
  );
  await writeFile(path.join(out, "LICENSE"), await readFile(path.join(root, "LICENSE")));
  await writeFile(
    path.join(out, "README.md"),
    "# workers-workload-identity client\n\nPre-release caller SDK built from source with `pnpm client:build`. It is not published to npm.\n\nUse createOidcClient(binding).issue({ aud }) in the caller Worker. Use defineIssuerBinding from the /config entry point for deployment configuration.\n\nDocumentation: https://github.com/akita0724/workers-workload-identity\n",
  );
  console.log(
    "Client ESM bundle and TypeScript declarations built. npm publication remains disabled.",
  );
} finally {
  await rm(types, { recursive: true, force: true });
  await rm(config, { force: true });
}
