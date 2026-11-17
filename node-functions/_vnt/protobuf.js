// 最小 protobuf 编解码运行时（protobuf3 子集）
//
// 只实现本协议用到的能力：
//   - varint（wire type 0）
//   - fixed32 / fixed64（wire type 5 / 1，小端）
//   - length-delimited（wire type 2：string / bytes / 子消息 / packed 数组）
//
// 不做 schema 反射，直接按字段号手工读写，避免引入任何依赖，
// 以便同时运行在 EdgeOne Edge Functions(V8) 与 Cloud Functions(Node.js)。
//
// proto3 语义要点：
//   - 默认值（0 / "" / false / 空 bytes）不写入线路。
//   - 读取时不存在的字段一律回落到默认值。

export const WIRE = {
  VARINT: 0,
  FIXED64: 1,
  LEN: 2,
  FIXED32: 5,
};

/** 计算无符号 varint 的字节长度 */
export function varintSize(value) {
  let v = Number(value);
  if (v < 0) return 10; // 负数按 64 位补码处理，恒为 10 字节
  let n = 1;
  while (v >= 0x80) {
    v = Math.floor(v / 128);
    n++;
  }
  return n;
}

/** 计算 tag（field<<3 | wireType）的字节长度 */
export function tagSize(field, wire) {
  return varintSize(field * 8 + wire);
}

export class Writer {
  constructor() {
    this.bytes = new Uint8Array(256);
    this.pos = 0;
  }

  _ensure(extra) {
    if (this.pos + extra <= this.bytes.length) return;
    let cap = this.bytes.length;
    while (cap < this.pos + extra) cap *= 2;
    const next = new Uint8Array(cap);
    next.set(this.bytes.subarray(0, this.pos));
    this.bytes = next;
  }

  writeVarint(value) {
    this._ensure(10);
    let v = Number(value);
    if (v < 0 || v > Number.MAX_SAFE_INTEGER) {
      // 大于 2^53 的整数用 BigInt 处理，保证 u64 正确
      let big = BigInt(value);
      if (big < 0n) big += 1n << 64n;
      while (big >= 0x80n) {
        this.bytes[this.pos++] = Number((big & 0x7fn) | 0x80n);
        big >>= 7n;
      }
      this.bytes[this.pos++] = Number(big);
      return this;
    }
    if (v < 0) v += 0x10000000000000000;
    while (v >= 0x80) {
      this.bytes[this.pos++] = (v & 0x7f) | 0x80;
      v = Math.floor(v / 128);
    }
    this.bytes[this.pos++] = v;
    return this;
  }

  writeTag(field, wire) {
    return this.writeVarint(field * 8 + wire);
  }

  writeFixed32(value) {
    this._ensure(4);
    const v = Number(value) >>> 0;
    this.bytes[this.pos++] = v & 0xff;
    this.bytes[this.pos++] = (v >>> 8) & 0xff;
    this.bytes[this.pos++] = (v >>> 16) & 0xff;
    this.bytes[this.pos++] = (v >>> 24) & 0xff;
    return this;
  }

  writeFixed64(value) {
    this._ensure(8);
    let big = BigInt(value);
    if (big < 0n) big += 1n << 64n;
    for (let i = 0; i < 8; i++) {
      this.bytes[this.pos++] = Number(big & 0xffn);
      big >>= 8n;
    }
    return this;
  }

  writeBytes(bytes) {
    const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    this._ensure(arr.length);
    this.bytes.set(arr, this.pos);
    this.pos += arr.length;
    return this;
  }

  writeLengthDelimited(field, bytes) {
    const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    this.writeTag(field, WIRE.LEN);
    this.writeVarint(arr.length);
    this.writeBytes(arr);
    return this;
  }

  writeString(field, str) {
    if (!str) return this;
    return this.writeLengthDelimited(field, new TextEncoder().encode(str));
  }

  /** 写入子消息（字段号 + 长度 + 内容） */
  writeMessage(field, subWriter) {
    return this.writeLengthDelimited(field, subWriter.snapshot());
  }

  writeUInt32(field, value) {
    if (!value) return this;
    this.writeTag(field, WIRE.VARINT);
    this.writeVarint(value);
    return this;
  }

  /** 有符号 64 位（int64），负数编码为 10 字节补码 */
  writeInt64(field, value) {
    if (!value) return this;
    this.writeTag(field, WIRE.VARINT);
    this.writeVarint(value);
    return this;
  }

  writeBool(field, value) {
    if (!value) return this;
    this.writeTag(field, WIRE.VARINT);
    this.writeVarint(1);
    return this;
  }

  writeFixed32Field(field, value) {
    if (!value) return this;
    this.writeTag(field, WIRE.FIXED32);
    this.writeFixed32(value);
    return this;
  }

  /** 无条件的 fixed32（用于必须显式写 0 的可选字段） */
  writeFixed32Always(field, value) {
    this.writeTag(field, WIRE.FIXED32);
    this.writeFixed32(value);
    return this;
  }

  writeFixed64Field(field, value) {
    if (!value) return this;
    this.writeTag(field, WIRE.FIXED64);
    this.writeFixed64(value);
    return this;
  }

  snapshot() {
    return this.bytes.subarray(0, this.pos);
  }

  finish() {
    // 复制一份，避免 subarray 共享底层缓冲
    return new Uint8Array(this.snapshot());
  }
}

export class Reader {
  constructor(bytes) {
    this.bytes = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    this.pos = 0;
  }

  get done() {
    return this.pos >= this.bytes.length;
  }

  readVarint() {
    // 用 BigInt 累加保证 u64 正确，最后转回 Number。
    // 协议里超过 2^53 的值只出现在版本号等对精度不敏感的场景。
    let big = 0n;
    let shift = 0n;
    for (let i = 0; i < 10; i++) {
      const b = this.bytes[this.pos++];
      if (b === undefined) throw new Error("protobuf: varint 越界");
      big |= BigInt(b & 0x7f) << shift;
      if ((b & 0x80) === 0) return Number(big);
      shift += 7n;
    }
    throw new Error("protobuf: varint 超过 10 字节");
  }

  readTag() {
    const tag = this.readVarint();
    return { field: Math.floor(tag / 8), wire: tag % 8 };
  }

  readFixed32() {
    const b = this.bytes;
    const v =
      (b[this.pos] | (b[this.pos + 1] << 8) | (b[this.pos + 2] << 16) | (b[this.pos + 3] << 24)) >>>
      0;
    this.pos += 4;
    return v;
  }

  readFixed64() {
    let big = 0n;
    for (let i = 0; i < 8; i++) {
      big |= BigInt(this.bytes[this.pos + i]) << BigInt(8 * i);
    }
    this.pos += 8;
    return big;
  }

  readBytes() {
    const len = this.readVarint();
    const out = this.bytes.subarray(this.pos, this.pos + len);
    this.pos += len;
    return out;
  }

  readString() {
    return new TextDecoder().decode(this.readBytes());
  }

  /** 读取子消息为新的 Reader */
  readMessage() {
    return new Reader(this.readBytes());
  }

  skip(wire) {
    switch (wire) {
      case WIRE.VARINT:
        this.readVarint();
        break;
      case WIRE.FIXED64:
        this.pos += 8;
        break;
      case WIRE.LEN: {
        // 必须先读长度再移动游标：readVarint 会改写 this.pos，
        // 若写成 `this.pos += this.readVarint()`，复合赋值会取到旧值而回退游标。
        const len = this.readVarint();
        this.pos += len;
        break;
      }
      case WIRE.FIXED32:
        this.pos += 4;
        break;
      default:
        throw new Error(`protobuf: 未知 wire type ${wire}`);
    }
  }

  /** 遍历字段，回调返回 true 表示已消费 */
  each(fn) {
    while (!this.done) {
      const { field, wire } = this.readTag();
      if (fn(field, wire, this)) continue;
      this.skip(wire);
    }
  }
}

/**
 * 解码 packed repeated uint32/fixed32 数组。
 * @param {Uint8Array} bytes
 * @param {boolean} fixed 是否为 fixed32 打包
 */
export function decodePacked(bytes, fixed = false) {
  const r = new Reader(bytes);
  const out = [];
  const step = fixed ? 4 : null;
  while (!r.done) {
    out.push(fixed ? r.readFixed32() : r.readVarint());
  }
  return out;
}
