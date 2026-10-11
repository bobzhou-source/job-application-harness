// lib/setup/scaffold.mjs — copy the missing example config files into place.

import { copyFile } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { join } from "node:path";
import { ROOT } from "./paths.mjs";
import { exists, isReadable } from "./fsutil.mjs";

const FILE_COPIES = [
  ["config.example.json", "config.json"],
  ["answers.example.json", "answers.json"],
  [".env.example", ".env"],
];

export async function copyMissingExamples() {
  for (const [sourceName, destinationName] of FILE_COPIES) {
    const source = join(ROOT, sourceName);
    const destination = join(ROOT, destinationName);
    if (await exists(destination)) {
      console.log(`[OK] ${destinationName} already exists; left unchanged`);
      continue;
    }
    if (!(await isReadable(source))) {
      throw new Error(`Cannot create ${destinationName}: missing ${sourceName}. Restore ${sourceName} and rerun: bun setup.mjs`);
    }
    await copyFile(source, destination, fsConstants.COPYFILE_EXCL);
    console.log(`[OK] Created ${destinationName} from ${sourceName}`);
  }
}
