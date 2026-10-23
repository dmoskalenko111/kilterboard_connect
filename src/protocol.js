// Aurora (Kilter Board) BLE LED protocol: encoder + streaming decoder.
// Sources: bazun.me/blog/kiterboard, github.com/1-max-1/fake_kilter_board,
// github.com/Stevie-Ray/hangtime-grip-connect (aurora.model.ts).
const Aurora = (() => {
  const ADVERTISED_SERVICE = "4488b571-7806-4df6-bcff-a2897e4953ff";
  const UART_SERVICE = "6e400001-b5a3-f393-e0a9-e50e24dcca9e";
  const RX_CHARACTERISTIC = "6e400002-b5a3-f393-e0a9-e50e24dcca9e";
  const BODY_MAX = 255;   // max payload bytes per packet
  const CHUNK = 20;       // BLE write size

  const MARKERS = {
    2: { middle: 77, first: 78, last: 79, only: 80 },
    3: { middle: 81, first: 82, last: 83, only: 84 },
  };

  function checksum(bytes) {
    let i = 0;
    for (const b of bytes) i = (i + b) & 255;
    return ~i & 255;
  }

  function parseHex(color) {
    const c = String(color).replace(/^#/, "");
    if (!/^[0-9a-fA-F]{6}$/.test(c)) throw new Error("Bad color " + color);
    return [0, 2, 4].map((i) => parseInt(c.slice(i, i + 2), 16));
  }

  function encodePlacement(position, color, api) {
    const [r, g, b] = parseHex(color);
    if (api === 3) {
      if (!Number.isInteger(position) || position < 0 || position > 0xffff) throw new Error("Bad position " + position);
      return [position & 255, (position >> 8) & 255, ((r >> 5) << 5) | ((g >> 5) << 2) | (b >> 6)];
    }
    if (!Number.isInteger(position) || position < 0 || position > 0x3ff) throw new Error("Bad position " + position);
    return [position & 255, ((r >> 6) << 6) | ((g >> 6) << 4) | ((b >> 6) << 2) | ((position >> 8) & 3)];
  }

  // placements: [{position, color:"RRGGBB"}] -> full byte message (array of numbers)
  function encode(placements, api = 3) {
    if (api !== 2 && api !== 3) throw new Error("Unsupported API level " + api);
    const m = MARKERS[api];
    const per = api === 3 ? 3 : 2;
    const packets = [];
    let cur = [m.middle];
    for (const p of placements) {
      if (cur.length + per > BODY_MAX) { packets.push(cur); cur = [m.middle]; }
      cur.push(...encodePlacement(p.position, p.color, api));
    }
    packets.push(cur);
    if (packets.length === 1) packets[0][0] = m.only;
    else { packets[0][0] = m.first; packets[packets.length - 1][0] = m.last; }
    const out = [];
    for (const body of packets) out.push(1, body.length, checksum(body), 2, ...body, 3);
    return out;
  }

  function chunks(bytes, size = CHUNK) {
    const res = [];
    for (let i = 0; i < bytes.length; i += size) res.push(Uint8Array.from(bytes.slice(i, i + size)));
    return res;
  }

  // Expand a 3/3/2 or 2/2/2 color back to RRGGBB (what the LED will roughly show).
  function decodeColor(byte, api) {
    const hex = (v) => v.toString(16).padStart(2, "0");
    if (api === 3) {
      const r = (byte >> 5) & 7, g = (byte >> 2) & 7, b = byte & 3;
      return hex(Math.round((r * 255) / 7)) + hex(Math.round((g * 255) / 7)) + hex(Math.round((b * 255) / 3));
    }
    const r = (byte >> 6) & 3, g = (byte >> 4) & 3, b = (byte >> 2) & 3;
    return hex(Math.round((r * 255) / 3)) + hex(Math.round((g * 255) / 3)) + hex(Math.round((b * 255) / 3));
  }

  // Streaming decoder: feed() any chunks; onMessage(placements, api) fires per complete message.
  function createDecoder(onMessage, onError = () => {}) {
    let buf = [];
    let pending = null; // {api, placements}
    function handlePacket(body) {
      const marker = body[0];
      let api = null, kind = null;
      for (const lvl of [2, 3]) for (const [k, v] of Object.entries(MARKERS[lvl])) if (v === marker) { api = lvl; kind = k; }
      if (!api) return onError("Неизвестный маркер пакета " + marker);
      const per = api === 3 ? 3 : 2;
      if ((body.length - 1) % per !== 0) return onError("Длина данных не кратна " + per);
      const placements = [];
      for (let i = 1; i < body.length; i += per) {
        if (api === 3) placements.push({ position: body[i] | (body[i + 1] << 8), color: decodeColor(body[i + 2], 3) });
        else placements.push({ position: body[i] | ((body[i + 1] & 3) << 8), color: decodeColor(body[i + 1], 2) });
      }
      if (kind === "only") { pending = null; return onMessage(placements, api); }
      if (kind === "first") { pending = { api, placements }; return; }
      if (!pending || pending.api !== api) { pending = null; return onError("Пакет вне сообщения"); }
      pending.placements.push(...placements);
      if (kind === "last") { const p = pending; pending = null; onMessage(p.placements, p.api); }
    }
    function feed(chunk) {
      buf.push(...chunk);
      for (;;) {
        const start = buf.indexOf(1);
        if (start < 0) { buf = []; return; }
        if (start > 0) { onError("Мусор перед пакетом: " + start + " байт"); buf = buf.slice(start); }
        if (buf.length < 4) return;
        const len = buf[1];
        if (buf.length < len + 5) return;
        const body = buf.slice(4, 4 + len);
        const ok = buf[3] === 2 && buf[4 + len] === 3 && checksum(body) === buf[2];
        if (!ok) { onError("Битый пакет (рамка или контрольная сумма)"); buf = buf.slice(1); continue; }
        buf = buf.slice(len + 5);
        handlePacket(body);
      }
    }
    return { feed, reset() { buf = []; pending = null; } };
  }

  function apiFromName(name) {
    const m = /@(\d+)$/.exec(name || "");
    return m && Number(m[1]) === 3 ? 3 : 2;
  }

  return { ADVERTISED_SERVICE, UART_SERVICE, RX_CHARACTERISTIC, checksum, encode, chunks, createDecoder, decodeColor, apiFromName };
})();
if (typeof module !== "undefined") module.exports = Aurora;
