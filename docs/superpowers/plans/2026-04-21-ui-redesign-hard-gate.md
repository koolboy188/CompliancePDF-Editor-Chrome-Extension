# CompliancePDF UI Redesign & Hard Gate Implementation Plan

**Goal:** Redesign the primary navigation menu to a modern, segmented style and enforce a "Hard Gate" on critical compliance failures.

**Architecture:**
- **UI:** Refactor `viewer.css` to implement a `segmented-control` for view modes.
- **Header:** Modify `viewer.html` structure to support the new dock-style navigation.
- **Logic:** The "Hard Gate" logic is already implemented in `compliance-scoring.js`. This plan focuses on UI and verification.

**Tech Stack:** Vanilla JS, CSS (flexbox/grid).

---

### Task 1: Update Header Structure

**Files:**
- Modify: `src/viewer/viewer.html`
- Modify: `src/viewer/viewer.css`

- [ ] **Step 1: Modify HTML structure**
Replace the existing header tools with the segmented container.

```html
<!-- Inside <header class="viewer-header"> -->
<div class="main-dock">
  <div class="segmented-control">
    <button id="viewMode" class="segment active" data-mode="view">View</button>
    <button id="textMode" class="segment" data-mode="text">Text Edit</button>
    <button id="objectMode" class="segment" data-mode="object">Object Edit</button>
  </div>
  <button class="btn-advanced">Advanced Tools ▾</button>
</div>
```

- [ ] **Step 2: Update CSS**
Add the new styles to `src/viewer/viewer.css`.

```css
.main-dock { display: flex; align-items: center; justify-content: space-between; padding: 4px; }
.segmented-control { display: flex; background: #f1f5f9; padding: 4px; border-radius: 10px; border: 1px solid #e2e8f0; }
.segment { padding: 8px 20px; cursor: pointer; border-radius: 7px; font-weight: 500; font-size: 13px; border: none; background: transparent; color: #475569; }
.segment.active { background: #ffffff; color: #2563eb; box-shadow: 0 2px 4px rgba(0,0,0,0.05); }
.btn-advanced { padding: 8px 16px; background: #ffffff; border: 1px solid #e2e8f0; border-radius: 8px; font-size: 13px; font-weight: 500; color: #475569; cursor: pointer; }
```

### Task 2: Update Mode Switching Logic

**Files:**
- Modify: `src/viewer/viewer-app.js`

- [ ] **Step 1: Update Event Listeners**
Refactor the mode switching code to target the new `.segment` buttons.

```javascript
document.querySelectorAll('.segment').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.segment').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    const mode = btn.dataset.mode;
    // Call existing mode switch function
    this.switchMode(mode); 
  });
});
```

### Task 3: Verify Compliance Hard Gate

**Files:**
- Modify: `tests/compliance-scoring.test.js`

- [ ] **Step 1: Add unit test for Hard Gate**

```javascript
it("should reject critical signature tampering", () => {
  const result = scoreCompliance({
    semantics: {
      findings: [{ ruleId: "signature-tamper", severity: "high" }]
    }
  });
  expect(result.decision).toBe("reject");
  expect(result.totalScore).toBe(100);
});
```
- [ ] **Step 2: Run verification**
Run `npm test`.

---

**Plan complete and saved to `docs/superpowers/plans/2026-04-21-ui-redesign-hard-gate.md`. Two execution options:**

**1. Subagent-Driven (recommended)** - I dispatch a fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** - Execute tasks in this session using executing-plans, batch execution with checkpoints.

**Which approach?**
