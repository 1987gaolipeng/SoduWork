/* SoduWork desktop companion skin.
   The action artwork is local and state-driven. The SVG character remains the
   safe fallback when an asset is missing or the desktop pet is not active. */
(function (global) {
  "use strict";

  const STATES = Object.freeze({
    resting:  { label: "休息", className: "resting" },
    ready:    { label: "打起精神", className: "ready" },
    working:  { label: "兴奋工作中", className: "working" },
    complete: { label: "完成", className: "complete" }
  });
  const FRAME_ROOT = "assets/pet-skins/soduwork-actions";
  const FRAME_DURATION = 250;
  const FRAME_COUNTS = Object.freeze({
    resting: 1,
    ready: 4,
    working: 7,
    complete: 1
  });
  const VALID = new Set(Object.keys(STATES));

  let requestedState = "resting";
  let appliedState = "";
  let frameIndex = 0;
  let frameTimer = null;
  let completionTimer = null;
  let completionHandled = false;
  let spriteElement = null;
  let spritePath = "";
  let spriteReady = false;
  let spriteFailed = false;
  let pendingImage = null;
  let frameEpoch = 0;
  let visibilityBound = false;
  const failedFrames = new Set();

  function visible() {
    const pet = petElement();
    return isActive() && cfg.petVisible !== false && !document.hidden && pet && pet.isConnected !== false;
  }

  function cancelPendingFrame() {
    frameEpoch++;
    if (pendingImage) pendingImage.onload = pendingImage.onerror = null;
    pendingImage = null;
  }

  function petElement() {
    return typeof document !== "undefined" ? document.getElementById("pet") : null;
  }

  function isActive() {
    return typeof cfg !== "undefined" && cfg && cfg._lastSkinId === "soduwork-signature";
  }

  function normalizedState(value) {
    return VALID.has(value) ? value : "resting";
  }

  function framePaths(state) {
    const next = normalizedState(state);
    const count = FRAME_COUNTS[next] || 1;
    return Array.from({ length: count }, (_, index) => {
      return FRAME_ROOT + "/" + next + "/frame-" + String(index + 1).padStart(2, "0") + ".png";
    });
  }

  function frameUrl(state, index) {
    const paths = framePaths(state === undefined ? requestedState : state);
    const safeIndex = Number.isFinite(index) ? Math.max(0, Math.floor(index)) : frameIndex;
    return paths[safeIndex % paths.length] || "";
  }

  function setClass(element, className, enabled) {
    if (!element || !element.classList) return;
    if (element.classList.contains && element.classList.contains(className) === !!enabled) return;
    if (typeof element.classList.toggle === "function") {
      element.classList.toggle(className, !!enabled);
    } else if (enabled) {
      element.classList.add(className);
    } else {
      element.classList.remove(className);
    }
  }

  function applyVisibility() {
    const pet = petElement();
    if (!pet) return;
    const showSprite = isActive() && spriteReady && !spriteFailed;
    setClass(pet, "soduwork-sprite-active", showSprite);
    setClass(pet, "soduwork-sprite-fallback", isActive() && !showSprite);
  }

  function stopFrameLoop() {
    if (frameTimer !== null) {
      clearTimeout(frameTimer);
      frameTimer = null;
    }
  }

  function ensureSprite() {
    const pet = petElement();
    if (!pet || typeof document === "undefined" || typeof document.createElement !== "function") {
      return null;
    }
    if (spriteElement && spriteElement.parentNode === pet) return spriteElement;

    const existing = typeof pet.querySelector === "function"
      ? pet.querySelector("#soduWorkPetSprite")
      : null;
    if (existing) {
      spriteElement = existing;
      return spriteElement;
    }

    const image = document.createElement("img");
    if (!image) return null;
    image.id = "soduWorkPetSprite";
    image.className = "soduwork-pet-sprite";
    image.alt = "";
    if (typeof image.setAttribute === "function") image.setAttribute("aria-hidden", "true");
    image.draggable = false;
    image.decoding = "async";
    const svg = typeof pet.querySelector === "function" ? pet.querySelector("#petSvg") : null;
    if (typeof pet.insertBefore === "function") pet.insertBefore(image, svg || null);
    else if (typeof pet.appendChild === "function") pet.appendChild(image);
    else return null;
    spriteElement = image;
    return image;
  }

  function assetUrl(relativePath) {
    if (typeof document !== "undefined" && document.baseURI && typeof URL === "function") {
      try { return new URL(relativePath, document.baseURI).href; } catch (e) {}
    }
    return relativePath;
  }

  function loadFrame(state, index) {
    const current = ensureSprite();
    if (!current || !visible()) return;
    const nextPath = frameUrl(state, index);
    if ((spritePath === nextPath && spriteReady) || failedFrames.has(nextPath)) {
      applyVisibility();
      return;
    }
    cancelPendingFrame();
    const epoch = frameEpoch;
    // Decode off-screen while keeping the last valid frame visible. Hiding the
    // sprite before every asynchronous load flashed the fallback SVG four times
    // per second and continuously invalidated the native overlay shape.
    const image = spriteReady ? document.createElement('img') : current;
    pendingImage = image;
    image.className = 'soduwork-pet-sprite'; image.alt = ''; image.draggable = false;
    image.decoding = 'async'; image.setAttribute('aria-hidden', 'true');
    image.setAttribute('data-soduwork-frame', nextPath);
    const valid = () => epoch === frameEpoch && pendingImage === image && visible() && current.parentNode === petElement();
    const failed = () => {
      if (!valid()) return;
      image.onload = image.onerror = null; pendingImage = null;
      failedFrames.add(nextPath);
      spriteFailed = !spriteReady;
      applyVisibility();
    };
    const commit = () => {
      if (!valid()) return;
      image.onload = image.onerror = null; pendingImage = null;
      if (image !== current) {
        image.id = 'soduWorkPetSprite';
        current.parentNode.replaceChild(image, current);
        spriteElement = image;
      }
      spritePath = nextPath; spriteReady = true; spriteFailed = false;
      applyVisibility();
    };
    image.onload = () => {
      if (!valid()) return;
      if (typeof image.decode === 'function') Promise.resolve().then(() => image.decode()).then(commit, failed);
      else commit();
    };
    image.onerror = failed;
    image.src = assetUrl(nextPath);
    if (image.complete && image.naturalWidth > 0) image.onload();
  }

  function scheduleFrameLoop(state) {
    stopFrameLoop();
    /*
     * Loop the ready and working action frames; keep resting and completed states still.
     */
    if (!visible() || !["ready", "working"].includes(state) || (FRAME_COUNTS[state] || 1) <= 1 ||
        global.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
    frameTimer = setTimeout(function () {
      frameTimer = null;
      if (!visible() || requestedState !== state) return;
      if (!pendingImage) {
        frameIndex = (frameIndex + 1) % (FRAME_COUNTS[state] || 1);
        loadFrame(state, frameIndex);
      }
      scheduleFrameLoop(state);
    }, FRAME_DURATION);
    if (frameTimer && typeof frameTimer.unref === "function") frameTimer.unref();
  }

  function clearStateClasses(pet) {
    Object.keys(STATES).forEach((state) => setClass(pet, "soduwork-state-" + state, false));
  }

  function applyState(next) {
    const pet = petElement();
    if (!pet || !isActive()) return;
    cancelPendingFrame();
    clearStateClasses(pet);
    pet.classList.add("soduwork-state-" + next);
    pet.setAttribute("data-soduwork-state", next);
    appliedState = next;
    frameIndex = 0;
    loadFrame(next, frameIndex);
    scheduleFrameLoop(next);
  }

  function resumeFrame(state) {
    applyVisibility();
    // A hidden pet cancels its pending image but retains the previous pixels.
    // Static states have no frame loop to retry that cancelled replacement.
    if (!pendingImage && (!spriteReady || spritePath !== frameUrl(state, frameIndex))) loadFrame(state, frameIndex);
    if (frameTimer === null) scheduleFrameLoop(state);
  }

  function setState(value) {
    if (!visibilityBound && document.addEventListener) {
      document.addEventListener('visibilitychange', sync);
      global.addEventListener?.('pagehide', destroy);
      visibilityBound = true;
    }
    const next = normalizedState(value);
    requestedState = next;
    const pet = petElement();
    if (!pet) return;

    if (!isActive()) {
      stopFrameLoop();
      cancelPendingFrame();
      if (completionTimer) { clearTimeout(completionTimer); completionTimer = null; }
      clearStateClasses(pet);
      pet.removeAttribute("data-soduwork-state");
      setClass(pet, "soduwork-sprite-active", false);
      setClass(pet, "soduwork-sprite-fallback", false);
      appliedState = "";
      completionHandled = false;
      return;
    }

    if (!visible()) { stopFrameLoop(); cancelPendingFrame(); return; }

    if (next !== "complete") completionHandled = false;
    if (next === "complete" && completionHandled) { resumeFrame(appliedState); return; }
    if (completionTimer) {
      clearTimeout(completionTimer);
      completionTimer = null;
    }
    if (appliedState !== next || pet.getAttribute("data-soduwork-state") !== next) {
      applyState(next);
    } else {
      resumeFrame(next);
    }

    if (next === "complete") {
      completionHandled = true;
      completionTimer = setTimeout(function () {
        completionTimer = null;
        if (requestedState === "complete" && isActive()) applyState("resting");
      }, 2600);
      if (completionTimer && typeof completionTimer.unref === "function") completionTimer.unref();
    }
  }

  function sync() {
    setState(requestedState);
  }

  function destroy() {
    stopFrameLoop();
    cancelPendingFrame();
    if (visibilityBound) {
      document.removeEventListener?.('visibilitychange', sync);
      global.removeEventListener?.('pagehide', destroy);
      visibilityBound = false;
    }
    if (completionTimer) {
      clearTimeout(completionTimer);
      completionTimer = null;
    }
    spriteElement = null;
    spritePath = "";
    spriteReady = false;
    spriteFailed = false;
    appliedState = '';
    completionHandled = false;
    failedFrames.clear();
  }

  global.SoduWorkPetSkin = Object.freeze({
    STATES,
    FRAME_ROOT,
    FRAME_DURATION,
    framePaths,
    frameUrl,
    setState,
    sync,
    destroy,
    isActive,
    isSpriteReady: () => spriteReady && !spriteFailed,
    currentState: () => requestedState
  });
})(typeof window !== "undefined" ? window : globalThis);
