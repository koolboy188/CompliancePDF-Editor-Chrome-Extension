import { ReflowEngine } from "./reflow/reflow-engine.js";

export class EditLayerManager {
  constructor({ root, stateStore, onBlockEdit, onBlockSelect }) {
    this.root = root;
    this.stateStore = stateStore;
    this.reflowEngine = new ReflowEngine();
    this.onBlockEdit = onBlockEdit;
    this.onBlockSelect = onBlockSelect;
    this.pageLayers = new Map();
  }

  registerPageLayer(pageNumber, pageShell, viewport) {
    const textLayer = document.createElement("div");
    textLayer.className = "text-layer";
    textLayer.style.width = `${viewport.width}px`;
    textLayer.style.height = `${viewport.height}px`;

    const objectLayer = document.createElement("canvas");
    objectLayer.className = "object-layer";
    objectLayer.width = viewport.width;
    objectLayer.height = viewport.height;
    objectLayer.style.width = `${viewport.width}px`;
    objectLayer.style.height = `${viewport.height}px`;

    pageShell.append(textLayer, objectLayer);
    this.pageLayers.set(pageNumber, { textLayer, objectLayer, viewport });
    return { textLayer, objectLayer };
  }

  renderTextBlocks(pageNumber, blocks, style, selectedBlockId = null) {
    const pageLayer = this.pageLayers.get(pageNumber);
    if (!pageLayer) {
      return;
    }

    pageLayer.textLayer.replaceChildren();

    blocks.forEach((block) => {
      const editable = document.createElement("div");
      editable.className = "editable-text-block";
      if (block.id === selectedBlockId) {
        editable.classList.add("selected");
      }
      editable.dataset.blockId = block.id;
      editable.contentEditable = "true";
      editable.style.left = `${block.x}px`;
      editable.style.top = `${block.y}px`;
      editable.style.width = `${block.width}px`;
      editable.style.minHeight = `${block.height}px`;
      applyStyle(editable, block.style ?? style);
      editable.textContent = block.text;

      editable.addEventListener("input", () => {
        const caretOffset = getCaretOffset(editable);
        const localStyle = block.style ?? style;
        const reflowed = this.reflowEngine.applyEdit(
          block,
          () => editable.textContent ?? "",
          localStyle
        );
        editable.textContent = reflowed.text;
        editable.style.minHeight = `${reflowed.height}px`;
        setCaretOffset(editable, caretOffset);
        this.onBlockEdit?.(pageNumber, reflowed);
      });
      editable.addEventListener("focus", () => {
        this.onBlockSelect?.(pageNumber, block.id);
      });
      editable.addEventListener("click", () => {
        this.onBlockSelect?.(pageNumber, block.id);
      });

      pageLayer.textLayer.append(editable);
    });
  }

  setMode(mode) {
    this.root.classList.remove("mode-view", "mode-text", "mode-object");
    this.root.classList.add(`mode-${mode}`);
  }
}

function applyStyle(element, style) {
  element.style.fontFamily = style.fontFamily;
  element.style.fontSize = `${style.fontSize}px`;
  element.style.lineHeight = String(style.lineSpacing);
  element.style.textAlign = style.textAlign;
}

function getCaretOffset(element) {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) {
    return 0;
  }
  const range = selection.getRangeAt(0);
  if (!element.contains(range.startContainer)) {
    return 0;
  }
  const preCaretRange = range.cloneRange();
  preCaretRange.selectNodeContents(element);
  preCaretRange.setEnd(range.startContainer, range.startOffset);
  return preCaretRange.toString().length;
}

function setCaretOffset(element, targetOffset) {
  const selection = window.getSelection();
  if (!selection) {
    return;
  }
  const range = document.createRange();
  let consumed = 0;
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
  let current = walker.nextNode();
  while (current) {
    const textLength = current.nodeValue?.length ?? 0;
    if (consumed + textLength >= targetOffset) {
      const localOffset = Math.max(0, targetOffset - consumed);
      range.setStart(current, Math.min(localOffset, textLength));
      range.collapse(true);
      selection.removeAllRanges();
      selection.addRange(range);
      return;
    }
    consumed += textLength;
    current = walker.nextNode();
  }

  range.selectNodeContents(element);
  range.collapse(false);
  selection.removeAllRanges();
  selection.addRange(range);
}
