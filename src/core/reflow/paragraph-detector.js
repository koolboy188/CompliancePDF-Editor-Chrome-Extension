function sameLine(a, b, tolerance) {
  return Math.abs(a.y - b.y) <= tolerance;
}

export function detectParagraphs(fragments, config = {}) {
  const avgHeight =
    fragments.length > 0
      ? fragments.reduce((sum, frag) => sum + Math.abs(frag.height ?? 0), 0) / fragments.length
      : 10;
  const baselineTolerance = config.baselineTolerance ?? Math.max(3, avgHeight * 0.45);
  const paragraphGap = config.paragraphGap ?? 10;

  const ordered = [...fragments].sort(
    (a, b) =>
      rotationBucket(a.angle) - rotationBucket(b.angle) ||
      (a.y - b.y) ||
      (a.x - b.x)
  );
  const lines = [];

  for (const fragment of ordered) {
    const latestLine = lines.at(-1);
    if (
      !latestLine ||
      rotationBucket(latestLine.angle) !== rotationBucket(fragment.angle) ||
      !sameLine(latestLine, fragment, baselineTolerance)
    ) {
      lines.push({
        y: fragment.y,
        angle: fragment.angle ?? 0,
        fragments: [fragment]
      });
      continue;
    }
    latestLine.fragments.push(fragment);
  }

  const paragraphs = [];
  for (const line of lines) {
    const direction = detectLineDirection(line.fragments);
    const orderedFragments = [...line.fragments].sort((a, b) =>
      direction === "rtl" ? b.x - a.x : a.x - b.x
    );
    const content = buildLineText(orderedFragments, direction);

    if (!content) {
      continue;
    }

    const lastParagraph = paragraphs.at(-1);
    if (!lastParagraph) {
      paragraphs.push({
        id: crypto.randomUUID(),
        lines: [buildLineBlock(content, orderedFragments, line.y, direction)],
        top: line.y,
        lastY: line.y
      });
      continue;
    }

    const gap = line.y - lastParagraph.lastY;
    if (gap > paragraphGap) {
      paragraphs.push({
        id: crypto.randomUUID(),
        lines: [buildLineBlock(content, orderedFragments, line.y, direction)],
        top: line.y,
        lastY: line.y
      });
    } else {
      lastParagraph.lines.push(buildLineBlock(content, orderedFragments, line.y, direction));
      lastParagraph.lastY = line.y;
    }
  }

  return paragraphs.map((p) => {
    const firstLine = p.lines[0];
    const minX = Math.min(...p.lines.map((line) => line.x));
    const maxRight = Math.max(...p.lines.map((line) => line.x + line.width));
    const minY = Math.min(...p.lines.map((line) => line.y));
    const maxBottom = Math.max(...p.lines.map((line) => line.y + line.height));
    const dominantFont = getDominantFont(p.lines);

    return {
      id: p.id,
      text: p.lines.map((line) => line.text).join("\n"),
      top: p.top,
      x: minX,
      y: minY,
      width: Math.max(32, maxRight - minX),
      height: Math.max(18, maxBottom - minY),
      fontName: dominantFont,
      fontSize: firstLine?.fontSize ?? 12,
      direction: firstLine?.direction ?? "ltr"
    };
  });
}

function buildLineText(fragments, direction) {
  if (!fragments.length) {
    return "";
  }
  let result = "";
  let previous = null;
  for (const fragment of fragments) {
    const text = sanitizeFragmentText(fragment.text);
    if (!text) {
      continue;
    }
    const isCombiningMark = /^\p{M}+$/u.test(text);
    if (isCombiningMark) {
      result += text;
      previous = fragment;
      continue;
    }
    if (previous) {
      const previousEdge =
        direction === "rtl" ? previous.x ?? 0 : (previous.x ?? 0) + (previous.width ?? 0);
      const currentEdge =
        direction === "rtl"
          ? (fragment.x ?? 0) + (fragment.width ?? 0)
          : fragment.x ?? 0;
      const gap = Math.abs(currentEdge - previousEdge);
      const gapThreshold = Math.max(1.5, (fragment.height ?? 10) * 0.18);
      if (gap > gapThreshold && !result.endsWith(" ")) {
        result += " ";
      }
    }
    result += text;
    previous = fragment;
  }
  return result.trim();
}

function sanitizeFragmentText(input) {
  return String(input ?? "")
    .normalize("NFC")
    .replace(/[\uFB00-\uFB06]/g, (ligature) => {
      const map = {
        "\uFB00": "ff",
        "\uFB01": "fi",
        "\uFB02": "fl",
        "\uFB03": "ffi",
        "\uFB04": "ffl",
        "\uFB05": "ft",
        "\uFB06": "st"
      };
      return map[ligature] ?? ligature;
    })
    .replace(/\u0000/g, "")
    .replace(/\s+/g, " ");
}

function rotationBucket(angle) {
  const normalized = ((angle ?? 0) + 360) % 360;
  return Math.round(normalized / 5) * 5;
}

function buildLineBlock(content, fragments, fallbackY, direction) {
  const minX = Math.min(...fragments.map((fragment) => fragment.x));
  const maxRight = Math.max(...fragments.map((fragment) => fragment.x + fragment.width));
  const maxHeight = Math.max(...fragments.map((fragment) => fragment.height));
  const fontSize = Math.max(
    8,
    ...fragments.map((fragment) => Math.max(8, Math.abs(fragment.height ?? 0) * 0.85))
  );
  return {
    text: content,
    x: minX,
    y: fallbackY,
    width: Math.max(24, maxRight - minX),
    height: Math.max(12, maxHeight),
    fontName: fragments[0]?.fontName ?? null,
    fontSize,
    direction
  };
}

function getDominantFont(lines) {
  const counter = new Map();
  lines.forEach((line) => {
    const key = line.fontName ?? "unknown";
    counter.set(key, (counter.get(key) ?? 0) + 1);
  });
  let winner = null;
  let best = -1;
  counter.forEach((count, font) => {
    if (count > best) {
      best = count;
      winner = font;
    }
  });
  return winner;
}

function detectLineDirection(fragments) {
  const rtlCount = fragments.filter((fragment) => fragment.dir === "rtl").length;
  return rtlCount > fragments.length / 2 ? "rtl" : "ltr";
}
