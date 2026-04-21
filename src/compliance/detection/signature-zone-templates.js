const TEMPLATES = {
  generic: [{ kind: "main", xMin: 0.52, xMax: 0.98, yMin: 0.68, yMax: 0.98 }],
  loan_contract: [{ kind: "main", xMin: 0.5, xMax: 0.98, yMin: 0.74, yMax: 0.98 }],
  payment_order: [{ kind: "main", xMin: 0.58, xMax: 0.98, yMin: 0.62, yMax: 0.9 }],
  kyc_form: [{ kind: "main", xMin: 0.48, xMax: 0.95, yMin: 0.7, yMax: 0.96 }]
};

export function getSignatureZoneTemplate(templateId) {
  const id = String(templateId ?? "generic").toLowerCase();
  const zones = TEMPLATES[id] ?? TEMPLATES.generic;
  const main = zones.find((zone) => zone.kind === "main") ?? zones[0];
  return clampZoneRatio(main);
}

export function getSignatureZoneTemplates(templateId) {
  const id = String(templateId ?? "generic").toLowerCase();
  return normalizeZoneEntries(TEMPLATES[id] ?? TEMPLATES.generic);
}

export function clampZoneRatio(zone) {
  const raw = zone ?? {};
  const xMin = clamp(raw.xMin, 0, 1);
  const xMax = clamp(raw.xMax, 0, 1);
  const yMin = clamp(raw.yMin, 0, 1);
  const yMax = clamp(raw.yMax, 0, 1);
  return {
    xMin: Math.min(xMin, xMax),
    xMax: Math.max(xMin, xMax),
    yMin: Math.min(yMin, yMax),
    yMax: Math.max(yMin, yMax)
  };
}

export function resolveSignatureZone(templateId, customZone) {
  if (customZone) {
    return clampZoneRatio(customZone);
  }
  return getSignatureZoneTemplate(templateId);
}

export function resolveSignatureZones(templateId, customZones) {
  if (Array.isArray(customZones) && customZones.length > 0) {
    return normalizeZoneEntries(customZones);
  }
  if (customZones && typeof customZones === "object" && !Array.isArray(customZones)) {
    return normalizeZoneEntries([{ kind: "main", ...customZones }]);
  }
  return getSignatureZoneTemplates(templateId);
}

export function normalizeZoneEntries(zones) {
  const normalized = (zones ?? []).map((zone, index) => {
    const clamped = clampZoneRatio(zone);
    const kind = zone?.kind === "initial" ? "initial" : "main";
    return {
      id: String(zone?.id ?? `zone-${index + 1}`),
      kind,
      ...clamped
    };
  });
  if (!normalized.some((zone) => zone.kind === "main") && normalized.length > 0) {
    normalized[0].kind = "main";
  }
  return normalized;
}

function clamp(value, min, max) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return min;
  }
  return Math.min(max, Math.max(min, numeric));
}
