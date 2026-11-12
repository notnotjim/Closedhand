// The one thing the relay reads of a personal URL's connection: the name the
// browser asks for, which TLS sends in the clear at the very start (the
// ClientHello's server_name, RFC 6066). Everything after it, and all of it
// past the handshake, is passed on unread: the relay holds no key that could
// open it.

const MAX_HELLO = 32 * 1024;

// The name in a ClientHello, from the bytes read so far: { name } once found,
// { need: true } while more bytes are needed, { error } when this isn't a TLS
// ClientHello with a name.
function serverName(buf) {
  // Handshake records, joined: a large hello may span several.
  const parts = [];
  let at = 0, total = 0;
  while (true) {
    if (buf.length < at + 5) return { need: true };
    if (buf[at] !== 0x16) return { error: 'not a TLS handshake' };
    if (buf[at + 1] !== 0x03) return { error: 'not TLS' };
    const len = buf.readUInt16BE(at + 3);
    if (buf.length < at + 5 + len) return buf.length > MAX_HELLO ? { error: 'hello too large' } : { need: true };
    parts.push(buf.subarray(at + 5, at + 5 + len));
    total += len;
    at += 5 + len;
    const hs = Buffer.concat(parts, total);
    if (hs.length < 4) continue;
    if (hs[0] !== 0x01) return { error: 'not a ClientHello' };
    const need = 4 + hs.readUIntBE(1, 3);
    if (need > MAX_HELLO) return { error: 'hello too large' };
    if (hs.length >= need) return nameIn(hs.subarray(4, need));
  }
}

function nameIn(hello) {
  try {
    let p = 2 + 32; // version, random
    p += 1 + hello[p]; // session id
    p += 2 + hello.readUInt16BE(p); // cipher suites
    p += 1 + hello[p]; // compression methods
    if (p + 2 > hello.length) return { error: 'no extensions' };
    const end = p + 2 + hello.readUInt16BE(p);
    p += 2;
    while (p + 4 <= end) {
      const type = hello.readUInt16BE(p), len = hello.readUInt16BE(p + 2);
      p += 4;
      if (type === 0) {
        // server_name_list: a list of { type, name }, host_name being type 0.
        let q = p + 2;
        const listEnd = p + 2 + hello.readUInt16BE(p);
        while (q + 3 <= listEnd) {
          const kind = hello[q], n = hello.readUInt16BE(q + 1);
          if (kind === 0) {
            const name = hello.subarray(q + 3, q + 3 + n).toString('ascii').toLowerCase();
            return /^[a-z0-9.-]{1,253}$/.test(name) ? { name } : { error: 'bad name' };
          }
          q += 3 + n;
        }
        return { error: 'no host name' };
      }
      p += len;
    }
    return { error: 'no server name' };
  } catch (_) {
    return { error: 'malformed hello' };
  }
}

module.exports = { serverName, MAX_HELLO };
