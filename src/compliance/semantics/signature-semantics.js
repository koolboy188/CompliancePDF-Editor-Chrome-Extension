export function analyzeSignatureSemantics({
  cryptographicSignature = null,
  objectBlocks,
  metadata,
  pages,
  textBlocks,
  expectedZonesByPage = null
}) {
  const findings = [];
  const signatures = [];
  const textSource = collectTextSource(textBlocks);
  const metadataSource = collectMetadataSource(metadata);

  const metadataHintStrong = hasStrongMetadataSignatureHint(metadataSource);
  const metadataHintWeak = hasWeakMetadataSignatureHint(metadataSource);
  const textHintStrong = hasStrongTextSignatureHint(textSource);
  const textHintWeak = hasWeakTextSignatureHint(textSource);
  const qrHint = hasQrHint(objectBlocks);
  const qrWithSignatureContext = hasQrWithSignatureContext(objectBlocks);
  const cornerQrHint = hasCornerQrCandidate(objectBlocks, pages);
  const qrTextMarker = hasQrTextMarker(textSource, metadataSource);
  const repeatedCrossPageSignal = hasRepeatedSignalAcrossPages(textBlocks);
  const logoLikeNegative = hasLogoLikeNegativeSignal(textSource, metadataSource);
  const isolatedQrNegative = hasIsolatedQrNegativeSignal(
    objectBlocks,
    textSource,
    metadataSource,
    qrWithSignatureContext
  );

  for (const page of pages) {
    const objects = objectBlocks?.[page.pageNumber] ?? [];
    const expectedZones = expectedZonesByPage?.[page.pageNumber] ?? [];
    const signatureLike = objects.filter((obj) => isSignatureLike(obj)).filter((obj) => {
      if (!expectedZones.length) return true;
      return !isInsideInitialZone(obj, expectedZones);
    });

    signatureLike.forEach((object, index) => {
      signatures.push({
        pageNumber: page.pageNumber,
        objectId: object.id ?? `${page.pageNumber}-sig-${index}`,
        type: classifySignatureType(object),
        bbox: {
          x: object.x ?? 0,
          y: object.y ?? 0,
          width: object.width ?? 0,
          height: object.height ?? 0
        }
      });
    });

    const annotationObjects = objects.filter((obj) => obj.source === "pdf-annotation");
    if (signatureLike.length > 0 && annotationObjects.length === 0 && !cryptographicSignature?.available) {
      findings.push({
        ruleId: "annotationSignatureMismatch",
        severity: "high",
        pageNumber: page.pageNumber,
        message: "Signature-like visual object detected without matching annotation/digital signature metadata.",
        evidence: {
          signatureLikeCount: signatureLike.length,
          annotationCount: annotationObjects.length,
          metadataHintStrong,
          textHintStrong,
          qrHint
        }
      });
    }
  }

  const heuristicAssessment = classifyFileDigitalSignature({
    metadataHintStrong,
    metadataHintWeak,
    textHintStrong,
    textHintWeak,
    qrHint,
    qrWithSignatureContext,
    cornerQrHint,
    qrTextMarker,
    repeatedCrossPageSignal,
    logoLikeNegative,
    isolatedQrNegative
  });
  const digitalSignatureAssessment = mergeCryptographicVerification(
    heuristicAssessment,
    cryptographicSignature
  );
  findings.push(...buildCryptographicSignatureFindings(cryptographicSignature, signatures));

  if (digitalSignatureAssessment.decision !== "detected" && signatures.length > 0) {
    findings.push({
      ruleId: "missingDigitalSignature",
      severity: digitalSignatureAssessment.decision === "uncertain" ? "low" : "medium",
      pageNumber: signatures[0].pageNumber,
      message: "No digital signature metadata found while visual signature objects exist.",
      evidence: {
        signatureCount: signatures.length,
        metadataHintStrong,
        textHintStrong,
        qrHint,
        trustTier: digitalSignatureAssessment.trustTier
      }
    });
  }

  return {
    findings,
    signatures,
    hasDigitalSignatureHint: digitalSignatureAssessment.decision !== "not_detected",
    hasTrustedDigitalSignature: digitalSignatureAssessment.trustTier === "trusted",
    digitalSignatureAssessment
  };
}

function mergeCryptographicVerification(heuristicAssessment, cryptographicSignature) {
  if (!cryptographicSignature?.available) {
    return heuristicAssessment;
  }

  const signatureCount = cryptographicSignature.signatures?.length ?? 0;
  if (cryptographicSignature.verified) {
    return {
      decision: "detected",
      trustTier: "trusted",
      confidence: 0.99,
      evidenceSummary: "Cryptographic PDF signature verified successfully.",
      assessmentMode: "cryptographic",
      verifiedCryptographically: true,
      positiveSignals: [
        "pdf_signature_dictionary_present",
        "cms_signature_integrity_verified",
        "certificate_chain_trusted"
      ],
      suppressedSignals: []
    };
  }

  if (signatureCount > 0 && cryptographicSignature.integrity) {
    return {
      decision: "uncertain",
      trustTier: "probable",
      confidence: 0.78,
      evidenceSummary: "Cryptographic signature integrity is valid, but certificate trust could not be fully established.",
      assessmentMode: "cryptographic",
      verifiedCryptographically: false,
      positiveSignals: [
        "pdf_signature_dictionary_present",
        "cms_signature_integrity_verified"
      ],
      suppressedSignals: [
        cryptographicSignature.expired ? "certificate_expired" : null,
        cryptographicSignature.authenticity ? null : "certificate_chain_untrusted"
      ].filter(Boolean)
    };
  }

  return {
    ...heuristicAssessment,
    assessmentMode: "cryptographic",
    verifiedCryptographically: false,
    evidenceSummary:
      cryptographicSignature.reason === "unsupported_subfilter"
        ? "PDF has a digital signature container, but the subfilter is not supported yet."
        : cryptographicSignature.reason === "verification_error"
          ? `Digital signature container found, but verification failed: ${cryptographicSignature.message ?? "unknown"}`
          : "Digital signature container found, but cryptographic verification did not pass.",
    positiveSignals: [
      ...heuristicAssessment.positiveSignals,
      "pdf_signature_dictionary_present"
    ]
  };
}

function buildCryptographicSignatureFindings(cryptographicSignature, signatures) {
  if (!cryptographicSignature?.available) {
    return [];
  }
  const pageNumber = signatures[0]?.pageNumber ?? 1;
  const findings = [];
  if (cryptographicSignature.reason === "unsupported_subfilter") {
    findings.push({
      ruleId: "unsupportedCryptographicSignature",
      severity: "low",
      pageNumber,
      message: "Digital signature container exists but uses an unsupported SubFilter.",
      evidence: {
        subFilter: cryptographicSignature.subFilter ?? null
      }
    });
    return findings;
  }
  if ((cryptographicSignature.signatures?.length ?? 0) > 0 && !cryptographicSignature.integrity) {
    findings.push({
      ruleId: "invalidCryptographicSignature",
      severity: "high",
      pageNumber,
      message: "Cryptographic PDF signature integrity verification failed.",
      evidence: {
        reason: cryptographicSignature.reason ?? null
      }
    });
  }
  if ((cryptographicSignature.signatures?.length ?? 0) > 0 && cryptographicSignature.expired) {
    findings.push({
      ruleId: "expiredSigningCertificate",
      severity: "medium",
      pageNumber,
      message: "Signing certificate is expired or not yet valid.",
      evidence: {}
    });
  }
  if ((cryptographicSignature.signatures?.length ?? 0) > 0 && !cryptographicSignature.authenticity) {
    findings.push({
      ruleId: "untrustedSigningCertificate",
      severity: "medium",
      pageNumber,
      message: "Cryptographic signature exists but the signing certificate chain is not trusted.",
      evidence: {}
    });
  }
  return findings;
}

function isInsideInitialZone(object, zones) {
  const centerX = (object.x ?? 0) + (object.width ?? 0) / 2;
  const centerY = (object.y ?? 0) + (object.height ?? 0) / 2;
  return (zones ?? []).some((zone) => {
    if (zone.kind !== "initial") return false;
    return centerX >= zone.xMin && centerX <= zone.xMax && centerY >= zone.yMin && centerY <= zone.yMax;
  });
}

function classifyFileDigitalSignature(signals) {
  const positiveSignals = [];
  const suppressedSignals = [];
  let score = 0;

  if (signals.metadataHintStrong) {
    score += 0.55;
    positiveSignals.push("metadata_strong_signature_hint");
  } else if (signals.metadataHintWeak) {
    score += 0.24;
    positiveSignals.push("metadata_weak_signature_hint");
  }

  if (signals.textHintStrong) {
    score += 0.55;
    positiveSignals.push("text_strong_signature_hint");
  } else if (signals.textHintWeak) {
    score += 0.26;
    positiveSignals.push("text_weak_signature_hint");
  }

  if (signals.qrHint) {
    score += 0.08;
    positiveSignals.push("qr_candidate_present");
  }
  if (signals.qrWithSignatureContext) {
    score += 0.25;
    positiveSignals.push("qr_with_signature_context");
  }
  if (signals.cornerQrHint) {
    score += 0.15;
    positiveSignals.push("corner_qr_pattern");
  }
  if (signals.qrTextMarker) {
    score += 0.2;
    positiveSignals.push("qr_text_marker");
  }
  if (signals.repeatedCrossPageSignal) {
    score += 0.1;
    positiveSignals.push("cross_page_signal_consistency");
  }

  if (signals.logoLikeNegative) {
    score -= 0.28;
    suppressedSignals.push("logo_like_context");
  }
  if (signals.isolatedQrNegative) {
    score -= 0.25;
    suppressedSignals.push("isolated_qr_without_signature_context");
  }

  const confidence = clamp(Number(score.toFixed(2)), 0, 1);
  const hasStrongDirectSignal = signals.metadataHintStrong || signals.textHintStrong;
  const hasStrongStructuralSignal = signals.qrWithSignatureContext && signals.qrTextMarker;

  if ((hasStrongDirectSignal && confidence >= 0.5) || (hasStrongStructuralSignal && confidence >= 0.72)) {
    return {
      decision: "detected",
      trustTier: "trusted",
      confidence,
      evidenceSummary: "Strong corroborated digital-signature evidence.",
      assessmentMode: "heuristic",
      verifiedCryptographically: false,
      positiveSignals,
      suppressedSignals
    };
  }

  if (confidence >= 0.25) {
    return {
      decision: "uncertain",
      trustTier: "probable",
      confidence,
      evidenceSummary: "Partial digital-signature evidence requires manual review.",
      assessmentMode: "heuristic",
      verifiedCryptographically: false,
      positiveSignals,
      suppressedSignals
    };
  }

  return {
    decision: "not_detected",
    trustTier: "none",
    confidence,
    evidenceSummary: "Insufficient trusted evidence for digital signature.",
    assessmentMode: "heuristic",
    verifiedCryptographically: false,
    positiveSignals,
    suppressedSignals
  };
}

function collectTextSource(textBlocks) {
  return Object.values(textBlocks ?? {})
    .flat()
    .map((block) => String(block?.text ?? ""))
    .join(" ");
}

function collectMetadataSource(metadata) {
  return `${metadata?.info?.Signature ?? ""} ${metadata?.info?.Subject ?? ""} ${metadata?.info?.Keywords ?? ""} ${
    metadata?.info?.Title ?? ""
  } ${metadata?.info?.Producer ?? ""}`;
}

function hasStrongMetadataSignatureHint(source) {
  return /digital\s*signed\s*by\s*:?|certificate|x509|pkcs|serial\s*number|đã\s*ký\s*bởi|da\s*ky\s*boi|đã\s*phê\s*duyệt\s*bởi|da\s*phe\s*duyet\s*boi|ký\s*số\s*bởi|ky\s*so\s*boi/i.test(
    source
  );
}

function hasWeakMetadataSignatureHint(source) {
  return /signed\s*by|chu\s*ky\s*so|đã\s*ký\b|da\s*ky\b|approved\s*by/i.test(source);
}

function hasStrongTextSignatureHint(source) {
  return /digital\s*signed\s*by\s*:?|đã\s*ký\s*bởi|da\s*ky\s*boi|đã\s*phê\s*duyệt\s*bởi|da\s*phe\s*duyet\s*boi|ký\s*số\s*bởi|ky\s*so\s*boi/i.test(
    source
  );
}

function hasWeakTextSignatureHint(source) {
  return /\bda\s*ky\b|đã\s*ký\b|signed\s*by|chu\s*ky\s*so/i.test(source);
}

function hasQrHint(objectBlocks) {
  return Object.values(objectBlocks ?? {}).some((pageObjects) =>
    (pageObjects ?? []).some((object) => {
      return isQrCandidate(object);
    })
  );
}

function hasQrTextMarker(textSource, metadataSource) {
  const source = `${textSource} ${metadataSource}`;
  return /\bqr\b|mã\s*qr|ma\s*qr|verify|xac\s*thuc|xác\s*thực/i.test(source);
}

function hasQrWithSignatureContext(objectBlocks) {
  return Object.values(objectBlocks ?? {}).some((pageObjects) => {
    const objects = pageObjects ?? [];
    const qrCandidates = objects.filter((object) => isQrCandidate(object));
    const signatureCandidates = objects.filter((object) => isSignatureLike(object));
    if (qrCandidates.length === 0 || signatureCandidates.length === 0) {
      return false;
    }
    // Consider it valid when at least one QR and one signature-like object are close on same page.
    return qrCandidates.some((qr) =>
      signatureCandidates.some((sig) => {
        const qrCx = (qr.x ?? 0) + (qr.width ?? 0) / 2;
        const qrCy = (qr.y ?? 0) + (qr.height ?? 0) / 2;
        const sigCx = (sig.x ?? 0) + (sig.width ?? 0) / 2;
        const sigCy = (sig.y ?? 0) + (sig.height ?? 0) / 2;
        const dx = Math.abs(qrCx - sigCx);
        const dy = Math.abs(qrCy - sigCy);
        return dx <= 280 && dy <= 220;
      })
    );
  });
}

function hasCornerQrCandidate(objectBlocks, pages) {
  return (pages ?? []).some((page) => {
    const objects = objectBlocks?.[page.pageNumber] ?? [];
    const pageWidth = Number(page.width ?? 0);
    const pageHeight = Number(page.height ?? 0);
    if (pageWidth <= 0 || pageHeight <= 0) {
      return false;
    }
    const edgeX = pageWidth * 0.22;
    const edgeY = pageHeight * 0.22;
    return objects.some((object) => {
      if (!isQrCandidate(object)) {
        return false;
      }
      const x = Number(object.x ?? 0);
      const y = Number(object.y ?? 0);
      const width = Number(object.width ?? 0);
      const height = Number(object.height ?? 0);
      const inCornerZone =
        (x <= edgeX || x + width >= pageWidth - edgeX) && (y <= edgeY || y + height >= pageHeight - edgeY);
      const sizeLooksQr = width >= 28 && width <= 180 && height >= 28 && height <= 180;
      return inCornerZone && sizeLooksQr;
    });
  });
}

function isQrCandidate(object) {
  const type = String(object?.type ?? "").toLowerCase();
  if (type !== "image" && type !== "rect" && type !== "vector") {
    return false;
  }
  const width = Number(object?.width ?? 0);
  const height = Number(object?.height ?? 0);
  if (width < 26 || height < 26 || width > 180 || height > 180) {
    return false;
  }
  const area = width * height;
  if (area < 900) return false;
  const ratio = width / Math.max(1, height);
  return ratio >= 0.88 && ratio <= 1.12;
}

function isSignatureLike(object) {
  if (!object) return false;
  const type = String(object.type ?? "").toLowerCase();
  const hasInkShape = type === "polygon" || type === "path";
  const hasImageShape = type === "image";
  const ratio = (object.width ?? 1) / Math.max(1, object.height ?? 1);
  const width = Number(object.width ?? 0);
  const height = Number(object.height ?? 0);
  const largeEnough = width >= 48 && height >= 10;
  const notTooLarge = width <= 620 && height <= 140;
  const ratioOk = ratio >= 1.8 && ratio <= 10;
  if (!largeEnough || !notTooLarge || !ratioOk) {
    return false;
  }
  if (hasImageShape) {
    const nearSquare = Math.abs(ratio - 1) < 0.3;
    if (nearSquare) return false;
  }
  return hasInkShape || hasImageShape;
}

function classifySignatureType(object) {
  const type = String(object.type ?? "").toLowerCase();
  if (type === "image") {
    return "scanned-image-signature";
  }
  if (type === "polygon" || type === "path") {
    return "drawn-signature";
  }
  return "unknown-signature";
}

function hasRepeatedSignalAcrossPages(textBlocks) {
  const pages = Object.values(textBlocks ?? {});
  const matchedPages = pages.filter((blocks) => {
    const source = (blocks ?? []).map((block) => String(block?.text ?? "")).join(" ");
    return hasWeakTextSignatureHint(source);
  });
  return matchedPages.length >= 2;
}

function hasLogoLikeNegativeSignal(textSource, metadataSource) {
  const source = `${textSource} ${metadataSource}`;
  return /\blogo\b|thương\s*hiệu|thuong\s*hieu|company\s*brand|con\s*dau\s*cong\s*ty/i.test(source);
}

function hasIsolatedQrNegativeSignal(objectBlocks, textSource, metadataSource, qrWithSignatureContext) {
  if (qrWithSignatureContext) {
    return false;
  }
  const qrCandidates = Object.values(objectBlocks ?? {})
    .flat()
    .filter((object) => isQrCandidate(object));
  if (qrCandidates.length !== 1) {
    return false;
  }
  if (hasStrongTextSignatureHint(textSource) || hasStrongMetadataSignatureHint(metadataSource)) {
    return false;
  }
  return true;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}
