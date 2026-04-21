import { EditLayerManager } from "../core/edit-layer-manager.js";
import { exportEditedPdf } from "../core/export/pdf-exporter.js";
import { FabricObjectManager } from "../core/objects/fabric-object-manager.js";
import {
  loadPdfDocument,
  renderPdfPage,
  extractTextFragments,
  extractPageObjects
} from "../core/pdfjs-adapter.js";
import { detectParagraphs } from "../core/reflow/paragraph-detector.js";
import { estimateLineHeight } from "../core/reflow/text-metrics.js";
import { CrossPageFlowManager } from "../core/textflow/cross-page-flow-manager.js";
import { EDIT_MODES, MESSAGE_TYPES } from "../shared/message-types.js";
import { getState, resetDocumentState, updateState } from "../shared/state-store.js";
import {
  getSignatureZoneTemplate,
  getSignatureZoneTemplates,
  normalizeZoneEntries,
  resolveSignatureZones
} from "../compliance/detection/signature-zone-templates.js";
import { verifyPdfDigitalSignature } from "../compliance/crypto/real-signature-verifier.js";
import { buildEvidenceBundle, serializeEvidenceBundle } from "../compliance/audit/evidence-bundle.js";
import { sendComplianceResult } from "../compliance/integration/workflow-bridge.js";
import { getComplianceMetrics, trackScanResult } from "../compliance/hardening/metrics.js";

const viewerRoot = document.getElementById("viewerRoot");
const fileInput = document.getElementById("fileInput");
const saveBtn = document.getElementById("saveBtn");
const themeToggleBtn = document.getElementById("themeToggleBtn");
const exportPreset = document.getElementById("exportPreset");
const uiDensityPreset = document.getElementById("uiDensityPreset");
const toggleMetaPanelBtn = document.getElementById("toggleMetaPanelBtn");
const advancedToolsBtn = document.querySelector(".btn-advanced");
const objectHoverTooltip = document.getElementById("objectHoverTooltip");
const loadingOverlay = document.getElementById("loadingOverlay");
const statusToast = document.getElementById("statusToast");
const compliancePolicy = document.getElementById("compliancePolicy");
const signatureZoneTemplate = document.getElementById("signatureZoneTemplate");
const showSignatureZoneToggle = document.getElementById("showSignatureZoneToggle");
const showEvidenceHeatmapToggle = document.getElementById("showEvidenceHeatmapToggle");
const runComplianceBtn = document.getElementById("runComplianceBtn");
const exportEvidenceBtn = document.getElementById("exportEvidenceBtn");
const prevFindingBtn = document.getElementById("prevFindingBtn");
const nextFindingBtn = document.getElementById("nextFindingBtn");
const complianceScanState = document.getElementById("complianceScanState");
const saveZoneTemplateBtn = document.getElementById("saveZoneTemplateBtn");
const resetZoneTemplateBtn = document.getElementById("resetZoneTemplateBtn");
const addSignatureZoneBtn = document.getElementById("addSignatureZoneBtn");
const removeSignatureZoneBtn = document.getElementById("removeSignatureZoneBtn");
const signatureZoneList = document.getElementById("signatureZoneList");
const signatureZoneKind = document.getElementById("signatureZoneKind");
const undoComplianceBtn = document.getElementById("undoComplianceBtn");
const redoComplianceBtn = document.getElementById("redoComplianceBtn");
const metadataFields = {
  name: document.getElementById("metaName"),
  source: document.getElementById("metaSource"),
  pages: document.getElementById("metaPages"),
  pageSize: document.getElementById("metaPageSize"),
  font: document.getElementById("metaFont"),
  scanQuality: document.getElementById("metaScanQuality"),
  signatureMode: document.getElementById("metaSignatureMode"),
  title: document.getElementById("metaTitle"),
  author: document.getElementById("metaAuthor"),
  subject: document.getElementById("metaSubject"),
  creator: document.getElementById("metaCreator"),
  producer: document.getElementById("metaProducer"),
  keywords: document.getElementById("metaKeywords")
};
const complianceFields = {
  decision: document.getElementById("complianceDecision"),
  score: document.getElementById("complianceScore"),
  findingsCount: document.getElementById("complianceFindingsCount"),
  digitalSignature: document.getElementById("complianceDigitalSignature"),
  breakdown: document.getElementById("complianceBreakdown"),
  explainability: document.getElementById("complianceExplainability"),
  why: document.getElementById("complianceWhy"),
  findingsList: document.getElementById("complianceFindingsList")
};

const editLayerManager = new EditLayerManager({
  root: viewerRoot,
  stateStore: { getState, updateState },
  onBlockEdit: handleBlockEdited,
  onBlockSelect: handleBlockSelected
});

const objectManager = new FabricObjectManager({
  onObjectsChanged: (pageNumber, objects) => {
    updateState((draft) => {
      draft.objectBlocks[pageNumber] = objects;
    });
    renderImageMaskOverlaysForPage(pageNumber, objects, objectManager.getImageMaskRects(pageNumber));
  },
  onObjectsTransforming: (pageNumber, payload) => {
    renderImageMaskOverlaysForPage(
      pageNumber,
      payload.objects,
      objectManager.getImageMaskRects(pageNumber)
    );
    renderSelectedObjectBadge(pageNumber, payload.selection);
    if (payload.selection) {
      selectedObjectPageNumber = pageNumber;
      syncTopObjectInspector(payload.selection);
    }
  },
  onSelectionChanged: (_pageNumber, selection) => {
    updateState((draft) => {
      draft.selectedObject = selection;
    });
    selectedObjectPageNumber = selection ? _pageNumber : selectedObjectPageNumber;
    syncTopObjectInspector(selection);
    renderSelectedObjectBadge(_pageNumber, selection);
  },
  onObjectHover: (payload) => {
    if (!payload) {
      hideObjectHoverTooltip();
      return;
    }
    const a4 = computeA4Percents(payload.object, payload.pageNumber);
    const source = String(payload.object.source ?? "user");
    const kind = String(payload.object.detectedType ?? payload.object.type ?? "object");
    showObjectHoverTooltip(
      payload.pointer,
      `BBox: ${kind} (${source}) | A4 W:${round(a4.widthPct)}% H:${round(a4.heightPct)}%`
    );
  }
});

const flowManager = new CrossPageFlowManager();
const backgroundPort = chrome.runtime.connect({ name: "flexipdf-viewer" });
const complianceWorker = new Worker(new URL("../worker/compliance-worker.js", import.meta.url), { type: "module" });

let sourceBytes = null;
let currentPdf = null;
let currentMetadataInfo = {};
let currentCryptographicSignature = null;
let currentCryptographicSignaturePromise = null;
let cryptographicVerificationRequestCounter = 0;
let selectedLinkSource = null;
let selectedTextBlockId = null;
let selectedTextPageNumber = null;
let selectedObjectPageNumber = null;
let objectLockState = false;
let isLightTheme = false;
let isCompactDensity = false;
let textDebugEnabled = false;
const debugLayerByPage = new Map();
const complianceHighlightLayerByPage = new Map();
const selectedObjectBadgeByPage = new Map();
const signatureZoneLayerByPage = new Map();
const imageMaskLayerByPage = new Map();
const undoStack = [];
const redoStack = [];
let currentMode = EDIT_MODES.VIEW;
let lastComplianceBundle = null;
let focusedFindingKey = null;
let customZoneByTemplate = {};
let zoneInteraction = null;
let activeSignatureZoneId = null;
let latestFindings = [];
let isMetadataPanelOpen = true;
const complianceUndoStack = [];
const complianceRedoStack = [];
let isApplyingComplianceSnapshot = false;

const PREFERENCES_KEY = "compliancepdf.viewerPreferences";
const COMPLIANCE_SCAN_TIMEOUT_MS = 15000;
let statusCardUpdateTimer = null;
let complianceScanRequestCounter = 0;

backgroundPort.onMessage.addListener((message) => {
  if (message.type === MESSAGE_TYPES.SIDE_PANEL_COMMAND) {
    handleSidePanelCommand(message.payload);
  }
});

chrome.runtime.sendMessage({ type: MESSAGE_TYPES.VIEWER_READY });

bootstrap();

async function bootstrap() {
  const preferences = await loadPreferences();
  currentMode = preferences.mode ?? EDIT_MODES.OBJECT;
  editLayerManager.setMode(currentMode);
  setActiveModeButton(currentMode);
  bindTopToolbar();
  applyPreferencesToUi(preferences);
  resetComplianceHistory();
  objectManager.setInteractiveMode(currentMode === EDIT_MODES.OBJECT);
  refreshFindingNavButtons();

  const params = new URLSearchParams(window.location.search);
  const src = params.get("src");
  setAdvancedToolsOpen(!src);
  if (src) {
    try {
      await loadPdfFromSource(src);
    } catch (_) {
      // Error is already rendered in viewer surface.
    }
  }

  fileInput?.addEventListener("change", async (event) => {
    const file = event.target.files?.[0];
    if (!file) {
      return;
    }
    try {
      const bytes = await file.arrayBuffer();
      await loadPdfFromBytes(bytes, file.name);
    } catch (_) {
      // Error is already rendered in viewer surface.
    }
  });

  saveBtn?.addEventListener("click", saveCurrentPdf);
  runComplianceBtn?.addEventListener("click", runComplianceScan);
  exportEvidenceBtn?.addEventListener("click", exportEvidenceBundleFile);
  window.addEventListener("keydown", handleObjectKeyboard);
  window.addEventListener("resize", applyMetadataPanelVisibility);
}

function bindTopToolbar() {
  document.querySelectorAll(".segment").forEach((button) => {
    button.addEventListener("click", () => {
      const mode = button.dataset.mode;
      handleSidePanelCommand({
        command: "SET_EDIT_MODE",
        mode
      });
      setActiveModeButton(mode);
    });
  });

  themeToggleBtn?.addEventListener("click", () => {
    isLightTheme = !isLightTheme;
    document.body.classList.toggle("theme-light", isLightTheme);
    themeToggleBtn.textContent = isLightTheme ? "Theme: Light" : "Theme: Dark";
    persistPreferences();
  });

  exportPreset?.addEventListener("change", () => {
    persistPreferences();
    showStatusToast(`Export preset: ${exportPreset.value}`);
  });
  uiDensityPreset?.addEventListener("change", () => {
    applyDensityPreset(String(uiDensityPreset.value));
    persistPreferences();
  });
  toggleMetaPanelBtn?.addEventListener("click", () => {
    isMetadataPanelOpen = !isMetadataPanelOpen;
    applyMetadataPanelVisibility();
    persistPreferences();
  });
  advancedToolsBtn?.addEventListener("click", () => {
    const isOpen = document.body.classList.contains("advanced-tools-open");
    setAdvancedToolsOpen(!isOpen);
  });

  compliancePolicy?.addEventListener("change", () => {
    pushComplianceUndoSnapshot();
    persistPreferences();
  });
  signatureZoneTemplate?.addEventListener("change", () => {
    pushComplianceUndoSnapshot();
    ensureActiveZoneForTemplate();
    syncZoneInputsFromTemplate();
    renderSignatureZoneOverlays();
    persistPreferences();
  });
  showSignatureZoneToggle?.addEventListener("change", () => {
    pushComplianceUndoSnapshot();
    renderSignatureZoneOverlays();
    persistPreferences();
  });
  showEvidenceHeatmapToggle?.addEventListener("change", () => {
    pushComplianceUndoSnapshot();
    if (lastComplianceBundle?.findings) {
      renderComplianceHighlights(lastComplianceBundle.findings);
    }
    persistPreferences();
  });
  undoComplianceBtn?.addEventListener("click", undoComplianceAction);
  redoComplianceBtn?.addEventListener("click", redoComplianceAction);
  signatureZoneList?.addEventListener("change", () => {
    activeSignatureZoneId = signatureZoneList.value || null;
    syncZoneInputsFromTemplate();
    renderSignatureZoneOverlays();
    refreshZoneControls();
  });
  signatureZoneKind?.addEventListener("change", () => {
    pushComplianceUndoSnapshot();
    updateActiveZoneKind(String(signatureZoneKind.value ?? "main"));
  });
  addSignatureZoneBtn?.addEventListener("click", addExpectedSignatureZone);
  removeSignatureZoneBtn?.addEventListener("click", removeSelectedSignatureZone);
  saveZoneTemplateBtn?.addEventListener("click", saveZoneTemplateOverride);
  resetZoneTemplateBtn?.addEventListener("click", resetZoneTemplateOverride);
  prevFindingBtn?.addEventListener("click", () => focusAdjacentFinding(-1));
  nextFindingBtn?.addEventListener("click", () => focusAdjacentFinding(1));
  window.addEventListener("pointermove", handleZonePointerMove);
  window.addEventListener("pointerup", stopZoneInteraction);
  bindObjectInspectorInputs();

  const snapGridToggle = document.getElementById("snapGridToggle");
  const snapGridSize = document.getElementById("snapGridSize");
  const applySnap = () => {
    const pageNumber = selectedObjectPageNumber ?? getState().pages?.[0]?.pageNumber;
    const stepMm = Number(snapGridSize?.value ?? 10);
    const stepPx = getGridStepPx(pageNumber, stepMm);
    objectManager.setSnapGrid(Boolean(snapGridToggle?.checked), stepPx);
    persistPreferences();
  };
  snapGridToggle?.addEventListener("change", applySnap);
  snapGridSize?.addEventListener("change", applySnap);

  document.getElementById("debugTextToggle")?.addEventListener("change", (event) => {
    textDebugEnabled = Boolean(event.target.checked);
    refreshDebugLayers();
    persistPreferences();
  });
  applyMetadataPanelVisibility();
  refreshShortcutHints();
  updateEvidenceExportAvailability();
  setComplianceScanState("idle", "Run scan to generate compliance evidence.");

}

function setAdvancedToolsOpen(open) {
  const shouldOpen = Boolean(open);
  document.body.classList.toggle("advanced-tools-open", shouldOpen);
  if (advancedToolsBtn) {
    advancedToolsBtn.setAttribute("aria-expanded", shouldOpen ? "true" : "false");
    advancedToolsBtn.textContent = shouldOpen ? "Advance tools ▴" : "Advance tools ▾";
  }
}

function setActiveModeButton(mode) {
  document.querySelectorAll(".segment").forEach((button) => {
    const isActive = button.dataset.mode === mode;
    button.classList.toggle("active", isActive);
    button.setAttribute("aria-pressed", isActive ? "true" : "false");
  });
}

async function loadPdfFromSource(url) {
  const resolvedUrl = resolvePdfSourceUrl(url);
  const response = await fetch(resolvedUrl, {
    credentials: "include"
  });
  if (!response.ok) {
    throw new Error(`Unable to fetch PDF (${response.status} ${response.statusText})`);
  }
  const contentType = String(response.headers.get("content-type") ?? "").toLowerCase();
  if (!contentType.includes("pdf") && !looksLikePdfUrl(resolvedUrl)) {
    throw new Error("Source URL does not appear to be a PDF file");
  }
  const bytes = await response.arrayBuffer();
  await loadPdfFromBytes(bytes, resolvedUrl);
}

async function loadPdfFromBytes(bytes, sourceLabel) {
  try {
    setLoading(true, "Parsing PDF...");
    sourceBytes = bytes;
    currentMetadataInfo = {};
    currentCryptographicSignature = null;
    currentCryptographicSignaturePromise = null;
    cryptographicVerificationRequestCounter += 1;
    objectManager.setDigitalSignatureDetected(false);
    lastComplianceBundle = null;
    latestFindings = [];
    resetComplianceHistory();
    updateEvidenceExportAvailability();
    setComplianceScanState("idle", "Run scan to generate compliance evidence.");
    resetDocumentState(sourceLabel);
    clearHistory();
    currentPdf = await loadPdfDocument(bytes);
    await updateMetadataPanel(currentPdf, sourceLabel);
    await renderAllPages(currentPdf);
    void ensureCryptographicSignatureVerification();
    applyDefaultEditModeForLoadedFile();
    showStatusToast("PDF loaded successfully.", "success");
  } catch (error) {
    setAdvancedToolsOpen(true);
    renderViewerError(error);
    showStatusToast("Failed to load PDF.", "error");
    throw error;
  } finally {
    setLoading(false);
  }
}

function resolvePdfSourceUrl(rawUrl) {
  let current = String(rawUrl ?? "").trim();
  if (!current) {
    return current;
  }
  for (let depth = 0; depth < 4; depth += 1) {
    let nextUrl = null;
    try {
      const parsed = new URL(current);
      for (const key of ["src", "file", "url"]) {
        const value = parsed.searchParams.get(key);
        if (!value) {
          continue;
        }
        const normalized = value.trim();
        if (normalized && normalized !== current) {
          nextUrl = normalized;
          break;
        }
      }
    } catch (_) {
      break;
    }
    if (!nextUrl) {
      break;
    }
    current = nextUrl;
  }
  return current;
}

function looksLikePdfUrl(url) {
  const normalized = String(url ?? "").toLowerCase();
  return normalized.includes(".pdf") || normalized.startsWith("blob:") || normalized.startsWith("file:");
}

async function renderAllPages(pdfDoc) {
  viewerRoot.replaceChildren();
  selectedObjectBadgeByPage.clear();
  signatureZoneLayerByPage.clear();
  imageMaskLayerByPage.clear();
  const detectedFontNames = new Set();
  let totalTextFragments = 0;
  let totalDetectedObjects = 0;

  for (let pageNumber = 1; pageNumber <= pdfDoc.numPages; pageNumber += 1) {
    const page = await pdfDoc.getPage(pageNumber);
    const pageShell = document.createElement("section");
    pageShell.className = "page-shell";

    const canvas = document.createElement("canvas");
    canvas.className = "pdf-canvas";
    pageShell.append(canvas);
    const imageMaskLayer = document.createElement("div");
    imageMaskLayer.className = "image-mask-layer";
    pageShell.append(imageMaskLayer);
    imageMaskLayerByPage.set(pageNumber, imageMaskLayer);

    const viewport = await renderPdfPage(page, canvas);
    pageShell.style.width = `${viewport.width}px`;
    pageShell.style.height = `${viewport.height}px`;
    viewerRoot.append(pageShell);

    const fragments = await extractTextFragments(page, viewport);
    totalTextFragments += fragments.length;
    fragments.forEach((fragment) => {
      const fontName = String(fragment.fontName ?? "").trim();
      if (fontName) {
        detectedFontNames.add(fontName);
      }
    });
    const paragraphs = detectParagraphs(fragments);
    const baseStyle = getState().style;
    const blocks = paragraphs.map((para, idx) => ({
      id: `p${pageNumber}-${idx}`,
      pageNumber,
      x: Math.max(0, para.x ?? 24),
      y: Math.max(0, para.y ?? para.top),
      width: Math.min(viewport.width, Math.max(48, para.width ?? 220)),
      height: Math.max(18, para.height ?? 40),
      lineHeight: Math.max(14, para.fontSize ? para.fontSize * 1.25 : estimateLineHeight(baseStyle)),
      text: para.text,
      style: {
        ...baseStyle,
        fontFamily: mapPdfFontToCss(para.fontName),
        fontSize: Math.max(10, Math.min(32, Math.round(para.fontSize ?? baseStyle.fontSize))),
        textAlign: mapDirectionToAlign(para.direction)
      },
      direction: para.direction ?? "ltr"
    }));

    const detectedObjects = await extractPageObjects(page, viewport);
    totalDetectedObjects += detectedObjects.length;
    const nativeObjects = buildEditableNativeObjects(canvas, detectedObjects);

    updateState((draft) => {
      draft.pages.push({
        pageNumber,
        width: viewport.width,
        height: viewport.height
      });
      draft.textBlocks[pageNumber] = blocks;
      draft.objectBlocks[pageNumber] = nativeObjects;
    });

    const layers = editLayerManager.registerPageLayer(pageNumber, pageShell, viewport);
    editLayerManager.renderTextBlocks(pageNumber, blocks, getState().style, selectedTextBlockId);
    renderDebugFragments(pageNumber, pageShell, fragments);
    await objectManager.attachPageCanvas(pageNumber, layers.objectLayer, nativeObjects);
    renderImageMaskOverlaysForPage(
      pageNumber,
      nativeObjects,
      objectManager.getImageMaskRects(pageNumber)
    );
  }
  renderFontMetadataStatus(detectedFontNames);
  renderScanQualityStatus({
    pageCount: Number(pdfDoc?.numPages ?? 0),
    textFragmentCount: totalTextFragments,
    fontCount: detectedFontNames.size,
    objectCount: totalDetectedObjects
  });
  renderSignatureZoneOverlays();
}

function buildEditableNativeObjects(pageCanvas, objects) {
  const sourceObjects = (objects ?? []).map((object) => ({ ...object }));
  const signatureIndices = [];

  sourceObjects.forEach((object, index) => {
    const isImageObject = String(object.type ?? "").toLowerCase() === "image";
    if (isImageObject) {
      object.bboxRole = "image";
      object.showBBox = true;
    } else if (isSignatureCandidateObject(object)) {
      signatureIndices.push(index);
      object.bboxRole = object.type === "image" ? "image" : "signature";
      object.showBBox = true;
    } else {
      object.showBBox = false;
    }
  });

  // If a signature exists, show nearby stamp-like objects too.
  if (signatureIndices.length > 0) {
    sourceObjects.forEach((object, index) => {
      if (object.showBBox || !isStampCandidateObject(object)) {
        return;
      }
      const nearSignature = signatureIndices.some((sigIndex) =>
        areObjectsNear(sourceObjects[sigIndex], object)
      );
      if (nearSignature) {
        sourceObjects[index].bboxRole = "stamp";
        sourceObjects[index].showBBox = true;
      }
    });
  }

  // Hydrate native image objects with real bitmap snapshots so Object Edit manipulates image content,
  // not only a transparent bbox proxy.
  sourceObjects.forEach((object) => {
    if (String(object.type ?? "").toLowerCase() !== "image" || object.src) {
      return;
    }
    const preview = cropCanvasRegionAsDataUrl(pageCanvas, object);
    if (preview) {
      object.src = preview;
      object.source = object.source ?? "pdf-native";
    }
  });

  return sourceObjects;
}

function isLikelySignatureCandidate(object) {
  const width = object.width ?? 0;
  const height = object.height ?? 1;
  const ratio = width / Math.max(1, height);
  return width >= 40 && height >= 10 && ratio >= 1.5 && ratio <= 9;
}

function isSignatureCandidateObject(object) {
  if (!object) return false;
  const type = String(object.type ?? "").toLowerCase();
  const ratio = (object.width ?? 1) / Math.max(1, object.height ?? 1);
  const width = Number(object.width ?? 0);
  const height = Number(object.height ?? 0);
  const supportsSignatureShape =
    type === "image" || type === "polygon" || type === "path" || type === "vector";
  return supportsSignatureShape && width >= 40 && height >= 12 && ratio >= 1.5 && ratio <= 9;
}

function isStampCandidateObject(object) {
  if (!object) return false;
  const type = String(object.type ?? "").toLowerCase();
  const ratio = (object.width ?? 1) / Math.max(1, object.height ?? 1);
  const width = Number(object.width ?? 0);
  const height = Number(object.height ?? 0);
  const supportsStampShape = type === "image" || type === "vector" || type === "polygon" || type === "rect";
  return supportsStampShape && width >= 24 && height >= 24 && width <= 220 && height <= 220 && ratio >= 0.8 && ratio <= 1.25;
}

function areObjectsNear(a, b) {
  const aCx = (a.x ?? 0) + (a.width ?? 0) / 2;
  const aCy = (a.y ?? 0) + (a.height ?? 0) / 2;
  const bCx = (b.x ?? 0) + (b.width ?? 0) / 2;
  const bCy = (b.y ?? 0) + (b.height ?? 0) / 2;
  const dx = Math.abs(aCx - bCx);
  const dy = Math.abs(aCy - bCy);
  return dx <= 260 && dy <= 220;
}

function mapPdfFontToCss(fontName) {
  const source = String(fontName ?? "").toLowerCase();
  const normalized = source.replace(/[^a-z0-9]+/g, "");
  if (normalized.includes("times")) return "Times New Roman";
  if (normalized.includes("courier")) return "Courier New";
  if (normalized.includes("calibri")) return "Calibri, Arial, sans-serif";
  if (normalized.includes("tahoma")) return "Tahoma, Arial, sans-serif";
  if (normalized.includes("segoeui")) return "Segoe UI, Arial, sans-serif";
  if (normalized.includes("arial") || normalized.includes("helvetica")) return "Arial";
  if (normalized.includes("dejavusans")) return "DejaVu Sans, Arial, sans-serif";
  if (normalized.includes("noto")) return "Noto Sans, Arial, sans-serif";
  if (source.includes("times")) return "Times New Roman";
  if (source.includes("courier")) return "Courier New";
  if (source.includes("arial") || source.includes("helvetica")) return "Arial";
  if (source.includes("symbol")) return "Arial";
  return "Arial";
}

function mapDirectionToAlign(direction) {
  return direction === "rtl" ? "right" : "left";
}

function renderDebugFragments(pageNumber, pageShell, fragments) {
  let layer = debugLayerByPage.get(pageNumber);
  if (!layer) {
    layer = document.createElement("div");
    layer.className = "debug-fragment-layer";
    layer.style.position = "absolute";
    layer.style.inset = "0";
    layer.style.pointerEvents = "none";
    debugLayerByPage.set(pageNumber, layer);
    pageShell.append(layer);
  }

  layer.replaceChildren();
  if (!textDebugEnabled) {
    layer.style.display = "none";
    return;
  }
  layer.style.display = "block";
  fragments.forEach((fragment) => {
    const box = document.createElement("div");
    box.className = "debug-text-fragment";
    box.style.left = `${fragment.x}px`;
    box.style.top = `${fragment.y}px`;
    box.style.width = `${Math.max(1, fragment.width)}px`;
    box.style.height = `${Math.max(1, fragment.height)}px`;
    layer.append(box);
  });
}

function refreshDebugLayers() {
  debugLayerByPage.forEach((layer) => {
    layer.style.display = textDebugEnabled ? "block" : "none";
  });
}

function cropCanvasRegionAsDataUrl(canvas, object) {
  const x = Math.max(0, Math.floor(object.x ?? 0));
  const y = Math.max(0, Math.floor(object.y ?? 0));
  const width = Math.max(6, Math.floor(object.width ?? 0));
  const height = Math.max(6, Math.floor(object.height ?? 0));
  if (width < 2 || height < 2 || x >= canvas.width || y >= canvas.height) {
    return null;
  }

  const sw = Math.min(width, canvas.width - x);
  const sh = Math.min(height, canvas.height - y);
  if (sw < 2 || sh < 2) {
    return null;
  }

  const temp = document.createElement("canvas");
  temp.width = sw;
  temp.height = sh;
  const ctx = temp.getContext("2d");
  if (!ctx) {
    return null;
  }
  ctx.drawImage(canvas, x, y, sw, sh, 0, 0, sw, sh);
  return temp.toDataURL("image/png");
}

function renderImageMaskOverlaysForPage(pageNumber, objects, maskRects = null) {
  const layer = imageMaskLayerByPage.get(pageNumber);
  if (!layer) {
    return;
  }
  layer.replaceChildren();
  const rects = Array.isArray(maskRects) && maskRects.length > 0
    ? maskRects
    : (objects ?? [])
      .filter((object) => object?.type === "image" && object?.src && object?.showBBox)
      .map((object) => ({
        x: Number(object.x ?? 0),
        y: Number(object.y ?? 0),
        width: Number(object.width ?? 0),
        height: Number(object.height ?? 0),
        angle: Number(object.angle ?? 0)
      }));
  rects.forEach((rect) => {
    const mask = document.createElement("div");
    mask.className = "image-mask-box";
    const bleed = 2;
    const x = Number(rect.x ?? 0) - bleed;
    const y = Number(rect.y ?? 0) - bleed;
    const width = Math.max(4, Number(rect.width ?? 0) + bleed * 2);
    const height = Math.max(4, Number(rect.height ?? 0) + bleed * 2);
    const angle = Number(rect.angle ?? 0);
    mask.style.left = `${x}px`;
    mask.style.top = `${y}px`;
    mask.style.width = `${width}px`;
    mask.style.height = `${height}px`;
    if (Number.isFinite(angle) && Math.abs(angle) > 0.01 && !(Array.isArray(maskRects) && maskRects.length > 0)) {
      mask.style.transformOrigin = "top left";
      mask.style.transform = `rotate(${angle}deg)`;
    }
    layer.append(mask);
  });
}

function handleBlockEdited(pageNumber, editedBlock) {
  pushUndoSnapshot();
  updateState((draft) => {
    const blocks = draft.textBlocks[pageNumber] ?? [];
    const index = blocks.findIndex((item) => item.id === editedBlock.id);
    if (index >= 0) {
      blocks[index] = { ...blocks[index], ...editedBlock };
    }
  });

  const state = getState();
  const allBlocks = new Map();
  Object.values(state.textBlocks).forEach((arr) => arr.forEach((b) => allBlocks.set(b.id, b)));
  flowManager.relayoutChain(allBlocks, editedBlock.id);
}

function handleSidePanelCommand(payload) {
  switch (payload.command) {
    case "SET_EDIT_MODE":
      updateState((draft) => {
        draft.editMode = payload.mode;
      });
      editLayerManager.setMode(payload.mode);
      objectManager.setInteractiveMode(payload.mode === EDIT_MODES.OBJECT);
      currentMode = payload.mode;
      setActiveModeButton(payload.mode);
      refreshShortcutHints();
      syncToolbarModeState();
      showStatusToast(`Switched to ${payload.mode} mode.`);
      persistPreferences();
      break;
    case "SET_TEXT_STYLE":
      pushUndoSnapshot();
      updateState((draft) => {
        const style = { ...draft.style, ...payload.style };
        draft.style = style;
        if (selectedTextBlockId) {
          for (const pageBlocks of Object.values(draft.textBlocks)) {
            const block = pageBlocks.find((item) => item.id === selectedTextBlockId);
            if (block) {
              block.style = style;
              block.lineHeight = estimateLineHeight(style);
              break;
            }
          }
        }
      });
      redrawTextLayers();
      break;
    case "START_LINK_BLOCK_SELECTION":
      setupLinkSelection();
      break;
    case "SAVE_PDF":
      saveCurrentPdf();
      break;
    case "UNDO":
      applyUndo();
      break;
    case "REDO":
      applyRedo();
      break;
    case "ADD_RECT_OBJECT":
      addRectangleToActivePage();
      break;
    case "CLEAR_SELECTION":
      selectedTextBlockId = null;
      selectedTextPageNumber = null;
      clearActiveObjectSelection();
      redrawTextLayers();
      break;
    case "DUPLICATE_OBJECT":
      duplicateActiveObject();
      break;
    case "DELETE_OBJECT":
      removeActiveObject();
      break;
    case "ADD_IMAGE_OBJECT":
      addImageObject(payload.dataUrl);
      break;
    case "TRANSFORM_OBJECT":
      transformActiveObject(payload.changes ?? {});
      break;
    case "FLIP_OBJECT_X":
      toggleFlip("x");
      break;
    case "FLIP_OBJECT_Y":
      toggleFlip("y");
      break;
    case "BRING_OBJECT_FORWARD":
      bringObjectForward();
      break;
    case "SEND_OBJECT_BACKWARD":
      sendObjectBackward();
      break;
    case "TOGGLE_OBJECT_LOCK":
      objectLockState = !objectLockState;
      transformActiveObject({ locked: objectLockState });
      break;
    default:
      break;
  }
}

function setupLinkSelection() {
  const blockElements = viewerRoot.querySelectorAll(".editable-text-block");
  blockElements.forEach((element) => {
    element.onclick = () => {
      const blockId = element.dataset.blockId;
      if (!blockId) {
        return;
      }
      if (!selectedLinkSource) {
        selectedLinkSource = blockId;
        element.style.outlineColor = "#16a34a";
        return;
      }
      flowManager.linkBlocks(selectedLinkSource, blockId);
      selectedLinkSource = null;
      redrawTextLayers();
    };
  });
}

function redrawTextLayers() {
  const state = getState();
  Object.entries(state.textBlocks).forEach(([pageNumber, blocks]) => {
    editLayerManager.renderTextBlocks(
      Number(pageNumber),
      blocks,
      state.style,
      selectedTextBlockId
    );
  });
}

async function saveCurrentPdf() {
  if (!sourceBytes) {
    return;
  }
  setLoading(true, "Exporting PDF...");
  try {
    const bytes = await exportEditedPdf({
      sourceBytes,
      state: getState(),
      options: { preset: String(exportPreset?.value ?? "editable") }
    });

    const blob = new Blob([bytes], { type: "application/pdf" });
    const url = URL.createObjectURL(blob);

    await chrome.runtime.sendMessage({
      type: MESSAGE_TYPES.EXPORT_PDF_DONE,
      payload: { size: bytes.byteLength }
    });

    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "flexipdf-edited.pdf";
    anchor.click();
    URL.revokeObjectURL(url);
    showStatusToast("PDF exported.", "success");
  } catch (_) {
    showStatusToast("Export failed.", "error");
  } finally {
    setLoading(false);
  }
}

function renderViewerError(error) {
  viewerRoot.replaceChildren();
  const panel = document.createElement("div");
  panel.style.background = "#fff1f2";
  panel.style.color = "#9f1239";
  panel.style.border = "1px solid #fecdd3";
  panel.style.borderRadius = "10px";
  panel.style.padding = "12px";
  panel.textContent = `Cannot load PDF: ${error?.message ?? "Unknown error"}. Open Advance tools and choose the PDF file manually if needed.`;
  viewerRoot.append(panel);
}

function handleBlockSelected(_pageNumber, blockId) {
  if (selectedTextBlockId === blockId) {
    return;
  }
  selectedTextBlockId = blockId;
  selectedTextPageNumber = _pageNumber;
  redrawTextLayers();
}

function snapshotForHistory() {
  const state = getState();
  return {
    textBlocks: structuredClone(state.textBlocks),
    style: structuredClone(state.style),
    objectBlocks: structuredClone(state.objectBlocks)
  };
}

function pushUndoSnapshot() {
  undoStack.push(snapshotForHistory());
  if (undoStack.length > 60) {
    undoStack.shift();
  }
  redoStack.length = 0;
}

function applyUndo() {
  const prev = undoStack.pop();
  if (!prev) {
    return;
  }
  redoStack.push(snapshotForHistory());
  updateState((draft) => {
    draft.textBlocks = structuredClone(prev.textBlocks);
    draft.style = structuredClone(prev.style);
    draft.objectBlocks = structuredClone(prev.objectBlocks);
  });
  syncObjectLayersFromState();
  redrawTextLayers();
}

function applyRedo() {
  const next = redoStack.pop();
  if (!next) {
    return;
  }
  undoStack.push(snapshotForHistory());
  updateState((draft) => {
    draft.textBlocks = structuredClone(next.textBlocks);
    draft.style = structuredClone(next.style);
    draft.objectBlocks = structuredClone(next.objectBlocks);
  });
  syncObjectLayersFromState();
  redrawTextLayers();
}

function clearHistory() {
  undoStack.length = 0;
  redoStack.length = 0;
}

function addRectangleToActivePage() {
  ensureObjectMode();
  pushUndoSnapshot();
  const state = getState();
  const pageNumber =
    selectedObjectPageNumber ?? selectedTextPageNumber ?? state.pages?.[0]?.pageNumber;
  if (!pageNumber) {
    return;
  }
  objectManager.addRectangle(pageNumber, {
    x: 70,
    y: 70,
    width: 160,
    height: 80
  });
}

function duplicateActiveObject() {
  const pageNumber = selectedObjectPageNumber ?? getState().pages?.[0]?.pageNumber;
  if (!pageNumber) {
    return;
  }
  pushUndoSnapshot();
  objectManager.duplicateActive(pageNumber);
}

function removeActiveObject() {
  const pageNumber = selectedObjectPageNumber ?? getState().pages?.[0]?.pageNumber;
  if (!pageNumber) {
    return;
  }
  pushUndoSnapshot();
  objectManager.removeActive(pageNumber);
}

function clearActiveObjectSelection() {
  const pageNumber = selectedObjectPageNumber ?? getState().pages?.[0]?.pageNumber;
  if (!pageNumber) {
    return;
  }
  objectManager.clearSelection(pageNumber);
}

async function addImageObject(dataUrl) {
  ensureObjectMode();
  const pageNumber = selectedObjectPageNumber ?? getState().pages?.[0]?.pageNumber;
  if (!pageNumber || !dataUrl) {
    return;
  }
  pushUndoSnapshot();
  await objectManager.addImage(pageNumber, dataUrl);
}

function transformActiveObject(changes) {
  ensureObjectMode();
  const pageNumber = selectedObjectPageNumber ?? getState().pages?.[0]?.pageNumber;
  if (!pageNumber) {
    return;
  }
  pushUndoSnapshot();
  objectManager.transformActive(pageNumber, changes);
}

function toggleFlip(axis) {
  ensureObjectMode();
  const selected = getState().selectedObject;
  if (!selected) {
    return;
  }
  if (axis === "x") {
    transformActiveObject({ flipX: !selected.flipX });
    return;
  }
  transformActiveObject({ flipY: !selected.flipY });
}

function bringObjectForward() {
  ensureObjectMode();
  const pageNumber = selectedObjectPageNumber ?? getState().pages?.[0]?.pageNumber;
  if (!pageNumber) {
    return;
  }
  pushUndoSnapshot();
  objectManager.bringForward(pageNumber);
}

function sendObjectBackward() {
  ensureObjectMode();
  const pageNumber = selectedObjectPageNumber ?? getState().pages?.[0]?.pageNumber;
  if (!pageNumber) {
    return;
  }
  pushUndoSnapshot();
  objectManager.sendBackward(pageNumber);
}

function handleObjectKeyboard(event) {
  if (handleModeHotkeys(event)) {
    return;
  }

  const state = getState();
  if (state.editMode !== EDIT_MODES.OBJECT) {
    return;
  }
  const pageNumber = selectedObjectPageNumber ?? state.pages?.[0]?.pageNumber;
  if (!pageNumber) {
    return;
  }

  const step = event.shiftKey ? 10 : 2;
  if (event.key === "Delete" || event.key === "Backspace") {
    event.preventDefault();
    removeActiveObject();
    return;
  }
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "d") {
    event.preventDefault();
    duplicateActiveObject();
    return;
  }

  let deltaX = 0;
  let deltaY = 0;
  if (event.key === "ArrowLeft") deltaX = -step;
  if (event.key === "ArrowRight") deltaX = step;
  if (event.key === "ArrowUp") deltaY = -step;
  if (event.key === "ArrowDown") deltaY = step;
  if (deltaX === 0 && deltaY === 0) {
    return;
  }
  event.preventDefault();
  pushUndoSnapshot();
  objectManager.nudgeActive(pageNumber, deltaX, deltaY);
}

function handleModeHotkeys(event) {
  const tag = String(event.target?.tagName ?? "").toLowerCase();
  if (tag === "input" || tag === "textarea" || event.target?.isContentEditable) {
    return false;
  }
  if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLowerCase() === "z") {
    event.preventDefault();
    undoComplianceAction();
    return true;
  }
  if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLowerCase() === "y") {
    event.preventDefault();
    redoComplianceAction();
    return true;
  }
  const key = event.key.toLowerCase();
  if (key === "r") {
    event.preventDefault();
    runComplianceScan();
    return true;
  }
  if (key === "e") {
    event.preventDefault();
    exportEvidenceBundleFile();
    return true;
  }
  if (event.key === "[" || event.key === "]") {
    event.preventDefault();
    focusAdjacentFinding(event.key === "[" ? -1 : 1);
    return true;
  }
  if (key === "v") {
    handleSidePanelCommand({ command: "SET_EDIT_MODE", mode: EDIT_MODES.VIEW });
    event.preventDefault();
    return true;
  }
  if (key === "t") {
    handleSidePanelCommand({ command: "SET_EDIT_MODE", mode: EDIT_MODES.TEXT });
    event.preventDefault();
    return true;
  }
  if (key === "o") {
    handleSidePanelCommand({ command: "SET_EDIT_MODE", mode: EDIT_MODES.OBJECT });
    event.preventDefault();
    return true;
  }
  return false;
}

function syncObjectLayersFromState() {
  const objectBlocks = getState().objectBlocks ?? {};
  Object.entries(objectBlocks).forEach(([pageNumber, objects]) => {
    objectManager.syncPageObjects(Number(pageNumber), objects);
  });
}

function ensureObjectMode() {
  const state = getState();
  if (state.editMode === EDIT_MODES.OBJECT) {
    return;
  }
  updateState((draft) => {
    draft.editMode = EDIT_MODES.OBJECT;
  });
  editLayerManager.setMode(EDIT_MODES.OBJECT);
  objectManager.setInteractiveMode(true);
  setActiveModeButton(EDIT_MODES.OBJECT);
  currentMode = EDIT_MODES.OBJECT;
  refreshShortcutHints();
  syncToolbarModeState();
}

function syncTopObjectInspector(selection) {
  if (!selection) {
    setInputValue("topObjectType", "Type: none");
    setInputValue("topObjectHint", "No object selected");
    setInputValue("topObjectA4Pct", "A4: --");
    updateTopToolbarByType(null);
    syncToolbarModeState();
    return;
  }
  setInputValue("topObjectType", `Type: ${selection.type ?? "unknown"}`);
  setInputValue("topObjectHint", getTypeHint(selection.type));
  setInputValue("topX", selection.x);
  setInputValue("topY", selection.y);
  setInputValue("topWidth", selection.width);
  setInputValue("topHeight", selection.height);
  setInputValue("topOpacity", selection.opacity ?? 1);
  setInputValue("topRotate", selection.angle ?? 0);
  setInputValue("topScaleX", selection.scaleX ?? 1);
  setInputValue("topScaleY", selection.scaleY ?? 1);
  if (selection.fill) setInputValue("topFill", selection.fill);
  if (selection.stroke) setInputValue("topStroke", selection.stroke);
  setInputValue("topStrokeWidth", selection.strokeWidth ?? 1.5);
  syncA4Percent(selection);
  updateTopToolbarByType(selection.type ?? null);
  syncToolbarModeState();
}

function setInputValue(id, value) {
  const element = document.getElementById(id);
  if (!element || value === undefined || value === null) {
    return;
  }
  if (element.tagName === "SPAN") {
    element.textContent = String(value);
    return;
  }
  element.value = typeof value === "number" ? String(round(value)) : String(value);
}

function round(value) {
  return Math.round(value * 100) / 100;
}

function updateTopToolbarByType(type) {
  const isImage = type === "image";
  const isVector = type === "polygon" || type === "rect" || type === "vector";
  const isMedia = type === "media";
  const hasType = Boolean(type);

  [
    "topX",
    "topY",
    "topWidth",
    "topHeight",
    "topOpacity",
    "topRotate",
    "topScaleX",
    "topScaleY",
    "topA4WPercent",
    "topA4HPercent"
  ].forEach((id) => setControlDisabled(id, !hasType));
  setControlDisabled("topFill", !hasType || isImage || isMedia);
  setControlDisabled("topStroke", !hasType || isImage || isMedia);
  setControlDisabled("topStrokeWidth", !hasType || isImage || isMedia);
  if (isVector && hasType) {
    setInputValue("topObjectHint", "Vector mode: geometry + style editable");
  }
}

function setControlDisabled(id, disabled) {
  const element = document.getElementById(id);
  if (!element) return;
  element.disabled = Boolean(disabled);
}

function bindObjectInspectorInputs() {
  const inputIds = [
    "topX",
    "topY",
    "topWidth",
    "topHeight",
    "topOpacity",
    "topRotate",
    "topScaleX",
    "topScaleY",
    "topFill",
    "topStroke",
    "topStrokeWidth",
    "topA4WPercent",
    "topA4HPercent"
  ];
  inputIds.forEach((id) => {
    const node = document.getElementById(id);
    if (!node) return;
    node.addEventListener("change", () => applyObjectTransformFromInputs(id.startsWith("topA4")));
  });
}

function applyObjectTransformFromInputs(resizeFromA4Percent) {
  if (currentMode !== EDIT_MODES.OBJECT || !getState().selectedObject) {
    return;
  }
  const changes = {
    x: Number(document.getElementById("topX")?.value ?? 0),
    y: Number(document.getElementById("topY")?.value ?? 0),
    width: Number(document.getElementById("topWidth")?.value ?? 100),
    height: Number(document.getElementById("topHeight")?.value ?? 100),
    opacity: Number(document.getElementById("topOpacity")?.value ?? 1),
    angle: Number(document.getElementById("topRotate")?.value ?? 0),
    scaleX: Number(document.getElementById("topScaleX")?.value ?? 1),
    scaleY: Number(document.getElementById("topScaleY")?.value ?? 1),
    fill: String(document.getElementById("topFill")?.value ?? "#3b82f6"),
    stroke: String(document.getElementById("topStroke")?.value ?? "#2563eb"),
    strokeWidth: Number(document.getElementById("topStrokeWidth")?.value ?? 1.5)
  };
  if (resizeFromA4Percent) {
    const pageNumber = selectedObjectPageNumber ?? getState().pages?.[0]?.pageNumber;
    if (pageNumber) {
      const a4Size = getA4CanvasSize(pageNumber);
      const widthPct = Number(document.getElementById("topA4WPercent")?.value ?? 10);
      const heightPct = Number(document.getElementById("topA4HPercent")?.value ?? 10);
      changes.width = (widthPct / 100) * a4Size.width;
      changes.height = (heightPct / 100) * a4Size.height;
    }
  }
  handleSidePanelCommand({
    command: "TRANSFORM_OBJECT",
    changes
  });
}

function syncToolbarModeState() {
  const disabled = currentMode !== EDIT_MODES.OBJECT;
  document.querySelectorAll(".object-group input").forEach((node) => {
    if (!(node instanceof HTMLInputElement)) return;
    if (!node.disabled) {
      node.readOnly = disabled;
    }
  });
  document.querySelectorAll(".object-group").forEach((node) => {
    node.classList.toggle("muted", disabled);
  });
}

function getTypeHint(type) {
  if (type === "image") return "Image mode: transform, opacity, layer order";
  if (type === "polygon" || type === "rect" || type === "vector") {
    return "Vector mode: transform + fill/stroke controls";
  }
  if (type === "media") return "Media proxy: move/resize/layer controls";
  return "Generic object controls";
}

function syncA4Percent(selection) {
  const pageNumber = selectedObjectPageNumber ?? getState().pages?.[0]?.pageNumber;
  if (!pageNumber) return;
  const a4 = computeA4Percents(selection, pageNumber);
  setInputValue("topA4WPercent", a4.widthPct);
  setInputValue("topA4HPercent", a4.heightPct);
  setInputValue(
    "topObjectA4Pct",
    `A4: W ${round(a4.widthPct)}% H ${round(a4.heightPct)}% Area ${round(a4.areaPct)}% X ${round(a4.xPct)}% Y ${round(a4.yPct)}%`
  );
}

function computeA4Percents(object, pageNumber) {
  const a4 = getA4CanvasSize(pageNumber);
  return {
    widthPct: ((object.width ?? 0) / a4.width) * 100,
    heightPct: ((object.height ?? 0) / a4.height) * 100,
    areaPct: (((object.width ?? 0) * (object.height ?? 0)) / (a4.width * a4.height)) * 100,
    xPct: ((object.x ?? 0) / a4.width) * 100,
    yPct: ((object.y ?? 0) / a4.height) * 100
  };
}

function getA4CanvasSize(pageNumber) {
  const page = getState().pages?.find((item) => item.pageNumber === pageNumber);
  const isLandscape = (page?.width ?? 0) > (page?.height ?? 0);
  const scale = 1.25;
  const a4Width = (isLandscape ? 841.89 : 595.28) * scale;
  const a4Height = (isLandscape ? 595.28 : 841.89) * scale;
  return { width: a4Width, height: a4Height };
}

function getGridStepPx(pageNumber, stepMm) {
  const page = getState().pages?.find((item) => item.pageNumber === pageNumber);
  const isLandscape = (page?.width ?? 0) > (page?.height ?? 0);
  const a4mmWidth = isLandscape ? 297 : 210;
  const a4pxWidth = getA4CanvasSize(pageNumber).width;
  const pxPerMm = a4pxWidth / a4mmWidth;
  return Math.max(2, stepMm * pxPerMm);
}

function showObjectHoverTooltip(pointer, text) {
  if (!objectHoverTooltip || !pointer) return;
  objectHoverTooltip.textContent = text;
  objectHoverTooltip.style.display = "block";
  objectHoverTooltip.style.left = `${Math.round(pointer.x + 14)}px`;
  objectHoverTooltip.style.top = `${Math.round(pointer.y + 18)}px`;
}

function hideObjectHoverTooltip() {
  if (!objectHoverTooltip) return;
  objectHoverTooltip.style.display = "none";
}

function renderSelectedObjectBadge(pageNumber, selection) {
  if (!pageNumber) {
    return;
  }
  const pageShell = viewerRoot.querySelectorAll(".page-shell")[pageNumber - 1];
  if (!pageShell) {
    return;
  }
  let badge = selectedObjectBadgeByPage.get(pageNumber);
  if (!badge) {
    badge = document.createElement("div");
    badge.className = "selected-object-a4-badge";
    badge.style.display = "none";
    selectedObjectBadgeByPage.set(pageNumber, badge);
    pageShell.append(badge);
  }
  if (!selection) {
    badge.style.display = "none";
    return;
  }
  const a4 = computeA4Percents(selection, pageNumber);
  badge.textContent = `A4 W ${round(a4.widthPct)}% | H ${round(a4.heightPct)}%`;
  badge.style.left = `${Math.max(4, (selection.x ?? 0) + 6)}px`;
  badge.style.top = `${Math.max(4, (selection.y ?? 0) - 22)}px`;
  badge.style.display = "block";
}

function syncZoneInputsFromTemplate() {
  ensureActiveZoneForTemplate();
  refreshZoneControls();
  const activeZone = getActiveZoneEntry();
  setZoneInputs(activeZone ?? getSignatureZoneTemplate(getActiveTemplateId()));
}

function saveZoneTemplateOverride() {
  pushComplianceUndoSnapshot();
  const templateId = getActiveTemplateId();
  const zones = getTemplateZoneList(templateId).map((zone) =>
    zone.id === activeSignatureZoneId ? { ...zone, ...getZoneInputsAsRatio() } : zone
  );
  customZoneByTemplate = {
    ...customZoneByTemplate,
    [templateId]: normalizeZoneEntries(zones)
  };
  syncZoneInputsFromTemplate();
  renderSignatureZoneOverlays();
  persistPreferences();
  showStatusToast(`Saved zone override for ${templateId}.`, "success");
}

function resetZoneTemplateOverride() {
  const templateId = getActiveTemplateId();
  if (!window.confirm(`Reset custom zone for template "${templateId}"?`)) {
    showStatusToast("Reset zone cancelled.", "info");
    return;
  }
  pushComplianceUndoSnapshot();
  const next = { ...customZoneByTemplate };
  delete next[templateId];
  customZoneByTemplate = next;
  syncZoneInputsFromTemplate();
  renderSignatureZoneOverlays();
  persistPreferences();
  showStatusToast(`Reset zone override for ${templateId}.`, "success");
}

function getZoneInputsAsRatio() {
  const xMin = Number(document.getElementById("zoneXMin")?.value ?? 52) / 100;
  const xMax = Number(document.getElementById("zoneXMax")?.value ?? 98) / 100;
  const yMin = Number(document.getElementById("zoneYMin")?.value ?? 68) / 100;
  const yMax = Number(document.getElementById("zoneYMax")?.value ?? 98) / 100;
  return normalizeZoneRatio({ xMin, xMax, yMin, yMax });
}

function setZoneInputs(ratio) {
  setInputValue("zoneXMin", round((ratio.xMin ?? 0) * 100));
  setInputValue("zoneXMax", round((ratio.xMax ?? 0) * 100));
  setInputValue("zoneYMin", round((ratio.yMin ?? 0) * 100));
  setInputValue("zoneYMax", round((ratio.yMax ?? 0) * 100));
}

function renderSignatureZoneOverlays() {
  const pages = getState().pages ?? [];
  const shouldShow = Boolean(showSignatureZoneToggle?.checked);
  const zones = getTemplateZoneList(getActiveTemplateId());

  pages.forEach((page, index) => {
    const pageShell = viewerRoot.querySelectorAll(".page-shell")[index];
    if (!pageShell) {
      return;
    }
    let layer = signatureZoneLayerByPage.get(page.pageNumber);
    if (!layer) {
      layer = document.createElement("div");
      layer.className = "signature-zone-layer";
      signatureZoneLayerByPage.set(page.pageNumber, layer);
      pageShell.append(layer);
    }
    layer.replaceChildren();
    if (!shouldShow) {
      layer.style.display = "none";
      return;
    }
    layer.style.display = "block";
    zones.forEach((zone, zoneIndex) => {
      const box = document.createElement("div");
      box.className = `signature-zone-box ${zone.kind === "initial" ? "initial" : "main"}`;
      if (zone.id === activeSignatureZoneId) {
        box.classList.add("selected");
      }
      box.addEventListener("pointerdown", (event) => startZoneMove(event, page, zone.id));
      box.style.left = `${(page.width ?? 0) * zone.xMin}px`;
      box.style.top = `${(page.height ?? 0) * zone.yMin}px`;
      box.style.width = `${(page.width ?? 0) * (zone.xMax - zone.xMin)}px`;
      box.style.height = `${(page.height ?? 0) * (zone.yMax - zone.yMin)}px`;
      const label = document.createElement("span");
      label.className = "signature-zone-label";
      label.textContent = zone.kind === "initial" ? `INITIAL ${zoneIndex + 1}` : `MAIN ${zoneIndex + 1}`;
      box.append(label);
      appendZoneHandles(box, page, zone.id);
      layer.append(box);
    });
  });
}

function getActiveTemplateId() {
  return String(signatureZoneTemplate?.value ?? "generic");
}

function getTemplateZoneList(templateId) {
  const custom = customZoneByTemplate[templateId];
  if (custom) {
    return normalizeZoneEntries(Array.isArray(custom) ? custom : [{ kind: "main", ...custom }]);
  }
  return normalizeZoneEntries(getSignatureZoneTemplates(templateId));
}

function ensureActiveZoneForTemplate() {
  const zones = getTemplateZoneList(getActiveTemplateId());
  if (!zones.length) {
    activeSignatureZoneId = null;
    return;
  }
  if (!zones.some((zone) => zone.id === activeSignatureZoneId)) {
    activeSignatureZoneId = zones.find((zone) => zone.kind === "main")?.id ?? zones[0].id;
  }
}

function getActiveZoneEntry() {
  const zones = getTemplateZoneList(getActiveTemplateId());
  return zones.find((zone) => zone.id === activeSignatureZoneId) ?? zones[0] ?? null;
}

function appendZoneHandles(box, page, zoneId) {
  ["nw", "ne", "sw", "se"].forEach((corner) => {
    const handle = document.createElement("div");
    handle.className = `signature-zone-handle ${corner}`;
    handle.addEventListener("pointerdown", (event) => startZoneResize(event, page, corner, zoneId));
    box.append(handle);
  });
}

function startZoneMove(event, page, zoneId) {
  if (!showSignatureZoneToggle?.checked) return;
  if (event.target !== event.currentTarget) return;
  pushComplianceUndoSnapshot();
  activeSignatureZoneId = zoneId;
  const ratio = getActiveZoneEntry();
  if (!ratio) return;
  refreshZoneControls();
  zoneInteraction = {
    mode: "move",
    page,
    zoneId,
    pointerStartX: event.clientX,
    pointerStartY: event.clientY,
    startRatio: { ...ratio }
  };
  event.preventDefault();
}

function startZoneResize(event, page, corner, zoneId) {
  if (!showSignatureZoneToggle?.checked) return;
  pushComplianceUndoSnapshot();
  activeSignatureZoneId = zoneId;
  const ratio = getActiveZoneEntry();
  if (!ratio) return;
  refreshZoneControls();
  zoneInteraction = {
    mode: "resize",
    page,
    zoneId,
    corner,
    pointerStartX: event.clientX,
    pointerStartY: event.clientY,
    startRatio: { ...ratio }
  };
  event.preventDefault();
  event.stopPropagation();
}

function handleZonePointerMove(event) {
  if (!zoneInteraction) return;
  const pageWidth = Math.max(1, zoneInteraction.page.width ?? 1);
  const pageHeight = Math.max(1, zoneInteraction.page.height ?? 1);
  const dxRatio = (event.clientX - zoneInteraction.pointerStartX) / pageWidth;
  const dyRatio = (event.clientY - zoneInteraction.pointerStartY) / pageHeight;
  const next = { ...zoneInteraction.startRatio };

  if (zoneInteraction.mode === "move") {
    const width = next.xMax - next.xMin;
    const height = next.yMax - next.yMin;
    next.xMin = clamp(zoneInteraction.startRatio.xMin + dxRatio, 0, 1 - width);
    next.yMin = clamp(zoneInteraction.startRatio.yMin + dyRatio, 0, 1 - height);
    next.xMax = next.xMin + width;
    next.yMax = next.yMin + height;
  } else {
    if (zoneInteraction.corner.includes("w")) {
      next.xMin = clamp(zoneInteraction.startRatio.xMin + dxRatio, 0, zoneInteraction.startRatio.xMax - 0.02);
    }
    if (zoneInteraction.corner.includes("e")) {
      next.xMax = clamp(zoneInteraction.startRatio.xMax + dxRatio, zoneInteraction.startRatio.xMin + 0.02, 1);
    }
    if (zoneInteraction.corner.includes("n")) {
      next.yMin = clamp(zoneInteraction.startRatio.yMin + dyRatio, 0, zoneInteraction.startRatio.yMax - 0.02);
    }
    if (zoneInteraction.corner.includes("s")) {
      next.yMax = clamp(zoneInteraction.startRatio.yMax + dyRatio, zoneInteraction.startRatio.yMin + 0.02, 1);
    }
  }

  const normalized = normalizeZoneRatio(next);
  const templateId = getActiveTemplateId();
  const zones = getTemplateZoneList(templateId).map((zone) =>
    zone.id === zoneInteraction.zoneId ? { ...zone, ...normalized } : zone
  );
  customZoneByTemplate = {
    ...customZoneByTemplate,
    [templateId]: normalizeZoneEntries(zones)
  };
  activeSignatureZoneId = zoneInteraction.zoneId;
  setZoneInputs(normalized);
  renderSignatureZoneOverlays();
  refreshZoneControls();
}

function stopZoneInteraction() {
  if (!zoneInteraction) return;
  zoneInteraction = null;
  persistPreferences();
}

function normalizeZoneRatio(zone) {
  const xMin = clamp(zone.xMin, 0, 1);
  const xMax = clamp(zone.xMax, 0, 1);
  const yMin = clamp(zone.yMin, 0, 1);
  const yMax = clamp(zone.yMax, 0, 1);
  return {
    xMin: Math.min(xMin, xMax),
    xMax: Math.max(xMin, xMax),
    yMin: Math.min(yMin, yMax),
    yMax: Math.max(yMin, yMax)
  };
}

function refreshZoneControls() {
  const zones = getTemplateZoneList(getActiveTemplateId());
  if (signatureZoneList) {
    signatureZoneList.replaceChildren();
    zones.forEach((zone, index) => {
      const option = document.createElement("option");
      option.value = zone.id;
      option.textContent = `${index + 1}. ${zone.kind === "main" ? "Main signature" : "Initial/nhay"}`;
      if (zone.id === activeSignatureZoneId) {
        option.selected = true;
      }
      signatureZoneList.append(option);
    });
    signatureZoneList.disabled = zones.length === 0;
  }
  const active = zones.find((zone) => zone.id === activeSignatureZoneId) ?? zones[0];
  if (active && signatureZoneKind) {
    signatureZoneKind.value = active.kind ?? "main";
  }
  if (removeSignatureZoneBtn) {
    removeSignatureZoneBtn.disabled = zones.length <= 1;
  }
}

function addExpectedSignatureZone() {
  pushComplianceUndoSnapshot();
  const templateId = getActiveTemplateId();
  const zones = getTemplateZoneList(templateId);
  const base = getActiveZoneEntry() ?? getSignatureZoneTemplate(templateId);
  const next = normalizeZoneRatio({
    xMin: clamp(base.xMin + 0.02, 0, 0.96),
    xMax: clamp(base.xMax + 0.02, 0.04, 1),
    yMin: clamp(base.yMin + 0.02, 0, 0.96),
    yMax: clamp(base.yMax + 0.02, 0.04, 1)
  });
  const zoneId = `zone-${Date.now().toString(36)}-${Math.floor(Math.random() * 999).toString(36)}`;
  const newZone = { id: zoneId, kind: "initial", ...next };
  customZoneByTemplate = {
    ...customZoneByTemplate,
    [templateId]: normalizeZoneEntries([...zones, newZone])
  };
  activeSignatureZoneId = zoneId;
  syncZoneInputsFromTemplate();
  renderSignatureZoneOverlays();
  persistPreferences();
  showStatusToast("Added expected signature zone.", "success");
}

function removeSelectedSignatureZone() {
  const templateId = getActiveTemplateId();
  const zones = getTemplateZoneList(templateId);
  if (zones.length <= 1) {
    showStatusToast("At least one expected zone is required.", "info");
    return;
  }
  const targetId = activeSignatureZoneId ?? zones[0].id;
  if (!window.confirm("Remove selected expected signature zone?")) {
    return;
  }
  pushComplianceUndoSnapshot();
  const nextZones = zones.filter((zone) => zone.id !== targetId);
  if (!nextZones.some((zone) => zone.kind === "main")) {
    nextZones[0].kind = "main";
  }
  customZoneByTemplate = {
    ...customZoneByTemplate,
    [templateId]: normalizeZoneEntries(nextZones)
  };
  activeSignatureZoneId = nextZones[0]?.id ?? null;
  syncZoneInputsFromTemplate();
  renderSignatureZoneOverlays();
  persistPreferences();
  showStatusToast("Removed expected signature zone.", "success");
}

function updateActiveZoneKind(kind) {
  const templateId = getActiveTemplateId();
  const zones = getTemplateZoneList(templateId);
  const targetId = activeSignatureZoneId ?? zones[0]?.id;
  if (!targetId) return;
  const nextKind = kind === "initial" ? "initial" : "main";
  const mapped = zones.map((zone) => {
    if (zone.id === targetId) {
      return { ...zone, kind: nextKind };
    }
    if (nextKind === "main" && zone.kind === "main") {
      return { ...zone, kind: "initial" };
    }
    return zone;
  });
  if (!mapped.some((zone) => zone.kind === "main")) {
    mapped[0].kind = "main";
  }
  customZoneByTemplate = {
    ...customZoneByTemplate,
    [templateId]: normalizeZoneEntries(mapped)
  };
  syncZoneInputsFromTemplate();
  renderSignatureZoneOverlays();
  persistPreferences();
}

function buildExpectedZonesByPage(pages, zoneTemplate, zoneOverride) {
  const map = {};
  (pages ?? []).forEach((page) => {
    const pageOverride =
      zoneOverride && typeof zoneOverride === "object" && !Array.isArray(zoneOverride)
        ? zoneOverride[page.pageNumber] ?? zoneOverride[String(page.pageNumber)] ?? zoneOverride
        : zoneOverride;
    const ratios = resolveSignatureZones(zoneTemplate, pageOverride);
    const width = Number(page.width ?? 0);
    const height = Number(page.height ?? 0);
    map[page.pageNumber] = ratios.map((ratio) => ({
      kind: ratio.kind ?? "main",
      xMin: width * ratio.xMin,
      xMax: width * ratio.xMax,
      yMin: height * ratio.yMin,
      yMax: height * ratio.yMax
    }));
  });
  return map;
}

function clamp(value, min, max) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return min;
  }
  return Math.min(max, Math.max(min, numeric));
}

function applyDensityPreset(density) {
  isCompactDensity = String(density ?? "comfortable") === "compact";
  document.body.classList.toggle("ui-compact", isCompactDensity);
}

function applyMetadataPanelVisibility() {
  const panel = document.querySelector(".metadata-panel");
  if (!panel) {
    return;
  }
  const isMobile = window.innerWidth <= 1024;
  const shouldHide = !isMetadataPanelOpen;
  panel.hidden = shouldHide && !isMobile;
  panel.classList.toggle("hidden-mobile", shouldHide && isMobile);
  if (!shouldHide) {
    panel.hidden = false;
  }
  if (toggleMetaPanelBtn) {
    toggleMetaPanelBtn.textContent = isMetadataPanelOpen ? "Panel: On" : "Panel: Off";
    toggleMetaPanelBtn.setAttribute("aria-pressed", isMetadataPanelOpen ? "true" : "false");
  }
}

function refreshShortcutHints() {
  document.querySelectorAll(".shortcut-hint [data-shortcut-scope]").forEach((node) => {
    const scope = String(node.getAttribute("data-shortcut-scope") ?? "view");
    const visible =
      scope === "view" ||
      (scope === "text" && currentMode === EDIT_MODES.TEXT) ||
      (scope === "object" && currentMode === EDIT_MODES.OBJECT);
    node.hidden = !visible;
  });
}

function updateEvidenceExportAvailability() {
  if (exportEvidenceBtn) {
    exportEvidenceBtn.disabled = !lastComplianceBundle;
  }
}

async function updateMetadataPanel(pdfDoc, sourceLabel) {
  const metadata = await pdfDoc.getMetadata().catch(() => ({ info: {}, metadata: null }));
  const info = metadata?.info ?? {};
  currentMetadataInfo = structuredClone(info);
  const pageCount = Number(pdfDoc?.numPages ?? 0);
  const firstPage = pageCount > 0 ? await pdfDoc.getPage(1).catch(() => null) : null;
  const viewport = firstPage?.getViewport({ scale: 1 }) ?? null;

  setMetadataField("name", extractFileName(sourceLabel));
  setMetadataField("source", sourceLabel || "-");
  setMetadataField("pages", pageCount > 0 ? String(pageCount) : "-");
  setMetadataField(
    "pageSize",
    viewport ? `${Math.round(viewport.width)} x ${Math.round(viewport.height)}` : "-"
  );
  setMetadataField("scanQuality", "Dang phan tich...");
  setMetadataField("signatureMode", "Chua scan");
  setMetadataField("title", info.Title || "-");
  setMetadataField("author", info.Author || "-");
  setMetadataField("subject", info.Subject || "-");
  setMetadataField("creator", info.Creator || "-");
  setMetadataField("producer", info.Producer || "-");
  setMetadataField("keywords", info.Keywords || "-");
}

function setMetadataField(key, value) {
  const node = metadataFields[key];
  if (node) {
    node.classList.remove("metadata-success", "metadata-warning", "metadata-info");
    node.title = "";
    node.textContent = String(value ?? "-");
  }
}

function renderFontMetadataStatus(fontNames) {
  const list = [...(fontNames ?? [])].filter(Boolean);
  const fontNode = metadataFields.font;
  if (!fontNode) {
    return;
  }
  fontNode.classList.remove("metadata-success", "metadata-warning", "metadata-info");
  if (list.length > 0) {
    fontNode.textContent = "Co font";
    fontNode.classList.add("metadata-success");
    fontNode.title = list.join(", ");
    return;
  }
  fontNode.textContent = "KHONG CO FONT";
  fontNode.classList.add("metadata-warning");
  fontNode.title = "Khong phat hien font nhung trong file PDF.";
}

function renderScanQualityStatus({ pageCount, textFragmentCount, fontCount, objectCount }) {
  const qualityNode = metadataFields.scanQuality;
  if (!qualityNode) {
    return;
  }
  const quality = assessScanQuality({ pageCount, textFragmentCount, fontCount, objectCount });
  qualityNode.textContent = quality.label;
  qualityNode.title = quality.detail;
  qualityNode.classList.remove("metadata-success", "metadata-warning", "metadata-info");
  if (quality.tone) {
    qualityNode.classList.add(quality.tone);
  }
}

function assessScanQuality({ pageCount, textFragmentCount, fontCount, objectCount }) {
  const safePages = Math.max(1, Number(pageCount ?? 0));
  const avgTextPerPage = Number(textFragmentCount ?? 0) / safePages;
  const hasFonts = Number(fontCount ?? 0) > 0;
  const detail =
    `Pages: ${safePages} | Text fragments: ${textFragmentCount} | Fonts: ${fontCount} | Objects: ${objectCount}`;

  if (!hasFonts || avgTextPerPage < 3) {
    return {
      label: "Kem / scan anh (~150 ppi)",
      tone: "metadata-warning",
      detail
    };
  }
  if (avgTextPerPage >= 25) {
    return {
      label: "Tot (~300 ppi)",
      tone: "metadata-success",
      detail
    };
  }
  return {
    label: "Trung binh (~200 ppi)",
    tone: "metadata-info",
    detail
  };
}

function setLoading(visible, message = "Loading...") {
  if (!loadingOverlay) {
    return;
  }
  loadingOverlay.textContent = message;
  loadingOverlay.classList.toggle("visible", Boolean(visible));
}

function showStatusToast(message, tone = "info") {
  if (!statusToast) {
    return;
  }
  statusToast.textContent = String(message ?? "");
  statusToast.classList.remove("toast-success", "toast-error", "toast-info", "visible");
  statusToast.classList.add(
    tone === "success" ? "toast-success" : tone === "error" ? "toast-error" : "toast-info"
  );
  void statusToast.offsetWidth;
  statusToast.classList.add("visible");
  window.setTimeout(() => {
    statusToast.classList.remove("visible");
  }, 2200);
}

function applyDefaultEditModeForLoadedFile() {
  handleSidePanelCommand({ command: "SET_EDIT_MODE", mode: currentMode ?? EDIT_MODES.VIEW });
}

function extractFileName(sourceLabel) {
  const raw = String(sourceLabel ?? "").trim();
  if (!raw) {
    return "-";
  }
  try {
    const parsed = new URL(raw);
    const pathname = parsed.pathname.split("/").filter(Boolean);
    return pathname[pathname.length - 1] || raw;
  } catch (_) {
    const parts = raw.split(/[\\/]/).filter(Boolean);
    return parts[parts.length - 1] || raw;
  }
}

async function loadPreferences() {
  try {
    const result = await chrome.storage.local.get(PREFERENCES_KEY);
    return result?.[PREFERENCES_KEY] ?? {};
  } catch (_) {
    return {};
  }
}

function applyPreferencesToUi(preferences) {
  isLightTheme = Boolean(preferences.isLightTheme);
  document.body.classList.toggle("theme-light", isLightTheme);
  if (themeToggleBtn) {
    themeToggleBtn.textContent = isLightTheme ? "Theme: Light" : "Theme: Dark";
  }

  const snapEnabled = Boolean(preferences.snapEnabled);
  const snapSize = Number(preferences.snapSizeMm ?? 10);
  const snapGridToggle = document.getElementById("snapGridToggle");
  const snapGridSize = document.getElementById("snapGridSize");
  if (snapGridToggle) snapGridToggle.checked = snapEnabled;
  if (snapGridSize) snapGridSize.value = String(snapSize);
  const stepPx = getGridStepPx(selectedObjectPageNumber ?? getState().pages?.[0]?.pageNumber, snapSize);
  objectManager.setSnapGrid(snapEnabled, stepPx);

  textDebugEnabled = Boolean(preferences.textDebugEnabled);
  const debugToggle = document.getElementById("debugTextToggle");
  if (debugToggle) debugToggle.checked = textDebugEnabled;

  if (exportPreset) {
    exportPreset.value = String(preferences.exportPreset ?? "editable");
  }
  applyDensityPreset(String(preferences.uiDensity ?? "comfortable"));
  if (uiDensityPreset) {
    uiDensityPreset.value = isCompactDensity ? "compact" : "comfortable";
  }
  isMetadataPanelOpen = preferences.metaPanelOpen !== false;
  applyMetadataPanelVisibility();
  if (compliancePolicy) {
    compliancePolicy.value = String(preferences.compliancePolicy ?? "standard");
  }
  if (signatureZoneTemplate) {
    signatureZoneTemplate.value = String(preferences.signatureZoneTemplate ?? "generic");
  }
  if (showSignatureZoneToggle) {
    // Keep signature zone hidden by default to avoid visual clutter in review mode.
    showSignatureZoneToggle.checked = false;
  }
  if (showEvidenceHeatmapToggle) {
    showEvidenceHeatmapToggle.checked = preferences.showEvidenceHeatmap !== false;
  }
  customZoneByTemplate = Object.fromEntries(
    Object.entries(preferences.customZoneByTemplate ?? {}).map(([templateId, value]) => [
      templateId,
      normalizeZoneEntries(Array.isArray(value) ? value : [{ kind: "main", ...(value ?? {}) }])
    ])
  );
  activeSignatureZoneId = preferences.activeSignatureZoneId ?? null;
  syncZoneInputsFromTemplate();
  renderSignatureZoneOverlays();
  refreshShortcutHints();
  syncToolbarModeState();
}

function persistPreferences() {
  const snapGridToggle = document.getElementById("snapGridToggle");
  const snapGridSize = document.getElementById("snapGridSize");
  const payload = {
    mode: currentMode,
    isLightTheme,
    snapEnabled: Boolean(snapGridToggle?.checked),
    snapSizeMm: Number(snapGridSize?.value ?? 10),
    textDebugEnabled,
    exportPreset: String(exportPreset?.value ?? "editable"),
    uiDensity: isCompactDensity ? "compact" : "comfortable",
    metaPanelOpen: isMetadataPanelOpen,
    compliancePolicy: String(compliancePolicy?.value ?? "standard"),
    signatureZoneTemplate: String(signatureZoneTemplate?.value ?? "generic"),
    customZoneByTemplate,
    activeSignatureZoneId,
    showSignatureZone: Boolean(showSignatureZoneToggle?.checked),
    showEvidenceHeatmap: Boolean(showEvidenceHeatmapToggle?.checked)
  };
  try {
    const maybePromise = chrome.storage.local.set({ [PREFERENCES_KEY]: payload });
    if (maybePromise && typeof maybePromise.catch === "function") {
      maybePromise.catch(() => {});
    }
  } catch (_) {
    // Ignore persistence issues.
  }
}

async function runComplianceScan() {
  const started = performance.now();
  const state = getState();
  const policyId = String(compliancePolicy?.value ?? "standard");
  const zoneTemplate = String(signatureZoneTemplate?.value ?? "generic");
  const zoneOverride = customZoneByTemplate[zoneTemplate] ?? null;
  let hasError = false;
  focusedFindingKey = null;
  setComplianceBusyState(true);
  setComplianceScanState("loading", "Scanning compliance rules and collecting evidence...");

  try {
    const cryptographicSignature = await ensureCryptographicSignatureVerification();
    const metadata = {
      info: {
        ...structuredClone(currentMetadataInfo),
        Title: currentMetadataInfo.Title ?? metadataFields.title?.textContent ?? "",
        Author: currentMetadataInfo.Author ?? metadataFields.author?.textContent ?? "",
        Subject: currentMetadataInfo.Subject ?? metadataFields.subject?.textContent ?? "",
        Keywords: currentMetadataInfo.Keywords ?? metadataFields.keywords?.textContent ?? "",
        Producer: currentMetadataInfo.Producer ?? metadataFields.producer?.textContent ?? "",
        Signature:
          currentMetadataInfo.Signature ??
          currentMetadataInfo.Subject ??
          currentMetadataInfo.Keywords ??
          ""
      }
    };

    const expectedZonesByPage = buildExpectedZonesByPage(state.pages, zoneTemplate, zoneOverride);
    const { baseline, semantics, scoring } = await runComplianceWorkerScan({
      cryptographicSignature,
      pages: state.pages,
      objectBlocks: state.objectBlocks,
      textBlocks: state.textBlocks,
      metadata,
      zoneTemplate,
      zoneOverride,
      expectedZonesByPage,
      policyId
    });

    const bundle = buildEvidenceBundle({
      state,
      baseline,
      semantics,
      scoring
    });
    lastComplianceBundle = bundle;
    updateEvidenceExportAvailability();
    renderComplianceResult(scoring, bundle);

    const workflowResult = await sendComplianceResult({
      endpoint: state.workflowEndpoint ?? "",
      payload: bundle
    });
    if (state.workflowEndpoint) {
      showStatusToast(
        workflowResult.ok
          ? "Compliance result sent to workflow."
          : `Workflow delivery failed: ${workflowResult.reason ?? workflowResult.status ?? "unknown"}`,
        workflowResult.ok ? "success" : "info"
      );
    }

    setComplianceScanState(
      "success",
      `Scan completed: ${scoring.decision} (${scoring.totalScore}/100, ${scoring.findings.length} findings).`
    );
    showStatusToast(`Compliance: ${scoring.decision} (${scoring.totalScore})`, "success");
  } catch (err) {
    console.error("Compliance scan error:", err);
    hasError = true;
    setComplianceScanState("error", "Compliance scan failed. Please review file content and retry.");
    showStatusToast("Compliance scan failed.", "error");
  } finally {
    setComplianceBusyState(false);
    const elapsed = performance.now() - started;
    trackScanResult({ durationMs: elapsed, hasError });
    renderComplianceMetrics();
  }
}

async function ensureCryptographicSignatureVerification() {
  if (currentCryptographicSignature) {
    return currentCryptographicSignature;
  }
  if (!sourceBytes) {
    return {
      available: false,
      verified: false,
      reason: "no_source_bytes",
      signatures: []
    };
  }
  if (!currentCryptographicSignaturePromise) {
    const requestId = ++cryptographicVerificationRequestCounter;
    currentCryptographicSignaturePromise = verifyPdfDigitalSignature(sourceBytes)
      .then((result) => {
        if (requestId === cryptographicVerificationRequestCounter) {
          currentCryptographicSignature = result;
          renderSignatureMetadataStatusFromVerification(result);
        }
        return result;
      })
      .catch((error) => {
        const fallback = {
          available: true,
          verified: false,
          reason: "verification_error",
          message: error?.message ?? "Unknown verification error",
          signatures: []
        };
        if (requestId === cryptographicVerificationRequestCounter) {
          currentCryptographicSignature = fallback;
          renderSignatureMetadataStatusFromVerification(fallback);
        }
        return fallback;
      });
  }
  return currentCryptographicSignaturePromise;
}

function runComplianceWorkerScan(payload) {
  const requestId = `scan-${Date.now().toString(36)}-${(complianceScanRequestCounter += 1).toString(36)}`;
  return new Promise((resolve, reject) => {
    const timeoutId = window.setTimeout(() => {
      cleanup();
      reject(new Error("Compliance worker timed out"));
    }, COMPLIANCE_SCAN_TIMEOUT_MS);

    const handleMessage = (event) => {
      const message = event.data ?? {};
      if (message.requestId !== requestId) {
        return;
      }
      cleanup();
      if (message.action === "scanError") {
        reject(new Error(message.error ?? "Compliance worker error"));
        return;
      }
      if (message.action === "scanResult") {
        resolve(message.results ?? {});
      }
    };

    const handleError = (event) => {
      cleanup();
      reject(event?.error ?? new Error(event?.message ?? "Compliance worker error"));
    };

    const cleanup = () => {
      window.clearTimeout(timeoutId);
      complianceWorker.removeEventListener("message", handleMessage);
      complianceWorker.removeEventListener("error", handleError);
    };

    complianceWorker.addEventListener("message", handleMessage);
    complianceWorker.addEventListener("error", handleError);
    complianceWorker.postMessage({
      action: "runScan",
      requestId,
      payload
    });
  });
}

function renderComplianceResult(scoring, bundle) {
  latestFindings = Array.isArray(scoring.findings) ? [...scoring.findings] : [];
  renderSignatureMetadataStatus(scoring.digitalSignature);
  if (complianceFields.decision) complianceFields.decision.textContent = scoring.decision;
  if (complianceFields.score) {
    const confidence = Math.round((scoring.confidence ?? 0) * 100);
    complianceFields.score.textContent = `${scoring.totalScore}/100 (${scoring.riskBand ?? "low"}, conf ${confidence}%)`;
  }
  if (complianceFields.digitalSignature) {
    const digitalDecision = String(scoring.digitalSignature?.decision ?? "not_detected");
    const detected = digitalDecision === "detected";
    const uncertain = digitalDecision === "uncertain";
    objectManager.setDigitalSignatureDetected(detected);
    complianceFields.digitalSignature.textContent = detected ? "Detected" : uncertain ? "Uncertain" : "Not detected";
    complianceFields.digitalSignature.classList.remove("detected", "not-detected", "uncertain");
    complianceFields.digitalSignature.classList.add(detected ? "detected" : uncertain ? "uncertain" : "not-detected");
    complianceFields.digitalSignature.title = buildDigitalSignatureTooltip(scoring.digitalSignature);
  }
  if (complianceFields.findingsCount) {
    complianceFields.findingsCount.textContent = String(scoring.findings.length);
  }
  const statusCard = document.getElementById("complianceStatusCard");
  if (statusCard) {
    statusCard.classList.remove("status-pass", "status-manual_review", "status-reject");
    statusCard.classList.add(`status-${scoring.decision ?? "pass"}`);
    pulseComplianceStatusCard(statusCard);
  }
  if (complianceFields.why) {
    if (scoring.findings.length === 0) {
      complianceFields.why.textContent =
        scoring.overrideReason === "trusted_heuristic_signature_evidence"
          ? "Trusted heuristic digital-signature evidence detected. Risk forced to 0."
          : scoring.overrideReason === "trusted_cryptographic_signature_evidence"
            ? "Cryptographic PDF signature verified successfully. Risk forced to 0."
            : "No issues detected by current policy.";
    } else {
      const topRules = Object.entries(scoring.breakdown?.byRule ?? {})
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(([rule, score]) => `${rule}: ${score}`)
        .join(" | ");
      complianceFields.why.textContent = [
        `Top contributors: ${topRules}`,
        ...scoring.findings
        .map((finding) => `- [${finding.severity}] ${finding.ruleId}: ${finding.message ?? "rule triggered"}`)
      ].join("\n");
    }
  }
  renderComplianceBreakdown(scoring.breakdown);
  renderComplianceExplainability(scoring.explainability);
  renderComplianceHighlights(scoring.findings);
  renderComplianceFindingList(scoring.findings);
  refreshFindingNavButtons();
}

function renderComplianceMetrics() {
  const metrics = getComplianceMetrics();
  if (!complianceFields.why) return;
  complianceFields.why.textContent += `\n\nScans: ${metrics.scans} | ErrorRate: ${round(
    metrics.errorRate * 100
  )}% | AvgMs: ${metrics.averageDurationMs}`;
}

function buildDigitalSignatureTooltip(digitalSignature) {
  if (!digitalSignature) {
    return "Digital signature evidence is not available.";
  }
  const decision = String(digitalSignature.decision ?? "not_detected");
  const trustTier = String(digitalSignature.trustTier ?? "none");
  const confidence = Math.round(Number(digitalSignature.confidence ?? 0) * 100);
  const positiveSignals = Array.isArray(digitalSignature.positiveSignals)
    ? digitalSignature.positiveSignals.slice(0, 3)
    : [];
  const suppressedSignals = Array.isArray(digitalSignature.suppressedSignals)
    ? digitalSignature.suppressedSignals.slice(0, 2)
    : [];

  const lines = [
    `Decision: ${decision}`,
    `Trust tier: ${trustTier}`,
    `Confidence: ${confidence}%`,
    `Assessment mode: ${digitalSignature.assessmentMode ?? "heuristic"}`,
    `Cryptographically verified: ${digitalSignature.verifiedCryptographically ? "yes" : "no"}`
  ];
  if (digitalSignature.evidenceSummary) {
    lines.push(`Why: ${digitalSignature.evidenceSummary}`);
  }
  if (positiveSignals.length > 0) {
    lines.push(`Signals: ${positiveSignals.join(", ")}`);
  }
  if (suppressedSignals.length > 0) {
    lines.push(`Suppressed: ${suppressedSignals.join(", ")}`);
  }
  return lines.join("\n");
}

function renderSignatureMetadataStatus(digitalSignature) {
  const node = metadataFields.signatureMode;
  if (!node) {
    return;
  }
  const mode = digitalSignature?.assessmentMode ?? "heuristic";
  const verified = Boolean(digitalSignature?.verifiedCryptographically);
  const trustTier = String(digitalSignature?.trustTier ?? "none");
  node.classList.remove("metadata-success", "metadata-warning", "metadata-info");
  if (verified) {
    node.textContent = "Verified";
    node.classList.add("metadata-success");
  } else if (mode === "cryptographic" && trustTier === "probable") {
    node.textContent = "Integrity OK";
    node.classList.add("metadata-info");
  } else if (mode === "cryptographic") {
    node.textContent = "Not verified";
    node.classList.add("metadata-warning");
  } else if (trustTier === "trusted" || trustTier === "probable") {
    node.textContent = "Heuristic only";
    node.classList.add("metadata-info");
  } else {
    node.textContent = "Not verified";
    node.classList.add("metadata-warning");
  }
  node.title = `Mode: ${mode} | Trust: ${trustTier}`;
}

function renderSignatureMetadataStatusFromVerification(verification) {
  const node = metadataFields.signatureMode;
  if (!node) {
    return;
  }
  node.classList.remove("metadata-success", "metadata-warning", "metadata-info");
  if (!verification?.available) {
    node.textContent = "Khong co chu ky so";
    node.classList.add("metadata-warning");
    node.title = "Khong tim thay PDF signature dictionary.";
    return;
  }
  if (verification.verified) {
    node.textContent = "Verified cryptographic";
    node.classList.add("metadata-success");
    node.title = "Chu ky so PDF hop le va chuoi chung thu duoc tin cay.";
    return;
  }
  if (verification.integrity) {
    node.textContent = "Integrity OK";
    node.classList.add("metadata-info");
    node.title = verification.authenticity
      ? "Noi dung ky dung, nhung co canh bao ve chung thu."
      : "Noi dung ky dung, nhung chuoi chung thu chua duoc tin cay.";
    return;
  }
  node.textContent = "Invalid cryptographic";
  node.classList.add("metadata-warning");
  node.title = verification.message ?? "Xac thuc chu ky so that bai.";
}

function exportEvidenceBundleFile() {
  if (!lastComplianceBundle) {
    showStatusToast("Run compliance scan before exporting evidence.", "info");
    return;
  }
  const payload = serializeEvidenceBundle(lastComplianceBundle);
  const blob = new Blob([payload], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = "compliance-evidence.json";
  anchor.click();
  URL.revokeObjectURL(url);
  showStatusToast("Evidence bundle exported.", "success");
}

function renderComplianceHighlights(findings) {
  clearComplianceHighlights();
  if (!Array.isArray(findings) || findings.length === 0) {
    return;
  }
  const showHeatmap = Boolean(showEvidenceHeatmapToggle?.checked);

  findings.forEach((finding) => {
    const pageShell = viewerRoot.querySelectorAll(".page-shell")[finding.pageNumber - 1];
    if (!pageShell || !finding.bbox) {
      return;
    }
    let layer = complianceHighlightLayerByPage.get(finding.pageNumber);
    if (!layer) {
      layer = document.createElement("div");
      layer.className = "compliance-highlight-layer";
      layer.style.position = "absolute";
      layer.style.inset = "0";
      layer.style.pointerEvents = "none";
      complianceHighlightLayerByPage.set(finding.pageNumber, layer);
      pageShell.append(layer);
    }

    const box = document.createElement("div");
    const key = findingKey(finding);
    box.dataset.findingKey = key;
    box.className = `compliance-highlight-box severity-${finding.severity ?? "low"}`;
    box.title = `Compliance finding bbox: ${finding.ruleId}`;
    box.style.left = `${finding.bbox.x ?? 0}px`;
    box.style.top = `${finding.bbox.y ?? 0}px`;
    box.style.width = `${Math.max(8, finding.bbox.width ?? 8)}px`;
    box.style.height = `${Math.max(8, finding.bbox.height ?? 8)}px`;
    box.style.display = showHeatmap ? "block" : "none";
    layer.append(box);

    if (showHeatmap) {
      const heatspot = document.createElement("div");
      heatspot.className = `compliance-heatspot ${finding.severity ?? "low"}`;
      heatspot.style.left = `${Math.max(0, (finding.bbox.x ?? 0) - 12)}px`;
      heatspot.style.top = `${Math.max(0, (finding.bbox.y ?? 0) - 12)}px`;
      heatspot.style.width = `${Math.max(24, (finding.bbox.width ?? 8) + 24)}px`;
      heatspot.style.height = `${Math.max(24, (finding.bbox.height ?? 8) + 24)}px`;
      layer.append(heatspot);
    }
  });
}

function snapshotComplianceState() {
  return {
    compliancePolicy: String(compliancePolicy?.value ?? "standard"),
    signatureZoneTemplate: String(signatureZoneTemplate?.value ?? "generic"),
    showSignatureZone: Boolean(showSignatureZoneToggle?.checked),
    showEvidenceHeatmap: Boolean(showEvidenceHeatmapToggle?.checked),
    customZoneByTemplate: structuredClone(customZoneByTemplate),
    activeSignatureZoneId,
    focusedFindingKey
  };
}

function applyComplianceSnapshot(snapshot) {
  if (!snapshot) {
    return;
  }
  isApplyingComplianceSnapshot = true;
  try {
    if (compliancePolicy) {
      compliancePolicy.value = String(snapshot.compliancePolicy ?? "standard");
    }
    if (signatureZoneTemplate) {
      signatureZoneTemplate.value = String(snapshot.signatureZoneTemplate ?? "generic");
    }
    if (showSignatureZoneToggle) {
      showSignatureZoneToggle.checked = Boolean(snapshot.showSignatureZone);
    }
    if (showEvidenceHeatmapToggle) {
      showEvidenceHeatmapToggle.checked = Boolean(snapshot.showEvidenceHeatmap);
    }
    customZoneByTemplate = structuredClone(snapshot.customZoneByTemplate ?? {});
    activeSignatureZoneId = snapshot.activeSignatureZoneId ?? null;
    focusedFindingKey = snapshot.focusedFindingKey ?? null;
    syncZoneInputsFromTemplate();
    renderSignatureZoneOverlays();
    if (lastComplianceBundle?.findings) {
      renderComplianceHighlights(lastComplianceBundle.findings);
      renderComplianceFindingList(lastComplianceBundle.findings);
    } else {
      clearComplianceHighlights();
    }
    refreshFindingNavButtons();
    persistPreferences();
  } finally {
    isApplyingComplianceSnapshot = false;
  }
}

function pushComplianceUndoSnapshot() {
  if (isApplyingComplianceSnapshot) {
    return;
  }
  complianceUndoStack.push(snapshotComplianceState());
  if (complianceUndoStack.length > 60) {
    complianceUndoStack.shift();
  }
  complianceRedoStack.length = 0;
}

function undoComplianceAction() {
  const previous = complianceUndoStack.pop();
  if (!previous) {
    showStatusToast("No compliance changes to undo.", "info");
    return;
  }
  complianceRedoStack.push(snapshotComplianceState());
  applyComplianceSnapshot(previous);
  showStatusToast("Compliance settings restored.", "success");
}

function redoComplianceAction() {
  const next = complianceRedoStack.pop();
  if (!next) {
    showStatusToast("No compliance changes to redo.", "info");
    return;
  }
  complianceUndoStack.push(snapshotComplianceState());
  applyComplianceSnapshot(next);
  showStatusToast("Compliance settings re-applied.", "success");
}

function resetComplianceHistory() {
  complianceUndoStack.length = 0;
  complianceRedoStack.length = 0;
}

function setComplianceBusyState(isBusy) {
  [
    runComplianceBtn,
    exportEvidenceBtn,
    prevFindingBtn,
    nextFindingBtn,
    saveZoneTemplateBtn,
    resetZoneTemplateBtn,
    addSignatureZoneBtn,
    removeSignatureZoneBtn,
    undoComplianceBtn,
    redoComplianceBtn,
    compliancePolicy,
    signatureZoneTemplate,
    signatureZoneList,
    signatureZoneKind,
    showSignatureZoneToggle,
    showEvidenceHeatmapToggle
  ].forEach((element) => {
    if (element) {
      element.disabled = Boolean(isBusy);
    }
  });
}

function setComplianceScanState(status, message) {
  if (!complianceScanState) {
    return;
  }
  complianceScanState.textContent = String(message ?? "");
  complianceScanState.classList.remove("state-loading", "state-error", "state-success", "state-updated");
  if (status === "loading") {
    complianceScanState.classList.add("state-loading");
  } else if (status === "error") {
    complianceScanState.classList.add("state-error");
  } else if (status === "success") {
    complianceScanState.classList.add("state-success");
  }
  complianceScanState.classList.add("state-updated");
  window.clearTimeout(statusCardUpdateTimer);
  statusCardUpdateTimer = window.setTimeout(() => {
    complianceScanState.classList.remove("state-updated");
  }, 900);
}

function pulseComplianceStatusCard(statusCard) {
  if (!statusCard) {
    return;
  }
  statusCard.classList.remove("status-updated");
  void statusCard.offsetWidth;
  statusCard.classList.add("status-updated");
  window.clearTimeout(statusCardUpdateTimer);
  statusCardUpdateTimer = window.setTimeout(() => {
    statusCard.classList.remove("status-updated");
  }, 900);
}

function renderComplianceBreakdown(breakdown) {
  if (!complianceFields.breakdown) {
    return;
  }
  complianceFields.breakdown.replaceChildren();
  const entries = Object.entries(breakdown?.byRule ?? {});
  if (entries.length === 0) {
    return;
  }
  const group = document.createElement("div");
  group.className = "breakdown-group";
  const title = document.createElement("div");
  title.className = "breakdown-group-title";
  title.textContent = "Rule breakdown";
  group.append(title);
  const maxScore = Math.max(...entries.map(([, score]) => Number(score ?? 0)), 1);
  entries
    .sort((a, b) => Number(b[1] ?? 0) - Number(a[1] ?? 0))
    .forEach(([rule, score]) => {
      const row = document.createElement("div");
      row.className = "breakdown-row";
      const label = document.createElement("div");
      label.className = "breakdown-label";
      label.textContent = rule;
      const bar = document.createElement("div");
      bar.className = "breakdown-bar";
      bar.style.width = `${Math.max(8, (Number(score ?? 0) / maxScore) * 100)}%`;
      row.append(label, bar);
      group.append(row);
    });
  complianceFields.breakdown.append(group);
}

function renderComplianceExplainability(explainability) {
  if (!complianceFields.explainability) {
    return;
  }
  complianceFields.explainability.replaceChildren();
  const entries = Object.entries(explainability ?? {}).filter(([, value]) => value !== undefined && value !== null && value !== "");
  if (entries.length === 0) {
    return;
  }
  entries.slice(0, 6).forEach(([key, value]) => {
    const card = document.createElement("div");
    card.className = "explain-card";
    const title = document.createElement("div");
    title.className = "explain-title";
    title.textContent = key;
    const content = document.createElement("div");
    content.className = "explain-item";
    content.textContent = typeof value === "string" ? value : JSON.stringify(value);
    card.append(title, content);
    complianceFields.explainability.append(card);
  });
}

function clearComplianceHighlights() {
  complianceHighlightLayerByPage.forEach((layer) => {
    layer.replaceChildren();
  });
}

function renderComplianceFindingList(findings) {
  if (!complianceFields.findingsList) {
    return;
  }
  complianceFields.findingsList.replaceChildren();
  if (!Array.isArray(findings) || findings.length === 0) {
    const empty = document.createElement("div");
    empty.className = "explain-item";
    empty.textContent = "No findings.";
    complianceFields.findingsList.append(empty);
    return;
  }
  findings.forEach((finding, index) => {
    const button = document.createElement("button");
    const key = findingKey(finding);
    button.type = "button";
    button.className = `compliance-finding-item ${finding.severity ?? "low"}`;
    button.dataset.findingKey = key;
    button.textContent = `${index + 1}. [${String(finding.severity ?? "low").toUpperCase()}] ${finding.message ?? finding.ruleId ?? "Finding"}`;
    button.addEventListener("click", () => focusFinding(key));
    complianceFields.findingsList.append(button);
  });
  syncFocusedFindingUi();
}

function findingKey(finding) {
  return [
    finding?.ruleId ?? "rule",
    finding?.pageNumber ?? 0,
    finding?.bbox?.x ?? 0,
    finding?.bbox?.y ?? 0,
    finding?.bbox?.width ?? 0,
    finding?.bbox?.height ?? 0
  ].join(":");
}

function focusAdjacentFinding(direction) {
  if (!latestFindings.length) {
    return;
  }
  const currentIndex = latestFindings.findIndex((finding) => findingKey(finding) === focusedFindingKey);
  const baseIndex = currentIndex >= 0 ? currentIndex : direction < 0 ? 0 : -1;
  const nextIndex = (baseIndex + direction + latestFindings.length) % latestFindings.length;
  focusFinding(findingKey(latestFindings[nextIndex]));
}

function focusFinding(targetKey) {
  const finding = latestFindings.find((item) => findingKey(item) === targetKey);
  if (!finding) {
    return;
  }
  focusedFindingKey = targetKey;
  syncFocusedFindingUi();
  const pageShell = viewerRoot.querySelectorAll(".page-shell")[Math.max(0, (finding.pageNumber ?? 1) - 1)];
  pageShell?.scrollIntoView({ behavior: "smooth", block: "center" });
  if (pageShell) {
    pageShell.classList.remove("focus-zoom");
    void pageShell.offsetWidth;
    pageShell.classList.add("focus-zoom");
  }
}

function syncFocusedFindingUi() {
  document.querySelectorAll(".compliance-highlight-box").forEach((node) => {
    node.classList.toggle("focused", node.dataset.findingKey === focusedFindingKey);
  });
  document.querySelectorAll(".compliance-finding-item").forEach((node) => {
    node.classList.toggle("active", node.dataset.findingKey === focusedFindingKey);
  });
}

function refreshFindingNavButtons() {
  const hasFindings = latestFindings.length > 0;
  if (prevFindingBtn) {
    prevFindingBtn.disabled = !hasFindings;
  }
  if (nextFindingBtn) {
    nextFindingBtn.disabled = !hasFindings;
  }
}
