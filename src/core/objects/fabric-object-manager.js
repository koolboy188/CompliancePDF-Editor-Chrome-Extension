let fabricPromise;

async function loadFabric() {
  if (!fabricPromise) {
    fabricPromise = import("../../../node_modules/fabric/dist/index.min.mjs");
  }
  return fabricPromise;
}

export class FabricObjectManager {
  constructor({ onObjectsChanged, onObjectsTransforming, onSelectionChanged, onObjectHover }) {
    this.onObjectsChanged = onObjectsChanged;
    this.onObjectsTransforming = onObjectsTransforming;
    this.onSelectionChanged = onSelectionChanged;
    this.onObjectHover = onObjectHover;
    this.fabricByPage = new Map();
    this.RectClass = null;
    this.PolygonClass = null;
    this.isSyncing = false;
    this.snapGrid = { enabled: false, stepPx: 16 };
    this.digitalSignatureDetected = false;
  }

  async attachPageCanvas(pageNumber, canvas, initialObjects = []) {
    const { Canvas, Rect, FabricImage, Polygon } = await loadFabric();
    this.RectClass = Rect;
    this.ImageClass = FabricImage;
    this.PolygonClass = Polygon;
    const fabricCanvas = new Canvas(canvas, {
      selection: true,
      preserveObjectStacking: true
    });

    for (const object of initialObjects) {
      // Rehydrate detected native PDF objects into editable proxy objects.
      if (object.type === "image" && object.src) {
        try {
          const imageSrc = object.src;
          const image = await FabricImage.fromURL(imageSrc, { crossOrigin: "anonymous" });
          const bboxStyle = getBBoxStyle(object, {
            digitalSignatureDetected: this.digitalSignatureDetected
          });
          const baseWidth = Math.max(1, image.width ?? 1);
          const baseHeight = Math.max(1, image.height ?? 1);
          const targetWidth = Math.max(1, object.width ?? baseWidth);
          const targetHeight = Math.max(1, object.height ?? baseHeight);
          image.set({
            left: object.x ?? 0,
            top: object.y ?? 0,
            originX: "left",
            originY: "top",
            angle: object.angle ?? 0,
            scaleX: (object.scaleX ?? 1) * (targetWidth / baseWidth),
            scaleY: (object.scaleY ?? 1) * (targetHeight / baseHeight),
            opacity: 1,
            stroke: bboxStyle.stroke,
            strokeWidth: Math.max(1.6, object.strokeWidth ?? 1.8),
            strokeUniform: true,
            objectCaching: false
          });
          image.set("data", {
            source: object.source ?? "pdf-native",
            detectedType: object.type ?? "snapshot",
            showBBox: Boolean(object.showBBox),
            bboxRole: object.bboxRole ?? null
          });
          this.applyObjectInteractivity(image);
          fabricCanvas.add(image);
          continue;
        } catch (_) {
          // Fall back to rectangle proxy below when image hydration fails.
        }
      }

      if (Array.isArray(object.points) && object.points.length >= 3 && this.PolygonClass) {
        const bboxStyle = getBBoxStyle(object, {
          digitalSignatureDetected: this.digitalSignatureDetected
        });
        const poly = new this.PolygonClass(object.points, {
          left: object.x ?? 0,
          top: object.y ?? 0,
          originX: "left",
          originY: "top",
          fill: bboxStyle.fill,
          stroke: bboxStyle.stroke,
          strokeWidth: object.strokeWidth ?? 1,
          angle: object.angle ?? 0,
          opacity: object.opacity ?? 1,
          scaleX: object.scaleX ?? 1,
          scaleY: object.scaleY ?? 1,
          objectCaching: false
        });
        poly.set("data", {
          source: object.source ?? "user",
          detectedType: "vector-path",
          showBBox: Boolean(object.showBBox),
          bboxRole: object.bboxRole ?? null
        });
        this.applyObjectInteractivity(poly);
        fabricCanvas.add(poly);
        continue;
      }

      const bboxStyle = getBBoxStyle(object, {
        digitalSignatureDetected: this.digitalSignatureDetected
      });
      const proxyRect = new Rect({
        left: object.x ?? 0,
        top: object.y ?? 0,
        originX: "left",
        originY: "top",
        width: object.width ?? 80,
        height: object.height ?? 40,
        fill: bboxStyle.fill,
        stroke: bboxStyle.stroke,
        strokeWidth: object.strokeWidth ?? 1,
        angle: object.angle ?? 0,
        opacity: object.opacity ?? 1,
        scaleX: object.scaleX ?? 1,
        scaleY: object.scaleY ?? 1
      });
      proxyRect.set("data", {
        source: object.source ?? "user",
        detectedType: object.type ?? "vector",
        showBBox: Boolean(object.showBBox),
        bboxRole: object.bboxRole ?? null
      });
      this.applyObjectInteractivity(proxyRect);
      fabricCanvas.add(proxyRect);
    }

    const emit = () => {
      if (this.isSyncing) {
        return;
      }
      this.onObjectsChanged?.(pageNumber, this.serialize(pageNumber));
    };
    const emitTransforming = (target) => {
      if (this.isSyncing || !target) {
        return;
      }
      this.onObjectsTransforming?.(pageNumber, {
        objects: this.serialize(pageNumber),
        selection: this.serializeSelection(pageNumber)
      });
    };
    fabricCanvas.on("object:modified", emit);
    fabricCanvas.on("object:moving", (event) => {
      this.applySnap(event?.target);
      emitTransforming(event?.target);
    });
    fabricCanvas.on("object:scaling", (event) => {
      this.applySnap(event?.target);
      emitTransforming(event?.target);
    });
    fabricCanvas.on("object:rotating", (event) => {
      emitTransforming(event?.target);
    });
    fabricCanvas.on("object:added", emit);
    fabricCanvas.on("object:removed", emit);
    fabricCanvas.on("selection:created", () => {
      this.onSelectionChanged?.(pageNumber, this.serializeSelection(pageNumber));
    });
    fabricCanvas.on("selection:updated", () => {
      this.onSelectionChanged?.(pageNumber, this.serializeSelection(pageNumber));
    });
    fabricCanvas.on("selection:cleared", () => {
      this.onSelectionChanged?.(pageNumber, null);
    });
    fabricCanvas.on("mouse:over", (event) => {
      if (!event?.target) return;
      this.onObjectHover?.({
        pageNumber,
        object: serializeFabricObject(event.target),
        pointer: event.pointer ?? null
      });
    });
    fabricCanvas.on("mouse:move", (event) => {
      if (!event?.target) return;
      this.onObjectHover?.({
        pageNumber,
        object: serializeFabricObject(event.target),
        pointer: event.pointer ?? null
      });
    });
    fabricCanvas.on("mouse:out", () => {
      this.onObjectHover?.(null);
    });

    this.fabricByPage.set(pageNumber, fabricCanvas);
  }

  addRectangle(pageNumber, props = {}) {
    const canvas = this.fabricByPage.get(pageNumber);
    if (!canvas || !this.RectClass) {
      return;
    }
    canvas.add(
      new this.RectClass({
        left: props.x ?? 60,
        top: props.y ?? 60,
        width: props.width ?? 120,
        height: props.height ?? 60,
        angle: props.angle ?? 0,
        fill: "rgba(59,130,246,0.18)",
        stroke: "#2563eb",
        strokeWidth: 1.5,
        cornerStyle: "circle",
        transparentCorners: false
      })
    );
    canvas.requestRenderAll();
    this.onObjectsChanged?.(pageNumber, this.serialize(pageNumber));
  }

  async addImage(pageNumber, dataUrl, props = {}) {
    const canvas = this.fabricByPage.get(pageNumber);
    if (!canvas || !this.ImageClass || !dataUrl) {
      return;
    }
    const image = await this.ImageClass.fromURL(dataUrl, {
      crossOrigin: "anonymous"
    });
    image.set({
      left: props.x ?? 80,
      top: props.y ?? 80,
      angle: props.angle ?? 0,
      scaleX: props.scaleX ?? 1,
      scaleY: props.scaleY ?? 1,
      opacity: props.opacity ?? 1
    });
    const maxWidth = props.maxWidth ?? 260;
    if (image.getScaledWidth() > maxWidth) {
      const ratio = maxWidth / image.getScaledWidth();
      image.scaleX *= ratio;
      image.scaleY *= ratio;
    }
    canvas.add(image);
    canvas.setActiveObject(image);
    canvas.requestRenderAll();
    this.onObjectsChanged?.(pageNumber, this.serialize(pageNumber));
    this.onSelectionChanged?.(pageNumber, this.serializeSelection(pageNumber));
  }

  duplicateActive(pageNumber) {
    const canvas = this.fabricByPage.get(pageNumber);
    const active = canvas?.getActiveObject();
    if (!canvas || !active) {
      return;
    }
    active.clone((cloned) => {
      cloned.set({
        left: (active.left ?? 0) + 18,
        top: (active.top ?? 0) + 18
      });
      canvas.add(cloned);
      canvas.setActiveObject(cloned);
      canvas.requestRenderAll();
      this.onObjectsChanged?.(pageNumber, this.serialize(pageNumber));
      this.onSelectionChanged?.(pageNumber, this.serializeSelection(pageNumber));
    });
  }

  removeActive(pageNumber) {
    const canvas = this.fabricByPage.get(pageNumber);
    const active = canvas?.getActiveObject();
    if (!canvas || !active) {
      return;
    }
    canvas.remove(active);
    canvas.discardActiveObject();
    canvas.requestRenderAll();
    this.onObjectsChanged?.(pageNumber, this.serialize(pageNumber));
    this.onSelectionChanged?.(pageNumber, null);
  }

  nudgeActive(pageNumber, deltaX, deltaY) {
    const canvas = this.fabricByPage.get(pageNumber);
    const active = canvas?.getActiveObject();
    if (!canvas || !active) {
      return;
    }
    active.set({
      left: (active.left ?? 0) + deltaX,
      top: (active.top ?? 0) + deltaY
    });
    active.setCoords();
    canvas.requestRenderAll();
    this.onObjectsChanged?.(pageNumber, this.serialize(pageNumber));
    this.onSelectionChanged?.(pageNumber, this.serializeSelection(pageNumber));
  }

  clearSelection(pageNumber) {
    const canvas = this.fabricByPage.get(pageNumber);
    if (!canvas) {
      return;
    }
    canvas.discardActiveObject();
    canvas.requestRenderAll();
    this.onSelectionChanged?.(pageNumber, null);
  }

  transformActive(pageNumber, changes = {}) {
    const canvas = this.fabricByPage.get(pageNumber);
    const active = canvas?.getActiveObject();
    if (!canvas || !active) {
      return;
    }
    if (typeof changes.x === "number") active.left = changes.x;
    if (typeof changes.y === "number") active.top = changes.y;
    if (typeof changes.angle === "number") active.angle = changes.angle;
    if (typeof changes.opacity === "number") active.opacity = clamp(changes.opacity, 0, 1);
    if (typeof changes.scaleX === "number") active.scaleX = Math.max(0.05, changes.scaleX);
    if (typeof changes.scaleY === "number") active.scaleY = Math.max(0.05, changes.scaleY);
    if (typeof changes.width === "number" && changes.width > 0 && active.width) {
      active.scaleX = Math.max(0.05, changes.width / active.width);
    }
    if (typeof changes.height === "number" && changes.height > 0 && active.height) {
      active.scaleY = Math.max(0.05, changes.height / active.height);
    }
    if (typeof changes.flipX === "boolean") active.flipX = changes.flipX;
    if (typeof changes.flipY === "boolean") active.flipY = changes.flipY;
    if (typeof changes.fill === "string" && "fill" in active) active.fill = changes.fill;
    if (typeof changes.stroke === "string" && "stroke" in active) active.stroke = changes.stroke;
    if (typeof changes.strokeWidth === "number" && "strokeWidth" in active) {
      active.strokeWidth = Math.max(0, changes.strokeWidth);
    }
    if (typeof changes.locked === "boolean") {
      const v = changes.locked;
      active.selectable = !v;
      active.evented = !v;
      active.lockMovementX = v;
      active.lockMovementY = v;
      active.lockScalingX = v;
      active.lockScalingY = v;
      active.lockRotation = v;
    }
    active.setCoords();
    canvas.requestRenderAll();
    this.onObjectsChanged?.(pageNumber, this.serialize(pageNumber));
    this.onSelectionChanged?.(pageNumber, this.serializeSelection(pageNumber));
  }

  bringForward(pageNumber) {
    const canvas = this.fabricByPage.get(pageNumber);
    const active = canvas?.getActiveObject();
    if (!canvas || !active) return;
    canvas.bringObjectForward(active);
    canvas.requestRenderAll();
    this.onObjectsChanged?.(pageNumber, this.serialize(pageNumber));
  }

  sendBackward(pageNumber) {
    const canvas = this.fabricByPage.get(pageNumber);
    const active = canvas?.getActiveObject();
    if (!canvas || !active) return;
    canvas.sendObjectBackwards(active);
    canvas.requestRenderAll();
    this.onObjectsChanged?.(pageNumber, this.serialize(pageNumber));
  }

  serialize(pageNumber) {
    const canvas = this.fabricByPage.get(pageNumber);
    if (!canvas) {
      return [];
    }
    return canvas.getObjects().map((obj) => serializeFabricObject(obj));
  }

  getImageMaskRects(pageNumber) {
    const canvas = this.fabricByPage.get(pageNumber);
    if (!canvas) {
      return [];
    }
    return canvas
      .getObjects()
      .filter((obj) => {
        const data = obj.get?.("data") ?? {};
        return obj.type === "image" && Boolean(data.showBBox);
      })
      .map((obj) => {
        const rect = obj.getBoundingRect();
        return {
          x: rect.left ?? 0,
          y: rect.top ?? 0,
          width: rect.width ?? 0,
          height: rect.height ?? 0
        };
      });
  }

  setInteractiveMode(enabled) {
    this.fabricByPage.forEach((canvas) => {
      canvas.selection = enabled;
      canvas.defaultCursor = enabled ? "default" : "grab";
      canvas.forEachObject((obj) => {
        this.applyObjectInteractivity(obj, enabled);
        obj.lockScalingFlip = true;
      });
      canvas.requestRenderAll();
    });
  }

  serializeSelection(pageNumber) {
    const canvas = this.fabricByPage.get(pageNumber);
    const active = canvas?.getActiveObject();
    if (!active) {
      return null;
    }
    return {
      type: active.type,
      x: active.left ?? 0,
      y: active.top ?? 0,
      width: active.getScaledWidth(),
      height: active.getScaledHeight(),
      angle: active.angle ?? 0,
      opacity: active.opacity ?? 1,
      scaleX: active.scaleX ?? 1,
      scaleY: active.scaleY ?? 1,
      flipX: Boolean(active.flipX),
      flipY: Boolean(active.flipY),
      fill: typeof active.fill === "string" ? active.fill : null,
      stroke: typeof active.stroke === "string" ? active.stroke : null,
      strokeWidth: typeof active.strokeWidth === "number" ? active.strokeWidth : 0
    };
  }

  syncPageObjects(pageNumber, objects = []) {
    const canvas = this.fabricByPage.get(pageNumber);
    if (!canvas || !this.RectClass) {
      return;
    }
    this.isSyncing = true;
    canvas.clear();
    objects.forEach((obj) => {
      if (obj.type === "image" || obj.src) {
        return;
      }
      canvas.add(
        new this.RectClass({
          left: obj.x ?? 0,
          top: obj.y ?? 0,
          width: obj.width ?? 80,
          height: obj.height ?? 40,
          angle: obj.angle ?? 0,
          opacity: obj.opacity ?? 1,
          scaleX: obj.scaleX ?? 1,
          scaleY: obj.scaleY ?? 1,
          flipX: Boolean(obj.flipX),
          flipY: Boolean(obj.flipY),
          fill: obj.fill ?? "rgba(59,130,246,0.18)",
          stroke: obj.stroke ?? "#2563eb",
          strokeWidth: obj.strokeWidth ?? 1.5,
          cornerStyle: "circle",
          transparentCorners: false
        })
      );
    });
    canvas.requestRenderAll();
    this.isSyncing = false;
  }

  setSnapGrid(enabled, stepPx) {
    this.snapGrid.enabled = Boolean(enabled);
    if (typeof stepPx === "number" && stepPx > 1) {
      this.snapGrid.stepPx = stepPx;
    }
  }

  applySnap(target) {
    if (!target || !this.snapGrid.enabled) {
      return;
    }
    const step = this.snapGrid.stepPx;
    if (typeof target.left === "number") {
      target.left = Math.round(target.left / step) * step;
    }
    if (typeof target.top === "number") {
      target.top = Math.round(target.top / step) * step;
    }
    target.setCoords();
  }

  setDigitalSignatureDetected(enabled) {
    this.digitalSignatureDetected = Boolean(enabled);
    this.fabricByPage.forEach((canvas) => {
      canvas.forEachObject((obj) => {
        const data = obj.get?.("data") ?? {};
        const bboxStyle = getBBoxStyle(data, {
          digitalSignatureDetected: this.digitalSignatureDetected
        });
        if ("fill" in obj) {
          obj.set("fill", bboxStyle.fill);
        }
        if ("stroke" in obj) {
          obj.set("stroke", bboxStyle.stroke);
        }
        this.applyObjectInteractivity(obj, canvas.selection);
      });
      canvas.requestRenderAll();
    });
  }

  applyObjectInteractivity(obj, objectModeEnabled = true) {
    const data = obj.get?.("data") ?? {};
    const canMoveWhenEnabled = canMoveObject(data, this.digitalSignatureDetected);
    const interactive = Boolean(objectModeEnabled && canMoveWhenEnabled);
    obj.selectable = interactive;
    obj.evented = interactive;
    obj.lockMovementX = !interactive;
    obj.lockMovementY = !interactive;
    obj.hoverCursor = interactive ? "move" : "default";
  }
}

function serializeFabricObject(obj) {
  const data = obj.get?.("data") ?? {};
  return {
    type: obj.type,
    x: obj.left ?? 0,
    y: obj.top ?? 0,
    width: obj.getScaledWidth(),
    height: obj.getScaledHeight(),
    angle: obj.angle ?? 0,
    opacity: obj.opacity ?? 1,
    scaleX: obj.scaleX ?? 1,
    scaleY: obj.scaleY ?? 1,
    flipX: Boolean(obj.flipX),
    flipY: Boolean(obj.flipY),
    fill: typeof obj.fill === "string" ? obj.fill : null,
    stroke: typeof obj.stroke === "string" ? obj.stroke : null,
    strokeWidth: typeof obj.strokeWidth === "number" ? obj.strokeWidth : 0,
    source: data.source ?? "user",
    detectedType: data.detectedType ?? null,
    src: obj.type === "image" ? obj.getSrc?.() ?? null : null,
    points: obj.type === "polygon" && Array.isArray(obj.points)
      ? obj.points.map((point) => ({ x: point.x, y: point.y }))
      : null
  };
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function getBBoxStyle(object, options = {}) {
  const digitalSignatureDetected = Boolean(options.digitalSignatureDetected);
  if (!object?.showBBox) {
    return {
      fill: "rgba(0,0,0,0)",
      stroke: "rgba(0,0,0,0)"
    };
  }

  if (digitalSignatureDetected) {
    return {
      fill: "rgba(250,204,21,0.15)",
      stroke: "rgba(234,179,8,0.98)"
    };
  }

  if (object.bboxRole === "stamp") {
    return {
      fill: "rgba(34,197,94,0.08)",
      stroke: "rgba(22,163,74,0.95)"
    };
  }

  if (object.bboxRole === "image") {
    return {
      fill: "rgba(239,68,68,0.16)",
      stroke: "rgba(220,38,38,0.98)"
    };
  }

  // Remove blue signature boxes by default.
  return {
    fill: "rgba(0,0,0,0)",
    stroke: "rgba(0,0,0,0)"
  };
}

function canMoveObject(data, digitalSignatureDetected) {
  if (!data?.showBBox) {
    return false;
  }
  if (digitalSignatureDetected) {
    return true;
  }
  return data.bboxRole === "image";
}
