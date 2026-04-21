# CompliancePDF Editor (Chrome Extension MV3)

`CompliancePDF Editor` is a Manifest V3 Chrome extension for opening, reviewing, and editing PDF files directly in-browser, with a strong focus on signature-overlay compliance checks.

## New in v0.2.0
- **Advanced Signature Contextualization**: Improved baseline detection using semantic text marker analysis.
- **Dynamic Policy Profiles**: Runtime-configurable risk thresholds and weight overrides.
- **Performance Optimized**: Compute-intensive compliance scans are now offloaded to WebWorkers for responsive UI.
- **Enhanced Auditability**: Standardized v1.0.0 evidence bundles with versioned metadata.

## Core Capabilities

- PDF rendering, text extraction, and object extraction using `pdfjs-dist`.
- Text editing with reflow-oriented block handling.
- Object editing with `fabric` (move/resize/rotate selected objects).
- Compliance scanning with explainability and evidence export.
- Digital-signature assessment with decision states:
  - `Detected`
  - `Uncertain`
  - `Not detected`
- Signature-zone management with multiple expected zones:
  - `main` (risk-critical)
  - `initial` (ignored for main-signature risk rules)

## Compliance Features

- Baseline geometry rules (`outOfZone`, `stackedOverlay`, `multipleMainSignatures`, `mainZoneMissingSignature`).
- Semantic signature analysis from metadata/text/object context.
- File-level digital signature classifier:
  - `digitalSignatureDecision`: `detected | uncertain | not_detected`
  - `trustTier`: `trusted | probable | none`
  - confidence and evidence signals.
- Risk scoring pipeline with:
  - normalized score (`0-100`)
  - risk bands
  - dynamic policy profiles (customizable weights)
  - explainability payload (`summary`, `confidenceDrivers`, `suppressedSignals`, top findings).

## Main Project Structure

- `manifest.json`: MV3 config, permissions, background worker, side panel, content script.
- `src/background/service-worker.js`: extension message routing and viewer open flow.
- `src/worker/compliance-worker.js`: Offloaded compliance scanning logic.
- `src/content/content-script.js`: PDF-page detection and quick-open action.
- `src/viewer/viewer.html`: primary UI (viewer, object controls, metadata/compliance panel).
- `src/viewer/viewer-app.js`: main runtime orchestration (render, edit, compliance, persistence).
- `src/viewer/viewer.css`: viewer and compliance UI styling.
- `src/compliance/detection/*`: baseline detection (worker-ready) and signature-zone templates.
- `src/compliance/semantics/*`: semantic analysis and digital-signature decisioning.
- `src/compliance/scoring/*`: weighted risk scoring + explainability.
- `src/compliance/audit/*`: versioned evidence bundle generation.
- `tests/*`: compliance and editor unit/benchmark tests.

## Development

1. Install dependencies:
   - `npm install`
2. Run tests:
   - `npm test`
3. Load extension in Chrome:
   - Open `chrome://extensions`
   - Enable Developer mode
   - Load unpacked extension from this folder

## Notes

- The extension defaults to `Object Edit` mode on file load.
- Compliance panel supports `Run Scan`, evidence export, findings navigation, and undo/redo for compliance-related configuration changes.
