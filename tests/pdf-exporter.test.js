import { describe, expect, it } from "vitest";
import { PDFDocument } from "pdf-lib";
import { exportEditedPdf } from "../src/core/export/pdf-exporter.js";

describe("pdf exporter", () => {
  it("exports edited text blocks with per-page mapping", async () => {
    const sourcePdf = await PDFDocument.create();
    sourcePdf.addPage([400, 500]);
    sourcePdf.addPage([400, 500]);
    const sourceBytes = await sourcePdf.save();

    const exportedBytes = await exportEditedPdf({
      sourceBytes,
      state: {
        style: {
          fontFamily: "Arial",
          fontSize: 12,
          lineSpacing: 1.2,
          textAlign: "left"
        },
        textBlocks: {
          2: [
            {
              id: "p2-1",
              pageNumber: 2,
              x: 40,
              y: 60,
              width: 180,
              height: 32,
              lineHeight: 16,
              text: "Export me on page 2",
              style: {
                fontFamily: "Times New Roman",
                fontSize: 14,
                textAlign: "center"
              }
            }
          ]
        },
        objectBlocks: {}
      }
    });

    const exportedPdf = await PDFDocument.load(exportedBytes);
    expect(exportedPdf.getPageCount()).toBe(2);
    expect(exportedPdf.getSubject()).toBe("Edited with CompliancePDF");
  }, 15000);
});
