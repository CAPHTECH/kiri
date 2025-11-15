/**
 * Integration tests for kiri proxy CLI
 */

import { dirname, join } from "path";
import { fileURLToPath } from "url";

import { createCliTests } from "../shared/cli/testHelpers.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const proxyPath = join(__dirname, "../../dist/src/client/proxy.js");

const cliTests = createCliTests({
  cliPath: proxyPath,
  commandName: "kiri",
  description: "KIRI MCP Client Proxy",
  expectedSections: [
    "Repository / Database:",
    "--repo",
    "--db",
    "Daemon Connection:",
    "--socket-path",
    "Watch Mode:",
    "--watch",
    "Security:",
    "--allow-degrade",
    "--security-config",
  ],
});

cliTests.runAll();
