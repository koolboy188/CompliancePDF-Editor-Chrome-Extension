if (!globalThis.pdfjsLib) {
  throw new Error(
    "Missing PDF.js runtime. Place the official pdf.min.mjs build into src/vendor/pdf.min.mjs."
  );
}

export const getDocument = globalThis.pdfjsLib.getDocument.bind(globalThis.pdfjsLib);
