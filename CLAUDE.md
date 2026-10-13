# ChatGPT Ads Pixel for B2B: a GTM Community Template

One Google Tag Manager **web** tag template by AI-Advisors that sends ChatGPT Ads conversions to OpenAI's Measurement Pixel, built for B2B lead gen. Sibling of `AI-Advisors/ai-crawler-analytics` (server-side); same org, same rules. Marketing site: `~/Projects/ai-advisors` (separate repo).

**Why it exists, in one line:** OpenAI's SDK validates events in the browser and silently drops invalid ones while GTM reports the tag as fired. Our Pixel Lab proved the leading template (Stape's) loses leads this way on pages with earlier GA4 ecommerce data (2026-10-13, confirmed in Ads Manager's Event Stream). This template validates first and never fails silently.

Background, evidence and spec live in the marketing repo:
- `docs/chatgpt-ads-pixel-template-competitive-analysis-2026-10-13.md`
- `docs/b2b-chatgpt-ads-pixel-template-spec-2026-10-13.md`
- `scripts/pixel-lab/`: replays recorded `oaiq()` calls through OpenAI's live SDK. Test data source in Ads Manager: "Pixel Lab test - do not use" (`VjWW8miJxHf9Z38iMAGMah`).

## Layout

- `src/code.js`: the sandboxed JS. `src/parameters.mjs`: the config UI. `src/permissions.mjs`: permissions. `src/tests.yaml`: in-editor tests. `src/notes.txt`.
- `scripts/build.mjs` assembles `template.tpl`. **Never edit `template.tpl` by hand.** The build embeds the icon programmatically with a round-trip check, and refuses em dashes.
- `test/run-tests.mjs` runs the real extracted code against simulated GTM APIs. `--fixtures <path>` writes Pixel Lab fixtures.

## Rules (inherited, non-negotiable)

1. Never hand-transcribe binary data (the icon). The build script handles it.
2. Every factual claim in README or help text needs a source we actually read. OpenAI rule changes are checked against `developers.openai.com/ads/llms-full.txt`.
3. Never claim a capability the default install does not deliver.
4. No telemetry. The only network destination is OpenAI's pixel.
5. No em dashes in user-facing copy.
6. Commits author as `kevin@ai-advisors.ai`; nothing publishes from a personal account.
7. Do not name competitors in the README or template copy. Describe failure modes generically.

## Sandbox notes (learned while building)

- GTM's sandbox has no regex literals, `new`, `try`, or documented `sort`/`slice`. The code sticks to `forEach`/`filter`/`map`, `indexOf`, string methods and plain loops.
- `copyFromDataLayer` reads GTM's merged data model, so keys from earlier pushes persist. Lead-type events deliberately read only a small key set (see README "Known limits").
- `isConsentGranted` returns true when the consent type was never set.
- OpenAI stores a consent denial in the first-party cookie `__oaiq_consent` (observed, undocumented). If it says `false` and consent is now granted, send `oaiq("consent", true)` before `init`, or the SDK drops everything.
- The SDK accepts `zip_code` as an alias of `postal_code`; we send the documented `postal_code`.

## Release process

1. Edit `src/`, then run `node scripts/build.mjs` and `node test/run-tests.mjs` (all must pass).
2. Import `template.tpl` into a GTM web container and run the in-editor tests (Google's runner is the authority on sandbox semantics).
3. Replay through the Pixel Lab against the test pixel; confirm arrival in Ads Manager's Event Stream.
4. Commit. Then prepend a `metadata.yaml` version entry whose `sha` is the commit containing the new `template.tpl`.
5. Push to `main`. Gallery propagation takes 2 to 3 days. Deleting `LICENSE` or `metadata.yaml` removes the template from the gallery.

## Status

- 2026-10-13: v1 built. Node tests 27/27; 9 scenarios confirmed end to end in Ads Manager's Event Stream; **in-editor tests 12/12 passed** (Kevin ran them in the website's GTM web container, GTM-PKTFRDMZ; template not saved there). Repo private.
- Import tip: the editor refuses to run tests in a **server** container ("not compatible with Server containers"); use a web container.
- Not submitted to the gallery.
