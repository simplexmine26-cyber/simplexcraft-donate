// Minimal TON cell / BOC builder for two payloads: a text comment and a jetton (USDT) transfer.
(function (root) {
  "use strict";

  function Builder() { this.bits = []; this.refs = []; }
  Builder.prototype.uint = function (v, n) {
    v = BigInt(v);
    for (let i = n - 1; i >= 0; i--) this.bits.push(Number((v >> BigInt(i)) & 1n));
    return this;
  };
  Builder.prototype.int = function (v, n) {
    v = BigInt(v);
    if (v < 0n) v = (1n << BigInt(n)) + v;
    return this.uint(v, n);
  };
  Builder.prototype.bit = function (b) { this.bits.push(b ? 1 : 0); return this; };
  Builder.prototype.bytes = function (arr) { for (const x of arr) this.uint(x, 8); return this; };
  Builder.prototype.coins = function (v) {
    v = BigInt(v);
    if (v === 0n) return this.uint(0, 4);
    let len = 0, t = v;
    while (t > 0n) { len++; t >>= 8n; }
    return this.uint(len, 4).uint(v, len * 8);
  };
  Builder.prototype.address = function (a) { // a = {wc, hash(Uint8Array 32)} or null
    if (!a) return this.uint(0, 2);
    return this.uint(2, 2).uint(0, 1).int(a.wc, 8).bytes(a.hash);
  };
  Builder.prototype.ref = function (c) { this.refs.push(c); return this; };

  function cellData(c) {
    const n = c.bits.length;
    const full = Math.ceil(n / 8);
    const out = new Uint8Array(full);
    for (let i = 0; i < n; i++) if (c.bits[i]) out[i >> 3] |= 0x80 >> (i & 7);
    if (n % 8 !== 0) out[n >> 3] |= 0x80 >> (n & 7); // completion tag
    return out;
  }

  function toBoc(rootCell) {
    const order = [];
    (function walk(c) { if (order.indexOf(c) < 0) { order.push(c); c.refs.forEach(walk); } })(rootCell);
    const parts = [];
    for (const c of order) {
      const d1 = c.refs.length;
      const d2 = Math.floor(c.bits.length / 8) + Math.ceil(c.bits.length / 8);
      parts.push(d1, d2, ...cellData(c), ...c.refs.map(r => order.indexOf(r)));
    }
    const head = [0xb5, 0xee, 0x9c, 0x72, 0x01, 0x01, order.length, 1, 0, parts.length, 0];
    if (order.length > 255 || parts.length > 255) throw new Error("payload too big");
    return new Uint8Array([...head, ...parts]);
  }

  function b64(u8) { let s = ""; u8.forEach(x => s += String.fromCharCode(x)); return btoa(s); }

  function parseAddress(s) {
    s = String(s).trim();
    if (/^-?\d+:[0-9a-fA-F]{64}$/.test(s)) {
      const [wc, hex] = s.split(":");
      const hash = new Uint8Array(32);
      for (let i = 0; i < 32; i++) hash[i] = parseInt(hex.substr(i * 2, 2), 16);
      return { wc: Number(wc), hash };
    }
    const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/"));
    if (bin.length !== 36) throw new Error("bad address");
    const u = Uint8Array.from(bin, ch => ch.charCodeAt(0));
    if (crc16(u.subarray(0, 34)) !== ((u[34] << 8) | u[35])) throw new Error("bad address checksum");
    const wc = u[1] > 127 ? u[1] - 256 : u[1];
    return { wc, hash: u.slice(2, 34) };
  }
  function crc16(d) {
    let r = 0;
    for (const x of d) {
      r ^= x << 8;
      for (let i = 0; i < 8; i++) r = (r & 0x8000) ? ((r << 1) ^ 0x1021) & 0xffff : (r << 1) & 0xffff;
    }
    return r;
  }
  function rawOf(a) {
    const p = parseAddress(a);
    return p.wc + ":" + Array.from(p.hash, x => x.toString(16).padStart(2, "0")).join("");
  }

  function commentCell(text) {
    const bytes = new TextEncoder().encode(text).slice(0, 120);
    return new Builder().uint(0, 32).bytes(bytes);
  }

  // TON transfer with a comment
  function commentPayload(text) { return b64(toBoc(commentCell(text))); }

  // TEP-74 jetton transfer: sent to the SENDER's jetton wallet
  function jettonTransferPayload(amountUnits, destination, responseTo, text) {
    const body = new Builder()
      .uint(0x0f8a7ea5, 32)                // op transfer
      .uint(Date.now(), 64)                // query_id
      .coins(amountUnits)                  // jetton amount
      .address(parseAddress(destination))  // new owner
      .address(parseAddress(responseTo))   // excess TON back to the sender
      .bit(0)                              // no custom_payload
      .coins(1)                            // forward_ton_amount: 1 nanoton (so the comment is delivered)
      .bit(1)                              // forward_payload in a ref
      .ref(commentCell(text));
    return b64(toBoc(body));
  }

  root.TonPay = { commentPayload, jettonTransferPayload, parseAddress, rawOf, _toBoc: toBoc, _Builder: Builder };
})(typeof window !== "undefined" ? window : globalThis);
