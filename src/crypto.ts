/**
 * 数玺 · 密码学与哈希算法 (严格对齐《数玺协议规范 v1.3》§3、§4)
 */

// SM3 国密算法实现
function sm3_rotl(x: number, n: number): number {
  return ((x << n) | (x >>> (32 - n))) >>> 0;
}

function sm3_ff(j: number, x: number, y: number, z: number): number {
  if (j <= 15) return (x ^ y ^ z) >>> 0;
  return ((x & y) | (x & z) | (y & z)) >>> 0;
}

function sm3_gg(j: number, x: number, y: number, z: number): number {
  if (j <= 15) return (x ^ y ^ z) >>> 0;
  return ((x & y) | ((~x) & z)) >>> 0;
}

function sm3_p0(x: number): number {
  return (x ^ sm3_rotl(x, 9) ^ sm3_rotl(x, 17)) >>> 0;
}

function sm3_p1(x: number): number {
  return (x ^ sm3_rotl(x, 15) ^ sm3_rotl(x, 23)) >>> 0;
}

export function sm3Hash(data: Uint8Array): string {
  const len = data.length * 8;
  const k = (448 - ((len + 8) % 512) + 512) % 512;
  const totalBytes = (len + 8 + k + 64) / 8;
  const padded = new Uint8Array(totalBytes);
  padded.set(data);
  padded[data.length] = 0x80;

  // 64-bit length big endian
  const view = new DataView(padded.buffer);
  view.setBigUint64(totalBytes - 8, BigInt(len), false);

  let v = [
    0x7380166f, 0x4914b2b9, 0x172442d7, 0xda8a0600,
    0xa96f30bc, 0x163138aa, 0xe38dee4d, 0xb0fb0e4e
  ];

  const w = new Uint32Array(68);
  const w1 = new Uint32Array(64);

  for (let b = 0; b < totalBytes; b += 64) {
    for (let i = 0; i < 16; i++) {
      w[i] = view.getUint32(b + i * 4, false);
    }
    for (let j = 16; j < 68; j++) {
      w[j] = (sm3_p1(w[j - 16] ^ w[j - 9] ^ sm3_rotl(w[j - 3], 15)) ^ sm3_rotl(w[j - 13], 7) ^ w[j - 6]) >>> 0;
    }
    for (let j = 0; j < 64; j++) {
      w1[j] = (w[j] ^ w[j + 4]) >>> 0;
    }

    let [a, b_reg, c, d, e, f, g, h] = v;
    for (let j = 0; j < 64; j++) {
      const t = j < 16 ? 0x79cc4519 : 0x7a879d8a;
      const ss1 = sm3_rotl((sm3_rotl(a, 12) + e + sm3_rotl(t, j % 32)) >>> 0, 7);
      const ss2 = (ss1 ^ sm3_rotl(a, 12)) >>> 0;
      const tt1 = (sm3_ff(j, a, b_reg, c) + d + ss2 + w1[j]) >>> 0;
      const tt2 = (sm3_gg(j, e, f, g) + h + ss1 + w[j]) >>> 0;
      d = c;
      c = sm3_rotl(b_reg, 9);
      b_reg = a;
      a = tt1;
      h = g;
      g = sm3_rotl(f, 19);
      f = e;
      e = sm3_p0(tt2);
    }

    v = [
      (v[0] ^ a) >>> 0, (v[1] ^ b_reg) >>> 0,
      (v[2] ^ c) >>> 0, (v[3] ^ d) >>> 0,
      (v[4] ^ e) >>> 0, (v[5] ^ f) >>> 0,
      (v[6] ^ g) >>> 0, (v[7] ^ h) >>> 0
    ];
  }

  return v.map(x => x.toString(16).padStart(8, '0')).join('');
}

export function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
  }
  return bytes;
}

export async function sha256Hash(data: Uint8Array): Promise<string> {
  const hashBuf = await crypto.subtle.digest('SHA-256', data as unknown as BufferSource);
  const hashArr = Array.from(new Uint8Array(hashBuf));
  return hashArr.map(b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Merkle 树精确计算 (对齐协议 §3: 256KB 分块，叶子域前缀 0x00，内部节点 0x01，奇数层尾节点自复制)
 */
export async function computeExactDualRoot(data: Uint8Array): Promise<{ sha256: string; sm3: string }> {
  const CHUNK_SIZE = 256 * 1024;
  const chunks: Uint8Array[] = [];
  if (data.length === 0) {
    const emptySha = await sha256Hash(new Uint8Array([0x00]));
    const emptySm3 = sm3Hash(new Uint8Array([0x00]));
    return { sha256: emptySha, sm3: emptySm3 };
  }

  for (let i = 0; i < data.length; i += CHUNK_SIZE) {
    chunks.push(data.subarray(i, Math.min(i + CHUNK_SIZE, data.length)));
  }

  // 1. SM3 Merkle Root
  const sm3LeafHashes: Uint8Array[] = chunks.map(chunk => {
    const leafBuf = new Uint8Array(1 + chunk.length);
    leafBuf[0] = 0x00;
    leafBuf.set(chunk, 1);
    return hexToBytes(sm3Hash(leafBuf));
  });

  let sm3Level = sm3LeafHashes;
  while (sm3Level.length > 1) {
    if (sm3Level.length % 2 === 1) {
      sm3Level.push(sm3Level[sm3Level.length - 1]);
    }
    const nextLevel: Uint8Array[] = [];
    for (let i = 0; i < sm3Level.length; i += 2) {
      const nodeBuf = new Uint8Array(1 + 32 + 32);
      nodeBuf[0] = 0x01;
      nodeBuf.set(sm3Level[i], 1);
      nodeBuf.set(sm3Level[i + 1], 33);
      nextLevel.push(hexToBytes(sm3Hash(nodeBuf)));
    }
    sm3Level = nextLevel;
  }
  const sm3Root = Array.from(sm3Level[0]).map(b => b.toString(16).padStart(2, '0')).join('');

  // 2. SHA-256 Merkle Root
  const shaLeafHashes: Uint8Array[] = [];
  for (const chunk of chunks) {
    const leafBuf = new Uint8Array(1 + chunk.length);
    leafBuf[0] = 0x00;
    leafBuf.set(chunk, 1);
    const h = await sha256Hash(leafBuf);
    shaLeafHashes.push(hexToBytes(h));
  }

  let shaLevel = shaLeafHashes;
  while (shaLevel.length > 1) {
    if (shaLevel.length % 2 === 1) {
      shaLevel.push(shaLevel[shaLevel.length - 1]);
    }
    const nextLevel: Uint8Array[] = [];
    for (let i = 0; i < shaLevel.length; i += 2) {
      const nodeBuf = new Uint8Array(1 + 32 + 32);
      nodeBuf[0] = 0x01;
      nodeBuf.set(shaLevel[i], 1);
      nodeBuf.set(shaLevel[i + 1], 33);
      const h = await sha256Hash(nodeBuf);
      nextLevel.push(hexToBytes(h));
    }
    shaLevel = nextLevel;
  }
  const sha256Root = Array.from(shaLevel[0]).map(b => b.toString(16).padStart(2, '0')).join('');

  return { sha256: sha256Root, sm3: sm3Root };
}

/**
 * 感知层文本 3-gram 相似度 (对齐协议 §4: NFKC 归一化 -> 去空白 -> 转小写 -> 3-gram Jaccard)
 */
export function computeTextSimilarity(t1: string, t2: string): { score: number; formatted: string } {
  const clean = (s: string) => s.normalize('NFKC').replace(/\s+/g, '').toLowerCase();
  const c1 = clean(t1);
  const c2 = clean(t2);

  if (!c1 && !c2) return { score: 1.0, formatted: "不可用" };
  if (!c1 || !c2) return { score: 0.0, formatted: "0.0000" };

  const get3Grams = (s: string) => {
    const set = new Set<string>();
    if (s.length < 3) {
      set.add(s);
      return set;
    }
    for (let i = 0; i <= s.length - 3; i++) {
      set.add(s.substring(i, i + 3));
    }
    return set;
  };

  const g1 = get3Grams(c1);
  const g2 = get3Grams(c2);
  let intersection = 0;
  for (const item of g1) {
    if (g2.has(item)) intersection++;
  }
  const union = new Set([...g1, ...g2]).size;
  const score = union === 0 ? 0 : intersection / union;
  return { score, formatted: score.toFixed(4) };
}
