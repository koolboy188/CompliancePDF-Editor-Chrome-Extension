export const POLICY_PROFILES = {
  strict: {
    id: "strict",
    label: "Strict",
    thresholds: {
      reject: 70,
      review: 40
    },
    weights: {
      outOfZone: 22,
      stackedOverlay: 16,
      multipleMainSignatures: 22,
      mainZoneMissingSignature: 15,
      lateAppearance: 14,
      annotationSignatureMismatch: 20,
      missingDigitalSignature: 18,
      probableDigitalSignature: 8,
      suspiciousRevisionHint: 16
    }
  },
  standard: {
    id: "standard",
    label: "Standard",
    thresholds: {
      reject: 75,
      review: 45
    },
    weights: {
      outOfZone: 16,
      stackedOverlay: 12,
      multipleMainSignatures: 16,
      mainZoneMissingSignature: 10,
      lateAppearance: 10,
      annotationSignatureMismatch: 14,
      missingDigitalSignature: 12,
      probableDigitalSignature: 6,
      suspiciousRevisionHint: 10
    }
  },
  review_only: {
    id: "review_only",
    label: "Review-only",
    thresholds: {
      reject: 100,
      review: 25
    },
    weights: {
      outOfZone: 10,
      stackedOverlay: 8,
      multipleMainSignatures: 10,
      mainZoneMissingSignature: 8,
      lateAppearance: 8,
      annotationSignatureMismatch: 8,
      missingDigitalSignature: 6,
      probableDigitalSignature: 4,
      suspiciousRevisionHint: 6
    }
  }
};

export function resolvePolicy(profileId) {
  return POLICY_PROFILES[profileId] ?? POLICY_PROFILES.standard;
}
