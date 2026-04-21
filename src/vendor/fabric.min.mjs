if (!globalThis.fabric) {
  throw new Error(
    "Missing Fabric.js runtime. Place the official fabric ESM build into src/vendor/fabric.min.mjs."
  );
}

export const Canvas = globalThis.fabric.Canvas;
export const Rect = globalThis.fabric.Rect;
