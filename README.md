# ChatGPT Ads Pixel for B2B

A Google Tag Manager web tag that sends ChatGPT Ads conversions to OpenAI's [Measurement Pixel](https://developers.openai.com/ads/measurement-pixel), built for B2B lead generation: leads, demo bookings, signups, trials and subscriptions.

Made by [AI-Advisors](https://www.ai-advisors.ai). Not affiliated with OpenAI.

## Why this exists

OpenAI's pixel checks every event in the browser before sending it. An event that breaks OpenAI's rules is dropped on the spot, and nothing reaches Ads Manager. Meanwhile GTM still reports the tag as fired. We tested this on 2026-10-13 against OpenAI's live SDK and Ads Manager's Event Stream:

- **A lead sent with product data attached is dropped.** GTM's data layer keeps earlier pushes. On a page that pushed GA4 ecommerce data earlier (a pricing page with a `view_item`, for example), a template that copies ecommerce fields onto every event attaches that product to the lead. OpenAI does not allow product contents on lead events, so the SDK drops the lead: `eventProps.contents is not a documented field`.
- **A custom event with an invalid name is dropped.** Firing on GTM's built-in Form Submission trigger and passing the GTM event name through sends `gtm.formSubmit`, which breaks OpenAI's naming rules.
- **A fractional amount is dropped.** OpenAI requires whole numbers in the currency's smallest unit.

This template checks every event against OpenAI's documented rules before calling the pixel:
- It fixes what it safely can, and says what it changed in GTM Preview.
- When a conversion truly cannot be sent, the tag reports **Failed**, with the reason in the browser console.

## Quick start

1. In GTM, add the template (Templates > Tag Templates > Search Gallery, or import `template.tpl` from this repository).
2. Create a tag from it and paste your Pixel ID (OpenAI Ads Manager > Conversions).
3. Fire it on your page view trigger and on your lead triggers. With the default **Automatic** setting, the tag maps the GTM event that fired it:

| GTM / GA4 event | Sent to OpenAI as |
|---|---|
| `generate_lead` | `lead_created` |
| `sign_up` | `registration_completed` |
| `page_view`, `gtm.js`, `gtm.init`, `gtm.dom`, `gtm.historyChange`, `gtm.historyChange-v2` | `page_viewed` |
| `view_item`, `add_to_cart`, `begin_checkout`, `purchase` | `contents_viewed`, `items_added`, `checkout_started`, `order_created` |
| An event already named after an OpenAI event (for example `trial_started`) | the same event |
| `b2b_lead` with a `lead_type` (see below) | the OpenAI event in `lead_type` |
| `gtm.formSubmit` | `lead_created`, only if "Treat GTM form submissions as leads" is on |

Add your own names under **Your event mappings** (for example `demo_booked` to Appointment scheduled). Events with no mapping are skipped by default, with the reason written to the console in GTM Preview. Or choose a single event on the tag instead of Automatic.

### `b2b_lead` events

To send a lead from your own code or a form/booking tool callback, push:

```js
dataLayer.push({
  event: 'b2b_lead',
  lead_type: 'appointment_scheduled', // lead_created, appointment_scheduled, registration_completed, trial_started or subscription_created
  dedupe_id: 'booking-123'            // optional: a submission or booking ID, used to ignore repeats
});
```

## What it does for you

**Conversion value**
- **Lead-type events never read ecommerce data.** This covers lead, signup, demo, trial and subscription events. They read only the data layer `value` and `currency` keys, so an earlier product view cannot attach itself to a lead.
- **Or set a fixed value on the tag**, for example every lead worth 500 USD.
- **Amounts are converted** to the currency's smallest unit using ISO 4217 (2 decimals for most currencies, 0 for JPY or KRW, 3 for KWD).
- **A value with no currency is removed, and the event is still sent.** OpenAI requires a currency with every amount.

**Consent (Google Consent Mode by default)**
- **When `ad_storage` is denied,** the tag sends OpenAI's own `oaiq("consent", false)`. That blocks events and removes the pixel's cookies, as OpenAI documents.
- **A visitor who never consented causes no request to OpenAI.** The pixel script only loads under a denial when OpenAI's cookies already exist and need removing.
- **Held events.** An event fired while consent is denied is held, and sent if consent is granted later on the same page.
- **Withdrawal.** If consent is withdrawn mid-visit, the tag sends `oaiq("consent", false)` again.
- **Customer data needs `ad_user_data` too.** It is only sent when `ad_user_data` is granted (configurable). Google defines that signal as consent to send user data for advertising. Without it, the event is still sent, without customer data.
- **Sites without Consent Mode:** GTM treats consent as granted.

**Customer matching**
- **Sources:** the GA4 `user_data` data layer object, a variable (for example GTM's User-Provided Data variable), or a table.
- **Hashing:** email, phone, names and external ID are normalized the way OpenAI documents, then SHA-256 hashed in the browser. Already-hashed values pass through.
- **Request scope:** customer data is sent on the pixel's `init` call, as OpenAI requires.

**Deduplication**
- **Every event gets an event ID**, generated by default, or your own.
- **The ID is pushed to the data layer** after each conversion as `chatgpt_ads_pixel_sent` with `chatgpt_ads_event_id`, so a server-side Conversions API tag can send the same ID. OpenAI then counts the browser and server events once.

**Repeats**
- A reloaded thank-you page does not count a lead, signup, demo, trial or subscription twice within the window (24 hours by default).
- This uses one key in the browser's local storage, only when consent allows the pixel to run.

**Several pixels:** enter several Pixel IDs separated by commas. Each receives one copy of each event.

## Permissions, and why

| Permission | Why |
|---|---|
| Inject script: `https://bzrcdn.openai.com/sdk/oaiq.min.js` only | OpenAI's pixel |
| Global variables: `oaiq`, `oaiq.q`, `dataLayer` | The pixel's command queue; the event ID and issue pushes |
| Data layer keys: `event`, `ecommerce`, `value`, `currency`, `plan_id`, `user_data`, `lead_type`, `dedupe_id` | Event mapping, value and customer data |
| Consent: read `ad_storage`, `ad_user_data` | Consent gating |
| Cookies: read `__oppref`, `__obref`, `__oaiq_consent` | Knowing whether OpenAI's cookies need removing, and lifting a stored denial once consent is granted |
| Local storage: `chatgpt_ads_b2b_guard` | The repeat guard |
| URL: path only | The repeat guard's default key |
| Container data, template storage, console logging in debug only | Preview detection, per-page state, diagnostics |

No telemetry. The only network destination is OpenAI's pixel.

## Known limits

- **The data layer can still carry stale values.** GTM's data layer merges every push. For lead-type events the template reads only `value`, `currency`, `plan_id`, `user_data`, `lead_type` and `dedupe_id`. If an earlier push on the same page set one of those keys and the current push does not, the earlier value is used. For ecommerce events, clear the ecommerce object before each push, as Google recommends (`dataLayer.push({ ecommerce: null })`).
- **Held events don't survive navigation.** An event fired while consent was denied is only sent if consent is granted before the visitor leaves the page. OpenAI does not replay events blocked by its own consent command.
- **Server-only events are not sent.** `app_installed` and `app_opened` are Conversions API only, and later CRM stages (qualified, closed-won) belong to the Conversions API, not the browser pixel.

## Verification

- **OpenAI's rules last checked:** 2026-10-13, against [developers.openai.com/ads](https://developers.openai.com/ads) (event types, allowed fields, naming, consent, customer data normalization).
- **Node tests:** `node test/run-tests.mjs` runs the real template code against simulated GTM APIs (27 scenarios).
- **In-editor tests:** the `___TESTS___` section of `template.tpl` runs in GTM's template editor.

## Support

Open an issue on this repository.

## License

Apache 2.0. See `LICENSE`.
