/**
 * Integration tests for kiri-daemon CLI
 */

import { fileURLToPath } from "url";
import { dirname, join } from "path";

import { createCliTests } from "../shared/cli/testHelpers.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const daemonPath = join(__dirname, "../../dist/src/daemon/daemon.js");

const cliTests = createCliTests({
  cliPath: daemonPath,
  commandName: "kiri-daemon",
  description: "KIRI Daemon Process",
  expectedSections: [
    "Repository / Database:",
    "--repo",
    "--db",
    "Daemon Lifecycle:",
    "--socket-path",
    "--daemon-timeout",
    "Watch Mode:",
    "--watch",
    "Security:",
    "--allow-degrade",
    "--security-config",
  ],
});

cliTests.runAll();
