/**
 * Minimal POSIX ustar tar (single regular file) + gzip (CompressionStream).
 */

/**
 * @param {Uint8Array} header
 */
function tarChecksumSum(header) {
  let sum = 0;
  for (let i = 0; i < 512; i++) sum += header[i];
  return sum;
}

/**
 * @param {Uint8Array} buf
 * @param {number} offset
 * @param {string} str
 * @param {number} len
 */
function writeTarStr(buf, offset, str, len) {
  const enc = new TextEncoder();
  const b = enc.encode(str);
  buf.fill(0, offset, offset + len);
  buf.set(b.slice(0, len), offset);
}

/**
 * 12-byte field: 11 octal digits + ASCII NUL (GNU / POSIX ustar).
 * @param {Uint8Array} buf
 * @param {number} offset
 * @param {number} value
 */
function writeTarOct12(buf, offset, value) {
  const n = Math.max(0, Math.floor(Number(value) || 0));
  const o = n.toString(8);
  if (o.length > 11) throw new Error("tar numeric field overflow");
  const padded = ("00000000000" + o).slice(-11) + "\0";
  const enc = new TextEncoder();
  const bytes = enc.encode(padded);
  if (bytes.length !== 12) throw new Error("tar oct12 encode");
  buf.set(bytes, offset);
}

/**
 * One file inside a ustar archive; entry name must be ≤ 100 bytes (UTF-8).
 * @param {string} innerPath e.g. memory_tree.json
 * @param {Uint8Array} body
 * @returns {Uint8Array}
 */
export function packUstarTarSingle(innerPath, body) {
  const name = String(innerPath ?? "").replace(/^\/+/, "");
  const enc = new TextEncoder();
  if (enc.encode(name).length > 100) {
    throw new Error("Tar entry name too long (max 100 bytes)");
  }

  const header = new Uint8Array(512);
  writeTarStr(header, 0, name, 100);
  writeTarStr(header, 100, "0000644\0", 8);
  writeTarStr(header, 108, "0000000\0", 8);
  writeTarStr(header, 116, "0000000\0", 8);
  writeTarOct12(header, 124, body.length);
  writeTarOct12(header, 136, Math.floor(Date.now() / 1000));
  header[156] = 48; // '0' regular file
  writeTarStr(header, 257, "ustar\0", 6);
  writeTarStr(header, 263, "00", 2);

  for (let i = 148; i < 156; i++) header[i] = 0x20;
  const sum = tarChecksumSum(header);
  const o = sum.toString(8);
  const chk6 = o.length <= 6 ? ("000000" + o).slice(-6) : o.slice(-6);
  writeTarStr(header, 148, `${chk6}\0 `, 8);

  const pad = (512 - (body.length % 512)) % 512;
  const eofBlocks = 1024;
  const out = new Uint8Array(512 + body.length + pad + eofBlocks);
  out.set(header, 0);
  out.set(body, 512);
  return out;
}

/**
 * @param {Uint8Array} data
 * @returns {Promise<Uint8Array>}
 */
export async function gzipUint8Array(data) {
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(data);
      controller.close();
    },
  }).pipeThrough(new CompressionStream("gzip"));
  const buf = await new Response(stream).arrayBuffer();
  return new Uint8Array(buf);
}
