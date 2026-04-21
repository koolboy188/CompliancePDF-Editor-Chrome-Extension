let pdfLibPromise;

async function loadPdfLib() {
  if (!pdfLibPromise) {
    pdfLibPromise = import("../../../node_modules/pdf-lib/es/index.js");
  }
  return pdfLibPromise;
}

export async function exportEditedPdf({ sourceBytes, state, options = {} }) {
  const { PDFDocument, StandardFonts, degrees, rgb } = await loadPdfLib();
  const pdfDoc = await PDFDocument.load(sourceBytes);
  const pages = pdfDoc.getPages();
  const fontCache = new Map();

  Object.entries(state.textBlocks ?? {}).forEach(([pageNumber, pageBlocks]) => {
    const page = pages[Number(pageNumber) - 1];
    if (!page) {
      return;
    }
    for (const block of pageBlocks) {
      const style = { ...(state.style ?? {}), ...(block.style ?? {}) };
      const lines = String(block.text ?? "").split("\n");
      const size = Number(style.fontSize ?? 12);
      const lineHeight = Number(block.lineHeight ?? size * (style.lineSpacing ?? 1.2));
      const textBoxHeight = Math.max(block.height ?? 0, Math.max(1, lines.length) * lineHeight + 8);
      const textBoxWidth = Math.max(block.width ?? 0, 24);
      const font = fontCache.get(style.fontFamily) ?? null;
      if (!font) {
        // placeholder; embedded below
      }
      eraseNativeRegion(page, {
        x: block.x ?? 0,
        y: block.y ?? 0,
        width: textBoxWidth,
        height: textBoxHeight
      }, rgb);
    }
  });

  for (const [pageNumber, pageBlocks] of Object.entries(state.textBlocks ?? {})) {
    const page = pages[Number(pageNumber) - 1];
    if (!page) {
      continue;
    }
    for (const block of pageBlocks) {
      const style = { ...(state.style ?? {}), ...(block.style ?? {}) };
      const lines = String(block.text ?? "").split("\n");
      const size = Number(style.fontSize ?? 12);
      const lineHeight = Number(block.lineHeight ?? size * (style.lineSpacing ?? 1.2));
      const font = await embedFontForFamily(pdfDoc, StandardFonts, fontCache, style.fontFamily);
      lines.forEach((line, index) => {
        const textWidth = font.widthOfTextAtSize(line, size);
        const baseX = Number(block.x ?? 0);
        const maxWidth = Math.max(Number(block.width ?? textWidth), textWidth);
        const x = resolveAlignedX(baseX, maxWidth, textWidth, style.textAlign);
        page.drawText(line, {
          x,
          y: page.getHeight() - Number(block.y ?? 0) - size - index * lineHeight,
          size,
          font,
          color: rgb(0, 0, 0),
          lineHeight
        });
      });
    }
  }

  await drawObjectPatches(state.objectBlocks, pages, pdfDoc, options, degrees, rgb);
  pdfDoc.setSubject("Edited with CompliancePDF");
  return pdfDoc.save();
}

async function drawObjectPatches(objectBlocks, pages, pdfDoc, options, degrees, rgb) {
  const preset = String(options?.preset ?? "editable");
  for (const [pageNumber, objects] of Object.entries(objectBlocks ?? {})) {
    const page = pages[Number(pageNumber) - 1];
    if (!page || !Array.isArray(objects)) {
      continue;
    }
    for (const obj of objects) {
      if (preset === "flattened" && obj.type !== "image") {
        // Flattened preset keeps only image/object snapshots for safest compatibility.
        continue;
      }
      if (obj.type === "image" && obj.src) {
        await drawImageObject(page, pdfDoc, obj, degrees, rgb);
        continue;
      }
      drawVectorObject(page, obj, degrees, rgb);
    }
  }
}

function drawVectorObject(page, obj, degrees, rgb) {
  if (obj.type === "polygon" && Array.isArray(obj.points) && obj.points.length >= 2) {
    drawPolygonObject(page, obj, degrees, rgb);
    return;
  }
  if (shouldEraseOriginalObject(obj)) {
    eraseNativeRegion(page, obj, rgb);
  }
  const fillColor = parseHexColor(obj.fill, [0.23, 0.51, 0.96]);
  const strokeColor = parseHexColor(obj.stroke, [0.15, 0.39, 0.92]);
  page.drawRectangle({
    x: obj.x ?? 0,
    y: page.getHeight() - (obj.y ?? 0) - (obj.height ?? 0),
    width: obj.width ?? 0,
    height: obj.height ?? 0,
    color: rgb(fillColor[0], fillColor[1], fillColor[2]),
    borderColor: rgb(strokeColor[0], strokeColor[1], strokeColor[2]),
    borderWidth: obj.strokeWidth ?? 1,
    opacity: obj.opacity ?? 1,
    rotate: degrees(obj.angle ?? 0)
  });
}

function drawPolygonObject(page, obj, degrees, rgb) {
  if (shouldEraseOriginalObject(obj)) {
    eraseNativeRegion(page, obj, rgb);
  }
  const fillColor = parseHexColor(obj.fill, [0.23, 0.51, 0.96]);
  const strokeColor = parseHexColor(obj.stroke, [0.15, 0.39, 0.92]);
  const points = obj.points ?? [];
  if (points.length < 2) {
    return;
  }
  const path = points
    .map((point, index) => {
      const px = round2((obj.x ?? 0) + point.x);
      const py = round2(page.getHeight() - ((obj.y ?? 0) + point.y));
      return `${index === 0 ? "M" : "L"} ${px} ${py}`;
    })
    .join(" ");

  page.drawSvgPath(`${path} Z`, {
    borderColor: rgb(strokeColor[0], strokeColor[1], strokeColor[2]),
    borderWidth: obj.strokeWidth ?? 1,
    color: rgb(fillColor[0], fillColor[1], fillColor[2]),
    opacity: obj.opacity ?? 1,
    rotate: degrees(obj.angle ?? 0)
  });
}

async function drawImageObject(page, pdfDoc, obj, degrees, rgb) {
  const src = obj.src;
  if (!src || typeof src !== "string" || !src.startsWith("data:image/")) {
    return;
  }
  if (shouldEraseOriginalObject(obj)) {
    eraseNativeRegion(page, obj, rgb);
  }
  const bytes = dataUrlToUint8(src);
  const isPng = src.startsWith("data:image/png");
  const image = isPng ? await pdfDoc.embedPng(bytes) : await pdfDoc.embedJpg(bytes);
  page.drawImage(image, {
    x: obj.x ?? 0,
    y: page.getHeight() - (obj.y ?? 0) - (obj.height ?? image.height),
    width: obj.width ?? image.width,
    height: obj.height ?? image.height,
    opacity: obj.opacity ?? 1,
    rotate: degrees(obj.angle ?? 0)
  });
}

function eraseNativeRegion(page, box, rgb) {
  const padding = 3;
  const x = Math.max(0, Number(box.x ?? 0) - padding);
  const y = page.getHeight() - Number(box.y ?? 0) - Number(box.height ?? 0) - padding;
  const width = Math.max(8, Number(box.width ?? 0) + padding * 2);
  const height = Math.max(8, Number(box.height ?? 0) + padding * 2);
  page.drawRectangle({
    x,
    y,
    width,
    height,
    color: rgb(1, 1, 1),
    opacity: 1
  });
}

async function embedFontForFamily(pdfDoc, StandardFonts, fontCache, fontFamily) {
  const cacheKey = String(fontFamily ?? "Helvetica");
  if (fontCache.has(cacheKey)) {
    return fontCache.get(cacheKey);
  }
  const source = cacheKey.toLowerCase();
  let standardFont = StandardFonts.Helvetica;
  if (source.includes("times")) {
    standardFont = StandardFonts.TimesRoman;
  } else if (source.includes("courier")) {
    standardFont = StandardFonts.Courier;
  }
  const font = await pdfDoc.embedFont(standardFont);
  fontCache.set(cacheKey, font);
  return font;
}

function resolveAlignedX(baseX, maxWidth, textWidth, textAlign) {
  if (textAlign === "center") {
    return baseX + Math.max(0, (maxWidth - textWidth) / 2);
  }
  if (textAlign === "right") {
    return baseX + Math.max(0, maxWidth - textWidth);
  }
  return baseX;
}

function shouldEraseOriginalObject(obj) {
  return typeof obj?.source === "string" && obj.source.startsWith("pdf-");
}

function dataUrlToUint8(dataUrl) {
  const base64 = dataUrl.split(",")[1] ?? "";
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function parseHexColor(value, fallback) {
  if (typeof value !== "string" || !value.startsWith("#")) {
    return fallback;
  }
  const normalized = value.length === 4
    ? `#${value[1]}${value[1]}${value[2]}${value[2]}${value[3]}${value[3]}`
    : value;
  const hex = normalized.slice(1);
  if (hex.length !== 6) {
    return fallback;
  }
  const num = Number.parseInt(hex, 16);
  if (Number.isNaN(num)) {
    return fallback;
  }
  const r = ((num >> 16) & 0xff) / 255;
  const g = ((num >> 8) & 0xff) / 255;
  const b = (num & 0xff) / 255;
  return [r, g, b];
}

function round2(value) {
  return Math.round(value * 100) / 100;
}
