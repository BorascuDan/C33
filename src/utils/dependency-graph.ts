import type { SettlementTask } from "../reflow/types.js";

export type DependencyGraph = Record<string, string[]>;

export function buildDependencyGraph(tasks: SettlementTask[]): DependencyGraph {
  const graph: DependencyGraph = {};
  for (const task of tasks) {
    graph[task.docId] = [...task.data.dependsOnTaskIds];
  }
  return graph;
}

/**
 @upgrade in real life production iterativ is better
 */
export function hasCycle(graph: DependencyGraph): boolean {
  const stack = new Set<string>();
  const safe = new Set<string>();

  const visit = (id: string): boolean => {
    if (stack.has(id)) return true;
    if (safe.has(id)) return false;

    stack.add(id);

    for (const dep of graph[id] ?? []) {
      if (visit(dep)) return true;
    }

    stack.delete(id);
    safe.add(id);
    return false;
  };

  for (const id of Object.keys(graph)) {
    if (visit(id)) return true;
  }
  return false;
}
