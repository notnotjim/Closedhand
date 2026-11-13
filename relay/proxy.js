// The header a host's front door puts before each connection it passes on
// (the PROXY protocol, version 1 or 2), saying the address it came from.
// Read from a connection's first bytes, before the browser's own:
//   { need: true }             more bytes are needed
//   { error }                  not a header: the connection is refused
//   { from, length }           the browser's address (null when the front
//                              door checks itself), and the header's length
const net = require('net');

const V1 = Buffer.from('PROXY ');
const V1_MAX = 107;
const V2 = Buffer.from('0d0a0d0a000d0a515549540a', 'hex');

const startsLike = (buf, sig) => sig.subarray(0, Math.min(buf.length, sig.length)).equals(buf.subarray(0, Math.min(buf.length, sig.length)));

function ipv6(raw) {
  const groups = [];
  for (let i = 0; i < 16; i += 2) groups.push(raw.readUInt16BE(i).toString(16));
  return groups.join(':');
}

function proxyHeader(buf) {
  if (startsLike(buf, V1)) {
    if (buf.length < V1.length) return { need: true };
    const end = buf.indexOf('\r\n');
    if (end < 0) return buf.length < V1_MAX ? { need: true } : { error: 'header too long' };
    const parts = buf.subarray(0, end).toString('latin1').split(' ');
    if (parts[1] === 'UNKNOWN') return { from: null, length: end + 2 };
    if (parts.length !== 6 || !['TCP4', 'TCP6'].includes(parts[1]) || !net.isIP(parts[2])) return { error: 'bad header' };
    return { from: parts[2], length: end + 2 };
  }
  if (!startsLike(buf, V2)) return { error: 'no header' };
  if (buf.length < 16) return { need: true };
  if (buf[12] >> 4 !== 2) return { error: 'bad header' };
  const length = 16 + buf.readUInt16BE(14);
  if (length > 16 + 216) return { error: 'header too long' };
  if (buf.length < length) return { need: true };
  // LOCAL: the front door checking itself, with no address.
  if ((buf[12] & 0x0f) === 0) return { from: null, length };
  if ((buf[12] & 0x0f) !== 1) return { error: 'bad header' };
  if (buf[13] === 0x11 && length >= 16 + 12) return { from: [...buf.subarray(16, 20)].join('.'), length };
  if (buf[13] === 0x21 && length >= 16 + 36) return { from: ipv6(buf.subarray(16, 32)), length };
  return { from: null, length };
}

module.exports = { proxyHeader };
