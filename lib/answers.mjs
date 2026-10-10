// answers.json load/save + question normalization. Schema: { facts: {...}, qa: { "<normalized question>": "<answer>" } }
import { readFileSync, writeFileSync } from 'node:fs';

export function load(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

export function save(path, data) {
  writeFileSync(path, JSON.stringify(data, null, 2) + '\n');
}

// lowercase, collapse whitespace/punctuation
export function normalize(question) {
  return String(question ?? '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
