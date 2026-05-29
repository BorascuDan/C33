import { describe, it, expect } from "@jest/globals";
import { buildDependencyGraph, hasCycle } from "../utils/dependency-graph.js";
import { ReflowService } from "../reflow/reflow.services.js";
import { UnsatisfiableScheduleError } from "../reflow/types.js";
import type { SettlementTask } from "../reflow/types.js";

/** Minimal task factory — only the dependency fields matter for these tests. */
function task(docId: string, dependsOnTaskIds: string[] = []): SettlementTask {
  return {
    docId,
    docType: "settlementTask",
    data: {
      taskReference: docId,
      tradeOrderId: "TRD-1",
      settlementChannelId: "CH-1",
      startDate: "2024-01-15T08:00:00Z",
      endDate: "2024-01-15T09:00:00Z",
      durationMinutes: 60,
      isRegulatoryHold: false,
      dependsOnTaskIds,
      taskType: "fundTransfer",
    },
  };
}

describe("buildDependencyGraph", () => {
  it("returns an empty graph for no tasks", () => {
    expect(buildDependencyGraph([])).toEqual({});
  });

  it("maps each task id to its dependency ids", () => {
    const graph = buildDependencyGraph([task("A"), task("B", ["A"]), task("C", ["A", "B"])]);
    expect(graph).toEqual({ A: [], B: ["A"], C: ["A", "B"] });
  });

  it("copies the dependency array so the graph is decoupled from the task", () => {
    const a = task("A", ["B"]);
    const graph = buildDependencyGraph([a]);
    graph["A"]!.push("C");
    expect(a.data.dependsOnTaskIds).toEqual(["B"]); // original untouched
  });
});

describe("hasCycle", () => {
  describe("acyclic graphs → false", () => {
    it("empty graph", () => {
      expect(hasCycle({})).toBe(false);
    });

    it("single node with no dependencies", () => {
      expect(hasCycle(buildDependencyGraph([task("A")]))).toBe(false);
    });

    it("linear chain A ← B ← C", () => {
      const tasks = [task("A"), task("B", ["A"]), task("C", ["B"])];
      expect(hasCycle(buildDependencyGraph(tasks))).toBe(false);
    });

    it("diamond A → {B, C} → D (shared dependency, exercises the `safe` set)", () => {
      const tasks = [task("A"), task("B", ["A"]), task("C", ["A"]), task("D", ["B", "C"])];
      expect(hasCycle(buildDependencyGraph(tasks))).toBe(false);
    });

    it("two disconnected acyclic components", () => {
      const tasks = [task("A"), task("B", ["A"]), task("X"), task("Y", ["X"])];
      expect(hasCycle(buildDependencyGraph(tasks))).toBe(false);
    });

    it("dangling dependency on a non-existent task is not a cycle", () => {
      const tasks = [task("A"), task("B", ["MISSING"])];
      expect(hasCycle(buildDependencyGraph(tasks))).toBe(false);
    });
  });

  describe("cyclic graphs → true", () => {
    it("self-loop A → A", () => {
      expect(hasCycle(buildDependencyGraph([task("A", ["A"])]))).toBe(true);
    });

    it("two-node cycle A ↔ B", () => {
      const tasks = [task("A", ["B"]), task("B", ["A"])];
      expect(hasCycle(buildDependencyGraph(tasks))).toBe(true);
    });

    it("three-node cycle A → B → C → A", () => {
      const tasks = [task("A", ["C"]), task("B", ["A"]), task("C", ["B"])];
      expect(hasCycle(buildDependencyGraph(tasks))).toBe(true);
    });

    it("cycle embedded in a larger graph with acyclic parts", () => {
      const tasks = [
        task("root"),
        task("A", ["root"]),
        task("B", ["A", "D"]),
        task("C", ["B"]),
        task("D", ["C"]), // B → D → C → B forms a cycle
      ];
      expect(hasCycle(buildDependencyGraph(tasks))).toBe(true);
    });

    it("cycle isolated in one of several disconnected components", () => {
      const tasks = [task("A"), task("B", ["A"]), task("X", ["Y"]), task("Y", ["X"])];
      expect(hasCycle(buildDependencyGraph(tasks))).toBe(true);
    });
  });
});

describe("ReflowService.reflow — dependency validation", () => {
  const svc = new ReflowService();

  it("accepts an acyclic schedule and returns the tasks unchanged", () => {
    const tasks = [task("A"), task("B", ["A"]), task("C", ["B"])];
    const result = svc.reflow({ settlementTasks: tasks });
    expect(result.updatedTasks).toHaveLength(3);
    expect(result.changes).toEqual([]);
    expect(result.explanation).toMatch(/no dependency cycles/i);
  });

  it("throws UnsatisfiableScheduleError on a circular dependency", () => {
    const tasks = [task("A", ["B"]), task("B", ["A"])];
    expect(() => svc.reflow({ settlementTasks: tasks })).toThrow(UnsatisfiableScheduleError);
  });

  it("tags the thrown error with the 'dependency' constraint", () => {
    const tasks = [task("A", ["A"])];
    try {
      svc.reflow({ settlementTasks: tasks });
      throw new Error("expected reflow to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(UnsatisfiableScheduleError);
      expect((err as UnsatisfiableScheduleError).violatedConstraints).toEqual(["dependency"]);
    }
  });
});
