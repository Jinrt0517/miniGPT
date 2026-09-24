const box = document.getElementById('selection');
let start, done = false;
window.capture.onImage(data => document.getElementById('screen').src = data);
function finish(rect) { if (!done) { done = true; window.capture.finish(rect); } }
window.addEventListener('keydown', e => { if (e.key === 'Escape') finish(null); });
window.addEventListener('contextmenu', e => { e.preventDefault(); finish(null); });
window.addEventListener('pointerdown', e => { if (e.button !== 0) return; start = { x: e.clientX, y: e.clientY }; document.getElementById('shade').hidden = true; box.style.display = 'block'; });
window.addEventListener('pointermove', e => { if (!start) return; Object.assign(box.style, { left: Math.min(start.x,e.clientX)+'px',top:Math.min(start.y,e.clientY)+'px',width:Math.abs(e.clientX-start.x)+'px',height:Math.abs(e.clientY-start.y)+'px' }); });
window.addEventListener('pointerup', e => { if (!start) return; const width = Math.abs(e.clientX-start.x),height = Math.abs(e.clientY-start.y); if (width < 5 || height < 5) { start=null;box.style.display='none';return; } finish({ x:Math.min(start.x,e.clientX)/innerWidth,y:Math.min(start.y,e.clientY)/innerHeight,width:width/innerWidth,height:height/innerHeight }); });
