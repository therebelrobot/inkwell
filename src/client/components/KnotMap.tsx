import { useEffect, useMemo, useRef, useState } from "react";
import { layoutStoryMap, type MapEdge, type MapLayout, type MapNode, type MapOrientation } from "../story/mapLayout";
import type { StoryOutline } from "../story/storyOutline";

interface KnotMapProps {
  outline: StoryOutline | null;
  onOpenLocation: (filePath: string, lineNumber: number) => void;
  onPlayFrom: (knotName: string) => void;
}

interface ViewTransform {
  offsetX: number;
  offsetY: number;
  scale: number;
}

const MINIMUM_SCALE = 0.25;
const MAXIMUM_SCALE = 2.5;
const NODE_HEIGHT = 34;

function clampScale(scale: number): number {
  return Math.min(MAXIMUM_SCALE, Math.max(MINIMUM_SCALE, scale));
}

function edgePath(edge: MapEdge, nodesById: Map<string, MapNode>, mapLayout: MapLayout): string {
  const fromNode = nodesById.get(edge.fromNodeId)!;
  const toNode = nodesById.get(edge.toNodeId)!;
  if (mapLayout.orientation === "horizontal") {
    const startX = fromNode.x + fromNode.width / 2;
    const startY = fromNode.y;
    if (!edge.isBackward) {
      const endX = toNode.x - toNode.width / 2;
      const handleLength = Math.max(40, (endX - startX) / 2);
      return `M ${startX} ${startY} C ${startX + handleLength} ${startY}, ${endX - handleLength} ${toNode.y}, ${endX} ${toNode.y}`;
    }
    // Backward threads loop under the loom so they never cross forward ones head-on.
    const endX = toNode.x;
    const endY = toNode.y + NODE_HEIGHT / 2;
    const loopDepth = Math.min(mapLayout.height - 16, Math.max(fromNode.y, toNode.y) + 46 + Math.abs(fromNode.x - toNode.x) * 0.08);
    return `M ${startX} ${startY} C ${startX + 60} ${startY}, ${startX + 40} ${loopDepth}, ${(startX + endX) / 2} ${loopDepth} S ${endX} ${loopDepth - 10}, ${endX} ${endY}`;
  }
  const startX = fromNode.x;
  const startY = fromNode.y + NODE_HEIGHT / 2;
  if (!edge.isBackward) {
    const endY = toNode.y - NODE_HEIGHT / 2;
    const handleLength = Math.max(30, (endY - startY) / 2);
    return `M ${startX} ${startY} C ${startX} ${startY + handleLength}, ${toNode.x} ${endY - handleLength}, ${toNode.x} ${endY}`;
  }
  // Backward threads loop out to the right of both knots, then come back in.
  const loopX = Math.min(mapLayout.width - 12, Math.max(fromNode.x + fromNode.width / 2, toNode.x + toNode.width / 2) + 34 + Math.abs(fromNode.y - toNode.y) * 0.06);
  const exitX = fromNode.x + fromNode.width / 2;
  const entryX = toNode.x + toNode.width / 2;
  return `M ${exitX} ${fromNode.y} C ${loopX} ${fromNode.y}, ${loopX} ${toNode.y}, ${entryX} ${toNode.y}`;
}

const MINIMUM_READABLE_SCALE = 0.7;

export function KnotMap({ outline, onOpenLocation, onPlayFrom }: KnotMapProps) {
  const [orientation, setOrientation] = useState<MapOrientation>("horizontal");
  const layout: MapLayout | null = useMemo(() => (outline ? layoutStoryMap(outline, orientation) : null), [outline, orientation]);
  const nodesById = useMemo(() => new Map((layout?.nodes ?? []).map((node) => [node.id, node])), [layout]);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [viewTransform, setViewTransform] = useState<ViewTransform>({ offsetX: 0, offsetY: 0, scale: 1 });
  const viewportRef = useRef<HTMLDivElement>(null);
  const activePointersRef = useRef(new Map<number, { x: number; y: number }>());
  const gestureStartRef = useRef<{ transform: ViewTransform; pinchDistance: number; midpointX: number; midpointY: number; moved: boolean } | null>(null);
  const hasAutoFittedRef = useRef(false);

  const fitToView = () => {
    const viewportElement = viewportRef.current;
    if (!viewportElement || !layout) return;
    // Fit if that keeps labels readable; otherwise stay readable and start at the beginning of the story.
    const fittedScale = clampScale(Math.max(MINIMUM_READABLE_SCALE, Math.min(viewportElement.clientWidth / layout.width, viewportElement.clientHeight / layout.height, 1.15)));
    const scaledWidth = layout.width * fittedScale;
    const scaledHeight = layout.height * fittedScale;
    setViewTransform({
      scale: fittedScale,
      offsetX: scaledWidth <= viewportElement.clientWidth ? (viewportElement.clientWidth - scaledWidth) / 2 : 0,
      offsetY: scaledHeight <= viewportElement.clientHeight ? (viewportElement.clientHeight - scaledHeight) / 2 : 0,
    });
  };

  // Lay the loom along the pane's long side, and re-fit when that flips (rotating an iPad).
  useEffect(() => {
    const viewportElement = viewportRef.current;
    if (!viewportElement) return;
    const resizeObserver = new ResizeObserver(() => {
      if (!viewportElement.clientWidth) return;
      const preferredOrientation: MapOrientation = viewportElement.clientHeight > viewportElement.clientWidth * 1.1 ? "vertical" : "horizontal";
      setOrientation((currentOrientation) => {
        if (currentOrientation !== preferredOrientation) hasAutoFittedRef.current = false;
        return preferredOrientation;
      });
    });
    resizeObserver.observe(viewportElement);
    return () => resizeObserver.disconnect();
  }, [Boolean(layout)]);

  useEffect(() => {
    if (layout && !hasAutoFittedRef.current && viewportRef.current?.clientWidth) {
      hasAutoFittedRef.current = true;
      fitToView();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layout]);

  useEffect(() => {
    if (selectedNodeId && !nodesById.has(selectedNodeId)) setSelectedNodeId(null);
  }, [nodesById, selectedNodeId]);

  // -- pan (one pointer), pinch-zoom (two pointers), wheel / trackpad zoom --------

  const handlePointerDown = (pointerEvent: React.PointerEvent) => {
    if ((pointerEvent.target as Element).closest("[data-map-node]")) return;
    viewportRef.current?.setPointerCapture(pointerEvent.pointerId);
    activePointersRef.current.set(pointerEvent.pointerId, { x: pointerEvent.clientX, y: pointerEvent.clientY });
    const pointerPositions = [...activePointersRef.current.values()];
    const pinchDistance =
      pointerPositions.length >= 2 ? Math.hypot(pointerPositions[0].x - pointerPositions[1].x, pointerPositions[0].y - pointerPositions[1].y) : 0;
    const midpointX = pointerPositions.reduce((sum, position) => sum + position.x, 0) / pointerPositions.length;
    const midpointY = pointerPositions.reduce((sum, position) => sum + position.y, 0) / pointerPositions.length;
    gestureStartRef.current = { transform: viewTransform, pinchDistance, midpointX, midpointY, moved: false };
  };

  const handlePointerMove = (pointerEvent: React.PointerEvent) => {
    if (!activePointersRef.current.has(pointerEvent.pointerId) || !gestureStartRef.current) return;
    activePointersRef.current.set(pointerEvent.pointerId, { x: pointerEvent.clientX, y: pointerEvent.clientY });
    const pointerPositions = [...activePointersRef.current.values()];
    const gestureStart = gestureStartRef.current;
    const midpointX = pointerPositions.reduce((sum, position) => sum + position.x, 0) / pointerPositions.length;
    const midpointY = pointerPositions.reduce((sum, position) => sum + position.y, 0) / pointerPositions.length;
    gestureStart.moved = true;

    if (pointerPositions.length >= 2 && gestureStart.pinchDistance > 0) {
      const viewportBounds = viewportRef.current!.getBoundingClientRect();
      const currentDistance = Math.hypot(pointerPositions[0].x - pointerPositions[1].x, pointerPositions[0].y - pointerPositions[1].y);
      const newScale = clampScale(gestureStart.transform.scale * (currentDistance / gestureStart.pinchDistance));
      // Keep the point under the fingers' starting midpoint fixed while zooming.
      const anchorX = gestureStart.midpointX - viewportBounds.left;
      const anchorY = gestureStart.midpointY - viewportBounds.top;
      const contentX = (anchorX - gestureStart.transform.offsetX) / gestureStart.transform.scale;
      const contentY = (anchorY - gestureStart.transform.offsetY) / gestureStart.transform.scale;
      setViewTransform({
        scale: newScale,
        offsetX: anchorX - contentX * newScale + (midpointX - gestureStart.midpointX),
        offsetY: anchorY - contentY * newScale + (midpointY - gestureStart.midpointY),
      });
    } else {
      setViewTransform({
        ...gestureStart.transform,
        offsetX: gestureStart.transform.offsetX + (midpointX - gestureStart.midpointX),
        offsetY: gestureStart.transform.offsetY + (midpointY - gestureStart.midpointY),
      });
    }
  };

  const handlePointerEnd = (pointerEvent: React.PointerEvent) => {
    const wasTap = gestureStartRef.current && !gestureStartRef.current.moved;
    activePointersRef.current.delete(pointerEvent.pointerId);
    // Re-base the gesture on the remaining finger so lifting one of two doesn't jump.
    if (activePointersRef.current.size > 0) {
      const [remainingPosition] = activePointersRef.current.values();
      gestureStartRef.current = { transform: viewTransform, pinchDistance: 0, midpointX: remainingPosition.x, midpointY: remainingPosition.y, moved: true };
    } else {
      gestureStartRef.current = null;
      if (wasTap) setSelectedNodeId(null);
    }
  };

  useEffect(() => {
    const viewportElement = viewportRef.current;
    if (!viewportElement) return;
    const handleWheel = (wheelEvent: WheelEvent) => {
      wheelEvent.preventDefault();
      const viewportBounds = viewportElement.getBoundingClientRect();
      const anchorX = wheelEvent.clientX - viewportBounds.left;
      const anchorY = wheelEvent.clientY - viewportBounds.top;
      setViewTransform((currentTransform) => {
        // ctrlKey is how trackpad pinches arrive; plain wheel scrolls pan.
        if (!wheelEvent.ctrlKey && !wheelEvent.metaKey) {
          return { ...currentTransform, offsetX: currentTransform.offsetX - wheelEvent.deltaX, offsetY: currentTransform.offsetY - wheelEvent.deltaY };
        }
        const newScale = clampScale(currentTransform.scale * Math.exp(-wheelEvent.deltaY * 0.01));
        const contentX = (anchorX - currentTransform.offsetX) / currentTransform.scale;
        const contentY = (anchorY - currentTransform.offsetY) / currentTransform.scale;
        return { scale: newScale, offsetX: anchorX - contentX * newScale, offsetY: anchorY - contentY * newScale };
      });
    };
    viewportElement.addEventListener("wheel", handleWheel, { passive: false });
    return () => viewportElement.removeEventListener("wheel", handleWheel);
  }, []);

  if (!layout || layout.nodes.length === 0) {
    return (
      <div className="pane-empty">
        <p>Add a knot (<code>=== name ===</code>) and divert to it to see the story's shape here.</p>
      </div>
    );
  }

  const selectedNode = selectedNodeId ? nodesById.get(selectedNodeId) ?? null : null;
  const isEdgeHighlighted = (edge: MapEdge) => selectedNodeId !== null && (edge.fromNodeId === selectedNodeId || edge.toNodeId === selectedNodeId);
  const unreachedCount = layout.nodes.filter((node) => node.kind === "unreached").length;

  return (
    <div className="knot-map">
      <div
        className="knot-map__viewport"
        ref={viewportRef}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerEnd}
        onPointerCancel={handlePointerEnd}
      >
        <svg width="100%" height="100%" role="img" aria-label="Map of knots and the diverts between them">
          <defs>
            <marker id="thread-end" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
              <path d="M0,0 L8,4 L0,8 z" fill="var(--color-thread)" />
            </marker>
            <marker id="thread-end-lit" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
              <path d="M0,0 L8,4 L0,8 z" fill="var(--color-lamplight)" />
            </marker>
          </defs>
          <g transform={`translate(${viewTransform.offsetX} ${viewTransform.offsetY}) scale(${viewTransform.scale})`}>
            {layout.warpPositions.map((warpPosition, warpIndex) =>
              layout.orientation === "horizontal" ? (
                <line key={warpIndex} className="knot-map__warp" x1={warpPosition} x2={warpPosition} y1={8} y2={layout.height - 8} />
              ) : (
                <line key={warpIndex} className="knot-map__warp" x1={8} x2={layout.width - 8} y1={warpPosition} y2={warpPosition} />
              ),
            )}
            {layout.edges.map((edge) => {
              const highlighted = isEdgeHighlighted(edge);
              return (
                <path
                  key={`${edge.fromNodeId}>${edge.toNodeId}>${edge.kind}`}
                  className={`knot-map__thread knot-map__thread--${edge.kind}${edge.isBackward ? " knot-map__thread--backward" : ""}${highlighted ? " is-lit" : ""}`}
                  d={edgePath(edge, nodesById, layout)}
                  markerEnd={`url(#${highlighted ? "thread-end-lit" : "thread-end"})`}
                  strokeWidth={Math.min(1.4 + edge.occurrenceCount * 0.5, 4)}
                />
              );
            })}
            {layout.nodes.map((node) => (
              <g
                key={node.id}
                data-map-node
                className={`knot-map__node knot-map__node--${node.kind}${node.id === selectedNodeId ? " is-selected" : ""}`}
                transform={`translate(${node.x - node.width / 2} ${node.y - NODE_HEIGHT / 2})`}
                onClick={() => setSelectedNodeId(node.id === selectedNodeId ? null : node.id)}
                role="button"
                tabIndex={0}
                aria-label={`${node.label}${node.kind === "unreached" ? ", not reached from the start" : ""}`}
                onKeyDown={(keyEvent) => {
                  if (keyEvent.key === "Enter" || keyEvent.key === " ") setSelectedNodeId(node.id);
                }}
              >
                <rect width={node.width} height={NODE_HEIGHT} rx={node.kind === "knot" || node.kind === "unreached" ? 6 : NODE_HEIGHT / 2} />
                <text x={node.width / 2} y={NODE_HEIGHT / 2 + 5} textAnchor="middle">
                  {node.label.length > 22 ? `${node.label.slice(0, 21)}…` : node.label}
                </text>
                {node.knot && node.knot.stitchNames.length > 0 && (
                  <text className="knot-map__stitch-count" x={node.width / 2} y={NODE_HEIGHT + 14} textAnchor="middle">
                    {node.knot.stitchNames.length} stitch{node.knot.stitchNames.length === 1 ? "" : "es"}
                  </text>
                )}
              </g>
            ))}
          </g>
        </svg>
      </div>

      <div className="knot-map__footer">
        {selectedNode ? (
          <>
            <div className="knot-map__selection">
              <strong>{selectedNode.label}</strong>
              {selectedNode.knot && (
                <span>
                  {selectedNode.knot.filePath}:{selectedNode.knot.lineNumber}
                </span>
              )}
              {selectedNode.kind === "unreached" && <span className="knot-map__warning">Nothing reaches this from the start</span>}
            </div>
            {selectedNode.knot && (
              <>
                <button type="button" onClick={() => onOpenLocation(selectedNode.knot!.filePath, selectedNode.knot!.lineNumber)}>
                  Open
                </button>
                <button type="button" className="button--lamplight" onClick={() => onPlayFrom(selectedNode.knot!.name)}>
                  Play from here
                </button>
              </>
            )}
          </>
        ) : (
          <span className="knot-map__hint">
            {layout.nodes.filter((node) => node.kind === "knot" || node.kind === "unreached").length} knots
            {unreachedCount > 0 ? `, ${unreachedCount} not reached from the start (dashed, at the far end)` : ""}. Tap a knot to open it or play from it.
          </span>
        )}
        <button type="button" className="button--quiet" onClick={fitToView}>
          Fit
        </button>
      </div>
    </div>
  );
}
