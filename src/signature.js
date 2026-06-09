import crypto from "node:crypto";

// SignalWire's Compatibility (LaML) API signs webhooks exactly like Twilio:
//   signature = base64( HMAC-SHA1( authToken, fullUrl + concat(sorted key+value) ) )
// where fullUrl is the exact URL SignalWire was configured to call (including any
// query string such as ?test_id=...) and the params are the POST form fields.
export function expectedSignalWireSignature(token, fullUrl, params = {}) {
  const data = Object.keys(params)
    .sort()
    .reduce((acc, key) => acc + key + params[key], fullUrl);
  return crypto
    .createHmac("sha1", token)
    .update(Buffer.from(data, "utf8"))
    .digest("base64");
}

export function isValidSignalWireSignature(token, fullUrl, params, received) {
  if (!token || !received) return false;
  const expected = expectedSignalWireSignature(token, fullUrl, params);
  const left = Buffer.from(expected);
  const right = Buffer.from(String(received));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}
