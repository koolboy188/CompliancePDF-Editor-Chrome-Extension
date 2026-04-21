import { resolveSignatureZones } from "./signature-zone-templates.js";

export function runBaselineOverlayDetection({
  pages,
  objectBlocks,
  zoneTemplate = "generic",
  zoneOverride = null
}) {
  const findings = [];
  const suspiciousObjects = [];

  for (const page of pages) {
    const objects = objectBlocks?.[page.pageNumber] ?? [];
    const zones = signatureZones(page, zoneTemplate, zoneOverride);
    const mainZones = zones.filter((zone) => zone.kind === "main");
    let pageCandidates = 0;
    let pageRelevantCandidates = 0;
    let pageMainCandidates = 0;

    objects.forEach((object, index) => {
      if (!isCandidateObject(object)) {
        return;
      }
      pageCandidates += 1;
      const centerX = object.x + object.width / 2;
      const centerY = object.y + object.height / 2;
      const matchedZone = zones.find((zone) => inZone(centerX, centerY, zone));
      const insideExpectedZone = Boolean(matchedZone);
      const isInitialZone = matchedZone?.kind === "initial";
      const isMainZone = matchedZone?.kind === "main";

      if (isMainZone) {
        pageMainCandidates += 1;
      }

      if (!insideExpectedZone) {
        findings.push(
          createFinding("outOfZone", "medium", page.pageNumber, object, "Signature-like object outside expected zone.", {
            insideExpectedZone,
            zoneTemplate,
            center: { x: centerX, y: centerY }
          })
        );
      }

      if (isInitialZone) {
        // Ignore initials/paraph zones from main-signature compliance scoring.
        return;
      }

      pageRelevantCandidates += 1;

      if (!isMainZone) {
        return;
      }

      const overlayPeers = objects.filter((peer, peerIndex) => {
        if (peerIndex === index) return false;
        if (!isCandidateObject(peer)) return false;
        const peerCenterX = (peer.x ?? 0) + (peer.width ?? 0) / 2;
        const peerCenterY = (peer.y ?? 0) + (peer.height ?? 0) / 2;
        const peerZone = zones.find((zone) => inZone(peerCenterX, peerCenterY, zone));
        if (peerZone?.kind !== "main") {
          return false;
        }
        return overlapRatio(object, peer) > 0.72;
      });

      if (overlayPeers.length >= 2) {
        const maxOverlap = overlayPeers.reduce((max, peer) => Math.max(max, overlapRatio(object, peer)), 0);
        findings.push(
          createFinding(
            "stackedOverlay",
            "high",
            page.pageNumber,
            object,
            "Multiple overlapping objects detected in signature area.",
            {
              overlayPeersCount: overlayPeers.length,
              maxOverlap: Number(maxOverlap.toFixed(2))
            }
          )
        );
      }

      if (object.type === "image" || object.type === "polygon" || object.type === "rect") {
        const hasSemanticSupport = checkSemanticContext(object, page.textTokens);
        suspiciousObjects.push({
          pageNumber: page.pageNumber,
          objectId: object.id ?? `${page.pageNumber}-${index}`,
          bbox: toBbox(object),
          objectType: object.type,
          confidenceModifier: hasSemanticSupport ? 0.2 : 0
        });
      }
    });

    if (mainZones.length > 0 && pageRelevantCandidates > 0 && pageMainCandidates === 0) {
      findings.push({
        ruleId: "mainZoneMissingSignature",
        severity: "medium",
        pageNumber: page.pageNumber,
        message: "Signature-like objects exist but no object appears in expected main signature zone.",
        evidence: {
          pageCandidates,
          pageRelevantCandidates,
          pageMainCandidates
        }
      });
    }

    if (pageMainCandidates >= 2) {
      findings.push({
        ruleId: "multipleMainSignatures",
        severity: "high",
        pageNumber: page.pageNumber,
        message: "Multiple signature-like objects detected in the expected main signature zone.",
        evidence: {
          pageMainCandidates
        }
      });
    }
  }

  return {
    findings,
    suspiciousObjects
  };
}

function checkSemanticContext(object, textTokens = []) {
  if (!textTokens || textTokens.length === 0) return false;
  const radius = 100;
  const cx = object.x + object.width / 2;
  const cy = object.y + object.height / 2;
  const keywords = [/sign/i, /date/i, /initial/i];
  return textTokens.some((token) => {
    const tx = token.x + token.width / 2;
    const ty = token.y + token.height / 2;
    const dist = Math.sqrt((tx - cx) ** 2 + (ty - cy) ** 2);
    if (dist < radius) {
      return keywords.some((regex) => regex.test(token.text));
    }
    return false;
  });
}

function signatureZones(page, zoneTemplate, zoneOverride) {
  const width = page.width ?? 1000;
  const height = page.height ?? 1200;
  const pageOverride =
    zoneOverride && typeof zoneOverride === "object" && !Array.isArray(zoneOverride)
      ? zoneOverride[page.pageNumber] ?? zoneOverride[String(page.pageNumber)] ?? zoneOverride
      : zoneOverride;
  const ratios = resolveSignatureZones(zoneTemplate, pageOverride);
  return ratios.map((ratio) => ({
    id: ratio.id,
    kind: ratio.kind ?? "main",
    xMin: width * ratio.xMin,
    xMax: width * ratio.xMax,
    yMin: height * ratio.yMin,
    yMax: height * ratio.yMax
  }));
}

function inZone(x, y, zone) {
  return x >= zone.xMin && x <= zone.xMax && y >= zone.yMin && y <= zone.yMax;
}

function overlapRatio(a, b) {
  const xOverlap = Math.max(
    0,
    Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)
  );
  const yOverlap = Math.max(
    0,
    Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y)
  );
  const overlap = xOverlap * yOverlap;
  if (overlap <= 0) {
    return 0;
  }
  const minArea = Math.max(1, Math.min(a.width * a.height, b.width * b.height));
  return overlap / minArea;
}

function createFinding(ruleId, severity, pageNumber, object, message, evidence = {}) {
  return {
    ruleId,
    severity,
    pageNumber,
    bbox: toBbox(object),
    message,
    evidence
  };
}

function toBbox(object) {
  return {
    x: object.x ?? 0,
    y: object.y ?? 0,
    width: object.width ?? 0,
    height: object.height ?? 0
  };
}

function isCandidateObject(object) {
  const type = String(object?.type ?? "").toLowerCase();
  return type === "image" || type === "polygon" || type === "rect" || type === "path" || type === "vector";
}
