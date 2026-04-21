const state = {
  documentId: null,
  sourceUrl: null,
  workflowEndpoint: "",
  pages: [],
  textBlocks: {},
  objectBlocks: {},
  selectedObject: null,
  links: [],
  editMode: "view",
  style: {
    fontFamily: "Arial",
    fontSize: 14,
    lineSpacing: 1.4,
    textAlign: "left"
  }
};

const listeners = new Set();

export function getState() {
  return structuredClone(state);
}

export function subscribe(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function updateState(mutator) {
  mutator(state);
  const snapshot = getState();
  listeners.forEach((listener) => listener(snapshot));
  return snapshot;
}

export function resetDocumentState(sourceUrl) {
  updateState((draft) => {
    draft.documentId = crypto.randomUUID();
    draft.sourceUrl = sourceUrl;
    draft.selectedObject = null;
    draft.pages = [];
    draft.textBlocks = {};
    draft.objectBlocks = {};
    draft.links = [];
    draft.editMode = "view";
  });
}
