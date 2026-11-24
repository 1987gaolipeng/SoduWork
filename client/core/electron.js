/*
 * Electron passthrough and overlay integration. Throttle high-frequency hit-testing with
 * animation frames, cached geometry, and state deduplication.
 */
const IS_ELECTRON=typeof window.soduWorkAPI!=='undefined';
/*
 * Confirm native shape support with the main process; API presence alone is insufficient
 * on macOS. Until confirmation, the main-process input guard rechecks passthrough requests
 * against cursor position.
 */
let HAS_NATIVE_SHAPE=IS_ELECTRON&&typeof window.soduWorkAPI.setOverlayShape==='function';
let _overlayDisplays=[];
function rememberOverlayDisplays(info){
  if(!Array.isArray(info?.displays))return;
  _overlayDisplays=info.displays.filter(r=>[r.x,r.y,r.width,r.height].every(Number.isFinite)&&r.width>0&&r.height>0);
  window.dispatchEvent(new CustomEvent('overlay-displays-changed'));
}
/* Keep restored/released widgets on a real monitor, not a gap in the virtual
   desktop. During a gesture the pointer may still cross a display boundary. */
function clampOverlayPosition(x,y,width,height){
  let best={x,y},distance=Infinity;
  for(const r of _overlayDisplays){
    const nx=Math.max(r.x,Math.min(x,r.x+Math.max(0,r.width-width)));
    const ny=Math.max(r.y,Math.min(y,r.y+Math.max(0,r.height-height)));
    const d=(nx-x)**2+(ny-y)**2;
    if(d<distance){best={x:nx,y:ny};distance=d;}
  }
  return best;
}
if(HAS_NATIVE_SHAPE&&typeof window.soduWorkAPI.getOverlayShape==='function'){
  window.soduWorkAPI.getOverlayShape().then(info=>{
    rememberOverlayDisplays(info);
    if(info&&typeof info.supported==='boolean')HAS_NATIVE_SHAPE=info.supported;
    // A reload can report geometry before preload learns the current revision.
    // Resend after that query, even when the DOM and its geometry are unchanged.
    if(info&&info.awaitingShape&&typeof window.requestOverlayShapeSync==='function')window.requestOverlayShapeSync(0,true);
  }).catch(()=>{});
}
let overlayDepth=0;
let _interactiveCache=null,_interactiveCacheDirty=true;
let _shapeFrame=null,_shapeTimer=null,_shapeTrackUntil=0,_lastShapeKey=null,_lastShapeRects=[];
let _shapeEnvelopes=new WeakMap();

/* Only the pet and dock remain topmost. Drop overlay topmost state while a panel matched by
   _TOP_DROPPERS is open, then restore it when those panels close. */
/* Independent workspace windows manage their own native stacking; only overlay panels belong in this selector. */
const _TOP_DROPPERS='.task-area.show,.panel.show,.task-list-panel.show';
let _lastTopmost=null,_topSyncTimer=null;
function _syncTopmost(){
  if(!IS_ELECTRON||!window.soduWorkAPI||!soduWorkAPI.setAlwaysOnTop)return;
  const anyOpen=!!document.querySelector(_TOP_DROPPERS);
  const want=!anyOpen;
  if(want!==_lastTopmost){_lastTopmost=want;soduWorkAPI.setAlwaysOnTop(want);}
}
const _markDirty=()=>{
  _interactiveCacheDirty=true;
  _queueOverlayShape(500);
  if(_topSyncTimer)return;
  _topSyncTimer=setTimeout(()=>{_topSyncTimer=null;_syncTopmost();},60);
};
/*
 * Observe direct body child changes and class/style changes on interactive containers
 * only. Coalesce callbacks through animation frames; style observation tracks dragging
 * without observing the entire subtree.
 */
var _mo=new MutationObserver(function(muts){
  _markDirty();
  for(var i=0;i<muts.length;i++){ if(muts[i].type==='childList'){ _observeInteractive(); break; } }
});
var _shapeRO=typeof ResizeObserver==='function'?new ResizeObserver(function(){_queueOverlayShape(200)}):null;
var _observedInteractive=new Set();
function _observeInteractive(){
  var next=new Set();
  var sels=['#pet','.img-viewer','.ring-btn','.panel',
            '.dock-more','.edge-dock','.ctx-menu','.pet-bubble'];
  for(var i=0;i<sels.length;i++){
    var els=document.querySelectorAll(sels[i]);
    for(var j=0;j<els.length;j++){
      next.add(els[j]);
    }
  }
  // Both observers retain their targets. Replaced panels must leave the target
  // set, otherwise opening overlays keeps their detached DOM alive indefinitely.
  if(next.size===_observedInteractive.size&&[...next].every(el=>_observedInteractive.has(el)))return;
  _mo.disconnect();
  _mo.observe(document.body,{childList:true});
  _observedInteractive.forEach(el=>{if(!next.has(el)&&_shapeRO)_shapeRO.unobserve(el)});
  next.forEach(el=>{
    _mo.observe(el,{attributes:true,attributeFilter:['class','style']});
    if(_shapeRO&&!_observedInteractive.has(el))_shapeRO.observe(el);
  });
  _observedInteractive=next;
}
function _initMO(){
  if(!document.body){document.addEventListener('DOMContentLoaded',_initMO);return;}
  _mo.observe(document.body,{childList:true});
  _observeInteractive();
  _queueOverlayShape(700);
}
_initMO();

const interactiveEls=()=>{
  if(!_interactiveCacheDirty&&_interactiveCache)return _interactiveCache;
  const pet=document.getElementById('pet');
  _interactiveCache=[
    pet,
    document.querySelector('.img-viewer.show'),   /* The image overlay needs a full-screen interactive region for close and open actions. */
    /* Register the overflow menu separately because it extends outside the dock. */
    document.querySelector('.dock-more.show'),
    // Closed ring buttons keep non-zero bounds while their parent is transparent.
    // They must not reserve native hit regions over another window's editor.
    ...document.querySelectorAll('.pet.ring-open .ring-btn'),
    document.querySelector('.panel.show'),
    document.querySelector('.ctx-menu.show'),
    /* Non-undoable feedback bubbles are intentionally pointer-transparent. */
    document.querySelector('.pet-bubble.show.undoable'),
    document.querySelector('.edge-dock.show')
    /*
     * Register every interactive surface hosted in this transparent overlay. Separate native
     * windows do not participate in its passthrough hit-testing.
     */
  ].filter(Boolean);
  _interactiveCacheDirty=false;
  return _interactiveCache;
};
/*
 * Expand hit regions slightly to disable passthrough before fast pointer movement reaches
 * a small control; IPC latency can otherwise lose the initial press.
 */
const HIT_PAD=6;









const DRAG_TILE_PAD=140;    /* Padding on each side of the element inside its tile. */
const DRAG_TILE_SLACK=40;   /* Retile when the remaining edge clearance reaches this value (travel per tile: PAD-SLACK = 100px). */
var _dragMode=false,_dragTiles=null;
/* Capture the pressed element before the first move. Document listeners alone
   lose fast moves outside a shaped native region. Keeping the original target
   also preserves ordinary dock/ring button clicks. */
function captureOverlayPointer(event,onLost){
  const target=event.target;
  if(!target||typeof target.setPointerCapture!=='function')return ()=>{};
  try{target.setPointerCapture(event.pointerId);}catch(_){return ()=>{};}
  const report=flag=>{if(IS_ELECTRON&&soduWorkAPI.setOverlayDragging)soduWorkAPI.setOverlayDragging(flag);};
  let active=true;
  const lost=e=>{if(e.pointerId===event.pointerId)onLost();};
  target.addEventListener('lostpointercapture',lost);
  report(true);
  return ()=>{
    if(!active)return;
    active=false;
    target.removeEventListener('lostpointercapture',lost);
    try{target.releasePointerCapture(event.pointerId);}catch(_){}
    report(false);
  };
}
function _dragTile(el,r){
  var t=_dragTiles&&_dragTiles.get(el);
  if(t&&r.x>=t.x+DRAG_TILE_SLACK&&r.y>=t.y+DRAG_TILE_SLACK&&
     r.x+r.width<=t.x+t.width-DRAG_TILE_SLACK&&r.y+r.height<=t.y+t.height-DRAG_TILE_SLACK)return t;
  t={x:r.x-DRAG_TILE_PAD,y:r.y-DRAG_TILE_PAD,
     width:r.width+DRAG_TILE_PAD*2,height:r.height+DRAG_TILE_PAD*2};
  if(_dragTiles)_dragTiles.set(el,t);
  return t;
}
function _shapeRect(el){
  const r=el.getBoundingClientRect();
  if(!r.width&&!r.height)return null;
  const pad=(el.id==='pet'&&el.classList.contains('ring-open'))?90:HIT_PAD;
  const left=Math.floor(r.left-pad),top=Math.floor(r.top-pad);
  const right=Math.ceil(r.right+pad),bottom=Math.ceil(r.bottom+pad);
  if(right<=left||bottom<=top)return null;
  return {x:left,y:top,width:right-left,height:bottom-top};
}
/* CSS scale/spring transitions change rounded bounds nearly every frame. Hold
   a small local envelope during that transition instead of calling native
   SetWindowRgn for each pixel; settle back to exact bounds when motion ends. */
function _shapeEnvelope(el,r,settled){
  const previous=_shapeEnvelopes.get(el);
  if(settled||!previous){_shapeEnvelopes.set(el,r);return r;}
  if(r.x>=previous.x&&r.y>=previous.y&&r.x+r.width<=previous.x+previous.width&&
     r.y+r.height<=previous.y+previous.height)return previous;
  const pad=12;
  const next={x:r.x-pad,y:r.y-pad,width:r.width+pad*2,height:r.height+pad*2};
  _shapeEnvelopes.set(el,next);
  return next;
}
function _syncOverlayShape(settled){
  if(!IS_ELECTRON||!window.soduWorkAPI||!soduWorkAPI.setOverlayShape)return;
  const els=interactiveEls(),rects=[];
  for(let i=0;i<els.length;i++){
    const r=_shapeRect(els[i]);
    if(!r)continue;
    rects.push(_dragMode?_dragTile(els[i],r):_shapeEnvelope(els[i],r,settled));
  }
  // Ordinary feedback bubbles stay visible without becoming mouse targets. They
  // can outlive the pet or dock, so native visibility cannot use hit regions alone.
  const visualRects=rects.slice(),bubble=document.querySelector('.pet-bubble.show');
  if(bubble&&!els.includes(bubble)){
    const r=_shapeRect(bubble);
    if(r)visualRects.push(_shapeEnvelope(bubble,r,settled));
  }
  const shapeKey=items=>items.map(r=>r.x+','+r.y+','+r.width+','+r.height).join('|');
  const key=shapeKey(rects)+';'+shapeKey(visualRects);
  if(key===_lastShapeKey)return;
  _lastShapeKey=key;
  _lastShapeRects=rects;
  soduWorkAPI.setOverlayShape(rects,visualRects);
}
/* Pet and dock drag implementations explicitly share this start and stop notification. */
if(typeof window!=='undefined')window.beginOverlayDrag=function(){
  if(_dragMode)return;
  _dragMode=true;
  _shapeEnvelopes=new WeakMap();
  _dragTiles=typeof Map==='function'?new Map():null;
  _lastShapeKey=null;                      /* Create the drag region immediately before movement begins. */
  _interactiveCacheDirty=true;
  _queueOverlayShape(0);
  /* Keep the main-process input guard from cutting input while the drag crosses work windows or display edges. */
  if(IS_ELECTRON&&window.soduWorkAPI&&soduWorkAPI.setOverlayDragging)soduWorkAPI.setOverlayDragging(true);
};
if(typeof window!=='undefined')window.endOverlayDrag=function(){
  if(!_dragMode)return;
  _dragMode=false;
  _shapeEnvelopes=new WeakMap();
  _dragTiles=null;
  _lastShapeKey=null;                      /* Force a fresh region calculation on release despite cached keys. */
  _interactiveCacheDirty=true;
  _queueOverlayShape(200);
  if(IS_ELECTRON&&window.soduWorkAPI&&soduWorkAPI.setOverlayDragging)soduWorkAPI.setOverlayDragging(false);
};
function _queueOverlayShape(trackMs){
  if(!IS_ELECTRON||!window.soduWorkAPI||!soduWorkAPI.setOverlayShape)return;
  _shapeTrackUntil=Math.max(_shapeTrackUntil,Date.now()+Math.max(0,Number(trackMs)||0));
  if(_shapeFrame!==null||_shapeTimer!==null)return;
  const schedule=()=>{
    let pending=true;
    const tick=()=>{
      if(!pending)return;
      pending=false;
      if(_shapeFrame!==null)cancelAnimationFrame(_shapeFrame);
      if(_shapeTimer!==null)clearTimeout(_shapeTimer);
      _shapeFrame=null;_shapeTimer=null;
      const tracking=Date.now()<_shapeTrackUntil;
      _syncOverlayShape(!tracking);
      if(tracking)schedule();
    };
    _shapeFrame=requestAnimationFrame(tick);
    // A hidden native window may stop animation frames after reload even with
    // background throttling disabled. Geometry must still wake it when needed.
    _shapeTimer=setTimeout(tick,100);
  };
  schedule();
}
/* Expose explicit refresh for dragging and dynamic positioning; observers handle ordinary class, style, and size changes. */
if(typeof window!=='undefined')window.requestOverlayShapeSync=(trackMs,force)=>{
  /*
   * Allow forced reporting to acknowledge blur, even when DOM geometry
   * and its deduplication key are unchanged.
   */
  if(force)_lastShapeKey=null;
  _interactiveCacheDirty=true;
  _queueOverlayShape(trackMs==null?120:trackMs);
};
if(typeof window!=='undefined')window.addEventListener('resize',()=>{
  _interactiveCacheDirty=true;
  _queueOverlayShape(700);
  if(IS_ELECTRON&&soduWorkAPI.getOverlayShape)soduWorkAPI.getOverlayShape().then(rememberOverlayDisplays).catch(()=>{});
});
function isPointInteractive(x,y){
  const els=interactiveEls();
  for(let i=0;i<els.length;i++){
    const el=els[i],r=el.getBoundingClientRect();
    if(!r.width&&!r.height)continue;              /* Ignore hidden zero-size boxes to avoid marking the viewport origin interactive. */
    /*
     * Expand the open pet ring's hit region by 90px to cover gaps between the pet and its
     * actions.
     */
    const pad=(el.id==='pet'&&el.classList.contains('ring-open'))?90:HIT_PAD;
    if(x>=r.left-pad&&x<=r.right+pad&&y>=r.top-pad&&y<=r.bottom+pad)return true;
  }
  return false;
}
let _currentPassthrough=null,_pendingFrame=null;
function updatePassthrough(x,y){
  /*
   * Native shape mode passes clicks outside the region through the OS. Keep mouse events
   * enabled inside it so visible pet controls remain clickable.
   */
  if(HAS_NATIVE_SHAPE){
    if(_currentPassthrough!==false){_currentPassthrough=false;window.soduWorkAPI.setIgnoreMouseEvents(false)}
    return;
  }
  if(overlayDepth>0){
    if(_currentPassthrough!==false){_currentPassthrough=false;window.soduWorkAPI.setIgnoreMouseEvents(false)}
  }else{
    const interactive=isPointInteractive(x,y);
    const wantPassthrough=!interactive;
    if(_currentPassthrough!==wantPassthrough){_currentPassthrough=wantPassthrough;window.soduWorkAPI.setIgnoreMouseEvents(wantPassthrough,{forward:true})}
  }
}
/* Retain the last pointer position to reevaluate hit-testing when overlays close. */
let _lastX=-1,_lastY=-1;
if(IS_ELECTRON){
  document.addEventListener('mousemove',e=>{
    const x=e.clientX,y=e.clientY;
    _lastX=x;_lastY=y;
    /*
     * Enable interaction immediately to avoid losing a click behind the window. Defer only the
     * transition back to passthrough.
     */
    if(!_currentPassthrough||isPointInteractive(x,y)){updatePassthrough(x,y);return;}
    if(_pendingFrame)return;
    _pendingFrame=requestAnimationFrame(()=>{_pendingFrame=null;updatePassthrough(x,y)});
  });
  window._expandOverlay=()=>{overlayDepth++;if(overlayDepth===1&&_currentPassthrough!==false){_currentPassthrough=false;window.soduWorkAPI.setIgnoreMouseEvents(false)}};




  window._shrinkOverlay=()=>{
    overlayDepth=Math.max(0,overlayDepth-1);
    if(overlayDepth!==0)return;
    if(HAS_NATIVE_SHAPE){
      if(_currentPassthrough!==false){_currentPassthrough=false;window.soduWorkAPI.setIgnoreMouseEvents(false)}
      return;
    }
    if(_lastX<0){                       /* Use the fallback behavior before any pointer position is known. */
      if(_currentPassthrough!==true){_currentPassthrough=true;window.soduWorkAPI.setIgnoreMouseEvents(true,{forward:true})}
      return;
    }
    _currentPassthrough=null;           /* Clear cached geometry and reevaluate the current pointer position. */
    updatePassthrough(_lastX,_lastY);
  };
}
/*
 * Expose read-only hit-testing, overlay-depth, and cache diagnostics to distinguish
 * passthrough failures.
 */
if(typeof window!=='undefined')window.__ptState=()=>({
  nativeShape:HAS_NATIVE_SHAPE,overlayDepth,currentPassthrough:_currentPassthrough,lastX:_lastX,lastY:_lastY,
  interactive:_lastX>=0?isPointInteractive(_lastX,_lastY):null,
  els:interactiveEls().map(e=>e.id||String(e.className).split(' ')[0]),
  shapeRects:_lastShapeRects
});
function expandForOverlay(){if(IS_ELECTRON&&window._expandOverlay)window._expandOverlay()}
function shrinkFromOverlay(){if(IS_ELECTRON&&window._shrinkOverlay)window._shrinkOverlay()}
