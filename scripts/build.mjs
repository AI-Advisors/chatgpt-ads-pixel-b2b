#!/usr/bin/env node
// Assembles template.tpl from src/. src/ is the source of truth; never edit
// template.tpl by hand. The icon is embedded programmatically and round-trip
// checked (a hand-transcribed thumbnail once shipped corrupt).
//
// Run: node scripts/build.mjs
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parameters } from "../src/parameters.mjs";
import { permissions } from "../src/permissions.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const read = (p) => readFileSync(join(root, p), "utf8");

const icon = readFileSync(join(root, "icon.png"));
const iconB64 = icon.toString("base64");
if (!Buffer.from(iconB64, "base64").equals(icon)) throw new Error("icon round-trip failed");

const info = {
  type: "TAG",
  id: "cvt_temp_public_id",
  version: 1,
  securityGroups: [],
  displayName: "ChatGPT Ads Pixel for B2B by AI-Advisors",
  categories: ["ADVERTISING", "CONVERSIONS", "LEAD_GENERATION"],
  brand: {
    id: "brand_dummy",
    displayName: "AI-Advisors",
    thumbnail: "data:image/png;base64," + iconB64,
  },
  description:
    "Sends ChatGPT Ads conversions to OpenAI's Measurement Pixel, built for B2B lead generation. Checks every event against OpenAI's rules before sending, so leads are not silently dropped. Uses OpenAI's consent command. Not affiliated with OpenAI.",
  containerContexts: ["WEB"],
};

const code = read("src/code.js").replace(/\s+$/, "");
const tests = read("src/tests.yaml").replace(/\s+$/, "");
const notes = read("src/notes.txt").replace(/\s+$/, "");

for (const [name, text] of [["code", code], ["tests", tests], ["notes", notes], ["info", JSON.stringify(info)], ["parameters", JSON.stringify(parameters)]]) {
  if (text.includes("\u2014")) throw new Error(`em dash in ${name}`);
}

const tos = `By creating or modifying this file you agree to Google Tag Manager's Community
Template Gallery Developer Terms of Service available at
https://developers.google.com/tag-manager/gallery-tos (or such other URL as
Google may provide), as modified from time to time.`;

const tpl = [
  "___TERMS_OF_SERVICE___",
  tos,
  "",
  "___INFO___",
  JSON.stringify(info, null, 2),
  "",
  "___TEMPLATE_PARAMETERS___",
  JSON.stringify(parameters, null, 2),
  "",
  "___SANDBOXED_JS_FOR_WEB_TEMPLATE___",
  code,
  "",
  "___WEB_PERMISSIONS___",
  JSON.stringify(permissions, null, 2),
  "",
  "___TESTS___",
  tests,
  "",
  "___NOTES___",
  notes,
  "",
].join("\n\n");

writeFileSync(join(root, "template.tpl"), tpl);
console.log(`template.tpl written (${tpl.length} chars, icon ${icon.length} bytes)`);
