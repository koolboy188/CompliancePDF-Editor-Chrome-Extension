# GEMINI.md

This file serves as the instructional context for the `flexipdf-editor-extension` project.

## Project Overview

`CompliancePDF Editor` is a Manifest V3 Chrome extension designed for in-browser PDF review and editing, with a specialized focus on compliance checks, digital-signature assessment, and risk scoring.

**Key Technologies:**
- **Runtime:** Chrome Extension MV3
- **PDF Handling:** `pdfjs-dist`
- **Object Manipulation:** `fabric`
- **PDF Mutation:** `pdf-lib`
- **Testing:** `vitest`

## Building and Running

- **Install Dependencies:** `npm install`
- **Run Tests:** `npm test`
- **Development/Debugging:**
  1. Open `chrome://extensions` in Chrome.
  2. Enable "Developer mode".
  3. Click "Load unpacked" and select the root directory of this project.

## Development Conventions

- **Architecture:** The project is modularized by concerns:
  - `src/viewer`: UI and main runtime orchestration.
  - `src/compliance`: Domain logic for scanning, signature analysis, scoring, and auditing.
  - `src/core`: PDF adapter, edit layer manager, and text flow/reflow engines.
  - `src/shared`: Global state and message types.
- **Testing:** Unit and benchmark tests are located in the `tests/` directory and executed via `vitest`.
- **Compliance Workflow:** Features should maintain the "Compliance-as-Code" philosophy, ensuring that scoring, policy profiles, and evidence generation are consistent with the established `baseline-detector` and `scoring` modules.
- **File Structure:** Maintain strict separation between UI (`viewer`, `sidepanel`, `popup`) and engine logic (`core`, `compliance`).
