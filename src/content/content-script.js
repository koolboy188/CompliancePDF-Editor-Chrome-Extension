const MESSAGE_TYPES = {
  OPEN_PDF_IN_VIEWER: "OPEN_PDF_IN_VIEWER"
};

const isPdfPage =
  document.contentType === "application/pdf" ||
  window.location.pathname.toLowerCase().endsWith(".pdf");

if (isPdfPage) {
  injectOpenButton();
}

function injectOpenButton() {
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = "Open in CompliancePDF Editor";
  Object.assign(button.style, {
    position: "fixed",
    zIndex: "2147483647",
    top: "16px",
    right: "16px",
    padding: "8px 12px",
    borderRadius: "8px",
    border: "1px solid #d0d7de",
    background: "#ffffff",
    cursor: "pointer"
  });

  button.addEventListener("click", () => {
    chrome.runtime.sendMessage({
      type: MESSAGE_TYPES.OPEN_PDF_IN_VIEWER,
      payload: { url: window.location.href }
    });
  });

  document.documentElement.append(button);
}
