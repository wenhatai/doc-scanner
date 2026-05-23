var DocScanner = (function () {
  'use strict';

  function detectCorners(sourceCanvas) {
    if (typeof cv === 'undefined' || !cv.Mat) return null;

    var src = cv.imread(sourceCanvas);

    try {
      var result = tryDetect(src);
      return result;
    } finally {
      src.delete();
    }
  }

  function tryDetect(src) {
    var gray = new cv.Mat();
    cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);

    try {
      var configs = [
        { blur: 5, cannyLow: 30, cannyHigh: 100, approxEps: 0.015, minArea: 0.01, useMorph: false },
        { blur: 5, cannyLow: 40, cannyHigh: 120, approxEps: 0.02, minArea: 0.02, useMorph: false },
        { blur: 7, cannyLow: 20, cannyHigh: 80, approxEps: 0.03, minArea: 0.01, useMorph: true },
        { blur: 3, cannyLow: 50, cannyHigh: 150, approxEps: 0.02, minArea: 0.03, useMorph: false },
      ];

      for (var ci = 0; ci < configs.length; ci++) {
        var cfg = configs[ci];
        var result = detectWithConfig(gray, src.rows, src.cols, cfg);
        if (result) return result;
      }

      return null;
    } finally {
      gray.delete();
    }
  }

  function detectWithConfig(gray, rows, cols, cfg) {
    var blurred = new cv.Mat();
    var edges = new cv.Mat();
    var contours = new cv.MatVector();
    var hierarchy = new cv.Mat();

    try {
      var ksize = new cv.Size(cfg.blur, cfg.blur);
      cv.GaussianBlur(gray, blurred, ksize, 0);
      cv.Canny(blurred, edges, cfg.cannyLow, cfg.cannyHigh);

      if (cfg.useMorph) {
        var kernel = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(3, 3));
        cv.morphologyEx(edges, edges, cv.MORPH_CLOSE, kernel);
        kernel.delete();
      }

      cv.findContours(edges, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);

      var imageArea = rows * cols;
      var minArea = imageArea * cfg.minArea;
      var candidates = [];

      for (var i = 0; i < contours.size(); i++) {
        var contour = contours.get(i);
        var area = cv.contourArea(contour);
        if (area < minArea) continue;

        var peri = cv.arcLength(contour, true);

        var epsilons = [cfg.approxEps, cfg.approxEps * 0.5, cfg.approxEps * 1.5];
        for (var ei = 0; ei < epsilons.length; ei++) {
          var approx = new cv.Mat();
          cv.approxPolyDP(contour, approx, epsilons[ei] * peri, true);

          if (approx.rows === 4) {
            var pts = [];
            var isConvex = true;
            for (var j = 0; j < 4; j++) {
              pts.push({ x: approx.data32S[j * 2], y: approx.data32S[j * 2 + 1] });
            }

            if (!isReasonableQuad(pts, rows, cols)) {
              approx.delete();
              continue;
            }

            candidates.push({ area: area, points: pts, epsIdx: ei });
            approx.delete();
            break;
          }
          approx.delete();
        }
      }

      if (candidates.length === 0) return null;

      candidates.sort(function (a, b) { return b.area - a.area; });

      var best = candidates[0];
      return orderPoints(best.points);

    } finally {
      blurred.delete();
      edges.delete();
      contours.delete();
      hierarchy.delete();
    }
  }

  function isReasonableQuad(pts, rows, cols) {
    var centerX = cols / 2;
    var centerY = rows / 2;

    var quadCenterX = (pts[0].x + pts[1].x + pts[2].x + pts[3].x) / 4;
    var quadCenterY = (pts[0].y + pts[1].y + pts[2].y + pts[3].y) / 4;

    var dx = Math.abs(quadCenterX - centerX) / cols;
    var dy = Math.abs(quadCenterY - centerY) / rows;
    if (dx > 0.4 || dy > 0.4) return false;

    for (var i = 0; i < 4; i++) {
      var a = pts[i];
      var b = pts[(i + 1) % 4];
      var c = pts[(i + 2) % 4];

      var cross = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
      if (i === 0) var sign = cross > 0;
      else if ((cross > 0) !== sign) return false;
    }

    var sideLens = [];
    for (var i = 0; i < 4; i++) {
      sideLens.push(dist(pts[i], pts[(i + 1) % 4]));
    }
    var avgLen = sideLens.reduce(function (s, l) { return s + l; }, 0) / 4;
    for (var i = 0; i < 4; i++) {
      if (sideLens[i] < avgLen * 0.15) return false;
    }

    return true;
  }

  function orderPoints(pts) {
    var sorted = pts.slice().sort(function (a, b) { return (a.x + a.y) - (b.x + b.y); });
    var tl = sorted[0];
    var br = sorted[3];

    var remaining = [sorted[1], sorted[2]];
    remaining.sort(function (a, b) { return (b.x - b.y) - (a.x - a.y); });
    var tr = remaining[0];
    var bl = remaining[1];

    return [tl, tr, br, bl];
  }

  function detectAndCorrect(sourceCanvas) {
    if (typeof cv === 'undefined' || !cv.Mat) return null;

    var corners = detectCorners(sourceCanvas);
    if (!corners) return null;

    var src = cv.imread(sourceCanvas);
    try {
      var dst = perspectiveCorrect(src, corners);
      var resultCanvas = document.createElement('canvas');
      resultCanvas.width = dst.cols;
      resultCanvas.height = dst.rows;
      cv.imshow(resultCanvas, dst);
      dst.delete();

      return resultCanvas.toDataURL('image/jpeg', 0.92);
    } finally {
      src.delete();
    }
  }

  function perspectiveCorrect(src, corners) {
    var widthTop = dist(corners[0], corners[1]);
    var widthBottom = dist(corners[3], corners[2]);
    var maxWidth = Math.max(widthTop, widthBottom);

    var heightLeft = dist(corners[0], corners[3]);
    var heightRight = dist(corners[1], corners[2]);
    var maxHeight = Math.max(heightLeft, heightRight);

    var targetW = Math.round(maxWidth);
    var targetH = Math.round(maxHeight);

    var srcPts = cv.matFromArray(4, 1, cv.CV_32FC2, [
      corners[0].x, corners[0].y,
      corners[1].x, corners[1].y,
      corners[2].x, corners[2].y,
      corners[3].x, corners[3].y,
    ]);

    var dstPts = cv.matFromArray(4, 1, cv.CV_32FC2, [
      0, 0,
      targetW, 0,
      targetW, targetH,
      0, targetH,
    ]);

    var M = cv.getPerspectiveTransform(srcPts, dstPts);
    var dsize = new cv.Size(targetW, targetH);
    var dst = new cv.Mat();
    cv.warpPerspective(src, dst, M, dsize, cv.INTER_LINEAR, cv.BORDER_CONSTANT, new cv.Scalar());

    M.delete();
    srcPts.delete();
    dstPts.delete();

    return dst;
  }

  function dist(a, b) {
    return Math.sqrt((a.x - b.x) * (a.x - b.x) + (a.y - b.y) * (a.y - b.y));
  }

  return {
    detectCorners: detectCorners,
    detectAndCorrect: detectAndCorrect,
  };
})();
