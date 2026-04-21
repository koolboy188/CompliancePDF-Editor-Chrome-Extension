import { MESSAGE_TYPES } from "../shared/message-types.js";

const controls = {
  fontFamily: document.getElementById("fontFamily"),
  fontSize: document.getElementById("fontSize"),
  lineSpacing: document.getElementById("lineSpacing"),
  textAlign: document.getElementById("textAlign")
};

document.querySelectorAll("[data-mode]").forEach((button) => {
  button.addEventListener("click", () => {
    sendCommand("SET_EDIT_MODE", { mode: button.dataset.mode });
  });
});

Object.entries(controls).forEach(([name, element]) => {
  element?.addEventListener("change", () => {
    sendCommand("SET_TEXT_STYLE", collectStylePayload(name));
  });
});

document.getElementById("linkBlocks")?.addEventListener("click", () => {
  sendCommand("START_LINK_BLOCK_SELECTION", {});
});

document.getElementById("savePdf")?.addEventListener("click", () => {
  sendCommand("SAVE_PDF", {});
});

document.getElementById("undoBtn")?.addEventListener("click", () => {
  sendCommand("UNDO", {});
});

document.getElementById("redoBtn")?.addEventListener("click", () => {
  sendCommand("REDO", {});
});

document.getElementById("addRectBtn")?.addEventListener("click", () => {
  sendCommand("ADD_RECT_OBJECT", {});
});

document.getElementById("clearSelectBtn")?.addEventListener("click", () => {
  sendCommand("CLEAR_SELECTION", {});
});

document.getElementById("duplicateObjBtn")?.addEventListener("click", () => {
  sendCommand("DUPLICATE_OBJECT", {});
});

document.getElementById("deleteObjBtn")?.addEventListener("click", () => {
  sendCommand("DELETE_OBJECT", {});
});

document.getElementById("imageInput")?.addEventListener("change", async (event) => {
  const file = event.target.files?.[0];
  if (!file) return;
  const dataUrl = await fileToDataUrl(file);
  sendCommand("ADD_IMAGE_OBJECT", { dataUrl });
  event.target.value = "";
});

document.getElementById("applyObjStyleBtn")?.addEventListener("click", () => {
  sendCommand("TRANSFORM_OBJECT", {
    changes: {
      opacity: Number(document.getElementById("objOpacity")?.value ?? 1),
      angle: Number(document.getElementById("objRotate")?.value ?? 0),
      scaleX: Number(document.getElementById("objScaleX")?.value ?? 1),
      scaleY: Number(document.getElementById("objScaleY")?.value ?? 1),
      fill: String(document.getElementById("objFill")?.value ?? "#3b82f6"),
      stroke: String(document.getElementById("objStroke")?.value ?? "#2563eb"),
      strokeWidth: Number(document.getElementById("objStrokeWidth")?.value ?? 1.5)
    }
  });
});

document.getElementById("flipXBtn")?.addEventListener("click", () => {
  sendCommand("FLIP_OBJECT_X", {});
});

document.getElementById("flipYBtn")?.addEventListener("click", () => {
  sendCommand("FLIP_OBJECT_Y", {});
});

document.getElementById("bringForwardBtn")?.addEventListener("click", () => {
  sendCommand("BRING_OBJECT_FORWARD", {});
});

document.getElementById("sendBackwardBtn")?.addEventListener("click", () => {
  sendCommand("SEND_OBJECT_BACKWARD", {});
});

document.getElementById("toggleLockBtn")?.addEventListener("click", () => {
  sendCommand("TOGGLE_OBJECT_LOCK", {});
});

function collectStylePayload(lastChanged) {
  return {
    lastChanged,
    style: {
      fontFamily: String(controls.fontFamily?.value ?? "Arial"),
      fontSize: Number(controls.fontSize?.value ?? 14),
      lineSpacing: Number(controls.lineSpacing?.value ?? 1.4),
      textAlign: String(controls.textAlign?.value ?? "left")
    }
  };
}

function sendCommand(command, payload) {
  chrome.runtime.sendMessage({
    type: MESSAGE_TYPES.SIDE_PANEL_COMMAND,
    payload: { command, ...payload }
  });
}

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Cannot read image file"));
    reader.onload = () => resolve(String(reader.result));
    reader.readAsDataURL(file);
  });
}
