import { estimateLineHeight, measureTokenWidth } from "./text-metrics.js";

export class ReflowEngine {
  reflowBlock(block, style) {
    const tokens = tokenize(block.text);
    const maxWidth = block.width;
    const lines = [];
    let current = "";
    let currentWidth = 0;

    for (const token of tokens) {
      const tokenWidth = measureTokenWidth(token, style);
      const projected = currentWidth + tokenWidth;
      if (projected > maxWidth && current) {
        lines.push(current.trimEnd());
        current = token;
        currentWidth = tokenWidth;
      } else {
        current += token;
        currentWidth = projected;
      }
    }

    if (current) {
      lines.push(current.trimEnd());
    }

    const lineHeight = estimateLineHeight(style);
    const height = Math.max(lineHeight, lines.length * lineHeight);

    return {
      ...block,
      lines,
      text: lines.join("\n"),
      height
    };
  }

  applyEdit(block, mutation, style) {
    const nextText = mutation(block.text);
    return this.reflowBlock({ ...block, text: nextText }, style);
  }
}

function tokenize(text) {
  const tokens = [];
  let current = "";

  for (const char of text) {
    current += char;
    if (char === " " || char === "\n") {
      tokens.push(current);
      current = "";
    }
  }

  if (current) {
    tokens.push(current);
  }
  return tokens;
}
