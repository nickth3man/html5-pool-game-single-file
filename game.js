(() => {
  // === DOM HOOKS & GLOBAL STATE ===
  const canvas = document.getElementById("poolCanvas");
  const ctx = canvas.getContext("2d");

  const hudPowerEl = document.getElementById("hud-power");
  const hudStatusEl = document.getElementById("hud-status");
  const ariaStatusEl = document.getElementById("aria-status");

  const btnHelp = document.getElementById("btn-help");
  const btnHelpText = document.getElementById("btn-help-text");
  const btnRestart = document.getElementById("btn-restart");
  const btnResetTable = document.getElementById("btn-reset-table");
  const btnHighContrast = document.getElementById("btn-high-contrast");
  const btnReducedMotion = document.getElementById("btn-reduced-motion");
  const btnToggleSound = document.getElementById("btn-toggle-sound");
  const helpPanel = document.getElementById("help-panel");

  // Single source of truth for meta state
  const gameState = {
    ready: true,
    aiming: false,
    ballsMoving: false,
    shotInProgress: false,
    currentPower: 0,
    lastMessage: "Ready",
    highContrast: false,
    reducedMotion:
      window.matchMedia &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches,
    soundOn: false,
    helpOpen: false,
    firstVisit: false,
  };

  // === TABLE & PHYSICS CONFIG ===
  const LOGICAL_WIDTH = 800;
  const LOGICAL_HEIGHT = 400;

  const TABLE = {
    width: LOGICAL_WIDTH,
    height: LOGICAL_HEIGHT,
    rail: 22,
    pocketRadius: 18,
    ballRadius: 10,
    friction: 0.985,
    stopEpsilon: 0.03,
  };

  let lastTime = 0;
  const BASE_DT = 1 / 60;

  // === STATE ===
  const balls = [];
  let cueBall = null;
  let isAiming = false;
  let aimStart = null;
  let aimCurrent = null;
  let shotInProgress = false;
  const pockets = createPockets();

  // Responsive scaling: we keep logical coords constant and scale via CSS.
  // Input mapping uses getBoundingClientRect() each time so we don't need to change physics on resize.

  // === HELPERS ===
  // Create six pockets with richer geometry:
  // - x, y: pocket drop center (inside the table, slightly inset from corners/edges)
  // - mouthX1, mouthY1, mouthX2, mouthY2: line segment representing rail opening
  // - rCapture: inner capture radius (ball fully over hole)
  // - rFunnel: outer funnel radius for gentle jaw guidance
  function createPockets() {
    const w = TABLE.width;
    const h = TABLE.height;
    const rail = TABLE.rail;
    const br = TABLE.ballRadius;
    const basePocket = TABLE.pocketRadius;

    const rCapture = basePocket + br * 0.4;
    const rFunnel = rCapture + br * 1.2;

    // Corner pockets: centers inset diagonally from corners.
    const cornerOffset = rail * 0.8;

    // Side pockets: centered on side, inset slightly inward.
    const sideInset = rail * 0.55;

    return [
      // Top-left corner
      {
        x: rail - cornerOffset,
        y: rail - cornerOffset,
        mouthX1: rail + br * 0.5,
        mouthY1: rail,
        mouthX2: rail,
        mouthY2: rail + br * 0.5,
        rCapture,
        rFunnel,
      },
      // Top-middle
      {
        x: w / 2,
        y: rail - sideInset,
        mouthX1: w / 2 - basePocket,
        mouthY1: rail,
        mouthX2: w / 2 + basePocket,
        mouthY2: rail,
        rCapture,
        rFunnel,
      },
      // Top-right corner
      {
        x: w - (rail - cornerOffset),
        y: rail - cornerOffset,
        mouthX1: w - rail,
        mouthY1: rail + br * 0.5,
        mouthX2: w - rail - br * 0.5,
        mouthY2: rail,
        rCapture,
        rFunnel,
      },
      // Bottom-left corner
      {
        x: rail - cornerOffset,
        y: h - (rail - cornerOffset),
        mouthX1: rail,
        mouthY1: h - rail - br * 0.5,
        mouthX2: rail + br * 0.5,
        mouthY2: h - rail,
        rCapture,
        rFunnel,
      },
      // Bottom-middle
      {
        x: w / 2,
        y: h - (rail - sideInset),
        mouthX1: w / 2 + basePocket,
        mouthY1: h - rail,
        mouthX2: w / 2 - basePocket,
        mouthY2: h - rail,
        rCapture,
        rFunnel,
      },
      // Bottom-right corner
      {
        x: w - (rail - cornerOffset),
        y: h - (rail - cornerOffset),
        mouthX1: w - rail - br * 0.5,
        mouthY1: h - rail,
        mouthX2: w - rail,
        mouthY2: h - rail - br * 0.5,
        rCapture,
        rFunnel,
      },
    ];
  }

  // Helper: squared distance from point to segment (for mouth checks).
  function distPointToSegmentSq(px, py, x1, y1, x2, y2) {
    const vx = x2 - x1;
    const vy = y2 - y1;
    const wx = px - x1;
    const wy = py - y1;
    const segLenSq = vx * vx + vy * vy || 1;
    const t = Math.max(0, Math.min(1, (wx * vx + wy * vy) / segLenSq));
    const projX = x1 + t * vx;
    const projY = y1 + t * vy;
    const dx = px - projX;
    const dy = py - projY;
    return dx * dx + dy * dy;
  }

  function len(x, y) {
    return Math.sqrt(x * x + y * y);
  }
  function norm(x, y) {
    const l = len(x, y) || 1;
    return { x: x / l, y: y / l };
  }

  function allBallsStopped() {
    for (const b of balls) {
      if (
        !b.pocketed &&
        (Math.abs(b.vx) > TABLE.stopEpsilon ||
          Math.abs(b.vy) > TABLE.stopEpsilon)
      )
        return false;
    }
    return true;
  }

  function setStatus(msg, aria = false) {
    gameState.lastMessage = msg;
    if (hudStatusEl) hudStatusEl.textContent = msg;
    if (aria && ariaStatusEl) {
      ariaStatusEl.textContent = msg;
    }
  }

  function setPower(p) {
    gameState.currentPower = Math.max(0, Math.min(1, p || 0));
    if (hudPowerEl)
      hudPowerEl.textContent = `Power: ${Math.round(
        gameState.currentPower * 100
      )}%`;
  }

  function updateReadyState() {
    const canShoot = allBallsStopped() && !cueBall.pocketed;
    gameState.ready = canShoot && !isAiming && !shotInProgress;
    gameState.ballsMoving = !allBallsStopped();
    if (gameState.ballsMoving) {
      setStatus("Balls moving…");
    } else if (!isAiming && !shotInProgress) {
      setStatus("Ready");
    }
  }

  function createBall(x, y, color, isCue = false) {
    return {
      x,
      y,
      vx: 0,
      vy: 0,
      r: TABLE.ballRadius,
      color,
      isCue,
      pocketed: false,
    };
  }

  function setupBalls() {
    balls.length = 0;
    cueBall = createBall(TABLE.width * 0.25, TABLE.height / 2, "#ffffff", true);
    balls.push(cueBall);

    const startX = TABLE.width * 0.65;
    const startY = TABLE.height / 2;
    const gap = TABLE.ballRadius * 2 + 1.5;
    const colors = [
      "#f97316",
      "#eab308",
      "#22c55e",
      "#38bdf8",
      "#a855f7",
      "#f97316",
      "#22c55e",
      "#38bdf8",
      "#ef4444",
    ];
    let c = 0;
    const rows = 5;
    for (let row = 0; row < rows; row++) {
      const count = rows - row;
      const offsetX = row * gap;
      const offsetY = (count - 1) * TABLE.ballRadius;
      for (let i = 0; i < count; i++) {
        const x = startX + offsetX;
        const y = startY - offsetY / 2 + i * (TABLE.ballRadius * 2);
        balls.push(createBall(x, y, colors[c++ % colors.length]));
      }
    }

    setStatus("New rack ready", true);
    setPower(0);
    gameState.shotInProgress = false;
    shotInProgress = false;
  }

  // === INPUT & INTERACTION ===
  function getCanvasPos(e) {
    const rect = canvas.getBoundingClientRect();
    const clientX = e.touches ? e.touches[0].clientX : e.clientX;
    const clientY = e.touches ? e.touches[0].clientY : e.clientY;
    const x = ((clientX - rect.left) / rect.width) * TABLE.width;
    const y = ((clientY - rect.top) / rect.height) * TABLE.height;
    return { x, y };
  }

  function pointerNearCue(pos) {
    if (!cueBall || cueBall.pocketed) return false;
    const d = len(pos.x - cueBall.x, pos.y - cueBall.y);
    const minRadius = 40; // ~44px touch target after scaling
    return d <= Math.max(cueBall.r * 2.5, minRadius);
  }

  function onPointerDown(e) {
    if (!allBallsStopped()) {
      setStatus("Wait for balls to stop before shooting", true);
      return;
    }
    if (shotInProgress || !cueBall || cueBall.pocketed) return;

    const pos = getCanvasPos(e);
    if (!pointerNearCue(pos)) {
      // Ignore distant taps; subtle feedback only
      setStatus("Start near the cue ball to aim", false);
      return;
    }

    isAiming = true;
    gameState.aiming = true;
    aimStart = { x: cueBall.x, y: cueBall.y };
    aimCurrent = pos;
    setStatus("Aiming… drag back to set power", false);
    e.preventDefault();
  }

  function onPointerMove(e) {
    if (!isAiming) return;
    aimCurrent = getCanvasPos(e);
    e.preventDefault();
  }

  function onPointerUp(e) {
    if (!isAiming) return;
    const pos = aimCurrent || getCanvasPos(e);
    const pullX = pos.x - aimStart.x;
    const pullY = pos.y - aimStart.y;
    const pullDist = Math.min(len(pullX, pullY), 160);

    if (pullDist > 4 && cueBall && !cueBall.pocketed) {
      const shotDir = norm(-pullX, -pullY);
      const maxSpeed = 14;
      const powerRatio = pullDist / 160;
      const speed = powerRatio * maxSpeed;
      cueBall.vx += shotDir.x * speed;
      cueBall.vy += shotDir.y * speed;
      shotInProgress = true;
      gameState.shotInProgress = true;
      setPower(powerRatio);
      setStatus("Shot in progress…", true);
    } else {
      setPower(0);
      setStatus("Ready", false);
    }

    isAiming = false;
    gameState.aiming = false;
    aimStart = null;
    aimCurrent = null;
    e.preventDefault();
  }

  function attachPointerEvents() {
    canvas.addEventListener("mousedown", onPointerDown);
    canvas.addEventListener("mousemove", onPointerMove);
    window.addEventListener("mouseup", onPointerUp);

    canvas.addEventListener("touchstart", onPointerDown, { passive: false });
    canvas.addEventListener("touchmove", onPointerMove, { passive: false });
    canvas.addEventListener("touchend", onPointerUp, { passive: false });
  }

  // Keyboard controls (basic): arrows adjust aim angle, up/down power, space to shoot.
  // For now, expose limited support and keep mapping simple.
  let keyboardAimAngle = 0;
  let keyboardPower = 0;

  function onKeyDown(e) {
    if (e.key === "Tab") return; // let browser handle
    if (e.key === "h" || e.key === "H") {
      toggleHelp();
      e.preventDefault();
    } else if (e.key === "r" || e.key === "R") {
      resetTable(false);
      e.preventDefault();
    } else if (e.code === "Space") {
      // keyboard shot if we have a power set
      if (!allBallsStopped() || shotInProgress || !cueBall || cueBall.pocketed)
        return;
      if (keyboardPower <= 0) {
        keyboardPower = 0.4;
      }
      const dir = {
        x: Math.cos(keyboardAimAngle),
        y: Math.sin(keyboardAimAngle),
      };
      const maxSpeed = 14;
      const speed = keyboardPower * maxSpeed;
      cueBall.vx += dir.x * speed;
      cueBall.vy += dir.y * speed;
      shotInProgress = true;
      gameState.shotInProgress = true;
      setPower(keyboardPower);
      setStatus("Shot in progress…", true);
      e.preventDefault();
    } else if (e.key === "ArrowLeft" || e.key === "a" || e.key === "A") {
      keyboardAimAngle -= 0.05;
      e.preventDefault();
    } else if (e.key === "ArrowRight" || e.key === "d" || e.key === "D") {
      keyboardAimAngle += 0.05;
      e.preventDefault();
    } else if (e.key === "ArrowUp" || e.key === "w" || e.key === "W") {
      keyboardPower = Math.min(1, keyboardPower + 0.05);
      setPower(keyboardPower);
      setStatus("Keyboard aiming: adjust power, press Space to shoot", false);
      e.preventDefault();
    } else if (e.key === "ArrowDown" || e.key === "s" || e.key === "S") {
      keyboardPower = Math.max(0, keyboardPower - 0.05);
      setPower(keyboardPower);
      e.preventDefault();
    }
  }

  // === CONTROLS & TOGGLES ===
  function toggleHelp() {
    if (!helpPanel) return;
    gameState.helpOpen = !gameState.helpOpen;
    helpPanel.hidden = !gameState.helpOpen;
  }

  function resetTable(fromMidShot) {
    if (fromMidShot && !gameState.reducedMotion) {
      // Optionally we could require confirmation; keeping it simple.
    }
    setupBalls();
  }

  function toggleHighContrast() {
    gameState.highContrast = !gameState.highContrast;
    document.body.classList.toggle("high-contrast", gameState.highContrast);
    setStatus(
      gameState.highContrast
        ? "High contrast mode on"
        : "High contrast mode off",
      true
    );
  }

  function toggleReducedMotion() {
    gameState.reducedMotion = !gameState.reducedMotion;
    document.body.classList.toggle("reduced-motion", gameState.reducedMotion);
    setStatus(
      gameState.reducedMotion
        ? "Reduced motion mode on"
        : "Reduced motion mode off",
      true
    );
  }

  function toggleSound() {
    gameState.soundOn = !gameState.soundOn;
    if (btnToggleSound) {
      btnToggleSound.textContent = `Sound: ${gameState.soundOn ? "On" : "Off"}`;
    }
  }

  function attachControlEvents() {
    if (btnHelp) btnHelp.addEventListener("click", () => toggleHelp());
    if (btnHelpText) btnHelpText.addEventListener("click", () => toggleHelp());
    if (btnRestart)
      btnRestart.addEventListener("click", () => resetTable(true));
    if (btnResetTable)
      btnResetTable.addEventListener("click", () => resetTable(true));
    if (btnHighContrast)
      btnHighContrast.addEventListener("click", () => toggleHighContrast());
    if (btnReducedMotion)
      btnReducedMotion.addEventListener("click", () => toggleReducedMotion());
    if (btnToggleSound)
      btnToggleSound.addEventListener("click", () => toggleSound());

    window.addEventListener("keydown", onKeyDown);
  }

  // === PHYSICS ===
  function update(dtFactor) {
    const minX = TABLE.rail + TABLE.ballRadius;
    const maxX = TABLE.width - TABLE.rail - TABLE.ballRadius;
    const minY = TABLE.rail + TABLE.ballRadius;
    const maxY = TABLE.height - TABLE.rail - TABLE.ballRadius;

    // Integrate
    for (const b of balls) {
      if (b.pocketed) continue;
      b.x += b.vx;
      b.y += b.vy;
    }

    // Rails with pocket mouth openings.
    // For each wall, skip bounce if ball is within any pocket mouth for that wall.
    const mouthMargin = TABLE.ballRadius * 0.6;
    const mouthMarginSq = mouthMargin * mouthMargin;

    function isInMouthForSide(b, side) {
      // side: 'left','right','top','bottom'
      for (const p of pockets) {
        const d2 = distPointToSegmentSq(
          b.x,
          b.y,
          p.mouthX1,
          p.mouthY1,
          p.mouthX2,
          p.mouthY2
        );
        if (d2 <= mouthMarginSq) {
          // Additionally, require that this mouth belongs to the relevant side by rough orientation.
          if (
            side === "top" &&
            p.mouthY1 === p.mouthY2 &&
            Math.abs(p.mouthY1 - TABLE.rail) < 1e-3
          )
            return true;
          if (
            side === "bottom" &&
            p.mouthY1 === p.mouthY2 &&
            Math.abs(p.mouthY1 - (TABLE.height - TABLE.rail)) < 1e-3
          )
            return true;
          if (
            side === "left" &&
            p.mouthX1 === p.mouthX2 &&
            Math.abs(p.mouthX1 - TABLE.rail) < 1e-3
          )
            return true;
          if (
            side === "right" &&
            p.mouthX1 === p.mouthX2 &&
            Math.abs(p.mouthX1 - (TABLE.width - TABLE.rail)) < 1e-3
          )
            return true;
        }
      }
      return false;
    }

    for (const b of balls) {
      if (b.pocketed) continue;

      // Left wall
      if (b.x < minX) {
        if (!isInMouthForSide(b, "left")) {
          b.x = minX;
          b.vx = -b.vx;
        }
      }

      // Right wall
      if (b.x > maxX) {
        if (!isInMouthForSide(b, "right")) {
          b.x = maxX;
          b.vx = -b.vx;
        }
      }

      // Top wall
      if (b.y < minY) {
        if (!isInMouthForSide(b, "top")) {
          b.y = minY;
          b.vy = -b.vy;
        }
      }

      // Bottom wall
      if (b.y > maxY) {
        if (!isInMouthForSide(b, "bottom")) {
          b.y = maxY;
          b.vy = -b.vy;
        }
      }
    }

    // Ball-ball collisions
    for (let i = 0; i < balls.length; i++) {
      const a = balls[i];
      if (a.pocketed) continue;
      for (let j = i + 1; j < balls.length; j++) {
        const b = balls[j];
        if (b.pocketed) continue;
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const dist = Math.sqrt(dx * dx + dy * dy);
        const minDist = a.r + b.r;
        if (dist > 0 && dist < minDist) {
          const nx = dx / dist;
          const ny = dy / dist;
          const overlap = (minDist - dist) / 2;
          a.x -= nx * overlap;
          a.y -= ny * overlap;
          b.x += nx * overlap;
          b.y += ny * overlap;
          const dvx = b.vx - a.vx;
          const dvy = b.vy - a.vy;
          const rel = dvx * nx + dvy * ny;
          if (rel < 0) {
            const impulse = -rel;
            const ix = impulse * nx;
            const iy = impulse * ny;
            a.vx -= ix;
            a.vy -= iy;
            b.vx += ix;
            b.vy += iy;
          }
        }
      }
    }

    // Pockets: funnel behavior + realistic capture.
    let allNonCuePocketed = true;
    for (const b of balls) {
      if (b.pocketed) continue;

      for (const p of pockets) {
        const dx = p.x - b.x;
        const dy = p.y - b.y;
        const dist = Math.sqrt(dx * dx + dy * dy) || 0;
        const toCenterX = dx / (dist || 1);
        const toCenterY = dy / (dist || 1);

        const mouthMidX = (p.mouthX1 + p.mouthX2) / 2;
        const mouthMidY = (p.mouthY1 + p.mouthY2) / 2;

        // Inward normal: from mouth midpoint into pocket center.
        const nx = p.x - mouthMidX;
        const ny = p.y - mouthMidY;

        // Ball must be on table side (negative along inward normal) to be funneled.
        const fromMouthToBallX = b.x - mouthMidX;
        const fromMouthToBallY = b.y - mouthMidY;
        const inwardDot = fromMouthToBallX * nx + fromMouthToBallY * ny;

        // Funnel region: gentle guidance when near and approaching.
        if (dist <= p.rFunnel + b.r && inwardDot < 0) {
          if (dist > p.rCapture) {
            const towardDot = b.vx * toCenterX + b.vy * toCenterY;
            if (towardDot > 0) {
              const funnelStrength = 0.04; // subtle; avoids suction feel
              b.vx += toCenterX * funnelStrength;
              b.vy += toCenterY * funnelStrength;
            }
          }
        }

        // Capture when ball is fully over the hole and past the rail/mouth region.
        if (dist + b.r <= p.rCapture) {
          let inside = false;

          // Corner pockets: center beyond both adjacent inner rail lines.
          const leftRailX = TABLE.rail;
          const rightRailX = TABLE.width - TABLE.rail;
          const topRailY = TABLE.rail;
          const bottomRailY = TABLE.height - TABLE.rail;

          const isTop = p.y < h / 2;
          const isLeft = p.x < w / 2;

          if (isTop && isLeft) {
            // top-left
            if (b.x <= leftRailX && b.y <= topRailY) inside = true;
          } else if (isTop && !isLeft) {
            // top-right
            if (b.x >= rightRailX && b.y <= topRailY) inside = true;
          } else if (!isTop && isLeft) {
            // bottom-left
            if (b.x <= leftRailX && b.y >= bottomRailY) inside = true;
          } else if (!isTop && !isLeft) {
            // bottom-right
            if (b.x >= rightRailX && b.y >= bottomRailY) inside = true;
          }

          // Side pockets: use inward normal from mouth.
          if (!inside) {
            const vx = b.x - mouthMidX;
            const vy = b.y - mouthMidY;
            const dotInside = vx * nx + vy * ny;
            if (dotInside > 0) inside = true;
          }

          if (inside) {
            b.pocketed = true;
            b.vx = 0;
            b.vy = 0;

            if (b.isCue) {
              setStatus("Cue ball pocketed – repositioning", true);
              setTimeout(() => {
                b.pocketed = false;
                b.x = TABLE.width * 0.25;
                b.y = TABLE.height / 2;
                b.vx = 0;
                b.vy = 0;
                setStatus("Cue ball respotted. Ready.", true);
              }, 400);
            }
            break;
          }
        }
      }

      if (!b.isCue && !b.pocketed) allNonCuePocketed = false;
    }

    if (allNonCuePocketed) {
      setStatus("Rack cleared! Press Reset Table for a new rack.", true);
    }

    // Friction & stop
    let anyMoving = false;
    const f = Math.pow(TABLE.friction, dtFactor);
    for (const b of balls) {
      if (b.pocketed) continue;
      b.vx *= f;
      b.vy *= f;
      if (Math.abs(b.vx) < TABLE.stopEpsilon) b.vx = 0;
      if (Math.abs(b.vy) < TABLE.stopEpsilon) b.vy = 0;
      if (b.vx !== 0 || b.vy !== 0) anyMoving = true;
    }

    if (!anyMoving) {
      if (shotInProgress || gameState.shotInProgress) {
        setStatus("Ready", true);
      }
      shotInProgress = false;
      gameState.shotInProgress = false;
    }

    gameState.ballsMoving = anyMoving;
  }

  // === RENDERING ===
  function drawTable() {
    const w = TABLE.width,
      h = TABLE.height,
      r = TABLE.rail;

    // Felt
    ctx.fillStyle = "#065f46";
    ctx.fillRect(0, 0, w, h);

    // Rails/frame (match DOM frame tones)
    ctx.fillStyle = "#5a3b19";

    // Top and bottom rails with gaps at pocket mouths.
    const pocketGap = TABLE.pocketRadius * 1.4;

    // Top rail segments
    ctx.fillRect(0, 0, w, r);
    // Left vertical rail
    ctx.fillRect(0, 0, r, h);
    // Right vertical rail
    ctx.fillRect(w - r, 0, r, h);
    // Bottom rail
    ctx.fillRect(0, h - r, w, r);

    // Carve simple visual gaps at mouths by overdrawing felt strips.
    ctx.fillStyle = "#065f46";
    for (const p of pockets) {
      const mx = (p.mouthX1 + p.mouthX2) / 2;
      const my = (p.mouthY1 + p.mouthY2) / 2;

      if (Math.abs(p.mouthY1 - p.mouthY2) < 0.001) {
        // Horizontal mouth (top or bottom)
        const gapHalf = pocketGap / 2;
        ctx.fillRect(mx - gapHalf, my - r, gapHalf * 2, r + 2);
      } else if (Math.abs(p.mouthX1 - p.mouthX2) < 0.001) {
        // Vertical mouth (left or right)
        const gapHalf = pocketGap / 2;
        ctx.fillRect(mx - r, my - gapHalf, r + 2, gapHalf * 2);
      }
    }

    // Pockets: draw capture circle so visual hole matches physics.
    for (const p of pockets) {
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.rCapture, 0, Math.PI * 2);
      ctx.fillStyle = "#020202";
      ctx.fill();

      // Subtle inner shadow ring to hint at depth / jaws
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.rCapture * 0.7, 0, Math.PI * 2);
      ctx.strokeStyle = "rgba(0,0,0,0.5)";
      ctx.lineWidth = 2;
      ctx.stroke();
    }
  }

  function drawBalls() {
    for (const b of balls) {
      if (b.pocketed) continue;
      ctx.beginPath();
      ctx.arc(b.x, b.y, b.r, 0, Math.PI * 2);
      ctx.fillStyle = b.color;
      ctx.fill();
      if (b.isCue) {
        ctx.lineWidth = 1.4;
        ctx.strokeStyle = gameState.ready ? "#fde68a" : "#d1d5db";
        ctx.stroke();
        // subtle halo when ready
        if (gameState.ready && !gameState.reducedMotion) {
          ctx.beginPath();
          ctx.arc(b.x, b.y, b.r + 4, 0, Math.PI * 2);
          ctx.strokeStyle = "rgba(250, 250, 210, 0.18)";
          ctx.lineWidth = 1;
          ctx.stroke();
        }
      }
    }
  }

  function drawAim() {
    if (!isAiming || !aimStart || !aimCurrent || !cueBall || cueBall.pocketed)
      return;
    const pullX = aimCurrent.x - aimStart.x;
    const pullY = aimCurrent.y - aimStart.y;
    const pullDist = Math.min(len(pullX, pullY), 160);
    if (pullDist < 4) {
      setPower(0);
      return;
    }

    const shotDir = norm(-pullX, -pullY);
    const maxLen = 110;
    const lineLen = (pullDist / 160) * maxLen;
    const ex = cueBall.x + shotDir.x * lineLen;
    const ey = cueBall.y + shotDir.y * lineLen;

    const powerRatio = pullDist / 160;
    setPower(powerRatio);

    ctx.save();
    ctx.strokeStyle = gameState.highContrast
      ? "#facc15"
      : "rgba(248, 250, 252, 0.95)";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(cueBall.x, cueBall.y);
    ctx.lineTo(ex, ey);
    ctx.stroke();

    // In-table power bar
    const bw = 90,
      bh = 6;
    const bx = cueBall.x - bw / 2;
    const by = cueBall.y - cueBall.r - 18;
    ctx.fillStyle = "rgba(15,23,42,0.85)";
    ctx.fillRect(bx, by, bw, bh);
    ctx.fillStyle = "#22c55e";
    ctx.fillRect(bx, by, bw * powerRatio, bh);
    ctx.restore();
  }

  // === MAIN LOOP ===
  function loop(ts) {
    if (!lastTime) lastTime = ts;
    const delta = ts - lastTime;
    lastTime = ts;
    const dtFactor = Math.max(0.25, Math.min(2.5, delta / (1000 * BASE_DT)));

    update(dtFactor);
    updateReadyState();

    ctx.clearRect(0, 0, canvas.width, canvas.height);

    // Draw at logical resolution; canvas element is scaled via CSS for responsiveness.
    drawTable();
    drawBalls();
    drawAim();

    requestAnimationFrame(loop);
  }

  // === INIT & ONBOARDING ===
  function initFirstVisitHint() {
    try {
      const key = "canvas-pool-first-visit";
      if (!localStorage.getItem(key)) {
        setStatus(
          "Tip: Drag back from the cue ball to aim and set power, then release.",
          true
        );
        localStorage.setItem(key, "1");
      }
    } catch (e) {
      // ignore storage errors
    }
  }

  function init() {
    // Keep internal logical size; visual scaling is in CSS.
    canvas.width = LOGICAL_WIDTH;
    canvas.height = LOGICAL_HEIGHT;

    setupBalls();
    attachPointerEvents();
    attachControlEvents();
    initFirstVisitHint();
    requestAnimationFrame(loop);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init, { once: true });
  } else {
    init();
  }
})();
