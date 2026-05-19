export function logInteraction(message, details = {}) {
  const safeDetails = redactSecrets(details);
  const suffix = Object.keys(safeDetails).length
    ? ` ${JSON.stringify(safeDetails)}`
    : "";
  console.log(`[${new Date().toISOString()}] ${message}${suffix}`);
}

function redactSecrets(value) {
  if (Array.isArray(value)) return value.map(redactSecrets);
  if (!value || typeof value !== "object") return value;

  return Object.fromEntries(
    Object.entries(value).map(([key, entryValue]) => [
      key,
      isSecretKey(key) ? "[redacted]" : redactSecrets(entryValue),
    ]),
  );
}

function isSecretKey(key) {
  return /token|secret|authorization|api[_-]?key/i.test(key);
}
