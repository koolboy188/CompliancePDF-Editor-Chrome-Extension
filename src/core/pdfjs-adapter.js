let pdfjsLibPromise;

async function loadPdfJs() {
  if (!pdfjsLibPromise) {
    pdfjsLibPromise = import("../../node_modules/pdfjs-dist/build/pdf.mjs").then((pdfjsLib) => {
      const workerUrl = chrome.runtime.getURL("node_modules/pdfjs-dist/build/pdf.worker.mjs");
      if (pdfjsLib.GlobalWorkerOptions?.workerSrc !== workerUrl) {
        pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl;
      }
      return pdfjsLib;
    });
  }
  return pdfjsLibPromise;
}

export async function loadPdfDocument(input) {
  const pdfjsLib = await loadPdfJs();
  const normalized = await normalizeInput(input);
  const task = pdfjsLib.getDocument(normalized);
  const doc = await task.promise;
  return doc;
}

export async function extractPageObjects(page, viewport) {
  const pdfjsLib = await loadPdfJs();
  const objects = [];

  try {
    const operatorList = await page.getOperatorList();
    objects.push(...extractObjectsFromOperators(operatorList, pdfjsLib, viewport));
  } catch (_) {
    // Ignore operator extraction errors and keep annotation extraction path.
  }

  try {
    const annotations = await page.getAnnotations({ intent: "display" });
    objects.push(...extractObjectsFromAnnotations(annotations, viewport));
  } catch (_) {
    // Ignore annotation extraction errors.
  }

  return refineDetectedObjects(objects, viewport);
}

export async function renderPdfPage(page, targetCanvas, scale = 1.25) {
  const viewport = page.getViewport({ scale });
  const context = targetCanvas.getContext("2d");

  targetCanvas.width = Math.floor(viewport.width);
  targetCanvas.height = Math.floor(viewport.height);
  targetCanvas.style.width = `${viewport.width}px`;
  targetCanvas.style.height = `${viewport.height}px`;

  await page.render({ canvasContext: context, viewport }).promise;
  return viewport;
}

export async function extractTextFragments(page, viewport) {
  const text = await page.getTextContent({
    normalizeWhitespace: true,
    disableCombineTextItems: false
  });
  return text.items.map((item, index) => {
    const angle = (Math.atan2(item.transform[1], item.transform[0]) * 180) / Math.PI;
    const normalizedFontName = normalizePdfFontName(item.fontName);
    const x = item.transform[4] * viewport.scale;
    const yBottom = item.transform[5] * viewport.scale;
    const fontHeight = Math.abs(item.height * viewport.scale);
    return {
      id: `frag-${index}`,
      text: String(item.str ?? "").normalize("NFC"),
      x,
      y: viewport.height - yBottom - fontHeight,
      width: item.width * viewport.scale,
      height: fontHeight,
      fontName: normalizedFontName,
      dir: item.dir ?? "ltr",
      hasUnicode: /[^\u0000-\u00ff]/.test(String(item.str ?? "")),
      angle
    };
  });
}

function normalizePdfFontName(fontName) {
  const source = String(fontName ?? "");
  // PDF subset fonts are usually prefixed like "ABCDEE+ArialMT".
  const plusIndex = source.indexOf("+");
  if (plusIndex > 0 && plusIndex < 10) {
    return source.slice(plusIndex + 1);
  }
  return source;
}

async function normalizeInput(input) {
  if (!input) {
    return { data: new Uint8Array() };
  }
  if (input instanceof ArrayBuffer) {
    return { data: input };
  }
  if (input instanceof Uint8Array) {
    return { data: input };
  }
  if (typeof input === "string") {
    if (input.startsWith("http://") || input.startsWith("https://") || input.startsWith("file://")) {
      return { url: input };
    }
    if (input.startsWith("blob:")) {
      const bytes = await fetch(input).then((r) => r.arrayBuffer());
      return { data: bytes };
    }
  }
  return input;
}

function extractObjectsFromOperators(operatorList, pdfjsLib, viewport) {
  const OPS = pdfjsLib.OPS;
  const fnArray = operatorList?.fnArray ?? [];
  const argsArray = operatorList?.argsArray ?? [];
  const objects = [];

  const stack = [];
  let ctm = [1, 0, 0, 1, 0, 0];

  for (let i = 0; i < fnArray.length; i += 1) {
    const fn = fnArray[i];
    const args = argsArray[i];

    if (fn === OPS.save) {
      stack.push([...ctm]);
      continue;
    }
    if (fn === OPS.restore) {
      ctm = stack.pop() ?? [1, 0, 0, 1, 0, 0];
      continue;
    }
    if (fn === OPS.transform && Array.isArray(args) && args.length >= 6) {
      ctm = multiplyTransform(ctm, args);
      continue;
    }

    if (fn === OPS.paintImageXObject || fn === OPS.paintInlineImageXObject || fn === OPS.paintImageMaskXObject) {
      const rect = imageTransformToRect(ctm, viewport);
      objects.push({
        id: `pdf-img-${i}`,
        type: "image",
        source: "pdf-native",
        ...rect,
        angle: rect.angle ?? 0,
        opacity: 0.9,
        fill: "rgba(16,185,129,0.2)",
        stroke: "#059669",
        strokeWidth: 1.25
      });
      continue;
    }

    if (fn === OPS.rectangle && Array.isArray(args) && args.length >= 4) {
      const rect = rectArgsToViewportRect(args, ctm, viewport);
      objects.push({
        id: `pdf-rect-${i}`,
        type: "vector",
        source: "pdf-native",
        ...rect,
        angle: rect.angle,
        opacity: 0.8,
        fill: "rgba(99,102,241,0.16)",
        stroke: "#4f46e5",
        strokeWidth: 1.25
      });
      continue;
    }

    if (fn === OPS.constructPath) {
      const pathShape = parseConstructPath(args, ctm, viewport);
      if (!pathShape?.bbox) {
        // Skip unknown path geometry instead of using CTM fallback (often too coarse).
        continue;
      }
      const rect = pathShape.bbox;
      objects.push({
        id: `pdf-vec-${i}`,
        type: "vector",
        source: "pdf-native",
        ...rect,
        angle: 0,
        opacity: 0.8,
        fill: "rgba(99,102,241,0.16)",
        stroke: "#4f46e5",
        strokeWidth: 1.25,
        points: pathShape?.points ?? null
      });
    }
  }

  return dedupeObjects(objects);
}

function extractObjectsFromAnnotations(annotations, viewport) {
  return (annotations ?? [])
    .filter((annotation) => Array.isArray(annotation.rect) && annotation.rect.length === 4)
    .map((annotation, index) => {
      const [x1, y1, x2, y2] = annotation.rect;
      const x = x1 * viewport.scale;
      const yTop = y2 * viewport.scale;
      const width = Math.max(8, Math.abs(x2 - x1) * viewport.scale);
      const height = Math.max(8, Math.abs(y2 - y1) * viewport.scale);
      const y = viewport.height - yTop;
      return {
        id: `pdf-ann-${index}`,
        type: annotation.subtype === "Movie" || annotation.subtype === "Screen" ? "media" : "vector",
        source: "pdf-annotation",
        annotationSubtype: annotation.subtype ?? null,
        x,
        y,
        width,
        height,
        angle: 0,
        opacity: 0.8,
        fill: "rgba(245,158,11,0.16)",
        stroke: "#d97706",
        strokeWidth: 1.2
      };
    });
}

function multiplyTransform(m1, m2) {
  return [
    m1[0] * m2[0] + m1[2] * m2[1],
    m1[1] * m2[0] + m1[3] * m2[1],
    m1[0] * m2[2] + m1[2] * m2[3],
    m1[1] * m2[2] + m1[3] * m2[3],
    m1[0] * m2[4] + m1[2] * m2[5] + m1[4],
    m1[1] * m2[4] + m1[3] * m2[5] + m1[5]
  ];
}

function ctmToRect(ctm, viewport) {
  const x = ctm[4] * viewport.scale;
  const y = viewport.height - ctm[5] * viewport.scale;
  const width = Math.max(12, Math.abs(ctm[0]) * viewport.scale);
  const height = Math.max(12, Math.abs(ctm[3]) * viewport.scale);
  return {
    x,
    y,
    width,
    height
  };
}

function imageTransformToRect(ctm, viewport) {
  // Image paint ops typically draw unit-rect transformed by current matrix.
  const rect = rectFromPoints(
    [
      transformPoint(ctm, 0, 0),
      transformPoint(ctm, 1, 0),
      transformPoint(ctm, 0, 1),
      transformPoint(ctm, 1, 1)
    ],
    viewport
  );
  return {
    ...rect,
    angle: (Math.atan2(ctm[1], ctm[0]) * 180) / Math.PI
  };
}

function rectArgsToViewportRect(args, ctm, viewport) {
  const [x, y, w, h] = args;
  const points = [
    transformPoint(ctm, x, y),
    transformPoint(ctm, x + w, y),
    transformPoint(ctm, x, y + h),
    transformPoint(ctm, x + w, y + h)
  ];
  const rect = rectFromPoints(points, viewport);
  const angle = (Math.atan2(ctm[1], ctm[0]) * 180) / Math.PI;
  return {
    ...rect,
    angle
  };
}

function transformPoint(matrix, x, y) {
  return {
    x: matrix[0] * x + matrix[2] * y + matrix[4],
    y: matrix[1] * x + matrix[3] * y + matrix[5]
  };
}

function rectFromPoints(points, viewport) {
  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);

  return {
    x: minX * viewport.scale,
    y: viewport.height - maxY * viewport.scale,
    width: Math.max(8, (maxX - minX) * viewport.scale),
    height: Math.max(8, (maxY - minY) * viewport.scale)
  };
}

function dedupeObjects(objects) {
  const unique = [];
  for (const object of objects) {
    const objectArea = Math.max(1, (object.width ?? 0) * (object.height ?? 0));
    const existingIndex = unique.findIndex((item) => {
      const closeByPosition =
        Math.abs(item.x - object.x) < 2 &&
        Math.abs(item.y - object.y) < 2 &&
        Math.abs(item.width - object.width) < 2 &&
        Math.abs(item.height - object.height) < 2;
      if (closeByPosition) {
        return true;
      }
      return iou(item, object) >= 0.92;
    });
    if (existingIndex >= 0) {
      const existing = unique[existingIndex];
      const existingArea = Math.max(1, (existing.width ?? 0) * (existing.height ?? 0));
      const preferCurrent =
        objectArea < existingArea ||
        (Array.isArray(object.points) && object.points.length > (existing.points?.length ?? 0));
      if (preferCurrent) {
        unique[existingIndex] = object;
      }
      continue;
    }
    unique.push(object);
  }
  return unique;
}

function refineDetectedObjects(objects, viewport) {
  const pageWidth = Number(viewport?.width ?? 0);
  const pageHeight = Number(viewport?.height ?? 0);
  const clamped = (objects ?? [])
    .map((object) => clampObjectToViewport(object, pageWidth, pageHeight))
    .filter((object) => {
      if (!object) return false;
      // Remove extremely thin artifacts that are usually drawing leftovers.
      const minSide = Math.min(object.width ?? 0, object.height ?? 0);
      const maxSide = Math.max(object.width ?? 0, object.height ?? 0);
      if (minSide < 2 && maxSide > 120) {
        return false;
      }
      return (object.width ?? 0) >= 4 && (object.height ?? 0) >= 4;
    });
  return dedupeObjects(clamped);
}

function clampObjectToViewport(object, pageWidth, pageHeight) {
  if (!object) return null;
  const x = clamp(Number(object.x ?? 0), 0, Math.max(0, pageWidth - 1));
  const y = clamp(Number(object.y ?? 0), 0, Math.max(0, pageHeight - 1));
  const rawWidth = Number(object.width ?? 0);
  const rawHeight = Number(object.height ?? 0);
  const width = clamp(rawWidth, 0, Math.max(0, pageWidth - x));
  const height = clamp(rawHeight, 0, Math.max(0, pageHeight - y));
  return {
    ...object,
    x,
    y,
    width,
    height
  };
}

function iou(a, b) {
  const x1 = Math.max(a.x ?? 0, b.x ?? 0);
  const y1 = Math.max(a.y ?? 0, b.y ?? 0);
  const x2 = Math.min((a.x ?? 0) + (a.width ?? 0), (b.x ?? 0) + (b.width ?? 0));
  const y2 = Math.min((a.y ?? 0) + (a.height ?? 0), (b.y ?? 0) + (b.height ?? 0));
  const interW = Math.max(0, x2 - x1);
  const interH = Math.max(0, y2 - y1);
  const intersection = interW * interH;
  if (intersection <= 0) return 0;
  const areaA = Math.max(1, (a.width ?? 0) * (a.height ?? 0));
  const areaB = Math.max(1, (b.width ?? 0) * (b.height ?? 0));
  const union = areaA + areaB - intersection;
  return union > 0 ? intersection / union : 0;
}

function clamp(value, min, max) {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

function parseConstructPath(args, ctm, viewport) {
  if (!Array.isArray(args) || args.length < 2) {
    return null;
  }
  const ops = args[0];
  const coords = args[1];
  if (!Array.isArray(ops) || !Array.isArray(coords)) {
    return null;
  }

  const points = [];
  let currentPoint = null;
  let cursor = 0;

  for (const op of ops) {
    // 19: moveTo, 20: lineTo, 21: curveTo, 24: curveTo2, 25: curveTo3, 22: closePath.
    if ((op === 19 || op === 20) && cursor + 1 < coords.length) {
      const x = coords[cursor];
      const y = coords[cursor + 1];
      const transformed = transformPoint(ctm, x, y);
      points.push(transformed);
      currentPoint = transformed;
      cursor += 2;
      continue;
    }
    if (op === 21 && cursor + 5 < coords.length) {
      const p0 = currentPoint ?? transformPoint(ctm, coords[cursor], coords[cursor + 1]);
      const p1 = transformPoint(ctm, coords[cursor], coords[cursor + 1]);
      const p2 = transformPoint(ctm, coords[cursor + 2], coords[cursor + 3]);
      const x3 = coords[cursor + 4];
      const y3 = coords[cursor + 5];
      const p3 = transformPoint(ctm, x3, y3);
      points.push(...sampleCubicBezier(p0, p1, p2, p3, 8));
      currentPoint = p3;
      cursor += 6;
      continue;
    }
    if (op === 24 && cursor + 3 < coords.length) {
      const p0 = currentPoint ?? transformPoint(ctm, coords[cursor], coords[cursor + 1]);
      const p1 = p0;
      const p2 = transformPoint(ctm, coords[cursor], coords[cursor + 1]);
      const p3 = transformPoint(ctm, coords[cursor + 2], coords[cursor + 3]);
      points.push(...sampleCubicBezier(p0, p1, p2, p3, 8));
      currentPoint = p3;
      cursor += 4;
      continue;
    }
    if (op === 25 && cursor + 3 < coords.length) {
      const p0 = currentPoint ?? transformPoint(ctm, coords[cursor + 2], coords[cursor + 3]);
      const p1 = transformPoint(ctm, coords[cursor], coords[cursor + 1]);
      const p2 = transformPoint(ctm, coords[cursor + 2], coords[cursor + 3]);
      const p3 = transformPoint(ctm, coords[cursor + 2], coords[cursor + 3]);
      points.push(...sampleCubicBezier(p0, p1, p2, p3, 8));
      currentPoint = p3;
      cursor += 4;
      continue;
    }
    if (op === 22 && points.length > 2) {
      points.push(points[0]);
      continue;
    }
    // 22: closePath, 23: rectangle (x, y, w, h)
    if (op === 23 && cursor + 3 < coords.length) {
      const x = coords[cursor];
      const y = coords[cursor + 1];
      const w = coords[cursor + 2];
      const h = coords[cursor + 3];
      points.push(transformPoint(ctm, x, y));
      points.push(transformPoint(ctm, x + w, y));
      points.push(transformPoint(ctm, x + w, y + h));
      points.push(transformPoint(ctm, x, y + h));
      currentPoint = transformPoint(ctm, x, y);
      cursor += 4;
      continue;
    }
  }

  if (points.length < 3) {
    return null;
  }

  const bbox = rectFromPoints(points, viewport);
  const normalized = points.map((point) => ({
    x: point.x * viewport.scale - bbox.x,
    y: viewport.height - point.y * viewport.scale - bbox.y
  }));

  return {
    bbox,
    points: normalized
  };
}

function sampleCubicBezier(p0, p1, p2, p3, segments = 6) {
  const result = [];
  for (let i = 1; i <= segments; i += 1) {
    const t = i / segments;
    const mt = 1 - t;
    const x =
      mt * mt * mt * p0.x +
      3 * mt * mt * t * p1.x +
      3 * mt * t * t * p2.x +
      t * t * t * p3.x;
    const y =
      mt * mt * mt * p0.y +
      3 * mt * mt * t * p1.y +
      3 * mt * t * t * p2.y +
      t * t * t * p3.y;
    result.push({ x, y });
  }
  return result;
}
