import type { SettlementTask, ScheduleChange, ReflowResult } from "./types.js";
import { UnsatisfiableScheduleError } from "./types.js";
import { buildDependencyGraph, hasCycle } from "../utils/dependency-graph.js";
import { parseUTC, toISO, minutesBetween } from "../utils/date-utils.js";

export class ReflowService {
  private updatedTask: SettlementTask[] = [];
  private changes: ScheduleChange[] = [];

  reflow(input: { settlementTasks: SettlementTask[] }): ReflowResult {
    this.updatedTask = [];
    this.changes = [];

    const { settlementTasks } = input;

    const graph = buildDependencyGraph(settlementTasks);
    if (hasCycle(graph)) {
      throw new UnsatisfiableScheduleError(
        "Circular dependency detected among settlement tasks; no valid ordering exists.",
        undefined,
        ["dependency"],
      );
    }

    this.#dependencies(settlementTasks);

    return {
      updatedTasks: this.updatedTask,
      changes: this.changes,
      explanation:
        this.changes.length === 0
          ? "All tasks already start after their dependencies; no changes needed."
          : `Rescheduled ${this.changes.length} task(s) so each starts after its dependencies complete.`,
    };
  }

  #dependencies(tasks: SettlementTask[]): SettlementTask[] {
    const byId = new Map<string, SettlementTask>();
    for (const t of tasks) byId.set(t.docId, t);

    const schedule: Record<string, { start: string; end: string }> = {};
    const passed = new Set<string>();

    const resolve = (task: SettlementTask): { start: string; end: string } => {
      if (passed.has(task.docId)) return schedule[task.docId]!;
      passed.add(task.docId);

      let start = parseUTC(task.data.startDate);
      let bindingDepId: string | undefined;


      for (const depId of task.data.dependsOnTaskIds) {
        const dep = byId.get(depId);
        if (!dep) continue;
        const depEnd = parseUTC(resolve(dep).end);
        if (depEnd > start) {
          start = depEnd;
          bindingDepId = depId;
        }
      }

      const end = start.plus({ minutes: task.data.durationMinutes });
      const startISO = toISO(start);
      const endISO = toISO(end);
      schedule[task.docId] = { start: startISO, end: endISO };

      const movedStart = start.toMillis() !== parseUTC(task.data.startDate).toMillis();
      const movedEnd = end.toMillis() !== parseUTC(task.data.endDate).toMillis();
      if (movedStart || movedEnd) {
        const depRef = bindingDepId
          ? byId.get(bindingDepId)?.data.taskReference ?? bindingDepId
          : undefined;
        this.changes.push({
          taskId: task.docId,
          taskReference: task.data.taskReference,
          originalStartDate: task.data.startDate,
          originalEndDate: task.data.endDate,
          newStartDate: startISO,
          newEndDate: endISO,
          delayMinutes: minutesBetween(parseUTC(task.data.endDate), end),
          triggeredBy: ["dependency"],
          reason: depRef
            ? `Start moved to ${startISO} to begin after dependency ${depRef} completes.`
            : `End normalized to ${endISO} (start + ${task.data.durationMinutes}m).`,
        });
      }

      return schedule[task.docId]!;
    };

    this.updatedTask = tasks.map((task) => {
      const { start, end } = resolve(task);
      return { ...task, data: { ...task.data, startDate: start, endDate: end } };
    });

    return this.updatedTask;
  }
}
