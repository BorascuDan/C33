import { describe, it, expect } from "@jest/globals";
import { DateTime } from "luxon";
import { buildDependencyGraph, hasCycle } from "../utils/dependency-graph.js";
import { ReflowService } from "../reflow/reflow.services.js";
import { UnsatisfiableScheduleError } from "../reflow/types.js";
import type { SettlementTask } from "../reflow/types.js";

/**
 * Task factory. `endDate` is kept consistent with `startDate + durationMinutes`
 * so an unshifted task reports no change. Cycle/graph tests ignore the times.
 */
function task(
  docId: string,
  dependsOnTaskIds: string[] = [],
  startDate = "2024-01-15T08:00:00Z",
  durationMinutes = 60,
  settlementChannelId = docId, // unique per task -> isolates dependency tests from channel conflicts
): SettlementTask {
  const endDate = DateTime.fromISO(startDate, { zone: "utc" })
    .plus({ minutes: durationMinutes })
    .toISO({ suppressMilliseconds: true })!;
  return {
    docId,
    docType: "settlementTask",
    data: {
      taskReference: docId,
      tradeOrderId: "TRD-1",
      settlementChannelId,
      startDate,
      endDate,
      durationMinutes,
      isRegulatoryHold: false,
      dependsOnTaskIds,
      taskType: "fundTransfer",
    },
  };
}

const find = (tasks: SettlementTask[], id: string): SettlementTask =>
  tasks.find((t) => t.docId === id)!;

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

describe("ReflowService.reflow — dependency resolution", () => {
  const svc = new ReflowService();

  it("leaves tasks that already start after their dependencies unchanged", () => {
    const tasks = [
      task("A", [], "2024-01-15T08:00:00Z", 60), // 08:00–09:00
      task("B", ["A"], "2024-01-15T09:00:00Z", 60), // 09:00–10:00 (already after A)
      task("C", ["B"], "2024-01-15T10:00:00Z", 60), // 10:00–11:00
    ];
    const result = svc.reflow({ settlementTasks: tasks });
    expect(result.changes).toEqual([]);
    expect(result.explanation).toMatch(/no changes needed/i);
    expect(find(result.updatedTasks, "B").data.startDate).toBe("2024-01-15T09:00:00Z");
  });

  it("shifts a dependent task to start when its dependency completes", () => {
    const tasks = [
      task("A", [], "2024-01-15T08:00:00Z", 60), // ends 09:00
      task("B", ["A"], "2024-01-15T08:00:00Z", 60), // starts too early (08:00)
    ];
    const result = svc.reflow({ settlementTasks: tasks });

    const b = find(result.updatedTasks, "B");
    expect(b.data.startDate).toBe("2024-01-15T09:00:00Z");
    expect(b.data.endDate).toBe("2024-01-15T10:00:00Z");

    expect(result.changes).toHaveLength(1);
    expect(result.changes[0]).toMatchObject({
      taskId: "B",
      newStartDate: "2024-01-15T09:00:00Z",
      newEndDate: "2024-01-15T10:00:00Z",
      delayMinutes: 60,
      triggeredBy: ["dependency"],
    });
  });

  it("cascades shifts along a dependency chain", () => {
    const tasks = [
      task("A", [], "2024-01-15T08:00:00Z", 60), // ends 09:00
      task("B", ["A"], "2024-01-15T08:00:00Z", 60), // -> 09:00–10:00
      task("C", ["B"], "2024-01-15T08:00:00Z", 30), // -> 10:00–10:30
    ];
    const result = svc.reflow({ settlementTasks: tasks });

    expect(find(result.updatedTasks, "C").data.startDate).toBe("2024-01-15T10:00:00Z");
    expect(find(result.updatedTasks, "C").data.endDate).toBe("2024-01-15T10:30:00Z");
    expect(result.changes).toHaveLength(2); // B and C moved; A did not
  });

  it("starts after the latest end among multiple dependencies", () => {
    const tasks = [
      task("A", [], "2024-01-15T08:00:00Z", 60), // ends 09:00
      task("B", [], "2024-01-15T08:00:00Z", 180), // ends 11:00 (the binding one)
      task("C", ["A", "B"], "2024-01-15T08:00:00Z", 60), // -> 11:00–12:00
    ];
    const result = svc.reflow({ settlementTasks: tasks });

    expect(find(result.updatedTasks, "C").data.startDate).toBe("2024-01-15T11:00:00Z");
    expect(find(result.updatedTasks, "C").data.endDate).toBe("2024-01-15T12:00:00Z");
    expect(result.changes).toHaveLength(1); // only C moved
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
