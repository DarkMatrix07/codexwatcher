import test from "node:test";
import assert from "node:assert/strict";
import { extractJson } from "../brain/brain-client.js";

test("extractJson handles fenced json", () => {
  assert.deepEqual(JSON.parse(extractJson("```json\n{\"ok\":true}\n```")), { ok: true });
});

test("extractJson handles prose around json", () => {
  assert.deepEqual(JSON.parse(extractJson("Here:\n{\"ok\":true}\nThanks")), { ok: true });
});

test("extractJson handles trailing prose after json", () => {
  assert.deepEqual(JSON.parse(extractJson("{\"ok\":true}\nDone")), { ok: true });
});
