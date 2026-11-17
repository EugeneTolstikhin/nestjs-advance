import { existsSync } from "node:fs";
import { join } from "node:path";
import { loadEnvFile } from "node:process";

// Always load this application's configuration, regardless of the caller's cwd.
const path = join(__dirname, "../.env");
if (existsSync(path)) loadEnvFile(path);
