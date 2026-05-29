import type { SettlementTask, ReflowResult } from "./types.js";
import { UnsatisfiableScheduleError } from "./types.js";
import { buildDependencyGraph, hasCycle } from "../utils/dependency-graph.js";

export class ReflowService {

  reflow(input: { settlementTasks: SettlementTask[] }): ReflowResult {
    const { settlementTasks } = input;

    const graph = buildDependencyGraph(settlementTasks);
    if (hasCycle(graph)) {
      throw new UnsatisfiableScheduleError(
        "Circular dependency detected among settlement tasks; no valid ordering exists.",
        undefined,
        ["dependency"],
      );
    }

    return {
      updatedTasks: settlementTasks,
      changes: [],
      explanation: "No dependency cycles detected; schedule is dependency-valid.",
    };
  }
}
