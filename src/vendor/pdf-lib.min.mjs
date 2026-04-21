if (!globalThis.PDFLib) {
  throw new Error(
    "Missing pdf-lib runtime. Place the official pdf-lib ESM build into src/vendor/pdf-lib.min.mjs."
  );
}

export const PDFDocument = globalThis.PDFLib.PDFDocument;
export const StandardFonts = globalThis.PDFLib.StandardFonts;
export const rgb = globalThis.PDFLib.rgb;
