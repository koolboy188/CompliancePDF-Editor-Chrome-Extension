import { describe, expect, it } from "vitest";
import { runBaselineOverlayDetection } from "../src/compliance/detection/baseline-detector.js";
import { analyzeSignatureSemantics } from "../src/compliance/semantics/signature-semantics.js";
import { scoreCompliance } from "../src/compliance/scoring/compliance-scoring.js";

const pages = [{ pageNumber: 1, width: 1000, height: 1200 }];

describe("Compliance benchmark suite", () => {
  it("keeps solid precision/recall for trusted-digital-signature detection", () => {
    const cases = [
      {
        id: "trusted_text_hint",
        objectBlocks: { 1: [{ type: "polygon", x: 500, y: 880, width: 180, height: 42 }] },
        textBlocks: { 1: [{ text: "Digital signed by: Compliance Team" }] },
        expectedTrusted: true
      },
      {
        id: "trusted_corner_qr",
        objectBlocks: { 1: [{ type: "image", x: 880, y: 16, width: 88, height: 88 }] },
        textBlocks: {},
        expectedTrusted: false
      },
      {
        id: "trusted_qr_with_signature_context",
        objectBlocks: {
          1: [
            { type: "image", x: 760, y: 860, width: 58, height: 58 },
            { type: "polygon", x: 520, y: 900, width: 180, height: 40 }
          ]
        },
        textBlocks: {},
        expectedTrusted: false
      },
      {
        id: "trusted_qr_text_marker_and_sign_phrase",
        objectBlocks: { 1: [{ type: "image", x: 760, y: 860, width: 58, height: 58 }] },
        textBlocks: { 1: [{ text: "Ma QR verify - Digital signed by Bank CA" }] },
        expectedTrusted: true
      },
      {
        id: "clean_no_signature_hint",
        objectBlocks: { 1: [{ type: "vector", x: 120, y: 220, width: 160, height: 80 }] },
        textBlocks: { 1: [{ text: "Internal memo only" }] },
        expectedTrusted: false
      },
      {
        id: "logo_square_not_qr_context",
        objectBlocks: { 1: [{ type: "image", x: 360, y: 260, width: 54, height: 54 }] },
        textBlocks: { 1: [{ text: "Company logo" }] },
        expectedTrusted: false
      },
      {
        id: "signature_like_without_hint",
        objectBlocks: { 1: [{ type: "polygon", x: 510, y: 910, width: 188, height: 42 }] },
        textBlocks: {},
        expectedTrusted: false
      },
      {
        id: "stamp_only_without_hint",
        objectBlocks: { 1: [{ type: "rect", x: 620, y: 830, width: 90, height: 90 }] },
        textBlocks: {},
        expectedTrusted: false
      }
    ];

    const outcomes = cases.map((scenario) => {
      const baseline = runBaselineOverlayDetection({
        pages,
        objectBlocks: scenario.objectBlocks
      });
      const semantics = analyzeSignatureSemantics({
        objectBlocks: scenario.objectBlocks,
        metadata: { info: {} },
        pages,
        textBlocks: scenario.textBlocks
      });
      const scoring = scoreCompliance({
        baseline,
        semantics,
        policyId: "standard"
      });
      return {
        id: scenario.id,
        expectedTrusted: scenario.expectedTrusted,
        actualTrusted: semantics.digitalSignatureAssessment?.decision === "detected",
        decision: scoring.decision
      };
    });

    const metrics = binaryMetrics(
      outcomes.map((item) => ({
        expected: item.expectedTrusted,
        predicted: item.actualTrusted
      }))
    );

    expect(metrics.precision).toBeGreaterThanOrEqual(0.8);
    expect(metrics.recall).toBeGreaterThanOrEqual(0.66);
    expect(metrics.f1).toBeGreaterThanOrEqual(0.72);
    expect(metrics.accuracy).toBeGreaterThanOrEqual(0.85);
    expect(metrics.falsePositiveRate).toBeLessThanOrEqual(0.2);
  });

  it("keeps risky overlay detection from regressing", () => {
    const cases = [
      {
        id: "heavy_stacked_overlay_risky",
        objectBlocks: {
          1: [
            { type: "image", x: 48, y: 44, width: 170, height: 50 },
            { type: "polygon", x: 46, y: 43, width: 171, height: 51 },
            { type: "rect", x: 50, y: 42, width: 169, height: 50 },
            { type: "vector", x: 49, y: 45, width: 170, height: 49 }
          ]
        },
        textBlocks: {},
        metadata: { info: {} },
        expectedRisky: true
      },
      {
        id: "trusted_signature_should_not_be_risky",
        objectBlocks: {
          1: [
            { type: "image", x: 760, y: 860, width: 58, height: 58 },
            { type: "polygon", x: 520, y: 900, width: 180, height: 40 }
          ]
        },
        textBlocks: { 1: [{ text: "Đã ký bởi: MB CA" }] },
        metadata: { info: {} },
        expectedRisky: false
      },
      {
        id: "benign_document_not_risky",
        objectBlocks: {
          1: [{ type: "vector", x: 220, y: 320, width: 140, height: 90 }]
        },
        textBlocks: { 1: [{ text: "Thông báo nội bộ" }] },
        metadata: { info: {} },
        expectedRisky: false
      }
    ];

    const outcomes = cases.map((scenario) => {
      const baseline = runBaselineOverlayDetection({ pages, objectBlocks: scenario.objectBlocks });
      const semantics = analyzeSignatureSemantics({
        objectBlocks: scenario.objectBlocks,
        metadata: scenario.metadata,
        pages,
        textBlocks: scenario.textBlocks
      });
      const scoring = scoreCompliance({ baseline, semantics, policyId: "standard" });
      const actualRisky = scoring.decision !== "pass";
      return {
        id: scenario.id,
        expectedRisky: scenario.expectedRisky,
        actualRisky,
        decision: scoring.decision
      };
    });

    const metrics = binaryMetrics(
      outcomes.map((item) => ({
        expected: item.expectedRisky,
        predicted: item.actualRisky
      }))
    );

    expect(metrics.precision).toBeGreaterThanOrEqual(0.7);
    expect(metrics.recall).toBeGreaterThanOrEqual(0.7);
    expect(metrics.accuracy).toBeGreaterThanOrEqual(0.8);
  });
});

function binaryMetrics(items) {
  let tp = 0;
  let tn = 0;
  let fp = 0;
  let fn = 0;
  items.forEach((item) => {
    if (item.expected && item.predicted) tp += 1;
    if (!item.expected && !item.predicted) tn += 1;
    if (!item.expected && item.predicted) fp += 1;
    if (item.expected && !item.predicted) fn += 1;
  });
  return {
    tp,
    tn,
    fp,
    fn,
    precision: tp + fp === 0 ? 1 : tp / (tp + fp),
    recall: tp + fn === 0 ? 1 : tp / (tp + fn),
    accuracy: (tp + tn) / Math.max(1, tp + tn + fp + fn),
    f1: tp === 0 ? 0 : (2 * tp) / Math.max(1, 2 * tp + fp + fn),
    falsePositiveRate: fp / Math.max(1, fp + tn)
  };
}
