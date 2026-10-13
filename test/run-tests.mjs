#!/usr/bin/env node
// Executes the REAL sandboxed JS extracted from template.tpl against
// simulated GTM web APIs, then asserts on every oaiq() call it makes. It is
// not a mirror of the logic: a green run means the shipping artifact behaves.
// Google's in-editor test runner (the ___TESTS___ section) remains the
// authority on sandbox semantics; both suites must pass.
//
// Run:   node test/run-tests.mjs
// Also:  node test/run-tests.mjs --fixtures <path>   writes the recorded calls
//        in the Pixel Lab fixture format, for replay against OpenAI's live SDK.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const tpl = readFileSync(join(root, "template.tpl"), "utf8");
const start = tpl.indexOf("___SANDBOXED_JS_FOR_WEB_TEMPLATE___");
const end = tpl.indexOf("___WEB_PERMISSIONS___");
if (start < 0 || end < 0) throw new Error("template sentinels not found");
const code = tpl.slice(start + "___SANDBOXED_JS_FOR_WEB_TEMPLATE___".length, end);

const PIXEL = "PIXEL_ID_PLACEHOLDER";
const sha = (s) => createHash("sha256").update(s, "utf8").digest("hex");
const getType = (v) => (v === null ? "null" : Array.isArray(v) ? "array" : typeof v);

// A page: shared state across several tag fires (data layer, consent,
// cookies, local storage, template storage, the oaiq queue).
function newPage(opts = {}) {
  return {
    dl: opts.dl || {},
    consent: { ad_storage: true, ad_user_data: true, ...(opts.consent || {}) },
    cookies: opts.cookies || {},
    path: opts.path || "/thanks",
    now: opts.now || 1700000000000,
    preview: !!opts.preview,
    sdkFails: !!opts.sdkFails,
    local: new Map(Object.entries(opts.local || {})),
    tstore: new Map(),
    listeners: [],
    calls: [], // [command, ...args] as passed to oaiq
    pushes: [], // dataLayer pushes by the template
    injected: [],
    logs: [],
    window: {},
  };
}

function apis(page) {
  const api = {
    addConsentListener: (type, cb) => page.listeners.push([type, cb]),
    callInWindow: (path, ...args) => {
      if (path !== "oaiq") throw new Error("unexpected callInWindow " + path);
      page.calls.push(structuredClone(args));
    },
    copyFromDataLayer: (key) => (page.dl[key] === undefined ? undefined : structuredClone(page.dl[key])),
    copyFromWindow: (k) => page.window[k],
    createArgumentsQueue: (fnName) => {
      const fn = () => {};
      page.window[fnName] = fn;
      return fn;
    },
    createQueue: (name) => (obj) => page.pushes.push([name, structuredClone(obj)]),
    generateRandom: () => 123456789,
    getContainerVersion: () => ({ previewMode: page.preview, debugMode: false }),
    getCookieValues: (name) => page.cookies[name] || [],
    getTimestampMillis: () => page.now,
    getType,
    getUrl: (part) => (part === "path" ? page.path : "https://example.com" + page.path),
    injectScript: (url, ok, fail) => {
      page.injected.push(url);
      queueMicrotask(page.sdkFails ? fail : ok);
    },
    isConsentGranted: (t) => page.consent[t] !== false,
    JSON: { parse: (s) => { try { return JSON.parse(s); } catch { return undefined; } }, stringify: JSON.stringify },
    localStorage: { getItem: (k) => (page.local.has(k) ? page.local.get(k) : null), setItem: (k, v) => page.local.set(k, String(v)) },
    logToConsole: (...a) => page.logs.push(a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" ")),
    makeNumber: (v) => Number(v),
    makeString: (v) => String(v),
    makeTableMap: (rows, k, v) => (rows && rows.length ? Object.fromEntries(rows.map((r) => [r[k], r[v]])) : null),
    Math,
    Object: { keys: Object.keys, values: Object.values, entries: Object.entries, delete: (o, k) => delete o[k] },
    sha256: (input, ok, _err, o) => queueMicrotask(() => ok(createHash("sha256").update(String(input), "utf8").digest(o && o.outputEncoding === "hex" ? "hex" : "base64"))),
    templateStorage: {
      getItem: (k) => page.tstore.get(k),
      setItem: (k, v) => page.tstore.set(k, v),
      removeItem: (k) => page.tstore.delete(k),
      clear: () => page.tstore.clear(),
    },
  };
  return (name) => {
    if (!(name in api)) throw new Error("template required an un-simulated API: " + name);
    return api[name];
  };
}

const defaults = {
  pixelId: PIXEL,
  eventSource: "auto",
  unmappedBehavior: "skip",
  valueSource: "event",
  sendUserData: true,
  consentSource: "gcm",
  userDataConsent: true,
  eventIdSource: "auto",
  shareEventId: true,
  guardRepeats: true,
  guardHours: "24",
  reportIssues: false,
  alwaysDebug: false,
};

async function fire(page, config = {}) {
  const result = { success: 0, failure: 0 };
  const data = { ...defaults, ...config, gtmOnSuccess: () => result.success++, gtmOnFailure: () => result.failure++ };
  const ctx = vm.createContext({ require: apis(page), data });
  vm.runInContext(`(function(){${code}\n})()`, ctx, { timeout: 2000 });
  await settle();
  return result;
}
const settle = async () => {
  for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
};
async function setConsent(page, granted) {
  page.consent.ad_storage = granted;
  for (const [type, cb] of page.listeners) if (type === "ad_storage") cb("ad_storage", granted);
  await settle();
}
const measures = (page) => page.calls.filter((c) => c[0] === "measureSingle");

const viewItem = { currency: "USD", value: 49, items: [{ item_id: "PRO", item_name: "Pro plan", price: 49, quantity: 1 }] };

// ---- scenarios -------------------------------------------------------------
const scenarios = [];
const scenario = (id, title, fn, lab = true) => scenarios.push({ id, title, fn, lab });

scenario("lead-after-view-item", "Lead after a product view: own value, no contents (Stape drops this)", async () => {
  const page = newPage({ dl: { event: "generate_lead", value: 500, currency: "USD", ecommerce: viewItem } });
  const r = await fire(page);
  const m = measures(page);
  assert.equal(m.length, 1);
  assert.deepEqual(m[0].slice(1, 4), [PIXEL, "lead_created", { type: "customer_action", amount: 50000, currency: "USD" }]);
  assert.equal(m[0][4].event_id, "1700000000000.123456789");
  assert.deepEqual(page.injected, ["https://bzrcdn.openai.com/sdk/oaiq.min.js"]);
  assert.deepEqual([r.success, r.failure], [1, 0]);
  return page;
});

scenario("form-submit-default", "GTM Form Submission, default settings: skipped with a reason", async () => {
  const page = newPage({ dl: { event: "gtm.formSubmit" } });
  const r = await fire(page);
  assert.equal(measures(page).length, 0);
  assert.ok(page.logs.some((l) => l.includes('"gtm.formSubmit" has no ChatGPT Ads mapping')));
  assert.equal(r.success, 1);
  return page;
}, false);

scenario("form-submit-as-lead", "GTM Form Submission with the lead option on: lead_created", async () => {
  const page = newPage({ dl: { event: "gtm.formSubmit" } });
  await fire(page, { formSubmitAsLead: true });
  assert.deepEqual(measures(page)[0].slice(2, 4), ["lead_created", { type: "customer_action" }]);
  return page;
});

scenario("unmapped-as-custom", "Unmapped event, 'send as custom': name cleaned to OpenAI's rules", async () => {
  const page = newPage({ dl: { event: "Demo.Form Submit!" } });
  await fire(page, { unmappedBehavior: "custom" });
  const m = measures(page);
  assert.equal(m[0][2], "custom");
  assert.equal(m[0][4].custom_event_name, "demo_form_submit");
  return page;
});

scenario("custom-invalid", "Manual custom event with an invalid name: Failed, nothing sent", async () => {
  const page = newPage({ dl: { event: "x" } });
  const r = await fire(page, { eventSource: "manual", eventName: "custom", customEventName: "gtm.formSubmit", reportIssues: true });
  assert.equal(measures(page).length, 0);
  assert.deepEqual([r.success, r.failure], [0, 1]);
  assert.equal(page.pushes[0][1].event, "chatgpt_ads_pixel_issue");
  return page;
}, false);

scenario("value-set-regular-units", "Value set on the tag (23.5 usd): amount 2350 USD", async () => {
  const page = newPage({ dl: { event: "generate_lead" } });
  await fire(page, { valueSource: "set", value: "23.5", currency: "usd" });
  assert.deepEqual(measures(page)[0][3], { type: "customer_action", amount: 2350, currency: "USD" });
  return page;
});

scenario("value-no-currency", "Value without currency: value removed, lead still sent", async () => {
  const page = newPage({ dl: { event: "generate_lead", value: 500 } });
  await fire(page);
  assert.deepEqual(measures(page)[0][3], { type: "customer_action" });
  assert.ok(page.logs.some((l) => l.includes("requires a currency")));
  return page;
});

scenario("currency-idr", "IDR uses ISO 4217's 2 decimals (Stape treats it as 0)", async () => {
  const page = newPage({ dl: { event: "generate_lead", value: 150000, currency: "IDR" } });
  await fire(page);
  assert.equal(measures(page)[0][3].amount, 15000000);
  return page;
}, false);

scenario("purchase-contents", "GA4 purchase: contents and amount from the ecommerce object", async () => {
  const page = newPage({ dl: { event: "purchase", ecommerce: { currency: "EUR", value: 98, items: [{ item_id: "A", item_name: "Seat", price: 49, quantity: 2, item_brand: "x" }] } } });
  await fire(page);
  assert.deepEqual(measures(page)[0][3], {
    type: "contents",
    contents: [{ content_type: "product", id: "A", name: "Seat", quantity: 2, amount: 4900 }],
    amount: 9800,
    currency: "EUR",
  });
  return page;
});

scenario("listener-demo", "Listener event b2b_lead with lead_type appointment_scheduled", async () => {
  const page = newPage({ dl: { event: "b2b_lead", lead_type: "appointment_scheduled", dedupe_id: "cal-1" } });
  await fire(page);
  assert.deepEqual(measures(page)[0].slice(2, 4), ["appointment_scheduled", { type: "customer_action" }]);
  return page;
});

scenario("trial-plan-id", "Trial with plan_id from the data layer", async () => {
  const page = newPage({ dl: { event: "trial_started", plan_id: "growth-monthly" } });
  await fire(page);
  assert.deepEqual(measures(page)[0][3], { type: "plan_enrollment", plan_id: "growth-monthly" });
  return page;
});

scenario("user-mapping", "User mapping table: demo_booked -> appointment_scheduled", async () => {
  const page = newPage({ dl: { event: "demo_booked" } });
  await fire(page, { eventMappings: [{ gtmEvent: "demo_booked", openaiEvent: "appointment_scheduled" }] });
  assert.equal(measures(page)[0][2], "appointment_scheduled");
  return page;
}, false);

scenario("user-data-hashed", "Customer data: normalized, hashed, sent on init; postal_code kept", async () => {
  const page = newPage({
    dl: { event: "generate_lead", user_data: { email: " Jane.Doe@Example.com ", phone_number: "+1 (415) 555-0100", address: { first_name: "José", last_name: "O'Neil", city: "San Francisco", postal_code: "94107", country: "us" } } },
  });
  await fire(page);
  const init = page.calls.find((c) => c[0] === "init")[1];
  assert.deepEqual(init.user, {
    email_sha256: sha("jane.doe@example.com"),
    phone_number_sha256: sha("14155550100"),
    first_name_sha256: sha("josé"),
    last_name_sha256: sha("oneil"),
    country: "US",
    city: "San Francisco",
    postal_code: "94107",
  });
  return page;
});

scenario("user-data-no-ad-user-data", "ad_user_data denied: event sent, customer data withheld", async () => {
  const page = newPage({ dl: { event: "generate_lead", user_data: { email: "a@b.co" } }, consent: { ad_user_data: false } });
  await fire(page);
  assert.equal(measures(page).length, 1);
  assert.equal(page.calls.find((c) => c[0] === "init")[1].user, undefined);
  return page;
}, false);

scenario("consent-denied-fresh", "Consent denied, no pixel cookies: consent false, nothing loaded", async () => {
  const page = newPage({ dl: { event: "generate_lead" }, consent: { ad_storage: false } });
  const r = await fire(page);
  assert.deepEqual(page.calls, [["consent", false]]);
  assert.equal(page.injected.length, 0);
  assert.equal(r.success, 1);
  return page;
}, false);

scenario("consent-denied-then-granted", "Denied, then granted on the same page: held event is sent", async () => {
  const page = newPage({ dl: { event: "generate_lead" }, consent: { ad_storage: false } });
  await fire(page);
  await setConsent(page, true);
  assert.deepEqual(page.calls[0], ["consent", false]);
  assert.deepEqual(page.calls[1], ["consent", true]);
  assert.equal(measures(page).length, 1);
  return page;
}, false);

scenario("consent-denied-with-cookies", "Denied with existing pixel cookies: SDK loaded so OpenAI removes them", async () => {
  const page = newPage({ dl: { event: "generate_lead" }, consent: { ad_storage: false }, cookies: { __obref: ["abc"] } });
  await fire(page);
  assert.deepEqual(page.calls[0], ["consent", false]);
  assert.equal(page.calls[1][0], "init");
  assert.equal(measures(page).length, 0);
  assert.equal(page.injected.length, 1);
  return page;
}, false);

scenario("consent-withdrawn", "Granted, then withdrawn mid-session: consent false sent", async () => {
  const page = newPage({ dl: { event: "generate_lead" } });
  await fire(page);
  await setConsent(page, false);
  assert.deepEqual(page.calls[page.calls.length - 1], ["consent", false]);
  return page;
}, false);

scenario("stored-denial-lifted", "Stored denial cookie but consent now granted: consent true before init", async () => {
  const page = newPage({ dl: { event: "generate_lead" }, cookies: { __oaiq_consent: ["false"] } });
  await fire(page);
  assert.deepEqual(page.calls[0], ["consent", true]);
  assert.equal(page.calls[1][0], "init");
  assert.equal(measures(page).length, 1);
  return page;
}, false);

scenario("repeat-guard", "Thank-you page reloaded: second lead ignored", async () => {
  const page = newPage({ dl: { event: "generate_lead" } });
  await fire(page);
  page.tstore.clear(); // a reload starts a new page; local storage survives
  page.calls = [];
  await fire(page);
  assert.equal(measures(page).length, 0);
  assert.ok(page.logs.some((l) => l.includes("repeat window")));
  return page;
}, false);

scenario("repeat-guard-expired", "Same lead after the window: sent again", async () => {
  const page = newPage({ dl: { event: "generate_lead" } });
  await fire(page);
  page.tstore.clear();
  page.calls = [];
  page.now += 25 * 3600000;
  await fire(page);
  assert.equal(measures(page).length, 1);
  return page;
}, false);

scenario("multi-pixel", "Two Pixel IDs: one init and one measureSingle each", async () => {
  const page = newPage({ dl: { event: "generate_lead" } });
  await fire(page, { pixelId: "PIXEL_A, PIXEL_B,," });
  assert.deepEqual(measures(page).map((c) => c[1]), ["PIXEL_A", "PIXEL_B"]);
  assert.equal(page.calls.filter((c) => c[0] === "init").length, 2);
  return page;
}, false);

scenario("init-once", "Second event on the same page does not re-init without customer data", async () => {
  const page = newPage({ dl: { event: "page_view" } });
  await fire(page);
  page.dl = { event: "generate_lead" };
  await fire(page);
  assert.equal(page.calls.filter((c) => c[0] === "init").length, 1);
  assert.equal(measures(page).length, 2);
  return page;
}, false);

scenario("share-event-id", "Event ID pushed to the data layer for a server-side tag", async () => {
  const page = newPage({ dl: { event: "generate_lead" } });
  await fire(page);
  assert.deepEqual(page.pushes[0], ["dataLayer", { event: "chatgpt_ads_pixel_sent", chatgpt_ads_event_name: "lead_created", chatgpt_ads_event_id: "1700000000000.123456789" }]);
  return page;
}, false);

scenario("own-event-ignored", "The template's own data layer event never triggers a send", async () => {
  const page = newPage({ dl: { event: "chatgpt_ads_pixel_sent" } });
  await fire(page, { unmappedBehavior: "custom" });
  assert.equal(measures(page).length, 0);
  return page;
}, false);

scenario("sdk-load-failure", "SDK blocked: tag reports Failed", async () => {
  const page = newPage({ dl: { event: "generate_lead" }, sdkFails: true });
  const r = await fire(page);
  assert.deepEqual([r.success, r.failure], [0, 1]);
  return page;
}, false);

scenario("missing-pixel", "No valid Pixel ID: Failed", async () => {
  const page = newPage({ dl: { event: "generate_lead" } });
  const r = await fire(page, { pixelId: " , " });
  assert.deepEqual([r.success, r.failure], [0, 1]);
  return page;
}, false);

// ---- run -------------------------------------------------------------------
let passed = 0;
const fixtures = [];
for (const s of scenarios) {
  try {
    const page = await s.fn();
    passed++;
    console.log("  ok   " + s.title);
    if (s.lab) fixtures.push({ id: "ours-" + s.id, title: "Ours: " + s.title, result: { oaiq: page.calls } });
  } catch (e) {
    console.log("  FAIL " + s.title + "\n       " + (e.message || e).split("\n").join("\n       "));
  }
}
console.log(`\n${passed}/${scenarios.length} passed`);

const fi = process.argv.indexOf("--fixtures");
if (fi !== -1) {
  const out = process.argv[fi + 1];
  writeFileSync(out, JSON.stringify({ source: "chatgpt-ads-pixel-b2b template.tpl", generatedAt: new Date().toISOString(), pixelPlaceholder: PIXEL, scenarios: fixtures }, null, 2) + "\n");
  console.log("Wrote " + out);
}
process.exit(passed === scenarios.length ? 0 : 1);
