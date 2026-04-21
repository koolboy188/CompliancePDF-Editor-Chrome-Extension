import { describe, expect, it } from "vitest";
import { runBaselineOverlayDetection } from "../src/compliance/detection/baseline-detector.js";
import { analyzeSignatureSemantics } from "../src/compliance/semantics/signature-semantics.js";
import { scoreCompliance } from "../src/compliance/scoring/compliance-scoring.js";

describe("Compliance scoring pipeline", () => {
  it("produces manual review or reject for suspicious overlays", () => {
    const pages = [{ pageNumber: 1, width: 1000, height: 1200 }];
    const objectBlocks = {
      1: [
        { type: "image", x: 40, y: 40, width: 160, height: 45 },
        { type: "polygon", x: 48, y: 42, width: 158, height: 44 },
        { type: "rect", x: 46, y: 41, width: 162, height: 43 }
      ]
    };

    const baseline = runBaselineOverlayDetection({ pages, objectBlocks });
    const semantics = analyzeSignatureSemantics({
      objectBlocks,
      metadata: { info: {} },
      pages
    });
    const scoring = scoreCompliance({
      baseline,
      semantics,
      policyId: "standard"
    });

    expect(scoring.totalScore).toBeGreaterThan(0);
    expect(["manual_review", "reject"]).toContain(scoring.decision);
    expect(scoring.riskBand).toMatch(/critical|elevated|low/);
    expect(scoring.confidence).toBeGreaterThan(0);
    expect(scoring.explainability?.topFindings?.length ?? 0).toBeGreaterThan(0);
    expect(scoring.explainability?.confidenceDrivers?.length ?? 0).toBeGreaterThan(0);
  });

  it("forces risk to zero when trusted digital signature evidence exists", () => {
    const pages = [{ pageNumber: 1, width: 1000, height: 1200 }];
    const objectBlocks = {
      1: [
        { type: "image", x: 700, y: 900, width: 64, height: 64 },
        { type: "polygon", x: 40, y: 40, width: 160, height: 45 }
      ]
    };
    const textBlocks = {
      1: [{ text: "Digital signed by Compliance Team" }]
    };

    const baseline = runBaselineOverlayDetection({ pages, objectBlocks });
    const semantics = analyzeSignatureSemantics({
      objectBlocks,
      metadata: { info: {} },
      pages,
      textBlocks
    });
    const scoring = scoreCompliance({
      baseline,
      semantics,
      policyId: "strict"
    });

    expect(semantics.digitalSignatureAssessment?.decision).toBe("detected");
    expect(semantics.digitalSignatureAssessment?.trustTier).toBe("trusted");
    expect(scoring.totalScore).toBe(0);
    expect(scoring.decision).toBe("pass");
    expect(scoring.riskBand).toBe("low");
    expect(scoring.explainability?.summary).toMatch(/trusted digital signature evidence/i);
  });

  it("treats Vietnamese watermark 'Da ky boi' as digital signature hint", () => {
    const pages = [{ pageNumber: 1, width: 1000, height: 1200 }];
    const objectBlocks = {
      1: [{ type: "polygon", x: 40, y: 40, width: 160, height: 45 }]
    };
    const textBlocks = {
      1: [{ text: "Đã ký bởi: ACB CA" }]
    };

    const baseline = runBaselineOverlayDetection({ pages, objectBlocks });
    const semantics = analyzeSignatureSemantics({
      objectBlocks,
      metadata: { info: {} },
      pages,
      textBlocks
    });
    const scoring = scoreCompliance({
      baseline,
      semantics,
      policyId: "standard"
    });

    expect(semantics.hasTrustedDigitalSignature).toBe(true);
    expect(scoring.totalScore).toBe(0);
  });

  it("treats 'Da phe duyet boi' as digital signature hint", () => {
    const pages = [{ pageNumber: 1, width: 1000, height: 1200 }];
    const objectBlocks = { 1: [{ type: "polygon", x: 40, y: 40, width: 160, height: 45 }] };
    const textBlocks = { 1: [{ text: "Đã phê duyệt bởi: MB Bank CA" }] };

    const baseline = runBaselineOverlayDetection({ pages, objectBlocks });
    const semantics = analyzeSignatureSemantics({
      objectBlocks,
      metadata: { info: {} },
      pages,
      textBlocks
    });
    const scoring = scoreCompliance({ baseline, semantics, policyId: "standard" });

    expect(semantics.hasTrustedDigitalSignature).toBe(true);
    expect(scoring.totalScore).toBe(0);
  });

  it("treats plain 'Da ky' as digital signature hint", () => {
    const pages = [{ pageNumber: 1, width: 1000, height: 1200 }];
    const objectBlocks = { 1: [{ type: "polygon", x: 40, y: 40, width: 160, height: 45 }] };
    const textBlocks = { 1: [{ text: "Van ban da ky dien tu" }] };

    const baseline = runBaselineOverlayDetection({ pages, objectBlocks });
    const semantics = analyzeSignatureSemantics({
      objectBlocks,
      metadata: { info: {} },
      pages,
      textBlocks
    });
    const scoring = scoreCompliance({ baseline, semantics, policyId: "standard" });

    expect(semantics.digitalSignatureAssessment?.decision).toBe("uncertain");
    expect(semantics.digitalSignatureAssessment?.trustTier).toBe("probable");
    expect(scoring.totalScore).toBeGreaterThan(0);
    expect(scoring.decision).toMatch(/manual_review|reject/);
  });

  it("does not trust QR + nearby signature object without corroborating text/metadata", () => {
    const pages = [{ pageNumber: 1, width: 1000, height: 1200 }];
    const objectBlocks = {
      1: [
        { type: "image", x: 760, y: 840, width: 58, height: 58 }, // QR-like
        { type: "polygon", x: 520, y: 880, width: 180, height: 42 } // Signature-like
      ]
    };

    const baseline = runBaselineOverlayDetection({ pages, objectBlocks });
    const semantics = analyzeSignatureSemantics({
      objectBlocks,
      metadata: { info: {} },
      pages,
      textBlocks: {}
    });
    const scoring = scoreCompliance({ baseline, semantics, policyId: "standard" });

    expect(semantics.digitalSignatureAssessment?.decision).toBe("uncertain");
    expect(semantics.digitalSignatureAssessment?.trustTier).toBe("probable");
    expect(scoring.totalScore).toBeGreaterThan(0);
  });

  it("does not trust top-corner QR alone as digital signature", () => {
    const pages = [{ pageNumber: 1, width: 1000, height: 1200 }];
    const objectBlocks = {
      1: [
        { type: "image", x: 870, y: 12, width: 95, height: 95 }, // top-right QR-like
        { type: "vector", x: 40, y: 40, width: 180, height: 55 } // unrelated block
      ]
    };

    const baseline = runBaselineOverlayDetection({ pages, objectBlocks });
    const semantics = analyzeSignatureSemantics({
      objectBlocks,
      metadata: { info: {} },
      pages,
      textBlocks: {}
    });
    const scoring = scoreCompliance({ baseline, semantics, policyId: "standard" });

    expect(semantics.digitalSignatureAssessment?.decision).toBe("not_detected");
    expect(scoring.totalScore).toBeGreaterThan(0);
  });

  it("ignores initial-signature zones from compliance scoring", () => {
    const pages = [{ pageNumber: 1, width: 1000, height: 1200 }];
    const objectBlocks = {
      1: [{ type: "polygon", x: 80, y: 80, width: 160, height: 48 }]
    };
    const zoneOverride = [
      { id: "main-1", kind: "main", xMin: 0.55, xMax: 0.98, yMin: 0.7, yMax: 0.98 },
      { id: "init-1", kind: "initial", xMin: 0.05, xMax: 0.35, yMin: 0.05, yMax: 0.2 }
    ];
    const baseline = runBaselineOverlayDetection({ pages, objectBlocks, zoneOverride });
    const semantics = analyzeSignatureSemantics({
      objectBlocks,
      metadata: { info: {} },
      pages,
      textBlocks: {},
      expectedZonesByPage: {
        1: [
          { kind: "main", xMin: 550, xMax: 980, yMin: 840, yMax: 1176 },
          { kind: "initial", xMin: 50, xMax: 350, yMin: 60, yMax: 240 }
        ]
      }
    });
    const scoring = scoreCompliance({ baseline, semantics, policyId: "standard" });

    expect(baseline.findings).toHaveLength(0);
    expect(semantics.findings).toHaveLength(0);
    expect(scoring.totalScore).toBe(0);
    expect(scoring.decision).toBe("pass");
  });

  it("should reject critical signature tampering", () => {
    const pages = [{ pageNumber: 1, width: 1000, height: 1200 }];
    const objectBlocks = { 1: [] };
    const baseline = { findings: [] };
    const semantics = {
      findings: [{ ruleId: "signature-tamper", severity: "high" }],
      hasTrustedDigitalSignature: false
    };
    const scoring = scoreCompliance({ baseline, semantics, policyId: "strict" });

    expect(scoring.decision).toBe("reject");
    expect(scoring.totalScore).toBe(100);
  });

  it("treats stacked overlay as a critical reject", () => {
    const scoring = scoreCompliance({
      baseline: {
        findings: [
          {
            ruleId: "stackedOverlay",
            severity: "high",
            pageNumber: 1,
            message: "Multiple overlapping objects detected."
          }
        ]
      },
      semantics: { findings: [] },
      policyId: "standard"
    });

    expect(scoring.decision).toBe("reject");
    expect(scoring.riskBand).toBe("critical");
  });

  it("marks digital signature assessment as heuristic", () => {
    const pages = [{ pageNumber: 1, width: 1000, height: 1200 }];
    const objectBlocks = { 1: [{ type: "polygon", x: 40, y: 40, width: 160, height: 45 }] };
    const textBlocks = { 1: [{ text: "Digital signed by Compliance Team" }] };

    const baseline = runBaselineOverlayDetection({ pages, objectBlocks });
    const semantics = analyzeSignatureSemantics({
      objectBlocks,
      metadata: { info: {} },
      pages,
      textBlocks
    });
    const scoring = scoreCompliance({ baseline, semantics, policyId: "strict" });

    expect(scoring.digitalSignature.assessmentMode).toBe("heuristic");
    expect(scoring.digitalSignature.verifiedCryptographically).toBe(false);
  });

  it("prefers cryptographic signature verification over heuristic hints", () => {
    const pages = [{ pageNumber: 1, width: 1000, height: 1200 }];
    const objectBlocks = {
      1: [{ type: "image", x: 80, y: 80, width: 180, height: 48 }]
    };
    const baseline = runBaselineOverlayDetection({ pages, objectBlocks });
    const semantics = analyzeSignatureSemantics({
      cryptographicSignature: {
        available: true,
        verified: true,
        authenticity: true,
        integrity: true,
        expired: false,
        signatures: [{}]
      },
      objectBlocks,
      metadata: { info: {} },
      pages,
      textBlocks: {}
    });
    const scoring = scoreCompliance({ baseline, semantics, policyId: "standard" });

    expect(semantics.digitalSignatureAssessment.assessmentMode).toBe("cryptographic");
    expect(semantics.digitalSignatureAssessment.verifiedCryptographically).toBe(true);
    expect(scoring.decision).toBe("pass");
    expect(scoring.totalScore).toBe(0);
  });
});
