// ChatGPT Ads Pixel for B2B by AI-Advisors
// Sends ChatGPT Ads conversions to OpenAI's Measurement Pixel, checking every
// event against OpenAI's documented rules first so a conversion is never lost
// silently. Rules verified against developers.openai.com/ads on 2026-10-13.

const addConsentListener = require('addConsentListener');
const callInWindow = require('callInWindow');
const copyFromDataLayer = require('copyFromDataLayer');
const copyFromWindow = require('copyFromWindow');
const createArgumentsQueue = require('createArgumentsQueue');
const createQueue = require('createQueue');
const generateRandom = require('generateRandom');
const getContainerVersion = require('getContainerVersion');
const getCookieValues = require('getCookieValues');
const getTimestampMillis = require('getTimestampMillis');
const getType = require('getType');
const getUrl = require('getUrl');
const injectScript = require('injectScript');
const isConsentGranted = require('isConsentGranted');
const JSON = require('JSON');
const localStorage = require('localStorage');
const logToConsole = require('logToConsole');
const makeNumber = require('makeNumber');
const makeString = require('makeString');
const makeTableMap = require('makeTableMap');
const Math = require('Math');
const Object = require('Object');
const sha256 = require('sha256');
const templateStorage = require('templateStorage');

const SDK_URL = 'https://bzrcdn.openai.com/sdk/oaiq.min.js';
const SDK_CACHE_TOKEN = 'chatgptAdsPixelB2B';
const LOG_PREFIX = '[ChatGPT Ads Pixel for B2B]';
const SENT_EVENT = 'chatgpt_ads_pixel_sent';
const ISSUE_EVENT = 'chatgpt_ads_pixel_issue';
const LISTENER_EVENT = 'b2b_lead';
const GUARD_KEY = 'chatgpt_ads_b2b_guard';
const GUARD_MAX_ENTRIES = 50;

// OpenAI event -> required payload type (developers.openai.com/ads/supported-events).
// app_installed and app_opened are Conversions API only, so they are absent.
const EVENT_TYPES = {
  page_viewed: 'contents',
  contents_viewed: 'contents',
  items_added: 'contents',
  checkout_started: 'contents',
  order_created: 'contents',
  lead_created: 'customer_action',
  registration_completed: 'customer_action',
  appointment_scheduled: 'customer_action',
  subscription_created: 'plan_enrollment',
  trial_started: 'plan_enrollment',
  custom: 'custom'
};

// Fields each payload type accepts. Anything else makes OpenAI's SDK drop the
// whole event ("is not a documented field"), so it is removed before sending.
const ALLOWED_FIELDS = {
  contents: ['type', 'amount', 'currency', 'contents'],
  customer_action: ['type', 'amount', 'currency'],
  plan_enrollment: ['type', 'plan_id', 'amount', 'currency', 'contents'],
  custom: ['type', 'plan_id', 'amount', 'currency', 'contents']
};
const CONTENT_FIELDS = ['id', 'name', 'content_type', 'quantity', 'amount', 'currency'];

// GTM / GA4 event names this template understands without configuration.
const BUILT_IN_MAP = {
  generate_lead: 'lead_created',
  sign_up: 'registration_completed',
  page_view: 'page_viewed',
  'gtm.init': 'page_viewed',
  'gtm.js': 'page_viewed',
  'gtm.dom': 'page_viewed',
  'gtm.historyChange': 'page_viewed',
  'gtm.historyChange-v2': 'page_viewed',
  view_item: 'contents_viewed',
  add_to_cart: 'items_added',
  begin_checkout: 'checkout_started',
  purchase: 'order_created'
};
const LISTENER_LEAD_TYPES = [
  'lead_created',
  'appointment_scheduled',
  'registration_completed',
  'trial_started',
  'subscription_created'
];
const GUARDED_TYPES = ['customer_action', 'plan_enrollment'];

// ISO 4217 minor units. Currencies not listed use 2.
const ZERO_DECIMAL = ['BIF', 'CLP', 'DJF', 'GNF', 'ISK', 'JPY', 'KMF', 'KRW', 'PYG', 'RWF', 'UGX', 'UYI', 'VND', 'VUV', 'XAF', 'XOF', 'XPF'];
const THREE_DECIMAL = ['BHD', 'IQD', 'JOD', 'KWD', 'LYD', 'OMR', 'TND'];
const FOUR_DECIMAL = ['CLF', 'UYW'];

const PUNCTUATION = ' \t\n\r!"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~';
const HEX = '0123456789abcdef';
const ALNUM = 'abcdefghijklmnopqrstuvwxyz0123456789';

/*==============================================================================
  Main
==============================================================================*/

let finished = false;
const succeed = () => {
  if (finished) return;
  finished = true;
  data.gtmOnSuccess();
};
const fail = () => {
  if (finished) return;
  finished = true;
  data.gtmOnFailure();
};
const noop = () => {};

const debugOn = data.alwaysDebug === true || isPreview();

const pixelIds = parsePixelIds(data.pixelId);
if (pixelIds.length === 0) {
  reportIssue('missing_pixel_id', 'No valid Pixel ID. Use the ID from Ads Manager > Conversions.');
  fail();
} else {
  run();
}

function run() {
  const resolved = resolveEvent();
  if (!resolved.send) {
    log(resolved.reason);
    return succeed();
  }

  const eventName = resolved.eventName;
  const type = EVENT_TYPES[eventName];
  const built = buildProps(type);
  const checked = validate(eventName, type, built.props, resolved.customEventName);
  built.notes.forEach((n) => log(n));
  checked.notes.forEach((n) => log(n));
  if (checked.error) {
    reportIssue('invalid_event', checked.error);
    return fail();
  }

  const job = {
    pixelIds: pixelIds,
    eventName: eventName,
    customEventName: checked.customEventName,
    props: checked.props,
    eventId: resolveEventId(),
    debug: debugOn,
    rawUser: data.sendUserData === false ? undefined : collectRawUser(),
    gateUserData: data.consentSource !== 'none' && data.userDataConsent !== false,
    guardKey: guardKeyFor(eventName, type, checked.customEventName),
    guardWindowMs: guardWindowMs(),
    shareEventId: data.shareEventId !== false && eventName !== 'page_viewed'
  };

  const consentSource = data.consentSource || 'gcm';
  if (consentSource === 'gcm') registerConsentListener();

  if (!measurementGranted(consentSource)) {
    applyDenial(job);
    if (consentSource === 'gcm') {
      queuePending(job);
      log('Waiting for ad_storage consent. The event is held and sent if consent is granted on this page.');
    } else {
      log('Consent variable says denied. Event not sent.');
    }
    return succeed();
  }

  sendJob(job, succeed, fail);
}

/*==============================================================================
  Event resolution
==============================================================================*/

function resolveEvent() {
  if (data.eventSource === 'manual') {
    const chosen = data.eventName;
    if (!EVENT_TYPES[chosen]) return { send: false, reason: 'No event chosen.' };
    return {
      send: true,
      eventName: chosen,
      customEventName: chosen === 'custom' ? trim(data.customEventName) : undefined
    };
  }

  const gtmEvent = makeString(copyFromDataLayer('event') || '');
  if (gtmEvent === SENT_EVENT || gtmEvent === ISSUE_EVENT) {
    return { send: false, reason: 'Ignored this template\'s own data layer event.' };
  }

  const userMap = makeTableMap(data.eventMappings || [], 'gtmEvent', 'openaiEvent') || {};
  if (userMap[gtmEvent] && EVENT_TYPES[userMap[gtmEvent]]) {
    return { send: true, eventName: userMap[gtmEvent] };
  }

  if (gtmEvent === LISTENER_EVENT) {
    const leadType = makeString(copyFromDataLayer('lead_type') || '');
    if (LISTENER_LEAD_TYPES.indexOf(leadType) !== -1) return { send: true, eventName: leadType };
    return { send: false, reason: 'b2b_lead event has no recognised lead_type ("' + leadType + '"). Skipped.' };
  }

  if (gtmEvent === 'gtm.formSubmit' && data.formSubmitAsLead === true) {
    return { send: true, eventName: 'lead_created' };
  }

  if (BUILT_IN_MAP[gtmEvent]) return { send: true, eventName: BUILT_IN_MAP[gtmEvent] };

  if (EVENT_TYPES[gtmEvent] && gtmEvent !== 'custom') return { send: true, eventName: gtmEvent };

  if (data.unmappedBehavior === 'custom') {
    const cleaned = cleanCustomName(gtmEvent);
    if (cleaned && EVENT_TYPES[cleaned]) return { send: true, eventName: cleaned };
    if (cleaned) return { send: true, eventName: 'custom', customEventName: cleaned };
  }

  return {
    send: false,
    reason: 'GTM event "' + gtmEvent + '" has no ChatGPT Ads mapping, so nothing was sent. ' +
      'Add it under "Your event mappings" or choose an event on the tag.'
  };
}

/*==============================================================================
  Payload
==============================================================================*/

function buildProps(type) {
  const props = { type: type };
  const notes = [];

  if (data.valueSource === 'set') {
    if (isPresent(data.value)) {
      const currency = normCurrency(data.currency);
      props.amount = toMinorUnits(data.value, currency);
      if (currency) props.currency = currency;
      notes.push('Value set on the tag: ' + makeString(data.value) + ' ' + makeString(currency || '(no currency)') + '.');
    }
  } else if (type === 'contents') {
    // Ecommerce-shaped events read the GA4 ecommerce object, as Google
    // documents it. Sites should clear it ({ecommerce: null}) before each push.
    const ecommerce = copyFromDataLayer('ecommerce');
    if (getType(ecommerce) === 'object') {
      const items = getType(ecommerce.items) === 'array' ? ecommerce.items : [];
      let currency = normCurrency(ecommerce.currency);
      if (!currency && items.length && getType(items[0]) === 'object') currency = normCurrency(items[0].currency);
      const contents = [];
      let itemsTotal = 0;
      items.forEach((item) => {
        if (getType(item) !== 'object') return;
        const content = { content_type: 'product' };
        if (isPresent(item.item_id)) content.id = makeString(item.item_id);
        if (isPresent(item.item_name)) content.name = makeString(item.item_name);
        const quantity = Math.round(makeNumber(item.quantity || 1)) || 1;
        content.quantity = quantity;
        if (isPresent(item.price)) {
          content.amount = toMinorUnits(item.price, currency);
          if (content.amount !== undefined) itemsTotal += content.amount * quantity;
        }
        contents.push(content);
      });
      if (contents.length) props.contents = contents;
      if (isPresent(ecommerce.value)) props.amount = toMinorUnits(ecommerce.value, currency);
      else if (itemsTotal) props.amount = itemsTotal;
      if (currency) props.currency = currency;
      notes.push('Value read from the data layer ecommerce object.');
    }
  } else {
    // Lead, registration, demo, trial and subscription events never read the
    // ecommerce object. GTM keeps earlier pushes, so a product viewed earlier
    // on the page would otherwise attach itself to the lead (and OpenAI drops
    // a lead that carries contents).
    const value = copyFromDataLayer('value');
    if (isPresent(value)) {
      const currency = normCurrency(copyFromDataLayer('currency'));
      props.amount = toMinorUnits(value, currency);
      if (currency) props.currency = currency;
      notes.push('Value read from the data layer "value" and "currency" keys.');
    }
  }

  if (type === 'plan_enrollment' || type === 'custom') {
    const planId = isPresent(data.planId) ? data.planId : copyFromDataLayer('plan_id');
    if (isPresent(planId)) props.plan_id = makeString(planId);
  }

  return { props: props, notes: notes };
}

function validate(eventName, type, props, customEventName) {
  const notes = [];
  const allowed = ALLOWED_FIELDS[type];
  const out = {};

  Object.keys(props).forEach((key) => {
    if (allowed.indexOf(key) === -1) {
      notes.push('Removed "' + key + '": OpenAI does not accept it on ' + type + ' events.');
      return;
    }
    out[key] = props[key];
  });
  out.type = type;

  if (out.amount !== undefined) {
    const n = makeNumber(out.amount);
    if (getType(n) !== 'number' || n !== n || n < 0) {
      notes.push('Removed the value: "' + makeString(out.amount) + '" is not a valid amount.');
      Object.delete(out, 'amount');
    } else if (Math.floor(n) !== n) {
      out.amount = Math.round(n);
      notes.push('Rounded the amount to a whole number of minor units (' + makeString(out.amount) + ').');
    } else {
      out.amount = n;
    }
  }

  if (out.currency !== undefined && !isCurrencyCode(out.currency)) {
    notes.push('Removed currency "' + makeString(out.currency) + '": not a 3-letter ISO 4217 code.');
    Object.delete(out, 'currency');
  }
  if (out.amount !== undefined && out.currency === undefined) {
    notes.push('Removed the value: OpenAI requires a currency with every amount. The event is still sent.');
    Object.delete(out, 'amount');
  }
  if (out.amount === undefined && out.currency !== undefined) Object.delete(out, 'currency');

  if (out.contents !== undefined) {
    const cleaned = cleanContents(out.contents, notes);
    if (cleaned.length) out.contents = cleaned;
    else Object.delete(out, 'contents');
  }

  let customName;
  if (eventName === 'custom') {
    customName = makeString(customEventName || '').toLowerCase();
    if (customName !== makeString(customEventName || '')) notes.push('Lowercased the custom event name, as OpenAI recommends.');
    if (!isValidCustomName(customName)) {
      return {
        error: 'Custom event name "' + makeString(customEventName || '') + '" breaks OpenAI\'s rules: 1 to 64 letters, numbers, ' +
          'underscores or dashes, starting and ending with a letter or number, and not a standard event name. ' +
          'OpenAI would drop this event, so it was not sent.',
        notes: notes
      };
    }
  }

  return { props: out, notes: notes, customEventName: customName };
}

function cleanContents(contents, notes) {
  if (getType(contents) !== 'array') {
    notes.push('Removed contents: not a list.');
    return [];
  }
  const cleaned = [];
  contents.forEach((item) => {
    if (getType(item) !== 'object') return;
    const c = {};
    CONTENT_FIELDS.forEach((field) => {
      if (isPresent(item[field])) c[field] = item[field];
    });
    if (c.quantity !== undefined) c.quantity = Math.max(1, Math.round(makeNumber(c.quantity)) || 1);
    if (c.amount !== undefined) {
      const amt = makeNumber(c.amount);
      if (amt !== amt) Object.delete(c, 'amount');
      else c.amount = Math.round(amt);
    }
    if (c.currency !== undefined) {
      c.currency = normCurrency(c.currency);
      if (!c.currency) Object.delete(c, 'currency');
    }
    if (c.id !== undefined) c.id = makeString(c.id);
    if (c.name !== undefined) c.name = makeString(c.name);
    cleaned.push(c);
  });
  return cleaned;
}

/*==============================================================================
  Sending
==============================================================================*/

function sendJob(job, onOk, onFail) {
  if (isRepeat(job)) {
    log('Same conversion already sent from this browser within the repeat window. Skipped (for example, a reloaded thank-you page).');
    return onOk();
  }

  ensureQueue();
  if (storedDenial()) oaiq2('consent', true);

  hashUser(job.rawUser, userDataAllowed(job), (user) => {
    job.pixelIds.forEach((pixelId) => {
      const initKey = 'init:' + pixelId;
      if (user || !templateStorage.getItem(initKey)) {
        const initArgs = { pixelId: pixelId, debug: job.debug };
        if (user) initArgs.user = user;
        oaiq2('init', initArgs);
        templateStorage.setItem(initKey, true);
      }
    });

    const options = { event_id: job.eventId };
    if (job.eventName === 'custom') options.custom_event_name = job.customEventName;
    job.pixelIds.forEach((pixelId) => {
      callInWindow('oaiq', 'measureSingle', pixelId, job.eventName, job.props, options);
    });

    rememberGuard(job);
    if (job.shareEventId) {
      const push = { event: SENT_EVENT, chatgpt_ads_event_name: job.eventName, chatgpt_ads_event_id: job.eventId };
      if (job.customEventName) push.chatgpt_ads_custom_event_name = job.customEventName;
      createQueue('dataLayer')(push);
    }
    log('Sent ' + job.eventName + (job.customEventName ? ' (' + job.customEventName + ')' : '') + ' to ' +
      makeString(job.pixelIds.length) + ' pixel(s).', { data: job.props, options: options, customerData: user ? 'sent (hashed)' : 'none' });

    injectScript(SDK_URL, onOk, () => {
      reportIssue('sdk_load_failed', 'OpenAI\'s pixel script did not load (blocked, offline, or a Content Security Policy).');
      onFail();
    }, SDK_CACHE_TOKEN);
  });
}

function ensureQueue() {
  if (getType(copyFromWindow('oaiq')) !== 'function') createArgumentsQueue('oaiq', 'oaiq.q');
}

function oaiq2(command, arg) {
  callInWindow('oaiq', command, arg);
}

function resolveEventId() {
  if (data.eventIdSource === 'set' && isPresent(data.eventId)) return makeString(data.eventId);
  return makeString(getTimestampMillis()) + '.' + makeString(generateRandom(100000000, 999999999));
}

/*==============================================================================
  Consent
==============================================================================*/

function measurementGranted(source) {
  if (source === 'none') return true;
  if (source === 'variable') return isGrantedValue(data.consentVariable);
  return isConsentGranted('ad_storage');
}

function userDataAllowed(job) {
  if (!job.gateUserData) return true;
  if ((data.consentSource || 'gcm') === 'variable') return isGrantedValue(data.consentVariable);
  return isConsentGranted('ad_user_data');
}

function isGrantedValue(v) {
  return v === true || v === 'true' || v === 'granted' || v === 1 || v === '1';
}

// OpenAI's own consent command: oaiq("consent", false) blocks events and
// removes the pixel's cookies (__oppref, __obref). It is only loaded under a
// denial when those cookies already exist, so a visitor who never consented
// causes no request to OpenAI at all.
function applyDenial(job) {
  ensureQueue();
  if (templateStorage.getItem('consentFalseSent') !== true) {
    oaiq2('consent', false);
    templateStorage.setItem('consentFalseSent', true);
  }
  if (hasPixelCookies()) {
    job.pixelIds.forEach((pixelId) => oaiq2('init', { pixelId: pixelId, debug: job.debug }));
    injectScript(SDK_URL, noop, noop, SDK_CACHE_TOKEN);
    log('Consent denied: told OpenAI\'s pixel to remove its cookies.');
  }
}

function registerConsentListener() {
  if (templateStorage.getItem('listenerAdded') === true) return;
  templateStorage.setItem('listenerAdded', true);
  addConsentListener('ad_storage', (consentType, granted) => {
    if (granted) {
      if (templateStorage.getItem('consentFalseSent') === true || storedDenial()) {
        ensureQueue();
        oaiq2('consent', true);
        templateStorage.setItem('consentFalseSent', false);
      }
      const pending = templateStorage.getItem('pending') || [];
      templateStorage.setItem('pending', []);
      pending.forEach((job) => sendJob(job, noop, noop));
    } else {
      ensureQueue();
      oaiq2('consent', false);
      templateStorage.setItem('consentFalseSent', true);
      if (hasPixelCookies()) injectScript(SDK_URL, noop, noop, SDK_CACHE_TOKEN);
    }
  });
}

function queuePending(job) {
  const pending = templateStorage.getItem('pending') || [];
  pending.push(job);
  templateStorage.setItem('pending', pending);
}

function storedDenial() {
  return getCookieValues('__oaiq_consent').indexOf('false') !== -1;
}

function hasPixelCookies() {
  return getCookieValues('__oppref').length > 0 || getCookieValues('__obref').length > 0;
}

/*==============================================================================
  Customer data (advanced matching)
==============================================================================*/

function collectRawUser() {
  const raw = {};
  const fromDataLayer = copyFromDataLayer('user_data');
  if (getType(fromDataLayer) === 'object') addUserFields(raw, fromDataLayer);
  if (getType(data.userDataVariable) === 'object') addUserFields(raw, data.userDataVariable);
  if (getType(data.userDataList) === 'array') {
    data.userDataList.forEach((row) => {
      if (row && isPresent(row.value)) raw[row.name] = row.value;
    });
  }
  return Object.keys(raw).length ? raw : undefined;
}

function addUserFields(out, src) {
  const address = getType(src.address) === 'array' ? src.address[0] : src.address;
  const a = getType(address) === 'object' ? address : {};
  setIf(out, 'email', first(src.email || src.email_address || src.sha256_email_address));
  setIf(out, 'phone', first(src.phone_number || src.phone || src.sha256_phone_number));
  setIf(out, 'external_id', src.external_id || src.user_id);
  setIf(out, 'first_name', a.first_name || a.sha256_first_name || src.first_name);
  setIf(out, 'last_name', a.last_name || a.sha256_last_name || src.last_name);
  setIf(out, 'city', a.city || src.city);
  setIf(out, 'region', a.region || src.region);
  setIf(out, 'postal_code', a.postal_code || a.zip || src.postal_code || src.zip);
  setIf(out, 'country', a.country || src.country);
}

// Normalization per developers.openai.com/ads/measurement-pixel, then SHA-256
// hex. Values that are already 64-character hex hashes pass through.
function hashUser(raw, allowed, onDone) {
  if (!raw || !allowed) return onDone(undefined);
  const user = {};
  const toHash = {};
  const hashed = { email: 'email_sha256', phone: 'phone_number_sha256', external_id: 'external_id_sha256', first_name: 'first_name_sha256', last_name: 'last_name_sha256' };

  Object.keys(hashed).forEach((field) => {
    if (!isPresent(raw[field])) return;
    const value = makeString(raw[field]);
    if (isHashed(value)) user[hashed[field]] = value.toLowerCase();
    else {
      const normalized = normalize(field, value);
      if (normalized) toHash[hashed[field]] = normalized;
    }
  });
  if (isPresent(raw.country)) user.country = makeString(raw.country).trim().toUpperCase().substring(0, 2);
  if (isPresent(raw.city)) user.city = makeString(raw.city).trim().substring(0, 128);
  if (isPresent(raw.region)) user.region = makeString(raw.region).trim().substring(0, 128);
  if (isPresent(raw.postal_code)) user.postal_code = makeString(raw.postal_code).trim().substring(0, 32);

  const keys = Object.keys(toHash);
  if (keys.length === 0) return onDone(Object.keys(user).length ? user : undefined);
  let pending = keys.length;
  keys.forEach((key) => {
    sha256(toHash[key], (digest) => {
      user[key] = digest;
      pending--;
      if (pending === 0) onDone(user);
    }, () => {
      pending--;
      if (pending === 0) onDone(Object.keys(user).length ? user : undefined);
    }, { outputEncoding: 'hex' });
  });
}

function normalize(field, value) {
  if (field === 'email') return removeChars(value.trim().toLowerCase(), ' \t\n\r');
  if (field === 'external_id') return value.trim();
  if (field === 'phone') {
    let digits = keepChars(value, '0123456789');
    while (digits.length && digits.charAt(0) === '0') digits = digits.substring(1);
    return digits;
  }
  return removeChars(value.toLowerCase(), PUNCTUATION);
}

/*==============================================================================
  Repeat guard
==============================================================================*/

function guardWindowMs() {
  if (data.guardRepeats === false) return 0;
  const hours = makeNumber(isPresent(data.guardHours) ? data.guardHours : 24);
  return hours > 0 ? hours * 3600000 : 0;
}

function guardKeyFor(eventName, type, customName) {
  if (GUARDED_TYPES.indexOf(type) === -1 && eventName !== 'custom') return undefined;
  let scope;
  if (data.eventIdSource === 'set' && isPresent(data.eventId)) scope = 'id:' + makeString(data.eventId);
  else if (isPresent(copyFromDataLayer('dedupe_id'))) scope = 'dd:' + makeString(copyFromDataLayer('dedupe_id'));
  else scope = 'path:' + makeString(getUrl('path'));
  return eventName + (customName ? ':' + customName : '') + '|' + scope;
}

function readGuard() {
  if (!localStorage) return {};
  const parsed = JSON.parse(localStorage.getItem(GUARD_KEY) || '{}');
  return getType(parsed) === 'object' ? parsed : {};
}

function isRepeat(job) {
  if (!job.guardKey || !job.guardWindowMs) return false;
  const seen = readGuard()[job.guardKey];
  return getType(seen) === 'number' && getTimestampMillis() - seen < job.guardWindowMs;
}

function rememberGuard(job) {
  if (!job.guardKey || !job.guardWindowMs || !localStorage) return;
  const now = getTimestampMillis();
  const store = readGuard();
  store[job.guardKey] = now;
  // Keep only unexpired entries, then evict the oldest beyond the cap.
  // (Plain loops: GTM's sandbox does not document sort or slice.)
  const out = {};
  let count = 0;
  Object.keys(store).forEach((k) => {
    if (getType(store[k]) === 'number' && now - store[k] < job.guardWindowMs) {
      out[k] = store[k];
      count++;
    }
  });
  while (count > GUARD_MAX_ENTRIES) {
    let oldest;
    Object.keys(out).forEach((k) => {
      if (oldest === undefined || out[k] < out[oldest]) oldest = k;
    });
    Object.delete(out, oldest);
    count--;
  }
  localStorage.setItem(GUARD_KEY, JSON.stringify(out));
}

/*==============================================================================
  Diagnostics
==============================================================================*/

function isPreview() {
  const v = getContainerVersion();
  return !!(v && (v.previewMode || v.debugMode));
}

function log(message, details) {
  if (details !== undefined) logToConsole(LOG_PREFIX, message, details);
  else logToConsole(LOG_PREFIX, message);
}

function reportIssue(reason, message) {
  logToConsole(LOG_PREFIX, 'NOT SENT: ' + message);
  if (data.reportIssues === true) {
    createQueue('dataLayer')({ event: ISSUE_EVENT, chatgpt_ads_issue: reason, chatgpt_ads_issue_detail: message });
  }
}

/*==============================================================================
  Helpers
==============================================================================*/

function parsePixelIds(value) {
  const list = getType(value) === 'array' ? value : makeString(value || '').split(',');
  const ids = [];
  list.forEach((p) => {
    const id = makeString(p).trim();
    if (id && isIdChars(id) && ids.indexOf(id) === -1) ids.push(id);
  });
  return ids;
}

function isIdChars(s) {
  for (let i = 0; i < s.length; i++) {
    const c = s.charAt(i).toLowerCase();
    if (ALNUM.indexOf(c) === -1 && c !== '_' && c !== '-') return false;
  }
  return true;
}

function isValidCustomName(name) {
  if (!name || name.length > 64 || EVENT_TYPES[name]) return false;
  if (ALNUM.indexOf(name.charAt(0)) === -1 || ALNUM.indexOf(name.charAt(name.length - 1)) === -1) return false;
  return isIdChars(name);
}

function cleanCustomName(name) {
  let out = '';
  const lower = makeString(name).toLowerCase();
  for (let i = 0; i < lower.length; i++) {
    const c = lower.charAt(i);
    out += ALNUM.indexOf(c) !== -1 || c === '-' ? c : '_';
  }
  while (out.length && ALNUM.indexOf(out.charAt(0)) === -1) out = out.substring(1);
  out = out.substring(0, 64);
  while (out.length && ALNUM.indexOf(out.charAt(out.length - 1)) === -1) out = out.substring(0, out.length - 1);
  return out;
}

function normCurrency(c) {
  if (!isPresent(c)) return undefined;
  const code = makeString(c).trim().toUpperCase();
  return isCurrencyCode(code) ? code : undefined;
}

function isCurrencyCode(c) {
  const s = makeString(c);
  if (s.length !== 3) return false;
  for (let i = 0; i < 3; i++) {
    if ('ABCDEFGHIJKLMNOPQRSTUVWXYZ'.indexOf(s.charAt(i)) === -1) return false;
  }
  return true;
}

function toMinorUnits(value, currency) {
  const n = makeNumber(value);
  if (getType(n) !== 'number' || n !== n) return undefined;
  let factor = 100;
  if (ZERO_DECIMAL.indexOf(currency) !== -1) factor = 1;
  else if (THREE_DECIMAL.indexOf(currency) !== -1) factor = 1000;
  else if (FOUR_DECIMAL.indexOf(currency) !== -1) factor = 10000;
  return Math.round(n * factor);
}

function isPresent(v) {
  return v !== undefined && v !== null && v !== '' && v !== false;
}

function first(v) {
  return getType(v) === 'array' ? v[0] : v;
}

function setIf(obj, key, value) {
  if (isPresent(value) && !isPresent(obj[key])) obj[key] = value;
}

function trim(v) {
  return isPresent(v) ? makeString(v).trim() : undefined;
}

function isHashed(v) {
  if (v.length !== 64) return false;
  const lower = v.toLowerCase();
  for (let i = 0; i < 64; i++) {
    if (HEX.indexOf(lower.charAt(i)) === -1) return false;
  }
  return true;
}

function keepChars(s, allowed) {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    if (allowed.indexOf(s.charAt(i)) !== -1) out += s.charAt(i);
  }
  return out;
}

function removeChars(s, banned) {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    if (banned.indexOf(s.charAt(i)) === -1) out += s.charAt(i);
  }
  return out;
}
