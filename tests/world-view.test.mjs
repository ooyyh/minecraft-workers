import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Script, runInNewContext } from 'node:vm';
import * as THREE from 'three';

const source = readFileSync(new URL('../src/world-view.ts', import.meta.url), 'utf8');
const browserScript = runInNewContext(source.replace('export const worldViewScript =', 'const worldViewScript =') + '\nworldViewScript;');

function harness({ pointerLockError = false } = {}) {
  const handlers = new Map(), intervals = new Map(), timeouts = new Map();
  const requests = [], renders = [];
  let nextTimer = 0;
  const on = target => (type, listener) => {
    const key = target + ':' + type;
    handlers.set(key, [...(handlers.get(key) || []), listener]);
  };
  const elements = Object.fromEntries(['radar', 'canvasWrap', 'viewStatus', 'fullscreenButton', 'app'].map(id => [id, {
    id, hidden: false, textContent: '', classList: { toggle() {} },
    addEventListener: on(id), setAttribute() {},
    getBoundingClientRect: () => ({ width: 800, height: 450 }),
  }]));
  const document = {
    hidden: false, pointerLockElement: null, activeElement: null,
    getElementById: id => elements[id], addEventListener: on('document'),
  };
  elements.radar.parentElement = elements.canvasWrap;
  elements.radar.focus = () => { document.activeElement = elements.radar; };
  elements.radar.requestPointerLock = async () => {
    if (pointerLockError) throw new Error('Pointer lock denied');
    document.pointerLockElement = elements.radar;
  };
  let world = { position: { x: 240, y: 72, z: 250, yaw: 0, pitch: 0 }, voxels: [240, 71, 251, 2], phase: 'play' };
  const window = { devicePixelRatio: 1, addEventListener: on('window') };
  class Renderer {
    constructor({ canvas }) { this.domElement = canvas; }
    setPixelRatio() {}
    setSize() {}
    render(scene, camera) { renders.push({ scene, camera }); }
  }
  class Input {}
  const context = {
    THREE: { ...THREE, WebGLRenderer: Renderer }, document, window,
    HTMLInputElement: Input, HTMLTextAreaElement: Input, HTMLSelectElement: Input, HTMLButtonElement: Input,
    ResizeObserver: class { observe() {} },
    setTimeout: fn => { const id = ++nextTimer; timeouts.set(id, fn); return id; },
    setInterval: fn => { const id = ++nextTimer; intervals.set(id, fn); return id; },
    clearTimeout: id => timeouts.delete(id), clearInterval: id => intervals.delete(id),
    requestAnimationFrame: fn => { const id = ++nextTimer; timeouts.set(id, fn); return id; },
    fetch: async (url, options) => {
      if (url === '/api/world') return { ok: true, json: async () => structuredClone(world) };
      assert.equal(url, '/api/bot/control');
      const input = JSON.parse(options.body);
      requests.push(input);
      world.position = { ...world.position, yaw: input.yaw, pitch: input.pitch };
      return { ok: true, json: async () => ({ position: { ...world.position } }) };
    },
  };
  new Script(browserScript.replace(/^import[^\n]+\n/, '')).runInNewContext(context);
  async function settle() { for (let i = 0; i < 15; i++) await Promise.resolve(); }
  async function flush() {
    const pending = [...timeouts.values()];
    timeouts.clear();
    for (const fn of pending) fn();
    await settle();
  }
  async function emit(target, type, event = {}) {
    for (const fn of handlers.get(target + ':' + type) || []) await fn({ preventDefault() {}, ...event });
    await settle();
  }
  return {
    document, elements, requests, renders, Input, intervals, emit, settle, flush,
    worldView: window.mcWorldView,
    setWorld: value => { world = value; },
    heartbeat: async () => { for (const fn of [...intervals.values()]) fn(); await settle(); },
  };
}

test('Three.js camera matches Minecraft yaw, pitch and strafe axes', async () => {
  for (const yaw of [0, 90, -90, -180]) {
    const h = harness();
    await h.settle();
    h.setWorld({ position: { x: 240, y: 72, z: 250, yaw, pitch: 30 }, voxels: [240, 71, 251, 2] });
    // Initialise a new view after a disconnect.
    h.setWorld({ position: null, voxels: [] }); await h.worldView.load();
    h.setWorld({ position: { x: 240, y: 72, z: 250, yaw, pitch: 30 }, voxels: [240, 71, 251, 2] });
    await h.worldView.load(); await h.flush();
    const { camera } = h.renders.at(-1);
    camera.updateMatrixWorld();
    const forward = camera.getWorldDirection(new THREE.Vector3());
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(camera.quaternion);
    const y = yaw * Math.PI / 180, p = Math.PI / 6;
    assert.ok(Math.abs(forward.x + Math.sin(y) * Math.cos(p)) < 1e-8);
    assert.ok(Math.abs(forward.z - Math.cos(y) * Math.cos(p)) < 1e-8);
    assert.ok(Math.abs(forward.y + Math.sin(p)) < 1e-8);
    assert.ok(Math.abs(right.x + Math.cos(y)) < 1e-8);
    assert.ok(Math.abs(right.z + Math.sin(y)) < 1e-8);
    assert.equal(camera.position.y, 73.62);
  }
});

test('mouse angles stay stable when the server echoes controls and wrap through a full turn', async () => {
  const h = harness(); await h.settle();
  await h.emit('radar', 'click'); await h.emit('document', 'pointerlockchange');
  await h.emit('document', 'mousemove', { movementX: 100, movementY: 50 });
  await h.flush(); await h.heartbeat(); await h.heartbeat();
  assert.equal(h.requests.at(-1).yaw, 16);
  assert.equal(h.requests.at(-1).pitch, 8);
  await h.worldView.load(); await h.heartbeat();
  assert.equal(h.requests.at(-1).yaw, 16);
  await h.emit('document', 'mousemove', { movementX: 2250, movementY: 0 });
  await h.flush();
  assert.equal(h.requests.at(-1).yaw, 16);
});

test('keyboard movement continues without pointer lock and keyup releases after focus changes', async () => {
  const h = harness({ pointerLockError: true }); await h.settle();
  await h.emit('radar', 'click');
  assert.match(h.elements.viewStatus.textContent, /Pointer lock denied/);
  await h.emit('document', 'keydown', { code: 'KeyW' }); await h.flush();
  assert.equal(h.requests.at(-1).forward, true);
  assert.equal(h.intervals.size, 2); // world refresh and input heartbeat
  h.document.activeElement = new h.Input();
  await h.emit('document', 'keyup', { code: 'KeyW' }); await h.flush();
  assert.equal(h.requests.at(-1).forward, false);
  assert.equal(h.intervals.size, 1);
});

test('world refresh frees replaced instance buffers and materials while reusing cube geometry', async () => {
  const h = harness(); await h.settle(); await h.flush();
  const { scene } = h.renders.at(-1);
  const group = scene.children.find(child => child.isGroup);
  const previous = group.children[0];
  let meshDisposed = false, materialDisposed = false;
  previous.addEventListener('dispose', () => { meshDisposed = true; });
  previous.material.addEventListener('dispose', () => { materialDisposed = true; });
  await h.worldView.load();
  assert.equal(meshDisposed, true);
  assert.equal(materialDisposed, true);
  assert.equal(group.children.length, 1);
  assert.equal(group.children[0].geometry, previous.geometry);
  assert.equal(group.children[0].count, 1);
});
