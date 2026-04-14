const IPV4_RE = /^(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/

const IPV6_RE = /^([\da-f]{1,4}:){7}[\da-f]{1,4}$/i

export function isValidIP(address) {
  return IPV4_RE.test(address) || IPV6_RE.test(address)
}
