/**
 * Integration tests for kiri-server CLI
 */

import { dirname, join } from "path";
import { fileURLToPath } from "url";

import { createCliTests } from "../shared/cli/testHelpers.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const serverPath = join(__dirname, "../../dist/src/server/main.js");

const cliTests = createCliTests({
  cliPath: serverPath,
  commandName: "kiri-server",
  description: "KIRI MCP Server",
  expectedSections: [
    "Repository / Database:",
    "--repo",
    "--db",
    "Server Mode:",
    "--port",
    "Indexing:",
    "--reindex",
    "--allow-degrade",
    "Watch Mode:",
    "--watch",
    "--debounce",
    "Security:",
    "--security-config",
  ],
});

cliTests.runAll();
