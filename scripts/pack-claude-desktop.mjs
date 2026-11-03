import { execFileSync } from "node:child_process";
import { cpSync, copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const staging = mkdtempSync(join(tmpdir(), "k8s-cronjob-mcp-"));
const output = join(root, "dist", "k8s-cronjob-mcp.mcpb");

try {
  for (const file of ["package.json", "package-lock.json"]) {
    copyFileSync(join(root, file), join(staging, file));
  }
  const manifest = JSON.parse(readFileSync(join(root, "claude-desktop", "manifest.json"), "utf8"));
  manifest.version = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
  writeFileSync(join(staging, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  cpSync(join(root, "dist"), join(staging, "dist"), { recursive: true });

  execFileSync("npm", ["ci", "--omit=dev"], { cwd: staging, stdio: "inherit" });
  execFileSync("npx", ["--yes", "@anthropic-ai/mcpb", "pack", staging, output], {
    cwd: root,
    stdio: "inherit",
  });
  console.log(`Created ${output}`);
} finally {
  rmSync(staging, { recursive: true, force: true });
}