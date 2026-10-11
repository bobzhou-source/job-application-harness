// lib/setup/paths.mjs — repo root shared by the setup scaffolding and doctor checks.

import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

// Repo root: this module's directory is <root>/lib/setup/.
export const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
