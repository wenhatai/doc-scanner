var DocScanner = (function () {
  'use strict';

  function detectCorners(sourceCanvas) {
    if (typeof cv === 'undefined' || !cv.Mat) return null;

    var src = cv.imread(sourceCanvas);
    var gray = new cv.Mat();
    var blurred = new cv.Mat();
    var edges = new cv.Mat();
    var contours = new cv.MatVector();
    var hierarchy = new cv.Mat();

    try {
      cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
      var ksize = new cv.Size(5, 5);
      cv.GaussianBlur(gray, blurred, ksize, 0);
      cv.Canny(blurred, edges, 50, 150);

      cv.findContours(edges, contours, hierarchy, cv.RETR_LIST, cv.CHAIN_APPROX_SIMPLE);

      var maxArea = 0;
      var bestContour = null;

      for (var i = 0; i < contours.size(); i++) {
        var contour = contours.get(i);
        var area = cv.contourArea(contour);
        if (area > maxArea && area > (src.rows * src.cols * 0.05)) {
          var peri = cv.arcLength(contour, true);
          var approx = new cv.Mat();
          cv.approxPolyDP(contour, approx, 0.02 * peri, true);
          if (approx.rows === 4) {
            maxArea = area;
            if (bestContour) bestContour.delete();
            bestContour = approx;
          } else {
            approx.delete();
          }
        }
      }

      if (!bestContour) return null;

      var points = [];
      for (var j = 0; j < 4; j++) {
        points.push({
          x: bestContour.data32S[j * 2],
          y: bestContour.data32S[j * 2 + 1],
        });
      }
      bestContour.delete();

      return orderPoints(points);
    } finally {
      src.delete();
      gray.delete();
      blurred.delete();
      edges.delete();
      contours.delete();
      hierarchy.delete();
    }
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

    var ratio = maxWidth / maxHeight;
    var targetW, targetH;
    if (ratio > 0.65 && ratio < 0.75) {
      targetW = maxHeight * 0.7071;
      targetH = maxHeight;
    } else {
      targetW = maxWidth;
      targetH = maxHeight;
    }

    targetW = Math.round(targetW);
    targetH = Math.round(targetH);

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
