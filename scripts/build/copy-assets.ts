import { cp, mkdir, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

async function copyAssetDirectory(
  sourceRelativePath: string,
  destinationRelativePath: string
): Promise<void> {
  const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  const sourcePath = resolve(projectRoot, sourceRelativePath);
  const destinationPath = resolve(projectRoot, destinationRelativePath);

  await mkdir(dirname(destinationPath), { recursive: true });
  await rm(destinationPath, { recursive: true, force: true });
  await cp(sourcePath, destinationPath, { recursive: true });
}

async function main(): Promise<void> {
  await mkdir(resolve(dirname(fileURLToPath(import.meta.url)), "../../dist"), { recursive: true });

  await copyAssetDirectory("config", "dist/config");
  await copyAssetDirectory("sql", "dist/sql");
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(
    `Failed to copy assets. Ensure source directories exist and re-run build. ${message}`
  );
  process.exitCode = 1;
});
