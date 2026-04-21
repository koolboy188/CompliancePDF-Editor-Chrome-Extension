export function buildEvidenceBundle({ state, baseline, semantics, scoring }) {
  const timestamp = new Date().toISOString();
  const version = "1.0.0";
  const summary = {
    timestamp,
    version,
    documentId: state.documentId ?? "unknown",
    sourceUrl: state.sourceUrl ?? "local-upload",
    pages: state.pages?.length ?? 0,
    decision: scoring.decision,
    score: scoring.totalScore,
    riskBand: scoring.riskBand ?? "low",
    confidence: scoring.confidence ?? 0
  };

  return {
    summary,
    suspiciousObjects: baseline.suspiciousObjects ?? [],
    signatures: semantics.signatures ?? [],
    findings: scoring.findings ?? [],
    metadata: {
      policy: {
        id: scoring.policy ?? "standard",
        snapshot: scoring.policySnapshot ?? null
      },
      digitalSignature: {
        ...(scoring.digitalSignature ?? semantics.digitalSignatureAssessment ?? {}),
        assessmentMode:
          scoring.digitalSignature?.assessmentMode ??
          semantics.digitalSignatureAssessment?.assessmentMode ??
          "heuristic",
        verifiedCryptographically: Boolean(
          scoring.digitalSignature?.verifiedCryptographically ??
          semantics.digitalSignatureAssessment?.verifiedCryptographically
        )
      },
      breakdown: scoring.breakdown ?? {},
      explainability: scoring.explainability ?? {},
      generator: {
        name: "CompliancePDF Editor",
        version: "0.2.0"
      }
    }
  };
}

export function serializeEvidenceBundle(bundle) {
  return JSON.stringify(bundle, null, 2);
}
