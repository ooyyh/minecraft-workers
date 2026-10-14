export const worldViewScript = String.raw`import * as THREE from 'https://cdn.jsdelivr.net/npm/three@0.180.0/build/three.module.min.js';

(() => {
  const canvas = document.getElementById('radar');
  const viewport = canvas?.parentElement;
  const frame = document.getElementById('canvasWrap');
  const label = document.getElementById('viewStatus');
  const fullScreenButton = document.getElementById('fullscreenButton');
  const app = document.getElementById('app');
  if (!canvas || !viewport || !frame || !label || !app) return;
  canvas.tabIndex = 0;

  const colors = {
    1: 0x8d9297, 2: 0x69a74f, 3: 0x80634b, 4: 0x71767d,
    5: 0xac8150, 7: 0x46474d, 8: 0x4d91bc, 9: 0x4d91bc,
    12: 0xd6c08a, 13: 0x7a7770, 17: 0x886446, 18: 0x4e844b,
    24: 0xd5bc82, 35: 0xc0b6ad, 41: 0xe5c558, 42: 0xc9cfd0,
    48: 0x6b816b, 49: 0x3b3247, 56: 0x76bace, 73: 0x88504d,
    79: 0xa8d5d9, 80: 0xe4eff0, 98: 0x81817d, 155: 0xe8e2d5
  };
  const transparent = new Set([8, 9, 18, 79]);
  const keys = { forward: false, back: false, left: false, right: false, jump: false, sprint: false, sneak: false };
  const keyMap = {
    KeyW: 'forward', ArrowUp: 'forward', KeyS: 'back', ArrowDown: 'back',
    KeyA: 'left', ArrowLeft: 'left', KeyD: 'right', ArrowRight: 'right',
    Space: 'jump', ShiftLeft: 'sneak', ShiftRight: 'sneak',
    ControlLeft: 'sprint', ControlRight: 'sprint'
  };

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x8eb4c5);
  scene.fog = new THREE.Fog(0x8eb4c5, 30, 66);
  const camera = new THREE.PerspectiveCamera(70, 1, 0.05, 80);
  camera.rotation.order = 'YXZ';
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, alpha: false, powerPreference: 'low-power', stencil: false });
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
  renderer.domElement.setAttribute('aria-label', 'Minecraft Three.js 第一人称世界画面');
  renderer.domElement.tabIndex = 0;

  scene.add(new THREE.HemisphereLight(0xd9f1ff, 0x536246, 2.25));
  const sun = new THREE.DirectionalLight(0xfff2d5, 2.1);
  sun.position.set(-0.45, 1, -0.35);
  scene.add(sun);

  const cubeGeometry = new THREE.BoxGeometry(1, 1, 1);
  const worldGroup = new THREE.Group();
  scene.add(worldGroup);
  const matrix = new THREE.Matrix4();
  let world = null;
  let meshes = [];
  let viewYaw = 0;
  let viewPitch = 0;
  let viewReady = false;
  let fov = 70;
  let loading = false;
  let lastWorldAt = 0;
  let controlTimer = null;
  let heartbeat = null;
  let controlInFlight = false;
  let controlPending = false;
  let animationFrame = 0;
  let renderWidth = 0;
  let renderHeight = 0;

  function normalizeYaw(value) {
    return ((value % 360) + 540) % 360 - 180;
  }

  function syncView(position) {
    if (!position) {
      viewReady = false;
      return;
    }
    if (viewReady) return;
    viewYaw = normalizeYaw(Number(position.yaw) || 0);
    viewPitch = Math.max(-90, Math.min(90, Number(position.pitch) || 0));
    viewReady = true;
  }

  function disposeWorld() {
    for (const mesh of meshes) {
      worldGroup.remove(mesh);
      mesh.dispose();
      mesh.material.dispose();
    }
    meshes = [];
  }

  function voxelsFromWorld(data) {
    const result = [];
    if (Array.isArray(data?.voxels)) {
      for (let index = 0; index + 3 < data.voxels.length; index += 4) {
        result.push({ x: data.voxels[index], y: data.voxels[index + 1], z: data.voxels[index + 2], id: data.voxels[index + 3], size: 1 });
      }
    }
    if (!result.length && Array.isArray(data?.chunks)) {
      for (const chunk of data.chunks) {
        const step = chunk.step || 1;
        const size = 16 / step;
        for (let z = 0; z < size; z++) for (let x = 0; x < size; x++) {
          const index = z * size + x;
          if (chunk.heights[index] >= 0) result.push({
            x: chunk.x * 16 + x * step,
            y: chunk.heights[index],
            z: chunk.z * 16 + z * step,
            id: chunk.blocks[index],
            size: step
          });
        }
      }
    }
    return result;
  }

  function rebuild() {
    disposeWorld();
    const groups = new Map();
    for (const voxel of voxelsFromWorld(world)) {
      const group = groups.get(voxel.id) || [];
      group.push(voxel);
      groups.set(voxel.id, group);
    }
    for (const [id, blocks] of groups) {
      const seeThrough = transparent.has(Number(id));
      const material = new THREE.MeshLambertMaterial({
        color: colors[id] || 0x8d947e,
        transparent: seeThrough,
        opacity: seeThrough ? 0.72 : 1,
        depthWrite: !seeThrough
      });
      const mesh = new THREE.InstancedMesh(cubeGeometry, material, blocks.length);
      mesh.renderOrder = seeThrough ? 1 : 0;
      for (let index = 0; index < blocks.length; index++) {
        const block = blocks[index];
        const size = block.size || 1;
        matrix.makeScale(size, 1, size);
        matrix.setPosition(block.x + size / 2, block.y + 0.5, block.z + size / 2);
        mesh.setMatrixAt(index, matrix);
      }
      mesh.instanceMatrix.needsUpdate = true;
      mesh.computeBoundingSphere();
      worldGroup.add(mesh);
      meshes.push(mesh);
    }
    return [...groups.values()].reduce((total, group) => total + group.length, 0);
  }

  function updateCamera() {
    const position = world?.position;
    syncView(position);
    const yaw = (viewReady ? viewYaw : 0) * Math.PI / 180;
    const pitch = Math.max(-89, Math.min(89, viewReady ? viewPitch : 0)) * Math.PI / 180;
    camera.position.set(position?.x || 0, (position?.y ?? 80) + 1.62, position?.z || 0);
    camera.rotation.y = Math.PI - yaw;
    camera.rotation.x = -pitch;
    camera.fov = fov;
    camera.updateProjectionMatrix();
  }

  function resize() {
    const rect = canvas.getBoundingClientRect();
    const width = Math.max(1, Math.round(rect.width));
    const height = Math.max(1, Math.round(rect.height));
    if (width === renderWidth && height === renderHeight) return;
    renderWidth = width;
    renderHeight = height;
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
  }

  function draw() {
    if (app.hidden) return;
    resize();
    updateCamera();
    renderer.render(scene, camera);
  }

  function scheduleDraw() {
    if (animationFrame) return;
    animationFrame = requestAnimationFrame(() => {
      animationFrame = 0;
      draw();
    });
  }

  async function load() {
    if (loading || app.hidden) return;
    loading = true;
    try {
      const response = await fetch('/api/world', { credentials: 'same-origin' });
      if (!response.ok) throw Error('场景请求失败 ' + response.status);
      world = await response.json();
      if (world.phase !== 'play') viewReady = false;
      syncView(world?.position);
      const count = rebuild();
      lastWorldAt = Date.now();
      label.textContent = count ? 'Three.js 体素视图 · ' + count + ' 个方块 · 点击进入' : '等待服务器发送区块';
      scheduleDraw();
    } catch (error) {
      label.textContent = error instanceof Error ? error.message : String(error);
    } finally {
      loading = false;
    }
  }

  function payload() {
    syncView(world?.position);
    return {
      ...keys,
      yaw: viewReady ? viewYaw : 0,
      pitch: viewReady ? viewPitch : 0
    };
  }

  async function sendControl() {
    if (app.hidden) return;
    if (controlInFlight) { controlPending = true; return; }
    controlInFlight = true;
    try {
      const response = await fetch('/api/bot/control', {
        method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload())
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        label.textContent = data.error || '控制请求失败 ' + response.status;
      } else if (data.position) {
        world = world || {};
        world.position = data.position;
        scheduleDraw();
      }
    } catch (error) {
      label.textContent = '控制请求失败：' + (error instanceof Error ? error.message : String(error));
    } finally {
      controlInFlight = false;
      if (controlPending) { controlPending = false; void sendControl(); }
    }
  }

  function queueControl() {
    if (controlTimer) return;
    controlTimer = setTimeout(() => { controlTimer = null; void sendControl(); }, 35);
  }

  function syncHeartbeat() {
    const active = !app.hidden && !document.hidden && (document.pointerLockElement === renderer.domElement || Object.values(keys).some(Boolean));
    if (active && !heartbeat) heartbeat = setInterval(() => void sendControl(), 50);
    if (!active && heartbeat) { clearInterval(heartbeat); heartbeat = null; }
  }

  function clearKeys() {
    let changed = false;
    for (const key of Object.keys(keys)) if (keys[key]) { keys[key] = false; changed = true; }
    if (changed) queueControl();
    syncHeartbeat();
  }

  function controlsFocused() {
    if (document.pointerLockElement === renderer.domElement || document.activeElement === canvas) return true;
    if (app.hidden) return false;
    const active = document.activeElement;
    return !(active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement || active instanceof HTMLSelectElement || active instanceof HTMLButtonElement);
  }

  fullScreenButton?.addEventListener('click', async () => {
    try {
      if (!document.fullscreenElement) await frame.requestFullscreen();
      else await document.exitFullscreen();
    } catch (error) {
      label.textContent = '全屏不可用：' + (error instanceof Error ? error.message : String(error));
    }
  });
  document.addEventListener('fullscreenchange', () => {
    frame.classList.toggle('fullscreen', document.fullscreenElement === frame);
    if (fullScreenButton) fullScreenButton.textContent = document.fullscreenElement === frame ? '退出全屏' : '全屏';
    scheduleDraw();
  });
  canvas.addEventListener('click', async () => {
    canvas.focus({ preventScroll: true });
    try {
      if (!canvas.requestPointerLock) throw Error('浏览器不支持鼠标锁定');
      await canvas.requestPointerLock();
    } catch (error) {
      label.textContent = '鼠标锁定不可用，可继续用 WASD 移动：' + (error instanceof Error ? error.message : String(error));
    }
  });
  document.addEventListener('pointerlockerror', () => {
    label.textContent = '鼠标锁定未获准，请在独立浏览器窗口打开控制台';
  });
  document.addEventListener('pointerlockchange', () => {
    const locked = document.pointerLockElement === renderer.domElement;
    label.textContent = locked ? '已进入游戏 · WASD 移动 · 空格跳跃 · Esc 释放' : '点击画面进入游戏';
    if (!locked) clearKeys();
    syncHeartbeat();
  });
  document.addEventListener('mousemove', event => {
    if (document.pointerLockElement !== renderer.domElement) return;
    syncView(world?.position);
    if (!viewReady) return;
    viewYaw = normalizeYaw(viewYaw + event.movementX * 0.16);
    viewPitch = Math.max(-89, Math.min(89, viewPitch + event.movementY * 0.16));
    scheduleDraw();
    queueControl();
  });
  document.addEventListener('keydown', event => {
    if (!controlsFocused()) return;
    const key = keyMap[event.code];
    if (!key) return;
    event.preventDefault();
    if (!keys[key]) { keys[key] = true; syncHeartbeat(); queueControl(); }
  });
  document.addEventListener('keyup', event => {
    const key = keyMap[event.code];
    if (!key || !keys[key]) return;
    event.preventDefault();
    if (keys[key]) { keys[key] = false; queueControl(); syncHeartbeat(); }
  });
  viewport.addEventListener('wheel', event => {
    event.preventDefault();
    fov = Math.max(35, Math.min(105, fov + (event.deltaY > 0 ? 4 : -4)));
    scheduleDraw();
  }, { passive: false });
  window.addEventListener('blur', clearKeys);
  document.addEventListener('visibilitychange', () => { if (document.hidden) clearKeys(); else syncHeartbeat(); });
  window.addEventListener('resize', scheduleDraw);
  const resizeObserver = new ResizeObserver(scheduleDraw);
  resizeObserver.observe(viewport);

  window.mcWorldView = { load, draw: scheduleDraw };
  setInterval(() => {
    if (!app.hidden && Date.now() - lastWorldAt > 4500) void load();
  }, 5000);
  if (!app.hidden) void load();
})();`;
