export function appHostname(value) {
  if (
    typeof value !== 'string' ||
    value.trim() !== value ||
    value.length > 253 ||
    !value.includes('.') ||
    !value.split('.').every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label)) ||
    /^[0-9.]+$/.test(value)
  ) {
    throw new Error('APP_HOSTNAME must be a DNS hostname without protocol, port or path.');
  }
  const hostname = value.toLowerCase();
  try {
    if (new URL(`https://${hostname}`).hostname === hostname) return hostname;
  } catch {
    // URL parsing rejects numeric-looking DNS suffixes interpreted as invalid IPv4.
  }
  throw new Error('APP_HOSTNAME must be a DNS hostname without protocol, port or path.');
}
