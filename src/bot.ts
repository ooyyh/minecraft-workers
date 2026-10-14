import { DurableObject } from "cloudflare:workers";
import { connect } from "cloudflare:sockets";
import { concat } from "./protocol";
import { DEFAULT_TARGET, serverTarget, type ServerTarget } from "./target";
import { decodeString, encodePlay, FrameDecoder, loginHandshake, readVar, stringField } from "./bot-protocol";
import { blockState, decodeBlockPosition, decodeChunk, decodeChunkBulk, type TerrainChunk } from "./world";

type Entry = { at: string; kind: string; text: string };
type BotState = {
  desired: boolean;
  username: string;
  phase: "stopped" | "connecting" | "login" | "play" | "disconnected" | "error";
  since: string | null;
  lastPacket: string | null;
  keepAlives: number;
  packets: number;
  disconnectReason: string | null;
  position: { x: number; y: number; z: number; yaw: number; pitch: number } | null;
  logs: Entry[];
};
type ControlInput = {
  forward: boolean;
  back: boolean;
  left: boolean;
  right: boolean;
  jump: boolean;
  sprint: boolean;
  sneak: boolean;
  yaw: number;
  pitch: number;
};
const INITIAL: BotState = {
  desired: false, username: "CodexBot", phase: "stopped", since: null,
  lastPacket: null, keepAlives: 0, packets: 0, disconnectReason: null, position: null, logs: [],
};

export class MinecraftBot extends DurableObject<Env> {
  private socket: ReturnType<typeof connect> | null = null;
  private reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  private writer: WritableStreamDefaultWriter<Uint8Array> | null = null;
  private loop: Promise<void> | null = null;
  private state: BotState = structuredClone(INITIAL);
  private threshold = -1;
  private mode: "login" | "play" = "login";
  private generation = 0;
  private sendQueue: Promise<void> = Promise.resolve();
  private position = { x: 0, y: 0, z: 0, yaw: 0, pitch: 0 };
  private chunks = new Map<string, TerrainChunk>();
  private skyLight = true;
  private spawn: { x: number; y: number; z: number } | null = null;
  private chunksSeen = 0;
  private nearbySeen = 0;
  private controls: ControlInput = { forward: false, back: false, left: false, right: false, jump: false, sprint: false, sneak: false, yaw: 0, pitch: 0 };
  private jumpQueued = false;
  private controlTimer: ReturnType<typeof setInterval> | null = null;
  private tickInFlight = false;
  private respawnRequested = false;
  private positionReady = false;
  private velocityY = 0;
  private onGround = false;
  private physicsReady = false;
  private target: ServerTarget = { ...DEFAULT_TARGET };

  // A compact collision model for the legacy block IDs used by the server.
  // The chunk cache remains authoritative for rendering; this only supplies
  // the small amount of physics a Minecraft client performs locally.
  private static readonly NON_SOLID = new Set([
    0, 6, 8, 9, 10, 11, 20, 31, 32, 37, 38, 39, 40, 50, 51, 55, 59, 63,
    65, 66, 68, 69, 70, 75, 76, 78, 83, 90, 104, 105, 106, 111, 115, 141,
    142, 144, 175,
  ]);

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      this.state = await ctx.storage.get<BotState>("bot") ?? structuredClone(INITIAL);
      this.target = await ctx.storage.get<ServerTarget>("target") ?? { ...DEFAULT_TARGET };
      if (this.state.desired && this.state.phase === "play") this.state.phase = "disconnected";
      if (this.state.desired) await ctx.storage.setAlarm(Date.now() + 1000);
    });
  }

  private async save() {
    await this.ctx.storage.put("bot", this.state);
  }
  private async note(kind: string, text: string) {
    this.state.logs.push({ at: new Date().toISOString(), kind, text: text.slice(0, 500) });
    if (this.state.logs.length > 80) this.state.logs = this.state.logs.slice(-80);
    await this.save();
  }
  async status() {
    return { ...this.state, position: this.state.position ?? null, chunkCount: this.chunks.size, chunksSeen: this.chunksSeen, nearbySeen: this.nearbySeen, connected: this.socket !== null && this.state.phase === "play", target: { ...this.target } };
  }
  async config() { return { target: { ...this.target } }; }
  async setConfig(input: Record<string, unknown>) {
    const target = serverTarget(input);
    const changed = target.hostname !== this.target.hostname || target.port !== this.target.port;
    await this.ctx.storage.put("target", target);
    this.target = target;
    if (changed) {
      await this.shutdown();
      this.state.position = null;
      this.chunks.clear();
      this.state.disconnectReason = null;
      this.state.since = null;
      this.state.phase = this.state.desired ? "connecting" : "stopped";
      await this.note("system", `服务器已更新为 ${target.hostname}:${target.port}`);
      if (this.state.desired && !this.loop) {
        await this.ctx.storage.setAlarm(Date.now() + 1000);
        this.launch();
      }
    }
    return { target: { ...this.target }, changed, reconnecting: changed && this.state.desired };
  }
  async world() {
    const position = this.state.position ?? null;
    const centerX = Math.floor((position?.x ?? 0) / 16);
    const centerZ = Math.floor((position?.z ?? 0) / 16);
    const nearby = [...this.chunks.values()].filter(chunk => Math.abs(chunk.x - centerX) <= 1 && Math.abs(chunk.z - centerZ) <= 1);
    const chunks = nearby
      .map(chunk => {
        const heights: number[] = [], blocks: number[] = [];
        for (let z = 0; z < 16; z += 2) for (let x = 0; x < 16; x += 2) {
          const index = z * 16 + x;
          heights.push(chunk.heights[index]); blocks.push(chunk.blocks[index]);
        }
        return { x: chunk.x, z: chunk.z, step: 2, heights, blocks };
      });
    // Keep the authoritative world in compact section arrays on the DO, but
    // only send exposed blocks in a small bubble to the browser. Four numbers
    // per voxel are cheaper than serialising full chunk objects and allow the
    // client to draw walls, trees and overhangs instead of a radar heightmap.
    const voxels: number[] = [];
    const px = position?.x ?? centerX * 16 + 8, py = position?.y ?? 80, pz = position?.z ?? centerZ * 16 + 8;
    const minY = Math.max(0, Math.floor(py) - 18), maxY = Math.min(255, Math.floor(py) + 22);
    const radius = 26, radiusSq = radius * radius;
    for (const chunk of nearby) {
      const minX = Math.max(chunk.x * 16, Math.floor(px - radius));
      const maxX = Math.min(chunk.x * 16 + 15, Math.floor(px + radius));
      const minZ = Math.max(chunk.z * 16, Math.floor(pz - radius));
      const maxZ = Math.min(chunk.z * 16 + 15, Math.floor(pz + radius));
      for (let y = minY; y <= maxY; y++) for (let z = minZ; z <= maxZ; z++) for (let x = minX; x <= maxX; x++) {
        const dx = x + .5 - px, dz = z + .5 - pz;
        if (dx * dx + dz * dz > radiusSq) continue;
        const state = blockState(this.chunks, x, y, z);
        const id = state === null ? 0 : state >> 4;
        if (!id) continue;
        const exposed = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]].some(([ox, oy, oz]) => {
          const neighbour = blockState(this.chunks, x + ox, y + oy, z + oz);
          return neighbour === null || neighbour === 0;
        });
        if (!exposed) continue;
        voxels.push(x, y, z, id);
        if (voxels.length >= 48_000) break;
      }
      if (voxels.length >= 48_000) break;
    }
    return { position, chunks, voxels, voxelCount: voxels.length / 4, nearest: [...this.chunks.values()].map(chunk => ({ x: chunk.x, z: chunk.z })).sort((a,b) => Math.abs(a.x-centerX)+Math.abs(a.z-centerZ)-Math.abs(b.x-centerX)-Math.abs(b.z-centerZ)).slice(0, 6), chunkCount: this.chunks.size, phase: this.state.phase, connected: this.socket !== null && this.state.phase === "play" };
  }
  async start(username = "CodexBot") {
    if (!/^[a-zA-Z0-9_]{3,16}$/.test(username)) throw Error("用户名需为 3–16 位英文字母、数字或下划线");
    if (this.state.desired && this.state.username === username && this.loop) return this.status();
    if (this.state.username !== username && this.socket) await this.shutdown();
    this.state.username = username;
    this.state.desired = true;
    this.state.disconnectReason = null;
    await this.save();
    await this.ctx.storage.setAlarm(Date.now() + 60_000);
    if (!this.loop) this.launch();
    return this.status();
  }
  async stop() {
    this.state.desired = false;
    this.state.phase = "stopped";
    this.state.since = null;
    await this.note("system", "已手动停止");
    await this.ctx.storage.deleteAlarm();
    await this.shutdown();
    return this.status();
  }
  async chat(message: string) {
    if (typeof message !== "string" || !message.trim() || new TextEncoder().encode(message).length > 100) {
      throw Error("聊天消息需要 1–100 字节");
    }
    if (this.state.phase !== "play" || !this.writer) throw Error("机器人尚未进入游戏");
    await this.sendPlay(0x01, stringField(message));
    await this.note("sent", message);
    return { sent: true };
  }
  async control(input: Partial<ControlInput>) {
    if (!this.positionReady) throw Error("Waiting for server position");
    if (this.state.phase !== "play" || !this.writer) throw Error("机器人尚未进入游戏");
    const next: ControlInput = {
      forward: Boolean(input.forward), back: Boolean(input.back), left: Boolean(input.left), right: Boolean(input.right),
      jump: Boolean(input.jump), sprint: Boolean(input.sprint), sneak: Boolean(input.sneak),
      yaw: Number(input.yaw), pitch: Number(input.pitch),
    };
    if (![next.yaw, next.pitch].every(Number.isFinite)) throw Error("视角参数无效");
    next.yaw = Math.max(-180, Math.min(180, next.yaw));
    next.pitch = Math.max(-90, Math.min(90, next.pitch));
    if (next.jump && !this.controls.jump) this.jumpQueued = true;
    this.controls = next;
    // The 50 ms loop owns packet emission. HTTP requests only replace the
    // current input state, so overlapping browser requests cannot race the
    // local position prediction or flood the server with duplicate moves.
    return this.status();
  }
  async alarm() {
    if (!this.state.desired) return;
    if (!this.loop) this.launch();
    await this.ctx.storage.setAlarm(Date.now() + 60_000);
  }
  private launch() {
    const generation = ++this.generation;
    const pending = this.run(generation).catch(async error => {
      if (generation !== this.generation) return;
      this.state.phase = "error";
      this.state.disconnectReason = error instanceof Error ? error.message : String(error);
      await this.note("error", this.state.disconnectReason);
    }).finally(async () => {
      if (this.loop !== pending) return;
      this.stopControlLoop();
      this.loop = null;
      this.socket = null;
      this.reader = null;
      this.writer = null;
      if (this.state.desired) {
        if (this.state.phase !== "error") this.state.phase = "disconnected";
        await this.save();
        await this.ctx.storage.setAlarm(Date.now() + 10_000);
      }
    });
    this.loop = pending;
    // The TCP socket keeps the object alive while connected; the alarm recovers after eviction.
    void pending.catch(error => console.error("bot loop failed", error));
  }
  private async run(generation: number) {
    this.mode = "login";
    this.threshold = -1;
    this.position = { x: 0, y: 0, z: 0, yaw: 0, pitch: 0 };
    this.state.position = null;
    this.chunks.clear();
    this.chunksSeen = 0;
    this.nearbySeen = 0;
    this.skyLight = true;
    this.spawn = null;
    this.respawnRequested = false;
    this.positionReady = false;
    this.velocityY = 0;
    this.onGround = false;
    this.physicsReady = false;
    this.state.phase = "connecting";
    await this.note("system", `正在连接 ${this.target.hostname}:${this.target.port}`);
    const socket = connect(this.target);
    this.socket = socket;
    void socket.closed.catch(() => undefined);
    this.reader = socket.readable.getReader();
    this.writer = socket.writable.getWriter();
    try {
      await socket.opened;
      if (!this.state.desired || generation !== this.generation) return;
      this.state.phase = "login";
      await this.note("system", `登录用户名: ${this.state.username}`);
      await this.write(loginHandshake(this.target.hostname, this.target.port, this.state.username));
      const decoder = new FrameDecoder();
      let lastSave = Date.now();
      while (this.state.desired && generation === this.generation) {
        const read = await this.reader.read();
        if (read.done) throw Error("服务器断开连接");
        decoder.push(read.value);
        let frame: ReturnType<FrameDecoder["next"]>;
        while ((frame = decoder.next(this.threshold))) {
          await this.handle(frame.id, frame.data);
          this.state.packets++;
          this.state.lastPacket = new Date().toISOString();
        }
        if (Date.now() - lastSave > 3000) { await this.save(); lastSave = Date.now(); }
      }
    } finally {
      await socket.close().catch(() => undefined);
    }
  }
  private async handle(id: number, data: Uint8Array) {
    if (this.mode === "login") {
      if (id === 0x00) {
        const reason = decodeString(data).value;
        throw Error(`登录被拒绝: ${reason}`);
      }
      if (id === 0x01) throw Error("目标服要求在线模式加密；当前版本仅支持该服的离线模式");
      if (id === 0x03) {
        const threshold = readVar(data);
        if (!threshold) throw Error("压缩阈值缺失");
        this.threshold = threshold.value;
        await this.note("system", `服务端启用压缩，阈值 ${this.threshold}`);
      }
      if (id === 0x02) {
        const uuidField = decodeString(data);
        const uuid = uuidField.value;
        const username = decodeString(data, uuidField.next).value;
        this.mode = "play";
        this.state.phase = "play";
        this.state.since = new Date().toISOString();
        this.state.disconnectReason = null;
        await this.note("joined", `已进入服务器: ${username} (${uuid})`);
        // 1.8.9 client settings: locale, view distance, chat flags, colors, skin bits.
        await this.sendPlay(0x15, concat(stringField("zh_CN"), Uint8Array.of(2, 0, 1, 0x7f)));
        this.startControlLoop();
      }
      return;
    }
    // 1.8.9 Play packet IDs: Keep Alive 0x00, Chat 0x02, Update Health 0x06,
    // Respawn 0x07, Position 0x08, Client Status (serverbound) 0x16.
    if (id === 0x01) {
      if (data.length >= 6) this.skyLight = new DataView(data.buffer, data.byteOffset, data.byteLength).getInt8(5) === 0;
    } else if (id === 0x07) {
      if (data.length >= 4) this.skyLight = new DataView(data.buffer, data.byteOffset, data.byteLength).getInt32(0) === 0;
      this.chunks.clear();
      this.positionReady = false;
      this.state.position = null;
    } else if (id === 0x05) {
      this.spawn = decodeBlockPosition(data);
    } else if (id === 0x06) {
      // Update Health: Float health, Short food, Float saturation (all big-endian).
      // Health <= 0 means the death screen is active. Client Status action 0
      // asks a vanilla 1.8.9 server to respawn immediately.
      if (data.length < 4) throw Error("Update Health packet is incomplete");
      const health = new DataView(data.buffer, data.byteOffset, data.byteLength).getFloat32(0);
      if (health > 0) {
        this.respawnRequested = false;
      } else if (!this.respawnRequested) {
        this.respawnRequested = true;
        await this.sendPlay(0x16, Uint8Array.of(0));
        await this.note("system", "死亡后自动复活");
      }
    } else if (id === 0x21) {
      const view = data.length >= 8 ? new DataView(data.buffer, data.byteOffset, data.byteLength) : null;
      if (view && this.state.position && !this.isNearby(view.getInt32(0), view.getInt32(4))) return;
      const chunk = decodeChunk(data, this.skyLight);
      if (chunk) this.rememberChunk(chunk);
      else if (data.length >= 8) {
        const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
        this.chunks.delete(`${view.getInt32(0)},${view.getInt32(4)}`);
      }
    } else if (id === 0x26) {
      for (const chunk of decodeChunkBulk(data, (x, z) => this.isNearby(x, z))) this.rememberChunk(chunk);
    } else if (id === 0x00) {
      if (!readVar(data) || data.length > 5) throw Error("KeepAlive 格式异常");
      await this.sendPlay(0x00, data);
      this.state.keepAlives++;
    } else if (id === 0x02) {
      const msg = decodeString(data).value;
      await this.note("chat", msg);
    } else if (id === 0x08) {
      if (data.length < 33) throw Error("位置包长度异常");
      const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
      const flags = view.getUint8(32);
      const x = view.getFloat64(0) + (flags & 1 ? this.position.x : 0);
      const y = view.getFloat64(8) + (flags & 2 ? this.position.y : 0);
      const z = view.getFloat64(16) + (flags & 4 ? this.position.z : 0);
      const yaw = view.getFloat32(24) + (flags & 8 ? this.position.yaw : 0);
      const pitch = view.getFloat32(28) + (flags & 16 ? this.position.pitch : 0);
      this.position = { x, y, z, yaw, pitch };
      this.state.position = { x, y, z, yaw, pitch };
      this.positionReady = true;
      this.velocityY = 0;
      const supported = this.supportStatus(x, y, z);
      // Until the spawn chunk arrives, assume the server's initial position
      // is grounded. Once terrain is known, physics takes over.
      this.onGround = supported === undefined ? true : supported;
      this.physicsReady = supported !== undefined;
      for (const [key, chunk] of this.chunks) if (!this.isNearby(chunk.x, chunk.z)) this.chunks.delete(key);
      const reply = new Uint8Array(33);
      const out = new DataView(reply.buffer);
      out.setFloat64(0, x); out.setFloat64(8, y); out.setFloat64(16, z);
      out.setFloat32(24, yaw); out.setFloat32(28, pitch); out.setUint8(32, this.onGround ? 1 : 0);
      await this.sendPlay(0x06, reply);
    } else if (id === 0x40) {
      throw Error(`服务器踢出: ${decodeString(data).value}`);
    }
  }
  private rememberChunk(chunk: TerrainChunk) {
    this.chunksSeen++;
    if (this.state.position && !this.isNearby(chunk.x, chunk.z)) return;
    this.nearbySeen++;
    const key = `${chunk.x},${chunk.z}`;
    this.chunks.delete(key);
    this.chunks.set(key, chunk);
    while (this.chunks.size > (this.state.position ? 9 : 1024)) this.chunks.delete(this.chunks.keys().next().value!);
  }
  private isNearby(x: number, z: number): boolean {
    const pos = this.state.position;
    const center = pos ?? this.spawn;
    return !center || (Math.abs(x - Math.floor(center.x / 16)) <= 1 && Math.abs(z - Math.floor(center.z / 16)) <= 1);
  }
  private async sendPlay(id: number, data: Uint8Array) {
    await this.write(encodePlay(id, data, this.threshold));
  }
  private startControlLoop() {
    if (this.controlTimer) return;
    this.controlTimer = setInterval(() => {
      void this.sendTick().catch(error => {
        if (this.state.phase === "play") void this.note("error", error instanceof Error ? error.message : String(error));
      });
    }, 50);
  }
  private stopControlLoop() {
    if (this.controlTimer) {
      clearInterval(this.controlTimer);
      this.controlTimer = null;
    }
    this.tickInFlight = false;
  }
  private async sendTick() {
    if (!this.writer || !this.positionReady || this.state.phase !== "play") return;
    if (this.tickInFlight) return;
    this.tickInFlight = true;
    try {
      // Let the server own the accepted position while idle. Sending a
      // locally predicted Y every tick can disagree with the spawn platform
      // before all chunk sections have arrived and triggers Spigot's flying
      // check. Vanilla sends an on-ground packet when there is no movement.
      if (this.hasMovement() || !this.onGround || !this.physicsReady) await this.sendMovement();
      else await this.sendGroundAndLook();
    } finally {
      this.tickInFlight = false;
    }
  }
  private hasMovement() {
    return this.controls.forward || this.controls.back || this.controls.left || this.controls.right || this.controls.jump || this.jumpQueued;
  }
  private async sendMovement() {
    if (!this.writer || !this.positionReady) return;
    const yaw = this.controls.yaw * Math.PI / 180;
    const forward = (this.controls.forward ? 1 : 0) - (this.controls.back ? 1 : 0);
    const strafe = (this.controls.right ? 1 : 0) - (this.controls.left ? 1 : 0);
    const length = Math.hypot(forward, strafe) || 1;
    const speed = this.controls.sneak ? 0.045 : this.controls.sprint ? 0.13 : 0.1;
    // Minecraft yaw 0 faces +Z; positive strafe is the player's right (-X).
    const dx = (-Math.sin(yaw) * forward - Math.cos(yaw) * strafe) / length * speed;
    const dz = (Math.cos(yaw) * forward - Math.sin(yaw) * strafe) / length * speed;

    // Do not invent a fall or walk through an unloaded spawn section. The
    // first position packet often arrives before the first chunk packet; send
    // the server's accepted position for this short window and begin physics
    // as soon as collision data makes the support block knowable.
    if (!this.physicsReady) {
      const supported = this.supportStatus(this.position.x, this.position.y, this.position.z);
      if (supported !== undefined) {
        this.physicsReady = true;
        this.onGround = supported;
      } else {
        this.velocityY = 0;
        this.onGround = true;
        this.position.yaw = this.controls.yaw;
        this.position.pitch = this.controls.pitch;
        this.state.position = { ...this.position };
        const waiting = new Uint8Array(33);
        const out = new DataView(waiting.buffer);
        out.setFloat64(0, this.position.x); out.setFloat64(8, this.position.y); out.setFloat64(16, this.position.z);
        out.setFloat32(24, this.position.yaw); out.setFloat32(28, this.position.pitch); out.setUint8(32, 1);
        await this.sendPlay(0x06, waiting);
        return;
      }
    }
    if (this.jumpQueued && this.onGround) this.velocityY = 0.42;
    this.jumpQueued = false;

    // Resolve horizontal axes independently, matching the useful part of
    // vanilla's AABB movement and allowing the player to slide along walls.
    const nextX = this.position.x + dx;
    const nextZ = this.position.z + dz;
    if (!this.collidesAt(nextX, this.position.y, this.position.z)) this.position.x = nextX;
    if (!this.collidesAt(this.position.x, this.position.y, nextZ)) this.position.z = nextZ;

    // Apply the same coarse 20 TPS gravity used by a vanilla client. A player
    // that starts one block above the cached surface must send falling
    // position packets with onGround=false or Spigot will kick it as flying.
    this.velocityY = Math.max(-3.92, this.velocityY - 0.08);
    const vertical = this.resolveVertical(this.position.y + this.velocityY);
    this.position.y = vertical.y;
    this.onGround = vertical.onGround;
    this.position.yaw = this.controls.yaw;
    this.position.pitch = this.controls.pitch;
    this.state.position = { ...this.position };
    // 1.8.9 serverbound Player Position And Look: X, Y, Z, yaw, pitch, onGround.
    const data = new Uint8Array(33);
    const view = new DataView(data.buffer);
    view.setFloat64(0, this.position.x);
    view.setFloat64(8, this.position.y);
    view.setFloat64(16, this.position.z);
    view.setFloat32(24, this.position.yaw);
    view.setFloat32(28, this.position.pitch);
    view.setUint8(32, this.onGround ? 1 : 0);
    await this.sendPlay(0x06, data);
  }

  private isSolid(x: number, y: number, z: number): boolean {
    const state = blockState(this.chunks, x, y, z);
    if (state === null) return false;
    const id = state >> 4;
    return id !== 0 && !MinecraftBot.NON_SOLID.has(id);
  }

  private supportStatus(x: number, y: number, z: number): boolean | undefined {
    const by = Math.floor(y - 0.05);
    let unknown = false;
    for (let bz = Math.floor(z - 0.29); bz <= Math.floor(z + 0.29); bz++) {
      for (let bx = Math.floor(x - 0.29); bx <= Math.floor(x + 0.29); bx++) {
        const state = blockState(this.chunks, bx, by, bz);
        if (state === null) unknown = true;
        else if ((state >> 4) !== 0 && !MinecraftBot.NON_SOLID.has(state >> 4)) return true;
      }
    }
    return unknown ? undefined : false;
  }

  private collidesAt(x: number, y: number, z: number): boolean {
    const minX = Math.floor(x - 0.3), maxX = Math.floor(x + 0.3);
    const minZ = Math.floor(z - 0.3), maxZ = Math.floor(z + 0.3);
    const minY = Math.floor(y + 0.01), maxY = Math.floor(y + 1.79);
    for (let by = minY; by <= maxY; by++) for (let bz = minZ; bz <= maxZ; bz++) for (let bx = minX; bx <= maxX; bx++) {
      if (this.isSolid(bx, by, bz)) return true;
    }
    return false;
  }

  private resolveVertical(nextY: number): { y: number; onGround: boolean } {
    const currentY = this.position.y;
    const minX = Math.floor(this.position.x - 0.29), maxX = Math.floor(this.position.x + 0.29);
    const minZ = Math.floor(this.position.z - 0.29), maxZ = Math.floor(this.position.z + 0.29);
    if (this.velocityY <= 0) {
      let landing = -Infinity;
      for (let by = Math.floor(nextY - 0.01); by <= Math.floor(currentY + 0.01); by++) {
        for (let bz = minZ; bz <= maxZ; bz++) for (let bx = minX; bx <= maxX; bx++) {
          if (this.isSolid(bx, by, bz)) {
            const top = by + 1;
            if (top <= currentY + 0.06 && top >= nextY - 0.06) landing = Math.max(landing, top);
          }
        }
      }
      if (landing > -Infinity) { this.velocityY = 0; return { y: landing, onGround: true }; }
      const support = this.supportStatus(this.position.x, nextY, this.position.z);
      if (support === undefined && this.onGround) { this.velocityY = 0; return { y: currentY, onGround: true }; }
      return { y: nextY, onGround: support === true && Math.abs(nextY - currentY) < 0.001 };
    }
    const currentTop = currentY + 1.8, nextTop = nextY + 1.8;
    for (let by = Math.floor(currentTop - 0.01); by <= Math.floor(nextTop + 0.01); by++) {
      for (let bz = minZ; bz <= maxZ; bz++) for (let bx = minX; bx <= maxX; bx++) {
        if (this.isSolid(bx, by, bz) && by < nextTop && by >= currentTop - 0.06) {
          this.velocityY = 0;
          return { y: by - 1.8, onGround: false };
        }
      }
    }
    return { y: nextY, onGround: false };
  }
  private async sendGroundAndLook() {
    if (!this.writer || !this.positionReady) return;
    await this.sendPlay(0x03, Uint8Array.of(this.onGround ? 1 : 0));
    if (this.controls.yaw !== this.position.yaw || this.controls.pitch !== this.position.pitch) {
      const data = new Uint8Array(9);
      const view = new DataView(data.buffer);
      view.setFloat32(0, this.controls.yaw);
      view.setFloat32(4, this.controls.pitch);
      view.setUint8(8, this.onGround ? 1 : 0);
      this.position.yaw = this.controls.yaw;
      this.position.pitch = this.controls.pitch;
      this.state.position = { ...this.position };
      await this.sendPlay(0x05, data);
    }
  }

  private async write(bytes: Uint8Array) {
    const writer = this.writer;
    if (!writer) throw Error("没有可用连接");
    const next = this.sendQueue.catch(() => undefined).then(() => writer.write(bytes));
    this.sendQueue = next;
    await next;
  }
  private async shutdown() {
    this.generation++;
    this.stopControlLoop();
    this.controls = { forward: false, back: false, left: false, right: false, jump: false, sprint: false, sneak: false, yaw: 0, pitch: 0 };
    this.jumpQueued = false;
    this.positionReady = false;
    this.tickInFlight = false;
    const socket = this.socket;
    this.socket = null;
    if (socket) await socket.close().catch(() => undefined);
    this.loop = null;
  }
}
