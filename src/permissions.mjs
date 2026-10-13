// Web permissions (GTM ___WEB_PERMISSIONS___). Every entry is a question a
// reviewer will ask, so each is as narrow as the code allows.

const str = (string) => ({ type: 1, string });
const bool = (boolean) => ({ type: 8, boolean });
const list = (items) => ({ type: 2, listItem: items });
const map = (keys, values) => ({ type: 3, mapKey: keys.map(str), mapValue: values });
const perm = (publicId, param) => ({ instance: { key: { publicId, versionId: "1" }, param }, isRequired: true });

const global = (key, read, write, execute) =>
  map(["key", "read", "write", "execute"], [str(key), bool(read), bool(write), bool(execute)]);

export const permissions = [
  perm("inject_script", [{ key: "urls", value: list([str("https://bzrcdn.openai.com/sdk/oaiq.min.js")]) }]),
  perm("access_globals", [
    {
      key: "keys",
      value: list([
        global("oaiq", true, true, true),
        global("oaiq.q", true, true, false),
        global("dataLayer", true, true, false),
      ]),
    },
  ]),
  perm("read_data_layer", [
    { key: "allowedKeys", value: str("specific") },
    {
      key: "keyPatterns",
      value: list(["event", "ecommerce", "value", "currency", "plan_id", "user_data", "lead_type", "dedupe_id"].map(str)),
    },
  ]),
  perm("access_consent", [
    {
      key: "consentTypes",
      value: list([
        map(["consentType", "read", "write"], [str("ad_storage"), bool(true), bool(false)]),
        map(["consentType", "read", "write"], [str("ad_user_data"), bool(true), bool(false)]),
      ]),
    },
  ]),
  perm("get_cookies", [
    { key: "cookieAccess", value: str("specific") },
    { key: "cookieNames", value: list(["__oppref", "__obref", "__oaiq_consent"].map(str)) },
  ]),
  perm("access_local_storage", [
    { key: "keys", value: list([map(["key", "read", "write"], [str("chatgpt_ads_b2b_guard"), bool(true), bool(true)])]) },
  ]),
  perm("get_url", [
    { key: "urlParts", value: str("specific") },
    { key: "path", value: bool(true) },
  ]),
  perm("access_template_storage", []),
  perm("read_container_data", []),
  perm("logging", [{ key: "environments", value: str("debug") }]),
];
