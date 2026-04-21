# CompliancePDF Editor

`CompliancePDF Editor` is a Chrome Extension (Manifest V3) for opening, reviewing, editing, and compliance-checking PDF files directly inside the browser.

It combines a PDF viewer, text/object editing tools, signature-zone inspection, compliance scoring, evidence export, and digital-signature assessment in one workflow.

## Highlights

- Open PDF files directly in the extension viewer.
- Edit text blocks with reflow-aware handling.
- Edit objects with drag, resize, rotate, scale, opacity, and styling controls.
- Run compliance scans for suspicious overlays, signature placement, and signature-related anomalies.
- Export evidence bundles for audit/review.
- Assess digital signatures in two layers:
  - heuristic detection from metadata, text, and visual context
  - cryptographic verification for supported PDF signature containers

## Main Features

### PDF viewer and editor

- PDF rendering and extraction powered by `pdfjs-dist`
- text editing and block reflow
- object editing powered by `fabric`
- PDF export using `pdf-lib`

### Compliance workflow

- signature-zone templates
- baseline geometry checks
- semantic signature analysis
- weighted compliance scoring
- explainability output
- evidence bundle export

### Digital signature checks

- `Detected`
- `Uncertain`
- `Not detected`
- `Verified cryptographic`
- `Integrity OK`
- `Invalid cryptographic`

## Typical Workflow

1. Load a PDF in the viewer.
2. Review the file in `View`, `Text Edit`, or `Object Edit`.
3. Inspect metadata such as font presence, scan quality, and digital signature status.
4. Configure policy and signature-zone template if needed.
5. Run `Compliance Scan`.
6. Review findings, evidence heatmap, explainability, and score.
7. Save the edited PDF or export the evidence bundle.

## Install in Chrome

### Option 1: Run from source

1. Install dependencies:

   ```bash
   npm install
   ```

2. Run tests:

   ```bash
   npm test
   ```

3. Open `chrome://extensions`
4. Enable `Developer mode`
5. Click `Load unpacked`
6. Select this project folder

### Chrome requirements

- Chrome `116+`
- permissions used:
  - `activeTab`
  - `downloads`
  - `scripting`
  - `sidePanel`
  - `storage`

## Project Structure

- `manifest.json` - MV3 extension manifest and runtime wiring
- `src/background/service-worker.js` - background orchestration and tab/panel behavior
- `src/content/content-script.js` - page detection and viewer opening flow
- `src/viewer/viewer.html` - main viewer markup
- `src/viewer/viewer.css` - viewer UI and layout styling
- `src/viewer/viewer-app.js` - main app runtime, editing, compliance, metadata, persistence
- `src/worker/compliance-worker.js` - worker for heavier compliance analysis
- `src/core/` - rendering, reflow, export, object editing, PDF integration
- `src/compliance/detection/` - baseline and signature-zone detection
- `src/compliance/semantics/` - semantic signature analysis
- `src/compliance/scoring/` - risk scoring and explainability
- `src/compliance/crypto/` - cryptographic PDF signature verification
- `src/compliance/audit/` - evidence bundle generation
- `tests/` - unit and regression tests

## Development

### Scripts

- `npm test` - run the test suite
- `npm run test:watch` - run tests in watch mode
- `npm run check` - alias for test validation

### Main dependencies

- `pdfjs-dist`
- `pdf-lib`
- `fabric`
- `@ninja-labs/verify-pdf`

## Current Notes

- The viewer toolbar is fixed while the PDF content area scrolls independently.
- Object inspector controls are available in the right sidebar.
- The compliance panel supports findings navigation, explainability, evidence export, and compliance undo/redo.
- Cryptographic verification currently supports common detached PDF signature subfilters and falls back to heuristic analysis when a signature cannot be fully verified.

## License

This repository includes an Apache-2.0 license. See `LICENSE`.
