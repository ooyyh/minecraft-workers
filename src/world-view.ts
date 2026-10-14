export const worldViewScript = String.raw`(() => {
  const canvas = document.getElementById('radar');
  const frame = document.getElementById('canvasWrap');
  const ctx = canvas && canvas.getContext('2d');
  if (!canvas || !frame || !ctx) return;
  canvas.tabIndex = 0;
  const label = document.getElementById('viewStatus');
  const fullScreenButton = document.getElementById('fullscreenButton');
  const colors = {1:'#8d9297',2:'#69a74f',3:'#80634b',4:'#71767d',5:'#ac8150',7:'#46474d',8:'#4d91bc',9:'#4d91bc',12:'#d6c08a',13:'#7a7770',17:'#886446',18:'#4e844b',24:'#d5bc82',35:'#c0b6ad',41:'#e5c558',42:'#c9cfd0',48:'#6b816b',49:'#3b3247',56:'#76bace',73:'#88504d',79:'#a8d5d9',80:'#e4eff0',98:'#81817d',155:'#e8e2d5'};
  const keys = {forward:false,back:false,left:false,right:false,jump:false,sprint:false,sneak:false};
  const keyMap = {KeyW:'forward',ArrowUp:'forward',KeyS:'back',ArrowDown:'back',KeyA:'left',ArrowLeft:'left',KeyD:'right',ArrowRight:'right',Space:'jump',ShiftLeft:'sneak',ShiftRight:'sneak',ControlLeft:'sprint',ControlRight:'sprint'};
  let world = null, cubes = [], yawOffset = 0, pitchOffset = 0, fov = 1, loading = false, lastWorldAt = 0, controlTimer = null, heartbeat = null, controlInFlight = false, controlPending = false;
  function shade(hex, factor) { const n=parseInt(hex.slice(1),16); return 'rgb('+Math.round((n>>16&255)*factor)+','+Math.round((n>>8&255)*factor)+','+Math.round((n&255)*factor)+')'; }
  function poly(points, color) { ctx.beginPath(); ctx.moveTo(points[0][0],points[0][1]); for(let i=1;i<points.length;i++) ctx.lineTo(points[i][0],points[i][1]); ctx.closePath(); ctx.fillStyle=color; ctx.fill(); ctx.strokeStyle='#08151b55'; ctx.lineWidth=.45; ctx.stroke(); }
  function rebuild() {
    const next=[];
    if (world && Array.isArray(world.voxels)) for (let i=0;i+3<world.voxels.length;i+=4) next.push({x:world.voxels[i],y:world.voxels[i+1],z:world.voxels[i+2],id:world.voxels[i+3]});
    if (!next.length && world && Array.isArray(world.chunks)) for (const ch of world.chunks) { const step=ch.step||1, size=16/step; for(let z=0;z<size;z++) for(let x=0;x<size;x++){const i=z*size+x;if(ch.heights[i]>=0) next.push({x:ch.x*16+x*step,y:ch.heights[i],z:ch.z*16+z*step,id:ch.blocks[i],step});} }
    cubes=next;
  }
  async function load() {
    if (loading || document.getElementById('app').hidden) return;
    loading=true;
    try { const r=await fetch('/api/world',{credentials:'same-origin'}); if(!r.ok) throw Error('场景请求失败 '+r.status); world=await r.json(); rebuild(); lastWorldAt=Date.now(); label.textContent=cubes.length?'真实体素 · '+cubes.length+' 个可见方块 · 点击锁定鼠标':'等待区块画面'; draw(); }
    catch(e) { label.textContent=e.message; } finally { loading=false; }
  }
  function camera() { const p=world&&world.position; return {x:p?.x??0,y:(p?.y??80)+1.62,z:p?.z??0,yaw:(p?.yaw??0)+yawOffset,pitch:Math.max(-89,Math.min(89,(p?.pitch??0)+pitchOffset))}; }
  function draw() {
    if(document.getElementById('app').hidden) return;
    const r=canvas.getBoundingClientRect(), w=Math.max(1,Math.round(r.width)), h=Math.max(1,Math.round(r.height)), d=Math.min(devicePixelRatio||1,2);
    if(canvas.width!==Math.round(w*d)||canvas.height!==Math.round(h*d)){canvas.width=Math.round(w*d);canvas.height=Math.round(h*d);} ctx.setTransform(d,0,0,d,0,0);
    const sky=ctx.createLinearGradient(0,0,0,h); sky.addColorStop(0,'#42647c'); sky.addColorStop(.6,'#a4bcbc'); sky.addColorStop(1,'#192d2b'); ctx.fillStyle=sky; ctx.fillRect(0,0,w,h);
    if(!cubes.length){ctx.fillStyle='#f0f8f4';ctx.font='14px system-ui';ctx.textAlign='center';ctx.fillText('等待区块画面…',w/2,h/2);ctx.textAlign='start';return;}
    const cam=camera(), y=cam.yaw*Math.PI/180, p=cam.pitch*Math.PI/180, fx=-Math.sin(y), fz=Math.cos(y), rx=-Math.cos(y), rz=-Math.sin(y), focal=Math.max(220,Math.min(w,h)*.92)*fov, horizon=h/2-Math.tan(p)*focal;
    const project=(x,y,z)=>{const dx=x-cam.x,dz=z-cam.z,depth=dx*fx+dz*fz,side=dx*rx+dz*rz;if(depth<=.2)return null;return [w/2+side/depth*focal,horizon-(y-cam.y)/depth*focal,depth];};
    const visible=cubes.map(c=>({...c,dist:(c.x+.5-cam.x)*fx+(c.z+.5-cam.z)*fz})).filter(c=>c.dist>.2&&c.dist<52).sort((a,b)=>b.dist-a.dist).slice(0,9000);
    for(const c of visible){
      const s=c.step||1,x=c.x,z=c.z,y0=c.y,y1=y0+1, a=project(x,y0,z),b=project(x+s,y0,z),e=project(x,y0,z+s),q=project(x+s,y0,z+s),u=project(x,y1,z),v=project(x+s,y1,z),t=project(x,y1,z+s),k=project(x+s,y1,z+s); if(!a||!b||!e||!q||!u||!v||!t||!k)continue;
      const color=colors[c.id]||'#8d947e';
      poly([a,e,q,b],shade(color,.42)); poly([a,u,t,e],shade(color,.52)); poly([b,q,k,v],shade(color,.76)); poly([a,b,v,u],shade(color,.66)); poly([e,t,k,q],shade(color,.58)); poly([u,v,k,t],color);
    }
    ctx.strokeStyle='#ffffffcc';ctx.lineWidth=1;ctx.beginPath();ctx.moveTo(w/2-7,h/2);ctx.lineTo(w/2+7,h/2);ctx.moveTo(w/2,h/2-7);ctx.lineTo(w/2,h/2+7);ctx.stroke();
  }
  function payload(){const p=world&&world.position;return {...keys,yaw:(p?.yaw||0)+yawOffset,pitch:Math.max(-90,Math.min(90,(p?.pitch||0)+pitchOffset))};}
  async function sendControl(){if(document.getElementById('app').hidden)return;if(controlInFlight){controlPending=true;return;}controlInFlight=true;try{const r=await fetch('/api/bot/control',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload())});const d=await r.json().catch(()=>({}));if(!r.ok){label.textContent=d.error||'控制请求失败 '+r.status;}else if(d.position){world=world||{};world.position=d.position;draw();}}catch(e){label.textContent='控制请求失败：'+e.message;}finally{controlInFlight=false;if(controlPending){controlPending=false;void sendControl();}}}
  function queue(){if(controlTimer)return;controlTimer=setTimeout(()=>{controlTimer=null;void sendControl();},35);}
  function clearKeys(){let changed=false;for(const k of Object.keys(keys))if(keys[k]){keys[k]=false;changed=true;}if(changed)queue();}
  fullScreenButton?.addEventListener('click',async()=>{try{if(!document.fullscreenElement)await frame.requestFullscreen();else await document.exitFullscreen();}catch(e){label.textContent='全屏不可用：'+e.message;}});
  document.addEventListener('fullscreenchange',()=>{frame.classList.toggle('fullscreen',!!document.fullscreenElement);if(fullScreenButton)fullScreenButton.textContent=document.fullscreenElement?'退出全屏':'全屏';requestAnimationFrame(draw);});
  canvas.addEventListener('click',()=>{canvas.focus();canvas.requestPointerLock?.();});
  document.addEventListener('pointerlockchange',()=>{const locked=document.pointerLockElement===canvas;label.textContent=locked?'鼠标已锁定 · WASD 移动 · 空格跳跃 · Esc 释放':'点击画面锁定鼠标';if(locked){if(!heartbeat)heartbeat=setInterval(()=>void sendControl(),50);}else{if(heartbeat){clearInterval(heartbeat);heartbeat=null;}clearKeys();}});
  // Minecraft turns to the right when the mouse moves right. The previous
  // subtraction inverted the horizontal look direction and made A/D feel
  // reversed relative to the rendered view.
  document.addEventListener('mousemove',e=>{if(document.pointerLockElement!==canvas)return;yawOffset+=e.movementX*.16;pitchOffset=Math.max(-75,Math.min(75,pitchOffset+e.movementY*.16));draw();queue();});
  function controlsFocused(){
    if(document.pointerLockElement===canvas||document.activeElement===canvas)return true;
    if(document.getElementById('app').hidden)return false;
    const active=document.activeElement;
    return !(active instanceof HTMLInputElement||active instanceof HTMLTextAreaElement||active instanceof HTMLSelectElement||active instanceof HTMLButtonElement);
  }
  // Pointer Lock is preferred for the Minecraft-like mouse, but keyboard
  // movement must still work when a browser refuses the lock or the page is
  // embedded. Clicking the canvas focuses it before requesting the lock.
  document.addEventListener('keydown',e=>{if(!controlsFocused())return;const k=keyMap[e.code];if(!k)return;e.preventDefault();if(!keys[k]){keys[k]=true;queue();}});
  document.addEventListener('keyup',e=>{if(!controlsFocused())return;const k=keyMap[e.code];if(!k)return;e.preventDefault();if(keys[k]){keys[k]=false;queue();}});
  canvas.addEventListener('wheel',e=>{e.preventDefault();fov=Math.max(.55,Math.min(1.8,fov*(e.deltaY>0?.9:1.1)));draw();},{passive:false});
  window.addEventListener('blur',clearKeys);window.addEventListener('resize',draw);window.mcWorldView={load,draw};setInterval(()=>{if(!document.getElementById('app').hidden&&Date.now()-lastWorldAt>4500)load();},5000);if(!document.getElementById('app').hidden)load();
})();`;
