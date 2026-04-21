const measureContext = getMeasureContext();

export function measureTokenWidth(token, style) {
  if (!measureContext) {
    const size = Number(style.fontSize ?? 14);
    return token.length * size * 0.55;
  }
  applyStyle(style);
  return measureContext.measureText(token).width;
}

export function estimateLineHeight(style) {
  const fontSize = Number(style.fontSize ?? 14);
  const lineSpacing = Number(style.lineSpacing ?? 1.4);
  return fontSize * lineSpacing;
}

function applyStyle(style) {
  if (!measureContext) {
    return;
  }
  const family = style.fontFamily ?? "Arial";
  const size = Number(style.fontSize ?? 14);
  measureContext.font = `${size}px ${family}`;
}

function getMeasureContext() {
  if (typeof document === "undefined") {
    return null;
  }
  const canvas = document.createElement("canvas");
  return canvas.getContext("2d");
}
