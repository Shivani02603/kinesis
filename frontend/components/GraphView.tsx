"use client";

import { useEffect, useMemo } from "react";
import {
  ReactFlow,
  Background,
  Controls,
  useReactFlow,
  useNodesInitialized,
  type Node,
  type Edge,
  MarkerType,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import dagre from "dagre";
import type { GraphData } from "@/lib/api";

const NODE_WIDTH = 220;
const NODE_HEIGHT = 56;

const LABEL_COLORS: Record<string, { bg: string; border: string }> = {
  Stage: { bg: "#ffdbca", border: "#933e00" },
  Asset: { bg: "#d9e2ff", border: "#003c90" },
  Signal: { bg: "#e8f5e9", border: "#2e7d32" },
  Role: { bg: "#ffdbca", border: "#933e00" },
  Department: { bg: "#ffdad6", border: "#ba1a1a" },
  Objective: { bg: "#e5eeff", border: "#0f52ba" },
};

// Lays nodes out left-to-right following the actual edges (a process reads as a
// timeline), instead of bucketing by entity type — bucketing by type ignored real
// connectivity and produced long crossing lines whenever a relationship skipped
// a column. dagre performs a proper layered (Sugiyama-style) layout that keeps
// connected nodes near each other and minimizes edge crossings.
function layoutWithDagre(nodes: Node[], edges: Edge[]): Node[] {
  const g = new dagre.graphlib.Graph();
  // Generous spacing gives smoothstep edges room to route around nodes instead
  // of cutting through/behind them — the earlier tight spacing was the main
  // cause of the tangled look, more than the layout algorithm itself. A graph
  // with several relationship types crossing the same nodes (precedes, part_of,
  // measures, produces) will still show some crossings — that's the real shape
  // of the data, not something a layout tweak alone can fully remove.
  g.setGraph({ rankdir: "LR", nodesep: 60, ranksep: 160 });
  g.setDefaultEdgeLabel(() => ({}));

  for (const node of nodes) {
    g.setNode(node.id, { width: NODE_WIDTH, height: NODE_HEIGHT });
  }
  for (const edge of edges) {
    g.setEdge(edge.source, edge.target);
  }

  dagre.layout(g);

  return nodes.map((node) => {
    const { x, y } = g.node(node.id);
    return {
      ...node,
      // dagre positions are the node's center; React Flow expects top-left.
      position: { x: x - NODE_WIDTH / 2, y: y - NODE_HEIGHT / 2 },
    };
  });
}

export function GraphView({ graph }: { graph: GraphData }) {
  const { nodes, edges } = useMemo(() => {
    const baseNodes: Node[] = graph.nodes.map((n) => {
      const colors = LABEL_COLORS[n.label] ?? { bg: "#ffffff", border: "#c3c6d5" };
      return {
        id: n.id,
        position: { x: 0, y: 0 },
        data: {
          label: (
            <div>
              <div style={{ fontSize: 11, fontWeight: 600, opacity: 0.65, textTransform: "uppercase", letterSpacing: 0.4 }}>
                {n.label}
                {n.perspective ? ` · ${n.perspective}` : ""}
              </div>
              <div style={{ fontSize: 13.5, fontWeight: 500, marginTop: 2 }}>{n.name}</div>
              {n.source_reference && (
                <div style={{ fontSize: 10, color: "#434653", marginTop: 2, fontFamily: "monospace" }}>
                  ↳ column: {n.source_reference}
                </div>
              )}
            </div>
          ),
        },
        style: {
          background: colors.bg,
          border: `1.5px solid ${colors.border}`,
          borderRadius: 8,
          padding: "8px 12px",
          width: NODE_WIDTH,
          fontFamily: "var(--font-inter, sans-serif)",
        },
      };
    });

    const flowEdges: Edge[] = graph.edges.map((e, i) => ({
      id: `${e.source}-${e.type}-${e.target}-${i}`,
      source: e.source,
      target: e.target,
      type: "smoothstep",
      pathOptions: { borderRadius: 12 },
      label: e.type.toLowerCase(),
      labelStyle: { fontSize: 10, fill: "#434653" },
      labelBgStyle: { fill: "#f8f9ff" },
      labelBgPadding: [3, 2] as [number, number],
      style: { stroke: "#c3c6d5", strokeWidth: 1.25 },
      markerEnd: { type: MarkerType.ArrowClosed, color: "#c3c6d5", width: 14, height: 14 },
    }));

    const laidOutNodes = layoutWithDagre(baseNodes, flowEdges);
    return { nodes: laidOutNodes, edges: flowEdges };
  }, [graph]);

  if (graph.nodes.length === 0) {
    return (
      <div className="flex items-center justify-center h-full text-sm text-[var(--text-faint)]">
        No entities yet — upload sources and run the pipeline.
      </div>
    );
  }

  return (
    <ReactFlow
      nodes={nodes}
      edges={edges}
      fitView
      proOptions={{ hideAttribution: true }}
      minZoom={0.1}
    >
      <FitViewOnGraphChange nodeCount={nodes.length} edgeCount={edges.length} />
      <Background color="#d3e4fe" gap={20} />
      <Controls showInteractive={false} />
    </ReactFlow>
  );
}

// `fitView` on <ReactFlow> only auto-fits once, on mount. This component lives INSIDE
// <ReactFlow> (so the hooks have the flow context) and re-fits the camera every time the
// node/edge count actually changes — needed for the live discovery run, where the graph is
// re-fetched every second and grows: without this the camera stays framed on the first few
// nodes and everything discovered afterwards sits off-screen. Waiting for nodesInitialized
// ensures dagre has measured real node sizes before fitting, so the fit isn't computed
// against zero-size placeholders (which was leaving the graph blank/off-screen).
function FitViewOnGraphChange({ nodeCount, edgeCount }: { nodeCount: number; edgeCount: number }) {
  const { fitView } = useReactFlow();
  const initialized = useNodesInitialized();
  useEffect(() => {
    if (initialized && nodeCount > 0) {
      fitView({ padding: 0.15, duration: 300 });
    }
  }, [initialized, nodeCount, edgeCount, fitView]);
  return null;
}
