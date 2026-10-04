import { BUILT_IN_ENDINGS, ROOT_NODE_NAME, resolveTargetKnotName, type OutlineDivertKind, type OutlineKnot, type StoryOutline } from "./storyOutline";

/**
 * Lays knots out on a loom: each column (a warp thread) holds the knots that
 * are the same number of diverts away from the start; diverts are the weft
 * threads between them. Knots the start can't reach go in a last column of
 * their own, which doubles as an "is anything orphaned?" check.
 */

export interface MapNode {
  id: string;
  label: string;
  kind: "start" | "knot" | "ending" | "unreached";
  columnIndex: number;
  x: number;
  y: number;
  width: number;
  knot: OutlineKnot | null;
}

export interface MapEdge {
  fromNodeId: string;
  toNodeId: string;
  kind: OutlineDivertKind;
  /** Points back to an earlier or the same column: drawn as a loop instead of a forward thread. */
  isBackward: boolean;
  occurrenceCount: number;
}

export type MapOrientation = "horizontal" | "vertical";

export interface MapLayout {
  orientation: MapOrientation;
  nodes: MapNode[];
  edges: MapEdge[];
  /** Positions of each warp thread along the depth axis (x when horizontal, y when vertical). */
  warpPositions: number[];
  width: number;
  height: number;
}

const HORIZONTAL_DEPTH_SPACING = 220;
const HORIZONTAL_BREADTH_SPACING = 64;
const VERTICAL_DEPTH_SPACING = 96;
const VERTICAL_BREADTH_GAP = 26;
const MARGIN = 48;
const CHARACTER_WIDTH_ESTIMATE = 8.2;
const NODE_HORIZONTAL_PADDING = 28;
const ENDING_NODE_ID = "END";

export function layoutStoryMap(outline: StoryOutline, orientation: MapOrientation = "horizontal"): MapLayout {
  const knotsByName = new Map(outline.knots.map((knot) => [knot.name, knot]));
  const storyKnots = outline.knots.filter((knot) => !knot.isFunction);

  // Aggregate diverts into knot-to-knot threads.
  const edgeKeyToEdge = new Map<string, MapEdge>();
  for (const divert of outline.diverts) {
    const targetName = resolveTargetKnotName(divert.rawTarget, divert.fromKnotName, knotsByName);
    if (!targetName) continue;
    const targetKnot = knotsByName.get(targetName);
    if (targetKnot?.isFunction) continue;
    const fromKnot = knotsByName.get(divert.fromKnotName);
    if (fromKnot?.isFunction) continue;
    const toNodeId = BUILT_IN_ENDINGS.has(targetName) ? ENDING_NODE_ID : targetName;
    if (toNodeId === divert.fromKnotName) continue; // loops inside a knot are weave, not map structure
    if (toNodeId === ENDING_NODE_ID && targetName === "DONE") continue; // DONE pauses a flow; only END ends the story
    const edgeKey = `${divert.fromKnotName}\u0000${toNodeId}\u0000${divert.kind}`;
    const existingEdge = edgeKeyToEdge.get(edgeKey);
    if (existingEdge) existingEdge.occurrenceCount += 1;
    else edgeKeyToEdge.set(edgeKey, { fromNodeId: divert.fromKnotName, toNodeId, kind: divert.kind, isBackward: false, occurrenceCount: 1 });
  }
  const edges = [...edgeKeyToEdge.values()];

  const outgoingByNodeId = new Map<string, string[]>();
  for (const edge of edges) {
    if (!outgoingByNodeId.has(edge.fromNodeId)) outgoingByNodeId.set(edge.fromNodeId, []);
    outgoingByNodeId.get(edge.fromNodeId)!.push(edge.toNodeId);
  }

  // Columns by shortest divert distance from the start (breadth-first).
  const startNodeId = outline.rootLocation || outgoingByNodeId.has(ROOT_NODE_NAME) ? ROOT_NODE_NAME : storyKnots[0]?.name ?? null;
  const columnIndexByNodeId = new Map<string, number>();
  if (startNodeId) {
    columnIndexByNodeId.set(startNodeId, 0);
    const queue = [startNodeId];
    while (queue.length > 0) {
      const currentNodeId = queue.shift()!;
      for (const nextNodeId of outgoingByNodeId.get(currentNodeId) ?? []) {
        if (nextNodeId === ENDING_NODE_ID || columnIndexByNodeId.has(nextNodeId)) continue;
        columnIndexByNodeId.set(nextNodeId, columnIndexByNodeId.get(currentNodeId)! + 1);
        queue.push(nextNodeId);
      }
    }
  }

  const reachedColumnCount = Math.max(0, ...columnIndexByNodeId.values()) + 1;
  const endingIsUsed = edges.some((edge) => edge.toNodeId === ENDING_NODE_ID);
  const endingColumnIndex = reachedColumnCount;
  const unreachedKnots = storyKnots.filter((knot) => !columnIndexByNodeId.has(knot.name));
  const unreachedColumnIndex = endingColumnIndex + (endingIsUsed ? 1 : 0);

  // Build columns, then order each one by the average row of its parents (one barycenter pass).
  const columns: string[][] = [];
  const placeInColumn = (nodeId: string, columnIndex: number) => {
    (columns[columnIndex] ??= []).push(nodeId);
  };
  if (startNodeId && startNodeId === ROOT_NODE_NAME) placeInColumn(ROOT_NODE_NAME, 0);
  for (const knot of storyKnots) {
    const columnIndex = columnIndexByNodeId.get(knot.name);
    if (columnIndex !== undefined) placeInColumn(knot.name, columnIndex);
  }
  if (endingIsUsed) placeInColumn(ENDING_NODE_ID, endingColumnIndex);
  for (const unreachedKnot of unreachedKnots) placeInColumn(unreachedKnot.name, unreachedColumnIndex);

  const rowIndexByNodeId = new Map<string, number>();
  columns.forEach((columnNodeIds, columnIndex) => {
    if (!columnNodeIds) return;
    if (columnIndex > 0) {
      const averageParentRow = (nodeId: string): number => {
        const parentRows = edges
          .filter((edge) => edge.toNodeId === nodeId && rowIndexByNodeId.has(edge.fromNodeId))
          .map((edge) => rowIndexByNodeId.get(edge.fromNodeId)!);
        return parentRows.length ? parentRows.reduce((sum, row) => sum + row, 0) / parentRows.length : Number.POSITIVE_INFINITY;
      };
      const parentRowByNodeId = new Map(columnNodeIds.map((nodeId) => [nodeId, averageParentRow(nodeId)]));
      columnNodeIds.sort((first, second) => parentRowByNodeId.get(first)! - parentRowByNodeId.get(second)!);
    }
    columnNodeIds.forEach((nodeId, rowIndex) => rowIndexByNodeId.set(nodeId, rowIndex));
  });

  const labelOf = (nodeId: string) => (nodeId === ROOT_NODE_NAME ? "start" : nodeId);
  const widthOf = (nodeId: string) => Math.min(200, Math.max(56, labelOf(nodeId).length * CHARACTER_WIDTH_ESTIMATE + NODE_HORIZONTAL_PADDING));
  const kindOf = (nodeId: string, columnIndex: number): MapNode["kind"] =>
    nodeId === ROOT_NODE_NAME ? "start" : nodeId === ENDING_NODE_ID ? "ending" : columnIndex === unreachedColumnIndex && !columnIndexByNodeId.has(nodeId) ? "unreached" : "knot";

  const nodes: MapNode[] = [];
  const pushNode = (nodeId: string, columnIndex: number, x: number, y: number) => {
    nodes.push({ id: nodeId, label: labelOf(nodeId), kind: kindOf(nodeId, columnIndex), columnIndex, x, y, width: widthOf(nodeId), knot: knotsByName.get(nodeId) ?? null });
  };

  let warpPositions: number[];
  let width: number;
  let height: number;

  if (orientation === "horizontal") {
    // Depth runs left to right; each column centered against the tallest one.
    const tallestColumnSize = Math.max(1, ...columns.map((columnNodeIds) => columnNodeIds?.length ?? 0));
    const contentHeight = (tallestColumnSize - 1) * HORIZONTAL_BREADTH_SPACING;
    warpPositions = columns.map((_, columnIndex) => MARGIN + 70 + columnIndex * HORIZONTAL_DEPTH_SPACING);
    columns.forEach((columnNodeIds, columnIndex) => {
      if (!columnNodeIds) return;
      const columnOffsetY = (contentHeight - (columnNodeIds.length - 1) * HORIZONTAL_BREADTH_SPACING) / 2;
      columnNodeIds.forEach((nodeId, rowIndex) => pushNode(nodeId, columnIndex, warpPositions[columnIndex], MARGIN + 40 + columnOffsetY + rowIndex * HORIZONTAL_BREADTH_SPACING));
    });
    width = (warpPositions.at(-1) ?? MARGIN) + 140 + MARGIN;
    height = MARGIN * 2 + 80 + contentHeight;
  } else {
    // Depth runs top to bottom (suits a tall pane or a portrait iPad); each row centered against the widest.
    const rowWidths = columns.map((columnNodeIds) =>
      (columnNodeIds ?? []).reduce((sum, nodeId) => sum + widthOf(nodeId), 0) + Math.max(0, (columnNodeIds?.length ?? 0) - 1) * VERTICAL_BREADTH_GAP,
    );
    const widestRow = Math.max(160, ...rowWidths);
    warpPositions = columns.map((_, columnIndex) => MARGIN + 30 + columnIndex * VERTICAL_DEPTH_SPACING);
    columns.forEach((columnNodeIds, columnIndex) => {
      if (!columnNodeIds) return;
      let cursorX = MARGIN + (widestRow - rowWidths[columnIndex]) / 2;
      for (const nodeId of columnNodeIds) {
        pushNode(nodeId, columnIndex, cursorX + widthOf(nodeId) / 2, warpPositions[columnIndex]);
        cursorX += widthOf(nodeId) + VERTICAL_BREADTH_GAP;
      }
    });
    width = MARGIN * 2 + widestRow + 60; // room on the right for backward loops
    height = (warpPositions.at(-1) ?? MARGIN) + 30 + MARGIN;
  }

  const columnByNodeId = new Map(nodes.map((node) => [node.id, node.columnIndex]));
  for (const edge of edges) {
    edge.isBackward = (columnByNodeId.get(edge.toNodeId) ?? 0) <= (columnByNodeId.get(edge.fromNodeId) ?? 0);
  }

  return {
    orientation,
    nodes,
    edges: edges.filter((edge) => columnByNodeId.has(edge.fromNodeId) && columnByNodeId.has(edge.toNodeId)),
    warpPositions,
    width,
    height,
  };
}
