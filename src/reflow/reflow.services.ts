import type { SettlementTask, SettlementChannel, ScheduleChange, ReflowResult } from "./types.js";
import { UnsatisfiableScheduleError } from "./types.js";
import { buildDependencyGraph, hasCycle } from "../utils/dependency-graph.js";
import {
  parseUTC,
  toISO,
  minutesBetween,
  intervalsOverlap,
  pushEndPastClosures,
  pushEndPastBlackouts,
} from "../utils/date-utils.js";

export class ReflowService {
  private updatedTask: SettlementTask[] = [];
  private changes: ScheduleChange[] = [];

  reflow(input: {
    settlementTasks: SettlementTask[];
    settlementChannels?: SettlementChannel[];
  }): ReflowResult {
    this.updatedTask = [];
    this.changes = [];

    const { settlementTasks, settlementChannels = [] } = input;

    const graph = buildDependencyGraph(settlementTasks);
    if (hasCycle(graph)) {
      throw new UnsatisfiableScheduleError(
        "Circular dependency detected among settlement tasks; no valid ordering exists.",
        undefined,
        ["dependency"],
      );
    }

    // Blackout windows first: moving a task out of a blackout changes its dates,
    // which in turn changes how the market-hours pass sees it — so resolve
    // blackouts before everything else
    this.#blackout(settlementTasks, settlementChannels);

    this.#marketHours(this.updatedTask, settlementChannels);

    this.#dependencies(this.updatedTask);

    // @upgrade In a real production environment, channel-conflict serialization
    // would be better solved with a message broker: publish each settlement task
    // to a per-channel (per-topic) queue and let a single consumer process one
    // message at a time. The channel then physically cannot run two tasks at
    // once, instead of us detecting and repairing overlaps after the fact.
    this.#conflicts(this.updatedTask);

    return {
      updatedTasks: this.updatedTask,
      changes: this.changes,
      explanation:
        this.changes.length === 0
          ? "No changes needed; tasks already satisfy blackout windows, operating hours, dependencies, and channel constraints."
          : `Applied ${this.changes.length} change(s) to satisfy blackout windows, operating hours, dependencies, and channel conflicts.`,
    };
  }

  /**
   * Regulatory blackout windows. No processing may happen during a channel's
   * blackout periods, so for each task the end is extended by the blackout time
   * that overlaps its span (the blocked time is paused). Start is left as given;
   * channels with no blackout windows impose no constraint.
   *
   * Appends each move to this.changes and saves the result in this.updatedTask.
   */
  #blackout(tasks: SettlementTask[], channels: SettlementChannel[]): SettlementTask[] {
    const channelById = new Map<string, SettlementChannel>();
    for (const c of channels) channelById.set(c.docId, c);

    this.updatedTask = tasks.map((task) => {
      const channel = channelById.get(task.data.settlementChannelId);
      const blackouts = channel?.data.blackoutWindows ?? [];
      if (blackouts.length === 0) return task;

      const newEnd = pushEndPastBlackouts(task.data.startDate, task.data.endDate, blackouts);
      if (parseUTC(newEnd).toMillis() === parseUTC(task.data.endDate).toMillis()) {
        return task;
      }

      this.changes.push({
        taskId: task.docId,
        taskReference: task.data.taskReference,
        originalStartDate: task.data.startDate,
        originalEndDate: task.data.endDate,
        newStartDate: task.data.startDate,
        newEndDate: newEnd,
        delayMinutes: minutesBetween(parseUTC(task.data.endDate), parseUTC(newEnd)),
        triggeredBy: ["blackoutWindow"],
        reason: `End moved to ${newEnd}: processing pauses during a blackout window on ${channel?.data.name ?? "the channel"}.`,
      });
      return { ...task, data: { ...task.data, endDate: newEnd } };
    });

    return this.updatedTask;
  }

  #marketHours(tasks: SettlementTask[], channels: SettlementChannel[]): SettlementTask[] {
    const channelById = new Map<string, SettlementChannel>();
    for (const c of channels) channelById.set(c.docId, c);

    this.updatedTask = tasks.map((task) => {
      const channel = channelById.get(task.data.settlementChannelId);
      const hours = channel?.data.operatingHours ?? [];
      if (hours.length === 0) return task;

      const newEnd = pushEndPastClosures(task.data.endDate, hours);
      if (parseUTC(newEnd).toMillis() === parseUTC(task.data.endDate).toMillis()) {
        return task;
      }

      this.changes.push({
        taskId: task.docId,
        taskReference: task.data.taskReference,
        originalStartDate: task.data.startDate,
        originalEndDate: task.data.endDate,
        newStartDate: task.data.startDate,
        newEndDate: newEnd,
        delayMinutes: minutesBetween(parseUTC(task.data.endDate), parseUTC(newEnd)),
        triggeredBy: ["operatingHours"],
        reason: `End moved to ${newEnd}: processing pauses while ${channel?.data.name ?? "the channel"} is closed.`,
      });
      return { ...task, data: { ...task.data, endDate: newEnd } };
    });

    return this.updatedTask;
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

      const delta = minutesBetween(parseUTC(task.data.startDate), start);
      const end = parseUTC(task.data.endDate).plus({ minutes: delta });
      const startISO = toISO(start);
      const endISO = toISO(end);
      schedule[task.docId] = { start: startISO, end: endISO };

      if (delta !== 0) {
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
          reason: `Start moved to ${startISO} to begin after dependency ${depRef ?? "upstream"} completes.`,
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

  #conflicts(tasks: SettlementTask[]): SettlementTask[] {
    const lanes = new Map<string, Set<[string, string]>>();
    const resolved = new Map<string, { start: string; end: string }>();

    const order = [...tasks].sort(
      (a, b) => parseUTC(a.data.startDate).toMillis() - parseUTC(b.data.startDate).toMillis(),
    );

    for (const task of order) {
      const key = `${task.data.settlementChannelId}::${task.data.taskType}`;
      let lane = lanes.get(key);
      if (!lane) {
        lane = new Set<[string, string]>();
        lanes.set(key, lane);
      }

      let start = task.data.startDate;
      let end = task.data.endDate;
      const spanMinutes = minutesBetween(parseUTC(start), parseUTC(end));

      let bumped = true;
      while (bumped) {
        bumped = false;
        for (const [s, e] of lane) {
          if (intervalsOverlap(start, end, s, e)) {
            start = e;
            end = toISO(parseUTC(start).plus({ minutes: spanMinutes }));
            bumped = true;
          }
        }
      }

      lane.add([start, end]);
      resolved.set(task.docId, { start, end });

      if (parseUTC(start).toMillis() !== parseUTC(task.data.startDate).toMillis()) {
        this.changes.push({
          taskId: task.docId,
          taskReference: task.data.taskReference,
          originalStartDate: task.data.startDate,
          originalEndDate: task.data.endDate,
          newStartDate: start,
          newEndDate: end,
          delayMinutes: minutesBetween(parseUTC(task.data.endDate), parseUTC(end)),
          triggeredBy: ["channelConflict"],
          reason: `Moved to ${start} to avoid a channel conflict on ${task.data.settlementChannelId} (${task.data.taskType}).`,
        });
      }
    }

    this.updatedTask = tasks.map((task) => {
      const r = resolved.get(task.docId)!;
      return { ...task, data: { ...task.data, startDate: r.start, endDate: r.end } };
    });

    return this.updatedTask;
  }
}
