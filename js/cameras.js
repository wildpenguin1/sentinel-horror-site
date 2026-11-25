/*!
 * cameras.js — CCTV feed renderer (Canvas 2D, no dependencies, no network).
 * Defines window.Cameras.Feed. Plain script, no modules, no build step.
 *
 *   const feed = new Cameras.Feed(canvas, {
 *     room: 'hall' | 'living' | 'nursery' | 'door',
 *     ir: false, seed: 42, label: 'CAM 03', clock: true
 *   });
 *   feed.setThreat(0..1); feed.setGlitch(0..1);
 *   feed.setPaused(bool); feed.resize(); feed.destroy();
 */
(function (global) {
  'use strict';

  var doc = global.document;
  if (!doc) return;

  /* ------------------------------------------------------------------ *
   * constants & math helpers
   * ------------------------------------------------------------------ */
  var TAU = Math.PI * 2;
  var BASE_H = 240;          // internal render height (px)
  var MIN_W = 300;
  var MAX_W = 520;
  var MAX_FPS = 30;
  var FRAME_MS = 1000 / MAX_FPS;
  var LEVELS = 5;

  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
  function lerp(a, b, t) { return a + (b - a) * t; }
  function smoothstep(t) { return t * t * (3 - 2 * t); }
  function hash1(n) { var s = Math.sin(n * 127.1 + 311.7) * 43758.5453; return s - Math.floor(s); }
  function vnoise(x) { var i = Math.floor(x), f = x - i; return lerp(hash1(i), hash1(i + 1), smoothstep(f)); }
  function pad2(n) { return n < 10 ? '0' + n : '' + n; }

  function mkCanvas(w, h) {
    var c = doc.createElement('canvas');
    c.width = Math.max(1, Math.round(w));
    c.height = Math.max(1, Math.round(h));
    return c;
  }

  function gray(v, a) {
    v = Math.round(clamp(v, 0, 255));
    return a === undefined ? 'rgb(' + v + ',' + v + ',' + v + ')' : 'rgba(' + v + ',' + v + ',' + v + ',' + a + ')';
  }
  function rgba(r, g, b, a) {
    return 'rgba(' + Math.round(clamp(r, 0, 255)) + ',' + Math.round(clamp(g, 0, 255)) + ',' +
      Math.round(clamp(b, 0, 255)) + ',' + a + ')';
  }

  function grad(c, x0, y0, x1, y1, cols) {
    var g = c.createLinearGradient(x0, y0, x1, y1);
    for (var i = 0; i < cols.length; i++) {
      g.addColorStop(cols.length === 1 ? 0 : i / (cols.length - 1), cols[i]);
    }
    return g;
  }
  function radGrad(c, x, y, r0, r1, cols) {
    var g = c.createRadialGradient(x, y, r0, x, y, r1);
    for (var i = 0; i < cols.length; i++) {
      g.addColorStop(cols.length === 1 ? 0 : i / (cols.length - 1), cols[i]);
    }
    return g;
  }

  function poly(c, pts, fill) {
    if (!pts || pts.length < 2) return;
    c.beginPath();
    c.moveTo(pts[0][0], pts[0][1]);
    for (var i = 1; i < pts.length; i++) c.lineTo(pts[i][0], pts[i][1]);
    c.closePath();
    if (fill) { c.fillStyle = fill; c.fill(); }
  }

  function rrect(c, x, y, w, h, r) {
    r = Math.min(r || 0, Math.abs(w) / 2, Math.abs(h) / 2);
    c.beginPath();
    c.moveTo(x + r, y);
    c.lineTo(x + w - r, y);
    c.quadraticCurveTo(x + w, y, x + w, y + r);
    c.lineTo(x + w, y + h - r);
    c.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    c.lineTo(x + r, y + h);
    c.quadraticCurveTo(x, y + h, x, y + h - r);
    c.lineTo(x, y + r);
    c.quadraticCurveTo(x, y, x + r, y);
    c.closePath();
  }

  /* smooth tapered ribbon through points [x, y, halfWidth] */
  function ribbon(c, pts) {
    var n = pts.length;
    if (n < 2) return;
    var L = [], R = [], i;
    for (i = 0; i < n; i++) {
      var p = pts[i];
      var a = pts[Math.max(0, i - 1)], b = pts[Math.min(n - 1, i + 1)];
      var dx = b[0] - a[0], dy = b[1] - a[1];
      var len = Math.sqrt(dx * dx + dy * dy) || 1e-6;
      var nx = -dy / len, ny = dx / len;
      var hw = p[2] / 2;
      L.push([p[0] + nx * hw, p[1] + ny * hw]);
      R.push([p[0] - nx * hw, p[1] - ny * hw]);
    }
    c.beginPath();
    c.moveTo(L[0][0], L[0][1]);
    for (i = 1; i < n - 1; i++) {
      c.quadraticCurveTo(L[i][0], L[i][1], (L[i][0] + L[i + 1][0]) / 2, (L[i][1] + L[i + 1][1]) / 2);
    }
    c.lineTo(L[n - 1][0], L[n - 1][1]);
    for (i = n - 1; i > 0; i--) {
      c.quadraticCurveTo(R[i][0], R[i][1], (R[i][0] + R[i - 1][0]) / 2, (R[i][1] + R[i - 1][1]) / 2);
    }
    c.lineTo(R[0][0], R[0][1]);
    c.closePath();
  }

  function line(c, x0, y0, x1, y1, col, w) {
    c.beginPath();
    c.moveTo(x0, y0);
    c.lineTo(x1, y1);
    c.strokeStyle = col;
    c.lineWidth = w || 1;
    c.stroke();
  }

  /* seeded rng ------------------------------------------------------- */
  function mulberry32(a) {
    return function () {
      a = (a + 0x6D2B79F5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  var ROOM_SALT = { hall: 11, living: 23, nursery: 37, door: 53 };
  function seeded(seed, room) {
    var s = ((seed | 0) * 2654435761 + (ROOM_SALT[room] || 7) * 40503) | 0;
    return mulberry32(s);
  }

  /* ------------------------------------------------------------------ *
   * shared palette / tint
   * ------------------------------------------------------------------ */

  /* monochrome scene -> CCTV colour. drawn before light sources. */
  function tintScene(c, W, H, ir) {
    c.save();
    c.globalCompositeOperation = 'multiply';
    if (ir) {
      c.fillStyle = 'rgb(122,196,128)';
      c.fillRect(0, 0, W, H);
      c.globalCompositeOperation = 'lighter';
      c.fillStyle = 'rgba(2,20,6,0.55)';
      c.fillRect(0, 0, W, H);
    } else {
      c.fillStyle = 'rgb(166,184,198)';
      c.fillRect(0, 0, W, H);
      c.globalCompositeOperation = 'lighter';
      c.fillStyle = 'rgba(4,8,14,0.52)';
      c.fillRect(0, 0, W, H);
    }
    c.restore();
  }

  /* light colour helpers (added after tint) */
  function lampCol(ir, a) {
    return ir ? rgba(150, 220, 158, a) : rgba(255, 206, 138, a);
  }
  function coolCol(ir, a) {
    return ir ? rgba(130, 210, 150, a) : rgba(150, 178, 210, a);
  }

  /* ================================================================== *
   * ROOM: hall — corridor receding to a vanishing point
   * ================================================================== */
  var HALL = { CX: 0.5, CY: 0.47, F: 0.86, HW: 1.28, CH: 2.68, CAMY: 1.56, ZF: 12.5 };

  function hallCam(W, H) {
    var CX = W * HALL.CX, CY = H * HALL.CY, F = H * HALL.F;
    return {
      CX: CX, CY: CY, F: F,
      P: function (x, y, z) { return [CX + F * x / z, CY + F * (HALL.CAMY - y) / z]; }
    };
  }

  function hallLights(W, H) {
    var P = hallCam(W, H).P;
    return [
      { p: P(-HALL.HW, 2.06, 3.35), s: 1.0 },
      { p: P(HALL.HW, 2.06, 5.30), s: 0.8 }
    ];
  }

  function hallBg(c, W, H, o) {
    var rng = o.rng, ir = o.ir;
    var C = hallCam(W, H), P = C.P, CX = C.CX, CY = C.CY;
    var HW = HALL.HW, CH = HALL.CH, zN = 0.9, zF = HALL.ZF;

    c.fillStyle = gray(6);
    c.fillRect(0, 0, W, H);

    /* ceiling */
    poly(c, [P(-HW, CH, zN), P(HW, CH, zN), P(HW, CH, zF), P(-HW, CH, zF)],
      grad(c, 0, 0, 0, CY, [gray(20), gray(9), gray(4)]));

    /* right wall (darker, light comes from the left) */
    poly(c, [P(HW, 0, zN), P(HW, CH, zN), P(HW, CH, zF), P(HW, 0, zF)],
      grad(c, W, 0, CX, 0, [gray(30), gray(14), gray(4)]));
    /* left wall */
    poly(c, [P(-HW, 0, zN), P(-HW, CH, zN), P(-HW, CH, zF), P(-HW, 0, zF)],
      grad(c, 0, 0, CX, 0, [gray(42), gray(19), gray(5)]));

    /* floor */
    poly(c, [P(-HW, 0, zN), P(HW, 0, zN), P(HW, 0, zF), P(-HW, 0, zF)],
      grad(c, 0, H, 0, CY, [gray(24), gray(15), gray(5)]));

    /* far wall + door sliver of light */
    var fw = [P(-HW, 0, zF), P(-HW, CH, zF), P(HW, CH, zF), P(HW, 0, zF)];
    poly(c, fw, gray(4));
    /* faint door outline at the end */
    c.save();
    c.strokeStyle = gray(16, 0.5);
    c.lineWidth = 1;
    var dl = P(-0.42, 0, zF), dl2 = P(-0.42, 2.0, zF), dr = P(0.42, 2.0, zF), dr2 = P(0.42, 0, zF);
    c.beginPath();
    c.moveTo(dl[0], dl[1]);
    c.lineTo(dl2[0], dl2[1]);
    c.lineTo(dr[0], dr[1]);
    c.lineTo(dr2[0], dr2[1]);
    c.stroke();
    c.restore();

    /* corridor shadow toward the vanishing point */
    c.fillStyle = radGrad(c, CX, CY + H * 0.02, H * 0.02, W * 0.52, [
      'rgba(0,0,0,0.72)', 'rgba(0,0,0,0.42)', 'rgba(0,0,0,0)'
    ]);
    c.fillRect(0, 0, W, H);

    /* floor tile seams */
    c.save();
    c.lineWidth = 1;
    var xs = [-0.64, 0, 0.64], i, z;
    for (i = 0; i < xs.length; i++) {
      var a = P(xs[i], 0, 1.5), b = P(xs[i], 0, zF);
      c.strokeStyle = gray(150, 0.055);
      c.beginPath();
      c.moveTo(a[0], a[1]);
      c.lineTo(b[0], b[1]);
      c.stroke();
    }
    var zs = [1.7, 2.3, 3.2, 4.4, 6.1, 8.6];
    for (i = 0; i < zs.length; i++) {
      z = zs[i];
      var p1 = P(-HW, 0, z), p2 = P(HW, 0, z);
      c.strokeStyle = gray(160, 0.045 + 0.02 * (i / zs.length));
      c.beginPath();
      c.moveTo(p1[0], p1[1]);
      c.lineTo(p2[0], p2[1]);
      c.stroke();
    }
    c.restore();

    /* skirting + ceiling junction */
    line(c, P(-HW, 0, zN)[0], P(-HW, 0, zN)[1], P(-HW, 0, zF)[0], P(-HW, 0, zF)[1], gray(58, 0.34), 2);
    line(c, P(HW, 0, zN)[0], P(HW, 0, zN)[1], P(HW, 0, zF)[0], P(HW, 0, zF)[1], gray(50, 0.26), 2);
    line(c, P(-HW, 0, zF)[0], P(-HW, 0, zF)[1], P(HW, 0, zF)[0], P(HW, 0, zF)[1], gray(40, 0.2), 1);
    line(c, P(-HW, CH, zN)[0], P(-HW, CH, zN)[1], P(-HW, CH, zF)[0], P(-HW, CH, zF)[1], gray(24, 0.28), 1.5);
    line(c, P(HW, CH, zN)[0], P(HW, CH, zN)[1], P(HW, CH, zF)[0], P(HW, CH, zF)[1], gray(20, 0.22), 1.5);

    /* doorways: darker recesses + jambs */
    var doors = [
      { s: -1, z: 2.0 + rng() * 0.3, d: 0.92 },
      { s: -1, z: 4.6 + rng() * 0.4, d: 0.95 },
      { s: 1, z: 2.9 + rng() * 0.3, d: 0.9 },
      { s: 1, z: 6.0 + rng() * 0.5, d: 1.0 }
    ];
    for (i = 0; i < doors.length; i++) {
      var d = doors[i], x = d.s * HW;
      var q = [P(x, 0, d.z), P(x, 2.02, d.z), P(x, 2.02, d.z + d.d), P(x, 0, d.z + d.d)];
      poly(c, q, gray(2));
      /* jamb highlight on the near edge */
      var nTop = P(x, 2.02, d.z), nBot = P(x, 0, d.z);
      line(c, nTop[0], nTop[1], nBot[0], nBot[1], gray(72, 0.3), 2);
      var fTop = P(x, 2.02, d.z + d.d);
      line(c, nTop[0], nTop[1], fTop[0], fTop[1], gray(52, 0.18), 1.5);
      var fBot = P(x, 0, d.z + d.d);
      line(c, fBot[0], fBot[1], nBot[0], nBot[1], gray(46, 0.14), 1);
    }

    tintScene(c, W, H, ir);

    /* wall sconces (lit) */
    var L = hallLights(W, H);
    for (i = 0; i < L.length; i++) {
      var pt = L[i].p, sc = L[i].s;
      c.save();
      c.globalCompositeOperation = 'lighter';
      c.fillStyle = radGrad(c, pt[0], pt[1], 0, H * 0.15 * sc, [
        lampCol(ir, 0.5 * sc), lampCol(ir, 0.13 * sc), lampCol(ir, 0)
      ]);
      c.fillRect(pt[0] - H * 0.16, pt[1] - H * 0.16, H * 0.32, H * 0.32);
      c.restore();
      /* fixture */
      c.fillStyle = gray(16);
      rrect(c, pt[0] - 2.6, pt[1] - 1.6, 5.2, 7.2, 1.4);
      c.fill();
      c.fillStyle = lampCol(ir, 0.85);
      c.fillRect(pt[0] - 1.4, pt[1] - 1.2, 2.8, 2.6);
    }

    /* floor reflection of the near sconce */
    var fl = P(-0.92, 0, 3.5);
    c.save();
    c.globalCompositeOperation = 'lighter';
    c.fillStyle = lampCol(ir, 0.07);
    c.beginPath();
    c.ellipse(fl[0], fl[1], W * 0.055, H * 0.045, 0, 0, TAU);
    c.fill();
    c.restore();
  }

  function hallAnim(c, W, H, t, o) {
    var L = hallLights(W, H), i;
    c.save();
    c.globalCompositeOperation = 'lighter';
    for (i = 0; i < L.length; i++) {
      var pt = L[i].p, sc = L[i].s;
      var f = 0.72 + 0.28 * vnoise(t * 2.4 + i * 9.1) - (o.reduce ? 0.04 : 0.09 * hash1(Math.floor(t * 8) + i));
      if (f < 0.25) f = 0.25;
      c.fillStyle = radGrad(c, pt[0], pt[1], 0, H * 0.17 * sc, [
        lampCol(o.ir, 0.16 * f * sc), lampCol(o.ir, 0.045 * f * sc), lampCol(o.ir, 0)
      ]);
      c.fillRect(pt[0] - H * 0.18, pt[1] - H * 0.18, H * 0.36, H * 0.36);
    }
    /* sliver of light under the far door */
    var C = hallCam(W, H);
    var a = C.P(-0.36, 0.015, HALL.ZF), b = C.P(0.36, 0.015, HALL.ZF);
    var sl = 0.5 + 0.5 * vnoise(t * 0.7);
    c.strokeStyle = lampCol(o.ir, 0.13 * sl);
    c.lineWidth = 1.4;
    c.beginPath();
    c.moveTo(a[0], a[1]);
    c.lineTo(b[0], b[1]);
    c.stroke();
    c.restore();
  }

  /* ================================================================== *
   * ROOM: living — sofa, tall window, floor lamp
   * ================================================================== */
  var LIV = { floorY: 0.60, win: { x0: 0.625, x1: 0.865, y0: 0.075, y1: 0.495 }, lampX: 0.565 };

  function livingBg(c, W, H, o) {
    var rng = o.rng, ir = o.ir, fy = H * LIV.floorY, i;
    var wx0 = W * LIV.win.x0, wx1 = W * LIV.win.x1;
    var wy0 = H * LIV.win.y0, wy1 = H * LIV.win.y1;

    /* back wall */
    c.fillStyle = grad(c, 0, 0, 0, fy, [gray(11), gray(15), gray(13)]);
    c.fillRect(0, 0, W, fy);
    /* left corner shadow */
    c.fillStyle = grad(c, 0, 0, W * 0.20, 0, ['rgba(0,0,0,0.55)', 'rgba(0,0,0,0)']);
    c.fillRect(0, 0, W * 0.20, fy);
    /* corner line */
    line(c, W * 0.115, 0, W * 0.115, fy, gray(40, 0.16), 1);

    /* floor */
    c.fillStyle = grad(c, 0, fy, 0, H, [gray(13), gray(17), gray(23)]);
    c.fillRect(0, fy, W, H - fy);
    line(c, 0, fy, W, fy, gray(52, 0.28), 1.5);

    /* floor boards */
    c.save();
    var by;
    for (i = 0; i < 7; i++) {
      by = fy + (H - fy) * Math.pow((i + 1) / 8, 1.5);
      c.strokeStyle = gray(110, 0.05);
      c.lineWidth = 1;
      c.beginPath();
      c.moveTo(0, by);
      c.lineTo(W, by);
      c.stroke();
    }
    c.restore();

    /* picture frame on the wall */
    var px = W * 0.13, py = H * 0.13, pw = W * 0.16, ph = H * 0.185;
    c.fillStyle = gray(9);
    c.fillRect(px, py, pw, ph);
    c.strokeStyle = gray(46, 0.55);
    c.lineWidth = 1.5;
    c.strokeRect(px + 0.5, py + 0.5, pw, ph);

    /* window: frame, outside glow, mullions */
    c.fillStyle = gray(7);
    c.fillRect(wx0 - 3, wy0 - 3, (wx1 - wx0) + 6, (wy1 - wy0) + 6);
    c.fillStyle = grad(c, wx0, wy0, wx0, wy1, [gray(74), gray(52), gray(30)]);
    c.fillRect(wx0, wy0, wx1 - wx0, wy1 - wy0);
    /* far treeline inside the glass */
    c.save();
    c.beginPath();
    c.rect(wx0, wy0, wx1 - wx0, wy1 - wy0);
    c.clip();
    c.fillStyle = gray(6, 0.85);
    c.beginPath();
    c.moveTo(wx0, wy1 * 0.72 + (wy1 - wy0) * 0.14);
    var n = 9;
    for (i = 0; i <= n; i++) {
      var tx = wx0 + (wx1 - wx0) * (i / n);
      var ty = wy1 - (wy1 - wy0) * (0.16 + rng() * 0.26);
      c.lineTo(tx, ty);
    }
    c.lineTo(wx1, wy1);
    c.lineTo(wx0, wy1);
    c.closePath();
    c.fill();
    c.restore();

    /* mullions */
    c.fillStyle = gray(26);
    c.fillRect((wx0 + wx1) / 2 - 1, wy0, 2, wy1 - wy0);
    c.fillRect(wx0, wy0 + (wy1 - wy0) * 0.42, wx1 - wx0, 2);
    c.strokeStyle = gray(58, 0.5);
    c.lineWidth = 2;
    c.strokeRect(wx0, wy0, wx1 - wx0, wy1 - wy0);

    /* curtains */
    function curtain(x, w, flip) {
      c.beginPath();
      c.moveTo(x, H * 0.045);
      c.lineTo(x + w, H * 0.055);
      c.quadraticCurveTo(x + w + (flip ? -6 : 6), H * 0.33, x + w * 1.05, H * 0.625);
      c.lineTo(x - w * 0.06, H * 0.62);
      c.quadraticCurveTo(x - (flip ? -7 : 7), H * 0.33, x, H * 0.045);
      c.closePath();
      c.fillStyle = grad(c, x, 0, x + w, 0, [gray(9), gray(15), gray(8)]);
      c.fill();
      c.strokeStyle = gray(30, 0.25);
      c.lineWidth = 1;
      c.beginPath();
      c.moveTo(x + w * 0.55, H * 0.06);
      c.quadraticCurveTo(x + w * 0.2, H * 0.35, x + w * 0.35, H * 0.62);
      c.stroke();
    }
    curtain(wx0 - W * 0.075, W * 0.075, false);
    curtain(wx1 + W * 0.002, W * 0.085, true);

    /* window light spill on the floor */
    c.save();
    c.fillStyle = grad(c, 0, fy, 0, H, [gray(70, 0.15), gray(50, 0.07), gray(40, 0)]);
    c.beginPath();
    c.moveTo(wx0 - W * 0.02, fy);
    c.lineTo(wx1 + W * 0.06, fy);
    c.lineTo(W * 1.02, H * 1.02);
    c.lineTo(W * 0.20, H * 1.02);
    c.closePath();
    c.fill();
    c.restore();

    /* rug */
    poly(c, [
      [W * 0.06, H * 0.795], [W * 0.64, H * 0.785],
      [W * 0.74, H * 1.02], [W * 0.01, H * 1.02]
    ], gray(24, 0.5));
    c.strokeStyle = gray(56, 0.18);
    c.lineWidth = 1;
    c.beginPath();
    c.moveTo(W * 0.075, H * 0.815);
    c.lineTo(W * 0.72, H * 1.0);
    c.stroke();

    /* sofa (front-left, 3/4) */
    var sx = W * 0.045, sw = W * 0.465, sy = H * 0.575;
    /* back */
    c.fillStyle = grad(c, sx, sy, sx, sy + H * 0.20, [gray(17), gray(11)]);
    rrect(c, sx + sw * 0.06, sy, sw * 0.88, H * 0.145, 5);
    c.fill();
    c.strokeStyle = gray(46, 0.22);
    c.lineWidth = 1.2;
    c.beginPath();
    c.moveTo(sx + sw * 0.10, sy + 1.5);
    c.lineTo(sx + sw * 0.90, sy + 1.5);
    c.stroke();
    /* seat */
    c.fillStyle = gray(14);
    rrect(c, sx + sw * 0.07, sy + H * 0.125, sw * 0.86, H * 0.06, 4);
    c.fill();
    /* cushion split */
    line(c, sx + sw * 0.50, sy + H * 0.06, sx + sw * 0.50, sy + H * 0.17, gray(30, 0.3), 1);
    /* arms */
    c.fillStyle = grad(c, sx, sy, sx, sy + H * 0.2, [gray(22), gray(12)]);
    rrect(c, sx, sy + H * 0.035, sw * 0.11, H * 0.155, 5);
    c.fill();
    rrect(c, sx + sw * 0.89, sy + H * 0.045, sw * 0.11, H * 0.15, 5);
    c.fill();
    /* base + legs */
    c.fillStyle = gray(8);
    c.fillRect(sx + sw * 0.06, sy + H * 0.183, sw * 0.90, H * 0.014);
    c.fillRect(sx + sw * 0.10, sy + H * 0.196, 3, H * 0.02);
    c.fillRect(sx + sw * 0.84, sy + H * 0.196, 3, H * 0.02);

    /* coffee table */
    var tx = W * 0.135, tw = W * 0.375, ty = H * 0.795;
    poly(c, [
      [tx, ty], [tx + tw, ty - H * 0.004],
      [tx + tw + W * 0.045, H * 0.885], [tx - W * 0.02, H * 0.89]
    ], gray(21));
    poly(c, [
      [tx - W * 0.02, H * 0.89], [tx + tw + W * 0.045, H * 0.885],
      [tx + tw + W * 0.045, H * 0.90], [tx - W * 0.02, H * 0.905]
    ], gray(10));
    line(c, tx + 2, ty + 1, tx + tw - 2, ty - H * 0.003, gray(90, 0.22), 1.2);
    c.fillStyle = gray(9);
    c.fillRect(tx + W * 0.02, H * 0.90, 3, H * 0.03);
    c.fillRect(tx + tw + W * 0.02, H * 0.895, 3, H * 0.03);

    /* floor lamp */
    var lx = W * LIV.lampX;
    c.fillStyle = gray(9);
    c.fillRect(lx - 1.2, H * 0.30, 2.4, H * 0.565);
    c.fillRect(lx - W * 0.012, H * 0.855, W * 0.024, 3);
    c.beginPath();
    c.ellipse(lx, H * 0.862, W * 0.045, H * 0.012, 0, 0, TAU);
    c.fillStyle = gray(12);
    c.fill();
    /* shade */
    poly(c, [
      [lx - W * 0.042, H * 0.235], [lx + W * 0.042, H * 0.235],
      [lx + W * 0.062, H * 0.315], [lx - W * 0.062, H * 0.315]
    ], grad(c, lx, H * 0.235, lx, H * 0.315, [gray(30), gray(13)]));

    tintScene(c, W, H, ir);

    /* window glow (cool moon light) */
    c.save();
    c.globalCompositeOperation = 'lighter';
    c.fillStyle = radGrad(c, (wx0 + wx1) / 2, (wy0 + wy1) / 2, 0, W * 0.30, [
      coolCol(ir, 0.20), coolCol(ir, 0.06), coolCol(ir, 0)
    ]);
    c.fillRect(wx0 - W * 0.32, wy0 - W * 0.32, W * 0.72, W * 0.72);
    c.restore();

    /* lamp bulb glow */
    c.save();
    c.globalCompositeOperation = 'lighter';
    c.fillStyle = radGrad(c, lx, H * 0.30, 0, H * 0.30, [
      lampCol(ir, 0.34), lampCol(ir, 0.09), lampCol(ir, 0)
    ]);
    c.fillRect(lx - H * 0.31, H * -0.01, H * 0.62, H * 0.62);
    c.fillStyle = lampCol(ir, 0.5);
    c.beginPath();
    c.ellipse(lx, H * 0.313, W * 0.045, H * 0.009, 0, 0, TAU);
    c.fill();
    c.restore();
  }

  function livingAnim(c, W, H, t, o) {
    var lx = W * LIV.lampX;
    var f = 0.85 + 0.15 * vnoise(t * 1.6);
    if (!o.reduce && hash1(Math.floor(t * 3.1)) > 0.93) f *= 0.55;
    c.save();
    c.globalCompositeOperation = 'lighter';
    c.fillStyle = radGrad(c, lx, H * 0.30, 0, H * 0.30, [
      lampCol(o.ir, 0.20 * f), lampCol(o.ir, 0.05 * f), lampCol(o.ir, 0)
    ]);
    c.fillRect(lx - H * 0.31, H * -0.02, H * 0.62, H * 0.64);
    /* window breathing (clouds passing) */
    var w = 0.85 + 0.15 * vnoise(t * 0.42 + 3.7);
    c.fillStyle = radGrad(c, W * 0.745, H * 0.28, 0, W * 0.26, [
      coolCol(o.ir, 0.10 * w), coolCol(o.ir, 0)
    ]);
    c.fillRect(W * 0.42, 0, W * 0.64, H * 0.62);
    c.restore();
  }

  /* ================================================================== *
   * ROOM: nursery — crib, mobile, nightlight
   * ================================================================== */
  var NUR = { floorY: 0.605, night: { x: 0.795, y: 0.652 } };

  function nurseryBg(c, W, H, o) {
    var rng = o.rng, ir = o.ir, fy = H * NUR.floorY, i;

    /* wall */
    c.fillStyle = grad(c, 0, 0, 0, fy, [gray(10), gray(18), gray(12)]);
    c.fillRect(0, 0, W, fy);
    /* wallpaper stripes */
    c.save();
    for (i = 0; i < 22; i++) {
      var sx = (i / 22) * W + W * 0.012;
      c.fillStyle = i % 2 ? gray(46, 0.035) : gray(4, 0.05);
      c.fillRect(sx, 0, W / 44, fy);
    }
    c.restore();

    /* floor */
    c.fillStyle = grad(c, 0, fy, 0, H, [gray(12), gray(16), gray(21)]);
    c.fillRect(0, fy, W, H - fy);
    line(c, 0, fy, W, fy, gray(54, 0.26), 1.5);
    /* floor boards */
    for (i = 1; i < 6; i++) {
      var by = fy + (H - fy) * Math.pow(i / 6, 1.45);
      line(c, 0, by, W, by, gray(120, 0.05), 1);
    }

    /* window with blinds (back left) */
    var wx0 = W * 0.065, wx1 = W * 0.305, wy0 = H * 0.085, wy1 = H * 0.325;
    c.fillStyle = gray(8);
    c.fillRect(wx0 - 3, wy0 - 3, (wx1 - wx0) + 6, (wy1 - wy0) + 6);
    c.fillStyle = grad(c, wx0, wy0, wx0, wy1, [gray(60), gray(40)]);
    c.fillRect(wx0, wy0, wx1 - wx0, wy1 - wy0);
    /* slats */
    for (i = 0; i < 7; i++) {
      c.fillStyle = gray(16);
      c.fillRect(wx0, wy0 + (wy1 - wy0) * (i / 7), wx1 - wx0, (wy1 - wy0) / 7 * 0.55);
    }
    c.strokeStyle = gray(50, 0.45);
    c.lineWidth = 1.5;
    c.strokeRect(wx0, wy0, wx1 - wx0, wy1 - wy0);
    /* blind light spill on floor (slats projected) */
    c.save();
    for (i = 0; i < 6; i++) {
      c.fillStyle = gray(64, 0.055);
      var yy = fy + (H - fy) * (0.06 + i * 0.115);
      poly(c, [
        [W * 0.02, yy], [W * 0.38, yy - H * 0.01],
        [W * 0.42, yy + H * 0.035], [W * 0.01, yy + H * 0.045]
      ], gray(70, 0.05));
    }
    c.restore();

    /* dresser (right) */
    var dx = W * 0.655, dw = W * 0.30, dy = H * 0.515, dh = H * 0.215;
    poly(c, [
      [dx, dy], [dx + dw, dy - H * 0.012],
      [dx + dw + W * 0.012, dy + H * 0.022], [dx - W * 0.008, dy + H * 0.03]
    ], gray(28, 0.9));
    c.fillStyle = grad(c, dx, dy, dx, dy + dh, [gray(20), gray(13)]);
    c.fillRect(dx, dy + H * 0.012, dw, dh);
    for (i = 0; i < 3; i++) {
      var yy2 = dy + H * 0.045 + i * (dh * 0.30);
      line(c, dx + 2, yy2, dx + dw - 2, yy2, gray(6, 0.8), 1.4);
      c.fillStyle = gray(52, 0.5);
      c.beginPath();
      c.arc(dx + dw * 0.5, yy2 + dh * 0.135, 1.7, 0, TAU);
      c.fill();
    }
    line(c, dx + 1, dy + H * 0.012, dx + 1, dy + dh, gray(46, 0.25), 1);

    /* crib */
    var cx0 = W * 0.10, cx1 = W * 0.515, cyT = H * 0.545, cyB = H * 0.845;
    /* interior void (behind the front bars) */
    c.fillStyle = grad(c, 0, cyT, 0, cyB, [gray(3), gray(1), gray(4)]);
    c.fillRect(cx0 + W * 0.03, cyT + H * 0.012, (cx1 - cx0) - W * 0.06, cyB - cyT - H * 0.03);
    /* back rail */
    c.fillStyle = gray(30);
    c.fillRect(cx0 + W * 0.025, cyT, (cx1 - cx0) - W * 0.05, H * 0.016);
    /* headboard (left panel) */
    c.fillStyle = grad(c, cx0, cyT, cx0, cyB, [gray(26), gray(14)]);
    rrect(c, cx0, cyT - H * 0.035, W * 0.055, (cyB - cyT) + H * 0.05, 4);
    c.fill();
    /* footboard */
    c.fillStyle = grad(c, cx1 - W * 0.055, cyT, cx1, cyB, [gray(22), gray(12)]);
    rrect(c, cx1 - W * 0.055, cyT - H * 0.028, W * 0.055, (cyB - cyT) + H * 0.045, 4);
    c.fill();
    /* bars */
    var bars = 9, bx0 = cx0 + W * 0.055, bw = (cx1 - cx0) - W * 0.11;
    for (i = 0; i < bars; i++) {
      var bx = bx0 + bw * (i / (bars - 1));
      c.fillStyle = grad(c, 0, cyT, 0, cyB, [gray(64, 0.85), gray(34, 0.9), gray(26, 0.9)]);
      c.fillRect(bx - 1, cyT + H * 0.012, 2.1, (cyB - cyT) - H * 0.03);
    }
    /* top rail of the front side */
    c.fillStyle = grad(c, 0, cyT, 0, cyT + H * 0.02, [gray(58), gray(26)]);
    c.fillRect(bx0 - W * 0.008, cyT + H * 0.004, bw + W * 0.016, H * 0.019);
    /* bottom rail */
    c.fillStyle = gray(20);
    c.fillRect(bx0 - W * 0.008, cyB - H * 0.022, bw + W * 0.016, H * 0.018);
    /* mattress hint below the bars */
    c.fillStyle = gray(9);
    c.fillRect(cx0 + W * 0.02, cyB - H * 0.032, (cx1 - cx0) - W * 0.04, H * 0.014);
    /* legs */
    c.fillStyle = gray(8);
    c.fillRect(cx0 + W * 0.012, cyB - H * 0.004, 3, H * 0.035);
    c.fillRect(cx1 - W * 0.02, cyB - H * 0.004, 3, H * 0.035);

    /* mobile stand */
    var mx = W * 0.462;
    c.fillStyle = gray(15);
    c.fillRect(mx - 1.2, H * 0.195, 2.4, H * 0.365);
    c.fillStyle = gray(22);
    c.fillRect(mx - W * 0.004, H * 0.192, W * 0.008, 2);

    /* rug */
    poly(c, [
      [W * 0.16, H * 0.845], [W * 0.62, H * 0.83],
      [W * 0.80, H * 1.02], [W * 0.02, H * 1.02]
    ], gray(26, 0.35));

    tintScene(c, W, H, ir);

    /* window cool glow */
    c.save();
    c.globalCompositeOperation = 'lighter';
    c.fillStyle = radGrad(c, (wx0 + wx1) / 2, (wy0 + wy1) / 2, 0, W * 0.26, [
      coolCol(ir, 0.16), coolCol(ir, 0)
    ]);
    c.fillRect(wx0 - W * 0.28, wy0 - W * 0.28, W * 0.62, W * 0.62);
    /* nightlight */
    var nx = W * NUR.night.x, ny = H * NUR.night.y;
    c.fillStyle = radGrad(c, nx, ny, 0, H * 0.20, [
      lampCol(ir, 0.30), lampCol(ir, 0.07), lampCol(ir, 0)
    ]);
    c.fillRect(nx - H * 0.21, ny - H * 0.21, H * 0.42, H * 0.42);
    c.restore();

    /* nightlight body */
    c.fillStyle = gray(30);
    rrect(c, W * NUR.night.x - 3.5, H * NUR.night.y - 5, 7, 10, 2);
    c.fill();
    c.fillStyle = lampCol(ir, 0.75);
    c.fillRect(W * NUR.night.x - 2, H * NUR.night.y - 3.5, 4, 4);
  }

  function nurseryAnim(c, W, H, t, o) {
    var nx = W * NUR.night.x, ny = H * NUR.night.y;
    var f = 0.8 + 0.2 * vnoise(t * 1.1 + 7.3);
    if (!o.reduce && hash1(Math.floor(t * 2.3) + 41) > 0.90) f *= 0.6;
    c.save();
    c.globalCompositeOperation = 'lighter';
    c.fillStyle = radGrad(c, nx, ny, 0, H * 0.21, [
      lampCol(o.ir, 0.22 * f), lampCol(o.ir, 0.05 * f), lampCol(o.ir, 0)
    ]);
    c.fillRect(nx - H * 0.22, ny - H * 0.22, H * 0.44, H * 0.44);

    /* mobile: hanging arm swings gently */
    var ax = W * 0.285, ay = H * 0.198;
    var ang = Math.sin(t * 0.62) * 0.055 + 0.015;
    c.translate(ax, ay);
    c.rotate(ang);
    c.globalCompositeOperation = 'source-over';
    /* arm bar */
    c.fillStyle = gray(18);
    c.fillRect(-W * 0.005, -1.2, W * 0.19, 2.2);
    var items = [{ dx: 0.045, len: 0.085 }, { dx: 0.10, len: 0.062 }, { dx: 0.155, len: 0.098 }];
    for (var i = 0; i < items.length; i++) {
      var it = items[i], x = W * it.dx, y = H * it.len;
      c.strokeStyle = gray(52, 0.45);
      c.lineWidth = 1;
      c.beginPath();
      c.moveTo(x, 0);
      c.lineTo(x, y);
      c.stroke();
      /* little hanging shapes: star / crescent / bird */
      c.fillStyle = gray(30);
      if (i === 0) {
        c.beginPath();
        c.moveTo(x, y);
        c.lineTo(x + 3, y + 6);
        c.lineTo(x - 3, y + 6);
        c.closePath();
        c.fill();
      } else if (i === 1) {
        c.beginPath();
        c.arc(x, y + 4, 3.6, 0.5, TAU - 0.5);
        c.fill();
      } else {
        c.beginPath();
        c.ellipse(x, y + 4, 3.4, 2.2, 0.2, 0, TAU);
        c.fill();
      }
    }
    c.restore();
    /* soft dust of light near the crib */
    c.save();
    c.globalCompositeOperation = 'lighter';
    c.fillStyle = coolCol(o.ir, 0.04 + 0.02 * vnoise(t * 0.8));
    c.fillRect(W * 0.06, H * 0.30, W * 0.32, H * 0.28);
    c.restore();
  }

  /* ================================================================== *
   * ROOM: door — porch seen through the door lens
   * ================================================================== */
  var DOOR = {
    horizon: 0.425, deckY: 0.575, step1: 0.775, step2: 0.875,
    light: { x: 0.705, y: 0.085 }
  };

  function doorBg(c, W, H, o) {
    var rng = o.rng, ir = o.ir, i;
    var hy = H * DOOR.horizon, dy = H * DOOR.deckY;

    /* sky */
    c.fillStyle = grad(c, 0, 0, 0, hy, [gray(4), gray(11), gray(20)]);
    c.fillRect(0, 0, W, hy + 2);
    /* faint clouds */
    c.save();
    for (i = 0; i < 4; i++) {
      var cx = rng() * W, cy = hy * (0.18 + rng() * 0.5);
      c.fillStyle = gray(70, 0.05 + rng() * 0.04);
      c.beginPath();
      c.ellipse(cx, cy, W * (0.14 + rng() * 0.16), H * (0.02 + rng() * 0.03), 0, 0, TAU);
      c.fill();
    }
    c.restore();
    /* moon haze behind trees */
    c.fillStyle = radGrad(c, W * 0.70, hy * 0.35, 0, W * 0.16, [gray(120, 0.10), gray(90, 0.03), gray(80, 0)]);
    c.fillRect(W * 0.52, 0, W * 0.38, hy);

    /* ground behind the porch */
    c.fillStyle = grad(c, 0, hy, 0, dy, [gray(9), gray(6)]);
    c.fillRect(0, hy, W, dy - hy);

    /* treeline */
    c.fillStyle = gray(3);
    c.beginPath();
    c.moveTo(0, hy);
    var n = 16;
    for (i = 0; i <= n; i++) {
      var tx = (i / n) * W;
      var th = hy - H * (0.03 + rng() * 0.115);
      c.lineTo(tx, th);
    }
    c.lineTo(W, hy);
    c.lineTo(W, hy + 6);
    c.lineTo(0, hy + 6);
    c.closePath();
    c.fill();
    /* a few taller trunks */
    c.fillStyle = gray(2);
    for (i = 0; i < 4; i++) {
      var tx2 = W * (0.06 + rng() * 0.88);
      c.fillRect(tx2 - 1, hy - H * (0.10 + rng() * 0.10), 2.4, H * 0.16);
    }

    /* fog band above the lawn */
    c.fillStyle = grad(c, 0, hy - H * 0.02, 0, hy + H * 0.09, [
      'rgba(120,140,150,0)', 'rgba(120,140,150,0.10)', 'rgba(120,140,150,0)'
    ]);
    c.fillRect(0, hy - H * 0.02, W, H * 0.11);

    /* porch deck */
    c.fillStyle = grad(c, 0, dy, 0, H, [gray(13), gray(19), gray(14)]);
    c.fillRect(0, dy, W, H - dy);
    /* planks: perspective seams */
    var seams = [0.612, 0.648, 0.688, 0.733, 0.782, 0.84, 0.905, 0.975];
    for (i = 0; i < seams.length; i++) {
      var yy = H * seams[i];
      line(c, 0, yy, W, yy, gray(4, 0.75), 1.6);
      line(c, 0, yy + 1.4, W, yy + 1.4, gray(70, 0.10), 1);
    }
    /* plank end joints */
    for (i = 0; i < 7; i++) {
      var jx = W * (0.08 + rng() * 0.86), jy = H * (0.60 + rng() * 0.35);
      line(c, jx, jy, jx, jy + H * 0.03, gray(0, 0.5), 1.2);
    }

    /* railing (right side) */
    c.fillStyle = gray(6);
    c.fillRect(W * 0.845, H * 0.415, W * 0.022, H * 0.30);
    c.fillRect(W * 0.955, H * 0.395, W * 0.028, H * 0.34);
    line(c, W * 0.845, H * 0.455, W * 0.965, H * 0.44, gray(30, 0.55), 3);
    line(c, W * 0.845, H * 0.60, W * 0.965, H * 0.595, gray(22, 0.4), 2);
    for (i = 0; i < 4; i++) {
      var bxs = W * (0.868 + i * 0.021);
      line(c, bxs, H * 0.455, bxs, H * 0.60, gray(26, 0.45), 1.6);
    }
    /* left short rail */
    c.fillStyle = gray(5);
    c.fillRect(W * 0.012, H * 0.44, W * 0.018, H * 0.26);
    line(c, W * 0.012, H * 0.475, W * 0.10, H * 0.462, gray(20, 0.35), 2);

    /* steps */
    var s1 = H * DOOR.step1, s2 = H * DOOR.step2;
    poly(c, [[0, s1], [W, s1 - H * 0.008], [W, s1 + H * 0.026], [0, s1 + H * 0.034]], gray(24));
    line(c, 0, s1, W, s1 - H * 0.008, gray(74, 0.35), 2.5);
    c.fillStyle = gray(7);
    c.fillRect(0, s1 + H * 0.028, W, s2 - s1 - H * 0.02);
    poly(c, [[0, s2], [W, s2 - H * 0.008], [W, H], [0, H]], gray(19));
    line(c, 0, s2, W, s2 - H * 0.008, gray(58, 0.3), 2.2);

    /* doormat */
    poly(c, [
      [W * 0.28, H * 0.80], [W * 0.72, H * 0.795],
      [W * 0.78, H * 0.905], [W * 0.22, H * 0.912]
    ], gray(7, 0.9));
    c.strokeStyle = gray(44, 0.22);
    c.lineWidth = 1;
    c.stroke();

    /* door jambs at the frame edge */
    c.fillStyle = gray(3);
    c.fillRect(0, 0, W * 0.022, H);
    c.fillRect(W * 0.978, 0, W * 0.022, H);
    c.fillStyle = gray(2);
    c.fillRect(0, 0, W, H * 0.012);

    tintScene(c, W, H, ir);

    /* porch light */
    var lx = W * DOOR.light.x, ly = H * DOOR.light.y;
    c.save();
    c.globalCompositeOperation = 'lighter';
    c.fillStyle = radGrad(c, lx, ly, 0, W * 0.34, [
      lampCol(ir, 0.50), lampCol(ir, 0.16), lampCol(ir, 0.03), lampCol(ir, 0)
    ]);
    c.fillRect(lx - W * 0.35, ly - W * 0.35, W * 0.70, W * 0.70);
    /* cone onto the deck */
    c.beginPath();
    c.moveTo(lx - 4, ly + 6);
    c.lineTo(lx + 5, ly + 6);
    c.lineTo(W * 0.92, H * 0.80);
    c.lineTo(W * 0.20, H * 0.80);
    c.closePath();
    c.fillStyle = grad(c, lx, ly, lx, H * 0.8, [lampCol(ir, 0.13), lampCol(ir, 0.03), lampCol(ir, 0)]);
    c.fill();
    c.restore();
    /* fixture */
    c.fillStyle = gray(20);
    c.fillRect(lx - 4.5, ly - 5, 9, 3);
    c.fillStyle = lampCol(ir, 0.85);
    c.beginPath();
    c.ellipse(lx, ly + 1.5, 3.4, 4.2, 0, 0, TAU);
    c.fill();

    /* door-lens barrel darkening (fisheye hint) */
    c.fillStyle = radGrad(c, W * 0.5, H * 0.5, H * 0.42, H * 0.92, [
      'rgba(0,0,0,0)', 'rgba(0,0,0,0.45)', 'rgba(0,0,0,0.8)'
    ]);
    c.fillRect(0, 0, W, H);
  }

  function doorAnim(c, W, H, t, o) {
    var lx = W * DOOR.light.x, ly = H * DOOR.light.y;
    var f = 0.82 + 0.18 * vnoise(t * 2.0 + 1.7);
    if (!o.reduce && hash1(Math.floor(t * 4.4) + 13) > 0.905) f *= 0.35;
    c.save();
    c.globalCompositeOperation = 'lighter';
    c.fillStyle = radGrad(c, lx, ly, 0, W * 0.30, [
      lampCol(o.ir, 0.16 * f), lampCol(o.ir, 0.03 * f), lampCol(o.ir, 0)
    ]);
    c.fillRect(lx - W * 0.31, ly - W * 0.31, W * 0.62, W * 0.62);
    c.restore();

    /* drizzle */
    if (!o.reduce) {
      c.save();
      c.globalCompositeOperation = 'lighter';
      for (var i = 0; i < 18; i++) {
        var px = hash1(i * 3.1) * W;
        var spd = 0.5 + hash1(i * 7.7) * 0.9;
        var py = ((hash1(i * 5.3) + t * 0.06 * spd) % 1) * H;
        var len = H * (0.02 + hash1(i * 9.1) * 0.03);
        c.strokeStyle = lampCol(o.ir, 0.10 + 0.05 * hash1(i * 2.2));
        c.lineWidth = 0.9;
        c.beginPath();
        c.moveTo(px, py);
        c.lineTo(px - 1.2, py + len);
        c.stroke();
      }
      c.restore();
    }

    /* slow fog drift */
    c.save();
    c.globalCompositeOperation = 'lighter';
    var fx = (t * 3) % W;
    c.fillStyle = grad(c, 0, 0, 0, H, ['rgba(110,130,140,0)', 'rgba(110,130,140,0.05)', 'rgba(110,130,140,0)']);
    c.fillRect(0, H * 0.40 + Math.sin(t * 0.2) * 3, W, H * 0.10);
    c.restore();
  }

  var ROOMS = {
    hall: { bg: hallBg, anim: hallAnim },
    living: { bg: livingBg, anim: livingAnim },
    nursery: { bg: nurseryBg, anim: nurseryAnim },
    door: { bg: doorBg, anim: doorAnim }
  };

  /* ================================================================== *
   * THE FIGURE
   * ================================================================== */
  var ANCH = {
    living: [
      [0.720, 0.618, 30], [0.640, 0.655, 42], [0.712, 0.720, 58],
      [0.548, 0.845, 87], [0.455, 0.992, 125]
    ],
    nursery: [
      [0.620, 0.622, 28], [0.718, 0.652, 40], [0.566, 0.712, 56],
      [0.672, 0.830, 82], [0.420, 0.995, 121]
    ],
    door: [
      [0.470, 0.600, 26], [0.600, 0.626, 38], [0.398, 0.676, 54],
      [0.560, 0.800, 80], [0.660, 0.972, 117]
    ]
  };
  var HALL_Z = [9.6, 7.2, 5.2, 3.7, 2.9];
  var HALL_X = [0.16, -0.34, 0.30, -0.44, 0.34];

  function levelOf(th) {
    if (th < 0.02) return -1;
    if (th >= 0.85) return LEVELS;      /* close-up */
    return Math.min(LEVELS - 1, Math.floor((th - 0.02) / 0.168));
  }

  /* one humanoid silhouette in unit space: feet y=0, head near y=-1 */
  function bodySilhouette(c, colour) {
    c.fillStyle = colour;

    /* torso */
    ribbon(c, [
      [0.000, -0.470, 0.156],
      [0.000, -0.560, 0.132],
      [0.005, -0.640, 0.140],
      [0.009, -0.714, 0.174],
      [0.011, -0.778, 0.204]
    ]);
    c.fill();

    /* legs — long, thin, asymmetric */
    ribbon(c, [
      [-0.037, -0.470, 0.078],
      [-0.044, -0.330, 0.062],
      [-0.041, -0.170, 0.052],
      [-0.031, -0.020, 0.044]
    ]);
    c.fill();
    ribbon(c, [
      [0.040, -0.465, 0.080],
      [0.052, -0.330, 0.064],
      [0.050, -0.170, 0.054],
      [0.040, -0.020, 0.046]
    ]);
    c.fill();
    c.beginPath();
    c.ellipse(-0.036, -0.008, 0.040, 0.013, 0.05, 0, TAU);
    c.fill();
    c.beginPath();
    c.ellipse(0.041, -0.008, 0.042, 0.013, -0.04, 0, TAU);
    c.fill();

    /* arms — too long, hands below the hips */
    ribbon(c, [
      [-0.100, -0.776, 0.062],
      [-0.130, -0.668, 0.054],
      [-0.140, -0.560, 0.048],
      [-0.133, -0.450, 0.042],
      [-0.118, -0.350, 0.036],
      [-0.106, -0.286, 0.032]
    ]);
    c.fill();
    ribbon(c, [
      [0.101, -0.778, 0.062],
      [0.129, -0.672, 0.054],
      [0.141, -0.566, 0.048],
      [0.147, -0.462, 0.040],
      [0.138, -0.366, 0.034],
      [0.127, -0.300, 0.030]
    ]);
    c.fill();
    /* slight bend on the right hand */
    c.beginPath();
    c.ellipse(0.122, -0.286, 0.024, 0.030, 0.2, 0, TAU);
    c.fill();

    /* neck */
    ribbon(c, [
      [0.008, -0.776, 0.052],
      [0.012, -0.826, 0.046]
    ]);
    c.fill();

    /* head (slightly tilted) */
    c.save();
    c.translate(0.013, -0.878);
    c.rotate(0.155);
    c.beginPath();
    c.ellipse(0, 0, 0.049, 0.060, 0, 0, TAU);
    c.fill();
    c.restore();

    /* hair mass — dark, falls past the shoulders */
    c.save();
    c.translate(0.013, -0.880);
    c.rotate(0.12);
    c.beginPath();
    c.ellipse(0.002, 0.002, 0.058, 0.071, 0.06, 0, TAU);
    c.fill();
    c.beginPath();
    c.moveTo(-0.052, -0.030);
    c.quadraticCurveTo(-0.082, 0.056, -0.050, 0.146);
    c.quadraticCurveTo(-0.026, 0.120, -0.028, 0.034);
    c.closePath();
    c.fill();
    c.beginPath();
    c.moveTo(0.054, -0.026);
    c.quadraticCurveTo(0.082, 0.052, 0.052, 0.132);
    c.quadraticCurveTo(0.028, 0.108, 0.030, 0.030);
    c.closePath();
    c.fill();
    c.restore();
  }

  /* interior volume: light wraps around the silhouette */
  function shadeSilhouette(c, W, H, box, strength) {
    c.save();
    c.globalCompositeOperation = 'source-atop';
    var cx = box.x + box.w * 0.36, cy = box.y + box.h * 0.10;
    c.fillStyle = radGrad(c, cx, cy, 0, Math.max(box.w, box.h) * 0.9, [
      rgba(46, 54, 56, strength), rgba(20, 25, 27, strength * 0.5), 'rgba(0,0,0,0)'
    ]);
    c.fillRect(box.x - 4, box.y - 4, box.w + 8, box.h + 8);
    /* slightly cooler shadow at the bottom */
    c.fillStyle = grad(c, 0, box.y + box.h * 0.5, 0, box.y + box.h, [
      'rgba(0,0,0,0)', 'rgba(0,0,0,0.35)'
    ]);
    c.fillRect(box.x - 4, box.y - 4, box.w + 8, box.h + 8);
    c.restore();
  }

  /* ================================================================== *
   * Feed
   * ================================================================== */
  function Feed(canvas, opts) {
    if (!canvas || typeof canvas.getContext !== 'function') {
      throw new TypeError('Cameras.Feed: a canvas element is required');
    }
    var o = opts || {};

    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    if (!this.ctx) throw new Error('Cameras.Feed: 2d canvas context unavailable');

    this.room = ROOMS[o.room] ? o.room : 'hall';
    this.ir = !!o.ir;
    this.seed = (typeof o.seed === 'number' && isFinite(o.seed)) ? (o.seed | 0) : 1;
    this.label = typeof o.label === 'string' ? o.label : 'CAM';
    this.showClock = o.clock !== false;

    this.threat = 0;
    this.glitch = 0;
    this.paused = false;
    this.destroyed = false;

    /* internal size — established in _layout() */
    var aw = canvas.width || 480, ah = canvas.height || 320;
    this._initialW = aw;
    this._initialH = ah;
    this.W = 0;
    this.H = BASE_H;
    this._zero = false;
    this._cssPatched = false;

    this._elapsed = 0;
    this._lastTs = 0;
    this._lastDraw = -1e9;
    this._raf = 0;
    this._running = false;
    this._visible = true;
    this._prevLevel = -2;
    this._cutT = -99;
    this._errCount = 0;
    this._perf = 0;
    this._softOn = true;
    this._glitchSeed = (this.seed * 7919 + 104729) | 0;

    /* prefer reduced motion */
    this._mql = null;
    this.reduce = false;
    try {
      if (global.matchMedia) {
        this._mql = global.matchMedia('(prefers-reduced-motion: reduce)');
        this.reduce = !!this._mql.matches;
      }
    } catch (e) { /* ignore */ }

    /* noise tiles */
    this._noise = [];
    var nrng = mulberry32(this.seed * 977 + 12345);
    this._noise.push(makeNoise(nrng, 180, 120, 850));
    this._noise.push(makeNoise(nrng, 180, 120, 620));

    /* scanline pattern */
    this._scan = makeScanlines();
    this._scanPat = this.ctx.createPattern(this._scan, 'repeat');

    this._onVis = this._handleVisibility.bind(this);
    this._onResize = this._handleWindowResize.bind(this);
    this._onMq = this._handleMq.bind(this);

    /* CSS: the canvas fills its parent box */
    try {
      if (canvas.style) {
        canvas.style.display = 'block';
      }
    } catch (e) { /* ignore */ }

    this._layout(true);
    this._observe();
    doc.addEventListener('visibilitychange', this._onVis, false);
    if (this._mql) {
      if (this._mql.addEventListener) this._mql.addEventListener('change', this._onMq);
      else if (this._mql.addListener) this._mql.addListener(this._onMq);
    }
    this._start();
  }

  /* ------------------------------------------------------------------ */
  Feed.prototype._measure = function () {
    var el = this.canvas;
    var w = 0, h = 0;
    if (el.getBoundingClientRect) {
      var r = el.getBoundingClientRect();
      w = r.width; h = r.height;
    }
    if ((!w || !h) && el.clientWidth) { w = el.clientWidth; h = el.clientHeight; }
    return { w: w, h: h };
  };

  Feed.prototype._layout = function (force) {
    if (this.destroyed) return;
    var el = this.canvas, m = this._measure(), w = m.w, h = m.h;

    /* If the canvas has no CSS sizing at all, let it fill the parent box. */
    if ((!w || !h) && !this._cssPatched) {
      this._cssPatched = true;
      try {
        if (el.style) {
          if (!el.style.width) el.style.width = '100%';
          if (!el.style.height) el.style.height = '100%';
        }
      } catch (e) { /* ignore */ }
      m = this._measure(); w = m.w; h = m.h;
      /* still nothing? fall back to the original pixel size */
      if ((!w || !h) && el.style) {
        try {
          el.style.width = this._initialW + 'px';
          el.style.height = this._initialH + 'px';
        } catch (e) { /* ignore */ }
        m = this._measure(); w = m.w; h = m.h;
      }
    }

    var zero = !(w > 4 && h > 4);
    var W, H2 = BASE_H;
    if (zero) {
      W = this.W || 360;
    } else {
      W = clamp(Math.round(H2 * (w / h)), MIN_W, MAX_W);
    }
    this._zero = zero;

    if (!force && W === this.W && H2 === this.H) return;
    this.W = W;
    this.H = H2;
    el.width = W;
    el.height = H2;

    this._buildSurfaces();

    if (this.paused) this._render();
  };

  Feed.prototype._buildSurfaces = function () {
    var W = this.W, H = this.H;

    this.frame = mkCanvas(W, H);
    this.fctx = this.frame.getContext('2d');

    this.soft = mkCanvas(W, H);
    this.sctx = this.soft.getContext('2d');
    if (!('filter' in this.sctx)) this._softOn = false;

    this.fig = mkCanvas(W, H);
    this.figx = this.fig.getContext('2d');

    this.bg = mkCanvas(W, H);
    var bx = this.bg.getContext('2d');
    var o = { rng: seeded(this.seed, this.room), ir: this.ir, W: W, H: H };
    ROOMS[this.room].bg(bx, W, H, o);

    this._buildVignette();

    this._scanPat = this.ctx.createPattern(this._scan, 'repeat');
  };

  Feed.prototype._buildVignette = function () {
    var W = this.W, H = this.H;
    var cv = mkCanvas(W, H), c = cv.getContext('2d');
    var extra = this.room === 'door' ? 0.06 : 0;
    var g = c.createRadialGradient(W * 0.5, H * 0.47, Math.min(W, H) * 0.16,
      W * 0.5, H * 0.5, Math.max(W, H) * 0.70);
    g.addColorStop(0, 'rgba(0,0,0,0)');
    g.addColorStop(0.42, 'rgba(0,0,0,' + (0.10 + extra).toFixed(3) + ')');
    g.addColorStop(0.72, 'rgba(0,0,0,' + (0.50 + extra).toFixed(3) + ')');
    g.addColorStop(1, 'rgba(0,0,0,0.94)');
    c.fillStyle = g;
    c.fillRect(0, 0, W, H);
    /* corner wedges */
    var i, corners = [[0, 0], [W, 0], [0, H], [W, H]];
    for (i = 0; i < corners.length; i++) {
      var x = corners[i][0], y = corners[i][1];
      var cg = c.createRadialGradient(x, y, 0, x, y, Math.min(W, H) * 0.55);
      cg.addColorStop(0, 'rgba(0,0,0,0.55)');
      cg.addColorStop(1, 'rgba(0,0,0,0)');
      c.fillStyle = cg;
      c.fillRect(0, 0, W, H);
    }
    this.vig = cv;
  };

  /* ------------------------------------------------------------------ */
  Feed.prototype._observe = function () {
    var self = this;
    if (global.IntersectionObserver) {
      this._io = new IntersectionObserver(function (entries) {
        for (var i = 0; i < entries.length; i++) {
          var e = entries[i];
          if (e.target !== self.canvas) continue;
          self._visible = e.isIntersecting && (e.intersectionRatio > 0.001 || !e.boundingClientRect || e.boundingClientRect.height > 0);
        }
        if (self._visible) self._start(); else self._stop();
      }, { threshold: [0, 0.01, 0.2] });
      try { this._io.observe(this.canvas); } catch (e) { /* ignore */ }
    }
    if (global.ResizeObserver) {
      this._ro = new ResizeObserver(function () { self._layout(false); });
      try { this._ro.observe(this.canvas); } catch (e) { /* ignore */ }
    } else {
      global.addEventListener('resize', this._onResize, false);
      global.addEventListener('orientationchange', this._onResize, false);
    }
  };

  Feed.prototype._handleWindowResize = function () { this._layout(false); };

  Feed.prototype._handleVisibility = function () {
    if (doc.hidden) this._stop();
    else if (this._visible && !this.paused) this._start();
  };

  Feed.prototype._handleMq = function (e) { this.reduce = !!(e && e.matches); };

  /* ------------------------------------------------------------------ */
  Feed.prototype._start = function () {
    if (this._running || this.destroyed || this.paused) return;
    if (!this._visible) return;
    if (typeof global.requestAnimationFrame !== 'function') return;
    var self = this;
    this._running = true;
    this._lastTs = 0;
    var step = function (ts) {
      if (!self._running || self.destroyed) return;
      self._raf = global.requestAnimationFrame(step);
      self._tick(ts);
    };
    this._raf = global.requestAnimationFrame(step);
  };

  Feed.prototype._stop = function () {
    this._running = false;
    if (this._raf) {
      try { global.cancelAnimationFrame(this._raf); } catch (e) { /* ignore */ }
      this._raf = 0;
    }
  };

  Feed.prototype._tick = function (ts) {
    if (this.destroyed) { this._stop(); return; }
    if (!this._lastTs) this._lastTs = ts;
    var dt = (ts - this._lastTs) / 1000;
    this._lastTs = ts;
    if (dt < 0) dt = 0;
    if (dt > 0.25) dt = 0.25;
    this._elapsed += dt;

    if (ts - this._lastDraw < FRAME_MS - 1.2) return;
    if (this._zero || !this.canvas.isConnected) return;

    this._lastDraw = ts;
    this._render();
  };

  Feed.prototype._render = function () {
    if (this.destroyed) return;
    if (!this.frame || this._zero) return;
    var t = this._elapsed, t0 = (global.performance && performance.now) ? performance.now() : 0;
    try {
      this._drawFrame(t);
      this._composite(t);
      this._errCount = 0;
    } catch (err) {
      this._errCount++;
      if (this._errCount > 4) {
        this._stop();
        if (global.console && console.warn) console.warn('Cameras.Feed: rendering stopped after repeated errors', err);
      }
      return;
    }
    if (t0) {
      var dur = performance.now() - t0;
      this._perf = this._perf * 0.9 + dur * 0.1;
      if (this._softOn && this._perf > 15) this._softOn = false;
    }
  };

  /* ------------------------------------------------------------------ */
  Feed.prototype._drawFrame = function (t) {
    var f = this.fctx, W = this.W, H = this.H;
    f.setTransform(1, 0, 0, 1, 0, 0);
    f.globalAlpha = 1;
    f.globalCompositeOperation = 'source-over';
    f.filter = 'none';
    f.drawImage(this.bg, 0, 0);

    ROOMS[this.room].anim(f, W, H, t, { ir: this.ir, reduce: this.reduce });

    this._drawFigure(t);

    /* sensor noise */
    this._drawNoise(t, f);
    /* exposure / white balance drift */
    this._drawGrade(t, f);
    /* lens vignette */
    f.drawImage(this.vig, 0, 0);
  };

  Feed.prototype._drawNoise = function (t, f) {
    var W = this.W, H = this.H;
    var nf = this.reduce ? 0.45 : 1;
    var n1 = this._noise[0], n2 = this._noise[1];
    var ox = (this._rnd() * 180) | 0, oy = (this._rnd() * 120) | 0;
    var ox2 = (this._rnd() * 180) | 0, oy2 = (this._rnd() * 120) | 0;
    var i, j;
    f.save();
    f.globalCompositeOperation = 'lighter';
    f.globalAlpha = (0.075 + this.glitch * 0.03) * nf;
    for (i = -oy; i < H; i += 120) {
      for (j = -ox; j < W; j += 180) {
        f.drawImage(n1, j, i);
      }
    }
    f.globalAlpha = 0.045 * nf;
    for (i = -oy2; i < H; i += 120) {
      for (j = -ox2; j < W; j += 180) {
        f.drawImage(n2, j, i);
      }
    }
    /* occasional hot pixels */
    if (!this.reduce) {
      f.globalAlpha = 0.16;
      for (i = 0; i < 4; i++) {
        f.fillStyle = gray(150 + this._rnd() * 105);
        f.fillRect((this._rnd() * W) | 0, (this._rnd() * H) | 0, 1, 1);
      }
    }
    /* rolling scan bar */
    if (!this.reduce) {
      var by = ((t * 0.11) % 1) * (H + 90) - 45;
      f.globalAlpha = 0.5;
      f.fillStyle = grad(f, 0, by, 0, by + 46, [
        'rgba(96,116,104,0)', 'rgba(96,116,104,0.055)', 'rgba(96,116,104,0)'
      ]);
      f.fillRect(0, by, W, 46);
    }
    f.restore();
  };

  Feed.prototype._drawGrade = function (t, f) {
    var W = this.W, H = this.H;
    /* slow auto white-balance drift */
    var wb = Math.sin(t * 0.087 + this.seed * 0.7) * 0.5 + Math.sin(t * 0.031 + 1.3) * 0.5;
    f.save();
    f.globalCompositeOperation = 'lighter';
    if (wb > 0) {
      f.fillStyle = rgba(34, 17, 5, 0.30 * wb);
    } else {
      f.fillStyle = rgba(5, 13, 28, 0.30 * -wb);
    }
    f.fillRect(0, 0, W, H);
    f.restore();

    /* faint brightness flicker */
    if (!this.reduce) {
      var fl = vnoise(t * 7.3) - 0.5;
      if (fl > 0) {
        f.save();
        f.globalCompositeOperation = 'lighter';
        f.fillStyle = rgba(120, 130, 120, 0.035 * fl * 2);
        f.fillRect(0, 0, W, H);
        f.restore();
      } else {
        f.save();
        f.fillStyle = rgba(0, 0, 0, -fl * 0.09);
        f.fillRect(0, 0, W, H);
        f.restore();
      }
    }
  };

  /* ------------------------------------------------------------------ *
   * figure
   * ------------------------------------------------------------------ */
  Feed.prototype._anchor = function (level) {
    var W = this.W, H = this.H;
    if (this.room === 'hall') {
      var C = hallCam(W, H);
      var z = HALL_Z[level], xw = HALL_X[level];
      var p = C.P(xw, 0, z);
      return { x: p[0], footY: p[1], h: C.F * 1.74 / z, blur: [1.5, 1.25, 1.0, 0.82, 0.68][level] };
    }
    var a = ANCH[this.room] ? ANCH[this.room][level] : ANCH.living[level];
    return {
      x: a[0] * W, footY: a[1] * H, h: a[2] * (H / 240),
      blur: [1.6, 1.35, 1.05, 0.85, 0.7][level]
    };
  };

  Feed.prototype._drawFigure = function (t) {
    var th = this.threat;
    if (th <= 0.02) { this._figBox = null; return; }
    var W = this.W, H = this.H, fig = this.figx;
    var level = levelOf(th);
    if (level < 0) { this._figBox = null; return; }

    if (level !== this._prevLevel) {
      this._prevLevel = level;
      this._cutT = t;
    }
    var jolt = 0;
    if (t - this._cutT < 0.11 && !this.reduce) {
      jolt = (hash1(level * 17.3 + Math.floor(t * 90)) * 2 - 1) * 3;
    }

    fig.setTransform(1, 0, 0, 1, 0, 0);
    fig.globalAlpha = 1;
    fig.globalCompositeOperation = 'source-over';
    fig.filter = 'none';
    fig.clearRect(0, 0, W, H);

    var alpha = clamp((th - 0.02) / 0.07, 0, 1) * 0.94;
    var box;

    if (level >= LEVELS) {
      box = this._closeup(fig, t, th);
    } else {
      box = this._standing(fig, t, level, jolt);
    }
    this._figBox = box;
    if (!box) return;

    var f = this.fctx;
    f.save();
    /* faint backlight so the silhouette separates from a dark wall */
    f.globalCompositeOperation = 'lighter';
    f.fillStyle = radGrad(f, box.x + box.w * 0.5, box.y + box.h * 0.22,
      0, Math.max(box.w, box.h) * 1.05, [
        rgba(30, 36, 34, 0.16 * alpha), rgba(18, 22, 20, 0.05 * alpha), 'rgba(0,0,0,0)'
      ]);
    f.fillRect(box.x - box.w * 0.6, box.y - box.h * 0.5, box.w * 2.2, box.h * 2);
    f.restore();

    var blur = level >= LEVELS ? 0.75 : [1.6, 1.35, 1.05, 0.85, 0.7][level];
    f.save();
    f.globalAlpha = alpha;
    if (this._softOn && 'filter' in f) f.filter = 'blur(' + blur.toFixed(2) + 'px)';
    f.drawImage(this.fig, 0, 0);
    /* ghost double exposure while it moves */
    if (level >= 2 && !this.reduce) {
      f.globalAlpha = alpha * (0.12 + 0.10 * vnoise(t * 2.2));
      f.drawImage(this.fig, -1.5, 0.6);
    }
    f.filter = 'none';
    f.restore();
  };

  Feed.prototype._standing = function (fig, t, level, jolt) {
    var W = this.W, H = this.H;
    var a = this._anchor(level);
    var sway = this.reduce ? 0 : Math.sin(t * 0.62 + level * 2.3) * (0.8 + level * 0.35);
    var breathe = this.reduce ? 0 : Math.sin(t * 1.7 + level) * 0.004;
    var bx = a.x + sway + jolt;
    var by = a.footY;
    var s = a.h;

    fig.save();
    fig.translate(bx, by);
    fig.scale(s, s);
    fig.rotate(-0.012 - breathe * 0.2);
    var colour = this.ir ? 'rgba(3,7,4,0.99)' : 'rgba(4,6,7,0.99)';
    bodySilhouette(fig, colour);
    fig.restore();

    /* shade inside the silhouette (in pixel space now) */
    var box = { x: bx - s * 0.46, y: by - s * 1.06, w: s * 0.92, h: s * 1.12 };
    fig.save();
    fig.beginPath();
    fig.rect(box.x, box.y, box.w, box.h);
    fig.clip();
    shadeSilhouette(fig, W, H, { x: bx - s * 0.5, y: by - s, w: s, h: s }, 0.5);
    fig.restore();

    this._figPix = { s: s, bx: bx, by: by };
    return box;
  };

  Feed.prototype._closeup = function (fig, t, th) {
    var W = this.W, H = this.H;
    var cx = W * 0.515, cy = H * 0.615;
    var rx = W * 0.125, ry = H * 0.155;
    var tilt = -0.115;
    var dark = this.ir ? 'rgba(2,6,3,1)' : 'rgba(3,4,5,1)';

    fig.save();
    fig.fillStyle = dark;

    /* shoulders / upper chest */
    fig.beginPath();
    fig.moveTo(W * -0.22, H * 1.30);
    fig.quadraticCurveTo(W * 0.02, H * 0.965, W * 0.235, H * 0.895);
    fig.quadraticCurveTo(W * 0.34, H * 0.862, W * 0.44, H * 0.878);
    fig.quadraticCurveTo(W * 0.56, H * 0.892, W * 0.665, H * 0.868);
    fig.quadraticCurveTo(W * 0.80, H * 0.858, W * 0.925, H * 0.898);
    fig.quadraticCurveTo(W * 1.06, H * 0.955, W * 1.22, H * 1.30);
    fig.closePath();
    fig.fill();

    /* neck */
    fig.beginPath();
    fig.moveTo(cx - W * 0.062, cy + H * 0.10);
    fig.lineTo(cx - W * 0.052, cy + H * 0.235);
    fig.lineTo(cx + W * 0.06, cy + H * 0.245);
    fig.lineTo(cx + W * 0.072, cy + H * 0.10);
    fig.closePath();
    fig.fill();

    /* hair mass behind the head */
    fig.save();
    fig.translate(cx, cy - H * 0.005);
    fig.rotate(tilt);
    fig.beginPath();
    fig.ellipse(0, 0, rx * 1.42, ry * 1.22, 0, 0, TAU);
    fig.fill();
    /* long strands falling to the shoulders */
    fig.beginPath();
    fig.moveTo(-rx * 1.30, -ry * 0.30);
    fig.quadraticCurveTo(-rx * 1.85, ry * 0.85, -rx * 1.25, ry * 2.0);
    fig.quadraticCurveTo(-rx * 0.95, ry * 1.4, -rx * 0.98, ry * 0.35);
    fig.closePath();
    fig.fill();
    fig.beginPath();
    fig.moveTo(rx * 1.28, -ry * 0.26);
    fig.quadraticCurveTo(rx * 1.86, ry * 0.90, rx * 1.22, ry * 2.05);
    fig.quadraticCurveTo(rx * 0.94, ry * 1.45, rx * 0.96, ry * 0.32);
    fig.closePath();
    fig.fill();
    fig.restore();

    /* head */
    fig.save();
    fig.translate(cx, cy);
    fig.rotate(tilt);
    fig.beginPath();
    fig.ellipse(0, 0, rx, ry, 0, 0, TAU);
    fig.fill();
    /* jaw taper */
    fig.beginPath();
    fig.moveTo(-rx * 0.72, ry * 0.22);
    fig.quadraticCurveTo(-rx * 0.30, ry * 1.14, 0, ry * 1.16);
    fig.quadraticCurveTo(rx * 0.34, ry * 1.12, rx * 0.70, ry * 0.20);
    fig.quadraticCurveTo(0, ry * 0.62, -rx * 0.72, ry * 0.22);
    fig.fill();
    /* face plane, marginally lighter */
    fig.beginPath();
    fig.ellipse(0, ry * 0.06, rx * 0.80, ry * 0.86, 0, 0, TAU);
    fig.fillStyle = this.ir ? 'rgba(9,16,10,0.85)' : 'rgba(11,13,14,0.85)';
    fig.fill();
    fig.restore();

    /* one strand across the face */
    fig.save();
    fig.strokeStyle = this.ir ? 'rgba(2,5,3,0.9)' : 'rgba(3,4,4,0.9)';
    fig.lineWidth = 2.4;
    fig.beginPath();
    fig.moveTo(cx - rx * 0.55, cy - ry * 1.02);
    fig.quadraticCurveTo(cx - rx * 0.95, cy - ry * 0.05, cx - rx * 0.42, cy + ry * 1.02);
    fig.stroke();
    fig.restore();

    /* eye glints */
    var ga = clamp((th - 0.855) / 0.10, 0, 1);
    var flick = 0.78 + 0.22 * vnoise(t * 3.1);
    var cT = Math.cos(tilt), sT = Math.sin(tilt);
    function put(ex, ey) {
      var dx = ex - cx, dy = ey - cy;
      return [cx + dx * cT - dy * sT, cy + dx * sT + dy * cT];
    }
    var e1 = put(cx - W * 0.043, cy + H * 0.016);
    var e2 = put(cx + W * 0.040, cy + H * 0.006);

    fig.save();
    /* sockets */
    fig.fillStyle = 'rgba(0,0,0,0.62)';
    fig.beginPath();
    fig.ellipse(e1[0], e1[1], W * 0.028, H * 0.020, tilt, 0, TAU);
    fig.fill();
    fig.beginPath();
    fig.ellipse(e2[0], e2[1], W * 0.026, H * 0.019, tilt, 0, TAU);
    fig.fill();

    fig.globalCompositeOperation = 'lighter';
    var gl = ga * 0.85 * flick;
    for (var k = 0; k < 2; k++) {
      var p = k ? e2 : e1;
      var rr = k ? W * 0.026 : W * 0.028;
      fig.fillStyle = radGrad(fig, p[0], p[1], 0, rr, [
        rgba(214, 226, 206, 0.55 * gl), rgba(160, 180, 160, 0.16 * gl), 'rgba(0,0,0,0)'
      ]);
      fig.fillRect(p[0] - rr, p[1] - rr, rr * 2, rr * 2);
      fig.fillStyle = rgba(226, 236, 218, 0.85 * gl);
      fig.beginPath();
      fig.ellipse(p[0], p[1], W * 0.0085, H * 0.0058, tilt, 0, TAU);
      fig.fill();
    }
    fig.restore();

    fig.restore();

    this._figPix = { s: H * 0.9, bx: cx, by: H * 1.05 };
    return { x: W * 0.05, y: H * 0.34, w: W * 0.95, h: H * 0.72 };
  };

  /* ------------------------------------------------------------------ *
   * composite: glitch / overlay
   * ------------------------------------------------------------------ */
  Feed.prototype._composite = function (t) {
    var c = this.ctx, W = this.W, H = this.H;
    var g = this.glitch;

    /* lens softness pass */
    var src = this.frame;
    if (this._softOn && this.sctx) {
      var sc = this.sctx;
      sc.setTransform(1, 0, 0, 1, 0, 0);
      sc.globalCompositeOperation = 'source-over';
      sc.globalAlpha = 1;
      sc.clearRect(0, 0, W, H);
      sc.filter = 'blur(0.45px)';
      sc.drawImage(this.frame, 0, 0);
      sc.filter = 'none';
      src = this.soft;
    }

    c.setTransform(1, 0, 0, 1, 0, 0);
    c.globalCompositeOperation = 'source-over';
    c.globalAlpha = 1;
    c.filter = 'none';
    c.clearRect(0, 0, W, H);
    c.drawImage(src, 0, 0);

    if (g > 0.02) this._drawGlitch(c, src, t, g);

    this._drawOverlay(c, t);
  };

  Feed.prototype._drawGlitch = function (c, src, t, g) {
    var W = this.W, H = this.H;
    var k = this.reduce ? 0.55 : 1;
    var bands = Math.max(1, Math.round((1 + g * 7) * k));
    var i, y, hh, dx;

    c.save();
    for (i = 0; i < bands; i++) {
      y = this._rnd() * H;
      hh = 1 + this._rnd() * (3 + g * 20);
      dx = (this._rnd() * 2 - 1) * (3 + g * 62) * k;
      c.drawImage(src, 0, y, W, hh, dx, y, W, hh);
      /* chroma fringing at the tear boundary */
      if (g > 0.18) {
        c.globalAlpha = 0.20 * g;
        c.fillStyle = 'rgba(214,64,86,1)';
        c.fillRect(0, y - 1, W, 1);
        c.fillStyle = 'rgba(58,158,214,1)';
        c.fillRect(0, y + hh, W, 1);
        c.globalAlpha = 1;
      }
    }

    /* dropped scanline band */
    if (g > 0.25) {
      var dy = this._rnd() * H;
      var dh = 2 + this._rnd() * (2 + g * 7);
      c.fillStyle = 'rgba(2,4,4,' + (0.55 + 0.35 * g).toFixed(2) + ')';
      c.fillRect(0, dy, W, dh);
      c.fillStyle = 'rgba(90,110,98,' + (0.10 * g).toFixed(2) + ')';
      c.fillRect(0, dy - 1, W, 1);
      /* duplicated frame slice */
      if (g > 0.45 && this._rnd() > 0.45) {
        c.globalAlpha = 0.28 * g;
        c.drawImage(src, 0, 0, W, H, 0, (this._rnd() * 2 - 1) * 5, W, H);
        c.globalAlpha = 1;
      }
    }

    /* horizontal smear near the top of the frame */
    if (g > 0.55) {
      var sm = H * (0.02 + this._rnd() * 0.10);
      c.globalAlpha = 0.16 * g;
      c.drawImage(src, 0, 0, W, sm, (this._rnd() * 2 - 1) * 9, 0, W, sm);
      c.globalAlpha = 1;
    }
    c.restore();
  };

  Feed.prototype._drawOverlay = function (c, t) {
    var W = this.W, H = this.H;
    var k = clamp(W / 360, 0.8, 1.45);

    /* monitor scanlines */
    if (this._scanPat) {
      c.save();
      c.globalCompositeOperation = 'source-over';
      c.globalAlpha = 0.42;
      c.fillStyle = this._scanPat;
      c.fillRect(0, 0, W, H);
      c.restore();
    }

    if (!this.showClock) return;

    var g = this.glitch;
    var jx = g > 0.4 ? (hash1(Math.floor(t * 11) * 1.7) * 2 - 1) * g * 1.6 : 0;
    var jy = g > 0.4 ? (hash1(Math.floor(t * 11) * 2.3) * 2 - 1) * g * 1.2 : 0;

    c.save();
    c.translate(jx, jy);
    c.textBaseline = 'alphabetic';
    c.font = Math.round(8 * k) + 'px ui-monospace, "Courier New", monospace';

    /* REC blink (irregular) */
    var ph = Math.floor(t * 2.2);
    var on = hash1(ph * 3.7) > 0.24;
    if (on) {
      var drift = 0.55 + 0.25 * vnoise(t * 0.8);
      c.fillStyle = 'rgba(226,232,224,' + drift.toFixed(2) + ')';
      c.beginPath();
      c.arc(9 * k, 11 * k, 2.6 * k, 0, TAU);
      c.fill();
      c.fillText('REC', 15 * k, 14 * k);
    }

    /* IR badge */
    if (this.ir) {
      c.textAlign = 'right';
      c.fillStyle = 'rgba(206,222,208,0.45)';
      c.fillText('IR', W - 8 * k, 14 * k);
    }
    c.textAlign = 'left';

    /* label bottom-left */
    c.fillStyle = 'rgba(214,224,216,0.55)';
    c.font = Math.round(8.5 * k) + 'px ui-monospace, "Courier New", monospace';
    c.fillText(this.label, 9 * k, H - 8 * k);

    /* timestamp bottom-right */
    var d = new Date();
    var hh = pad2(d.getHours()), mm = pad2(d.getMinutes()), ss = pad2(d.getSeconds());
    var dateStr = d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
    var timeStr = hh + ':' + mm + ':' + ss;
    c.textAlign = 'right';
    c.font = Math.round(11 * k) + 'px ui-monospace, "Courier New", monospace';
    c.fillStyle = 'rgba(226,236,224,0.66)';
    c.fillText(timeStr, W - 9 * k, H - 7 * k);
    c.font = Math.round(7.5 * k) + 'px ui-monospace, "Courier New", monospace';
    c.fillStyle = 'rgba(206,216,208,0.40)';
    c.fillText(dateStr, W - 9 * k, H - 20 * k);
    c.textAlign = 'left';
    c.restore();
  };

  /* deterministic per-frame rng (visual noise only) */
  Feed.prototype._rnd = function () {
    this._glitchSeed = (Math.imul(this._glitchSeed, 1664525) + 1013904223) | 0;
    return ((this._glitchSeed >>> 8) & 0xffffff) / 0x1000000;
  };

  /* ------------------------------------------------------------------ *
   * public API
   * ------------------------------------------------------------------ */
  Feed.prototype.setThreat = function (v) {
    if (this.destroyed) return this;
    v = Number(v);
    if (!isFinite(v)) v = 0;
    this.threat = clamp(v, 0, 1);
    return this;
  };

  Feed.prototype.setGlitch = function (v) {
    if (this.destroyed) return this;
    v = Number(v);
    if (!isFinite(v)) v = 0;
    this.glitch = clamp(v, 0, 1);
    return this;
  };

  Feed.prototype.setPaused = function (p) {
    if (this.destroyed) return this;
    p = !!p;
    if (this.paused === p) return this;
    this.paused = p;
    if (p) this._stop();
    else this._start();
    return this;
  };

  Feed.prototype.resize = function () {
    if (this.destroyed) return this;
    this._layout(true);
    return this;
  };

  Feed.prototype.destroy = function () {
    if (this.destroyed) return;
    this.destroyed = true;
    this._stop();
    try { doc.removeEventListener('visibilitychange', this._onVis, false); } catch (e) { /* ignore */ }
    try {
      if (!global.ResizeObserver) {
        global.removeEventListener('resize', this._onResize, false);
        global.removeEventListener('orientationchange', this._onResize, false);
      }
    } catch (e) { /* ignore */ }
    try {
      if (this._mql) {
        if (this._mql.removeEventListener) this._mql.removeEventListener('change', this._onMq);
        else if (this._mql.removeListener) this._mql.removeListener(this._onMq);
      }
    } catch (e) { /* ignore */ }
    try { if (this._io) this._io.disconnect(); } catch (e) { /* ignore */ }
    try { if (this._ro) this._ro.disconnect(); } catch (e) { /* ignore */ }
    this._io = this._ro = null;
    this.fctx = this.sctx = this.figx = this.ctx = null;
    this.frame = this.soft = this.fig = this.bg = this.vig = null;
    this._noise = null;
    this._scanPat = null;
  };

  /* ------------------------------------------------------------------ *
   * noise / scanline generation
   * ------------------------------------------------------------------ */
  function makeNoise(rng, w, h, dots) {
    var cv = mkCanvas(w, h), c = cv.getContext('2d');
    var img = c.createImageData(w, h), d = img.data, i, idx;
    for (i = 0; i < dots; i++) {
      var x = (rng() * w) | 0, y = (rng() * h) | 0;
      idx = (y * w + x) * 4;
      var v = 70 + rng() * 185;
      d[idx] = v; d[idx + 1] = v; d[idx + 2] = v;
      d[idx + 3] = 20 + rng() * 135;
    }
    c.putImageData(img, 0, 0);
    return cv;
  }

  function makeScanlines() {
    var cv = mkCanvas(4, 4), c = cv.getContext('2d');
    c.clearRect(0, 0, 4, 4);
    c.fillStyle = 'rgba(0,0,0,0.30)';
    c.fillRect(0, 0, 4, 1);
    c.fillStyle = 'rgba(255,255,255,0.025)';
    c.fillRect(0, 2, 4, 1);
    return cv;
  }

  /* ------------------------------------------------------------------ *
   * export
   * ------------------------------------------------------------------ */
  var Cameras = global.Cameras || (global.Cameras = {});
  Cameras.Feed = Feed;
  Cameras.version = '1.0.0';

})(typeof window !== 'undefined' ? window : this);
