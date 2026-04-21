import { describe, expect, it } from "vitest";
import { buildEvidenceBundle } from "../src/compliance/audit/evidence-bundle.js";

describe("evidence bundle", () => {
  it("embeds policy snapshot and heuristic signature metadata", () => {
    const bundle = buildEvidenceBundle({
      state: {
        documentId: "doc-1",
        sourceUrl: "file:///sample.pdf",
        pages: [{ pageNumber: 1 }]
      },
      baseline: {
        suspiciousObjects: [{ objectId: "obj-1" }]
      },
      semantics: {
        signatures: [{ objectId: "sig-1" }],
        digitalSignatureAssessment: {
          decision: "uncertain",
          trustTier: "probable",
          assessmentMode: "heuristic",
          verifiedCryptographically: false
        }
      },
      scoring: {
        decision: "manual_review",
        totalScore: 42,
        riskBand: "elevated",
        confidence: 0.77,
        policy: "standard",
        policySnapshot: {
          id: "standard",
          thresholds: { reject: 75, review: 45 },
          weights: { stackedOverlay: 12 }
        },
        findings: [{ ruleId: "stackedOverlay" }],
        digitalSignature: {
          decision: "uncertain",
          trustTier: "probable",
          assessmentMode: "heuristic",
          verifiedCryptographically: false
        },
        breakdown: { byRule: { stackedOverlay: 12 } },
        explainability: { summary: "test" }
      }
    });

    expect(bundle.metadata.policy.id).toBe("standard");
    expect(bundle.metadata.policy.snapshot?.thresholds?.reject).toBe(75);
    expect(bundle.metadata.digitalSignature.assessmentMode).toBe("heuristic");
    expect(bundle.metadata.digitalSignature.verifiedCryptographically).toBe(false);
  });
});
