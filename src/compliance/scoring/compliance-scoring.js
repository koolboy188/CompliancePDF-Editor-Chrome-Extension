import { resolvePolicy } from "../policy-profiles.js";

const CRITICAL_RULE_IDS = new Set([
  "signature-tamper",
  "stackedOverlay",
  "multipleMainSignatures",
  "annotationSignatureMismatch"
]);

export function scoreCompliance({ baseline, semantics, policyId = "standard", customWeights = null }) {
  const policy = structuredClone(resolvePolicy(policyId));
  if (customWeights) {
    policy.weights = { ...policy.weights, ...customWeights };
  }
  const digitalAssessment = normalizeDigitalAssessment(semantics?.digitalSignatureAssessment);
  const policySnapshot = structuredClone(policy);
  if (digitalAssessment.trustTier === "trusted") {
    const isCryptographic = digitalAssessment.verifiedCryptographically === true;
    const explainability = {
      summary: isCryptographic
        ? "Risk overridden by trusted digital signature evidence (cryptographic verification)."
        : "Risk overridden by trusted digital signature evidence (heuristic assessment).",
      confidenceDrivers: [
        isCryptographic ? "cryptographic_signature_verified" : "metadata_or_text_signature_hint",
        "digital_signature_override",
        ...digitalAssessment.positiveSignals.slice(0, 2)
      ],
      suppressedSignals: digitalAssessment.suppressedSignals ?? [],
      topFindings: []
    };
    return {
      policy: policy.id,
      policySnapshot,
      totalScore: 0,
      decision: "pass",
      findings: [],
      overrideReason: isCryptographic
        ? "trusted_cryptographic_signature_evidence"
        : "trusted_heuristic_signature_evidence",
      confidence: 0.98,
      riskBand: "low",
      digitalSignature: digitalAssessment,
      explainability,
      breakdown: {
        byRule: {},
        bySeverity: {},
        byCategory: {}
      }
    };
  }

  const allFindings = [...(baseline?.findings ?? []), ...(semantics?.findings ?? [])];
  if (digitalAssessment.trustTier === "probable") {
    allFindings.push({
      ruleId: "probableDigitalSignature",
      severity: "low",
      pageNumber: semantics?.signatures?.[0]?.pageNumber ?? 1,
      message: "Digital signature evidence is probable but not trusted. Manual review recommended.",
      evidence: {
        trustTier: digitalAssessment.trustTier,
        confidence: digitalAssessment.confidence
      }
    });
  }
  const dedupedFindings = dedupeFindings(allFindings).map((finding) => ({
    ...finding,
    category: inferCategory(finding.ruleId)
  }));
  const hasCriticalFinding = dedupedFindings.some(isCriticalFinding);
  if (hasCriticalFinding) {
      const weighted = dedupedFindings.map((finding) => ({
        ...finding,
        score: 100
      }));
      return {
          policy: policy.id,
          policySnapshot,
          totalScore: 100,
          decision: "reject",
          riskBand: "critical",
          confidence: 1.0,
          digitalSignature: digitalAssessment,
          findings: weighted,
          breakdown: buildBreakdown(weighted),
          explainability: { 
            summary: "Critical signature integrity or overlay tampering detected. Manual review or rejection mandatory.",
            confidenceDrivers: ["critical_signal"],
            suppressedSignals: digitalAssessment.suppressedSignals ?? [],
            topFindings: weighted.filter((finding) => finding.severity === "high")
          }
      };
  }

  const weighted = dedupedFindings.map((finding) => {
    const weight = policy.weights[finding.ruleId] ?? 5;
    const severityMultiplier = severityToMultiplier(finding.severity);
    return {
      ...finding,
      weight,
      score: Math.round(weight * severityMultiplier)
    };
  });

  const rawScore = weighted.reduce((sum, finding) => sum + finding.score, 0);
  const totalScore = normalizeRiskScore(rawScore, policy);
  const decision = decide(totalScore, policy);
  const breakdown = buildBreakdown(weighted);
  const confidence = estimateConfidence({
    findingsCount: weighted.length,
    hasBaselineSignals: (baseline?.findings?.length ?? 0) > 0,
    hasSemanticSignals: (semantics?.findings?.length ?? 0) > 0
  });

  return {
    policy: policy.id,
    policySnapshot,
    totalScore,
    decision,
    riskBand: riskBand(totalScore),
    confidence,
    digitalSignature: digitalAssessment,
    findings: weighted,
    breakdown,
    explainability: buildExplainability(weighted, {
      confidence,
      hasBaselineSignals: (baseline?.findings?.length ?? 0) > 0,
      hasSemanticSignals: (semantics?.findings?.length ?? 0) > 0,
      digitalSignature: digitalAssessment
    })
  };
}

function normalizeDigitalAssessment(digitalAssessment) {
  const base = digitalAssessment ?? {
    decision: "not_detected",
    trustTier: "none",
    confidence: 0,
    positiveSignals: [],
    suppressedSignals: [],
    evidenceSummary: "No digital signature assessment available."
  };
  return {
    ...base,
    assessmentMode: base.assessmentMode ?? "heuristic",
    verifiedCryptographically: base.verifiedCryptographically === true
  };
}

function isCriticalFinding(finding) {
  if (finding?.severity !== "high") {
    return false;
  }
  if (CRITICAL_RULE_IDS.has(String(finding.ruleId ?? ""))) {
    return true;
  }
  return finding.category === "signature_integrity" || finding.category === "overlay_tampering";
}

function severityToMultiplier(severity) {
  if (severity === "high") return 1.4;
  if (severity === "medium") return 1;
  return 0.6;
}

function decide(score, policy) {
  if (score >= policy.thresholds.reject) return "reject";
  if (score >= policy.thresholds.review) return "manual_review";
  return "pass";
}

function normalizeRiskScore(rawScore, policy) {
  const baselineDenominator = Math.max(120, policy.thresholds.reject + 40);
  return clamp(Math.round((rawScore / baselineDenominator) * 100), 0, 100);
}

function dedupeFindings(findings) {
  const map = new Map();
  findings.forEach((finding) => {
    const bbox = finding.bbox ?? {};
    const key = [
      finding.ruleId ?? "unknown-rule",
      finding.pageNumber ?? 0,
      Math.round(bbox.x ?? -1),
      Math.round(bbox.y ?? -1),
      Math.round(bbox.width ?? -1),
      Math.round(bbox.height ?? -1),
      finding.message ?? ""
    ].join(":");
    const existing = map.get(key);
    if (!existing || severityToMultiplier(finding.severity) > severityToMultiplier(existing.severity)) {
      map.set(key, finding);
    }
  });
  return [...map.values()];
}

function inferCategory(ruleId) {
  if (ruleId?.toLowerCase().includes("signature")) return "signature_integrity";
  if (ruleId?.toLowerCase().includes("overlay")) return "overlay_tampering";
  if (ruleId?.toLowerCase().includes("zone")) return "placement_anomaly";
  return "general_risk";
}

function buildBreakdown(weightedFindings) {
  const byRule = {};
  const bySeverity = {};
  const byCategory = {};
  weightedFindings.forEach((finding) => {
    byRule[finding.ruleId] = (byRule[finding.ruleId] ?? 0) + finding.score;
    bySeverity[finding.severity] = (bySeverity[finding.severity] ?? 0) + finding.score;
    byCategory[finding.category] = (byCategory[finding.category] ?? 0) + finding.score;
  });
  return { byRule, bySeverity, byCategory };
}

function estimateConfidence({ findingsCount, hasBaselineSignals, hasSemanticSignals }) {
  let score = 0.45;
  if (hasBaselineSignals) score += 0.2;
  if (hasSemanticSignals) score += 0.2;
  if (findingsCount >= 3) score += 0.1;
  return clamp(Number(score.toFixed(2)), 0.3, 0.99);
}

function riskBand(score) {
  if (score >= 75) return "critical";
  if (score >= 45) return "elevated";
  return "low";
}

function buildExplainability(findings, context) {
  const topFindings = [...(findings ?? [])]
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
    .slice(0, 5)
    .map((finding) => ({
      ruleId: finding.ruleId,
      severity: finding.severity,
      score: finding.score,
      pageNumber: finding.pageNumber,
      message: finding.message ?? "rule triggered",
      evidence: finding.evidence ?? {}
    }));

  const confidenceDrivers = [];
  if (context.hasBaselineSignals) confidenceDrivers.push("baseline_geometry_signals");
  if (context.hasSemanticSignals) confidenceDrivers.push("semantic_signature_signals");
  if ((findings?.length ?? 0) >= 3) confidenceDrivers.push("multi_signal_consistency");
  if (context.digitalSignature?.positiveSignals?.length) {
    confidenceDrivers.push(...context.digitalSignature.positiveSignals.slice(0, 2));
  }
  if (confidenceDrivers.length === 0) confidenceDrivers.push("limited_signals");

  return {
    summary:
      topFindings.length > 0
        ? `Top ${topFindings.length} findings contribute most to risk.`
        : "No suspicious findings detected.",
    confidenceDrivers,
    suppressedSignals: context.digitalSignature?.suppressedSignals ?? [],
    digitalSignature: context.digitalSignature ?? null,
    topFindings
  };
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}
