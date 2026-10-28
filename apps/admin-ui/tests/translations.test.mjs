import { readFileSync } from "node:fs";
import { test } from "node:test";
import assert from "node:assert/strict";

const read = (language) =>
  JSON.parse(readFileSync(new URL(`../src/locales/${language}.json`, import.meta.url)));
const variables = (text) =>
  [...text.matchAll(/\{\{\s*([^}]+)\s*\}\}/g)].map((match) => match[1]).sort();

test("Japanese and English cover the same messages and interpolation values", () => {
  const ja = read("ja"),
    en = read("en");
  assert.deepEqual(Object.keys(en).sort(), Object.keys(ja).sort());
  for (const key of Object.keys(ja)) {
    assert.ok(ja[key].trim() && en[key].trim(), `Empty translation: ${key}`);
    assert.deepEqual(variables(en[key]), variables(ja[key]), `Interpolation mismatch: ${key}`);
    assert.doesNotMatch(en[key], /[\u3040-\u30ff\u3400-\u9fff]/, `Untranslated English: ${key}`);
  }
});
