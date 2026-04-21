import { runBaselineOverlayDetection } from "../compliance/detection/baseline-detector.js";
import { analyzeSignatureSemantics } from "../compliance/semantics/signature-semantics.js";
import { scoreCompliance } from "../compliance/scoring/compliance-scoring.js";

self.onmessage = async (event) => {
  const { action, payload, requestId } = event.data ?? {};
  if (action !== "runScan") {
    return;
  }

  try {
    const baseline = runBaselineOverlayDetection(payload);
    const semantics = analyzeSignatureSemantics({
      cryptographicSignature: payload.cryptographicSignature,
      objectBlocks: payload.objectBlocks,
      metadata: payload.metadata,
      pages: payload.pages,
      textBlocks: payload.textBlocks,
      expectedZonesByPage: payload.expectedZonesByPage
    });
    const scoring = scoreCompliance({
      baseline,
      semantics,
      policyId: payload.policyId
    });

    self.postMessage({
      action: "scanResult",
      requestId,
      results: {
        baseline,
        semantics,
        scoring
      }
    });
  } catch (error) {
    self.postMessage({
      action: "scanError",
      requestId,
      error: error?.message ?? "Unknown compliance worker error"
    });
  }
};
