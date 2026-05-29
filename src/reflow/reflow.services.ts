import type {
  SettlementTask,
  SettlementChannel,
  TradeOrder,
  ScheduleChange,
  ReflowResult,
} from "./types.js";
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
  private updatedTask: SettlementTask[];
  private changes: ScheduleChange[];
  private settlementChannels: SettlementChannel[];
  private explanation: string[];

  constructor() {
    this.updatedTask = [];
    this.changes = [];
    this.settlementChannels = [];
    this.explanation = [];
  }

  reflow(input: {
    settlementTasks: SettlementTask[];
    settlementChannels?: SettlementChannel[];
    tradeOrders?: TradeOrder[];
  }): ReflowResult {
    this.changes = [];
    this.explanation = [];
    const { settlementTasks, settlementChannels = [], tradeOrders = [] } = input;
    //Firstly check if there are any circular dependencies
    const graph = buildDependencyGraph(settlementTasks);
    if (hasCycle(graph)) {
      throw new UnsatisfiableScheduleError(
        "Circular dependency detected among settlement tasks; no valid ordering exists.",
        undefined,
        ["dependency"],
      );
    }
    //populate this with necesarry variables
    this.#orderByTradeOrders(settlementTasks, settlementChannels, tradeOrders);

    // Blackout windows first: moving a task out of a blackout changes its dates,
    // which in turn changes how the market-hours pass sees it.
    this.#blackout();
    this.#marketHours();

    //chekcking if there are any dependencies. also a good solution for this
    //would be a different service that 
    //keeps track of all curent dependencies and when something is changed
    //sends an event via a socket to the worker to check if any 
    //affected dependency is now runing to stop them and make them work
    //via the new rules
    this.#dependencies();

    // @upgrade In a real production environment, channel-conflict serialization
    // would be better solved with a message broker: publish each settlement task
    // to a per-channel (per-topic) queue and let a single consumer process one
    // message at a time. The channel then physically cannot run two tasks at
    // once, instead of us detecting and repairing overlaps after the fact.
    this.#conflicts();

    return {
      updatedTasks: this.updatedTask,
      changes: this.changes,
      explanation:
        this.explanation.length === 0
          ? "No changes needed; tasks already satisfy blackout windows, operating hours, dependencies, and channel constraints."
          : `Applied ${this.explanation.join(", ")} (${this.changes.length} change(s) total).`,
    };
  }

  /**
   * Setup pass. Stores the channels on the instance and seeds this.updatedTask
   * with the tasks arranged in the sequence of their trade orders (tasks whose
   * trade order is unknown keep their relative order at the end).
   */
  #orderByTradeOrders(
    tasks: SettlementTask[],
    channels: SettlementChannel[],
    tradeOrders: TradeOrder[],
  ): void {
    this.settlementChannels = channels;

    const rank = new Map<string, number>();
    tradeOrders.forEach((order, i) => rank.set(order.docId, i));

    this.updatedTask = [...tasks].sort(
      (a, b) =>
        (rank.get(a.data.tradeOrderId) ?? Number.MAX_SAFE_INTEGER) -
        (rank.get(b.data.tradeOrderId) ?? Number.MAX_SAFE_INTEGER),
    );
  }

  /**
   * Regulatory blackout windows. No processing may happen during a channel's
   * blackout periods, so for each task the end is extended by the blackout time
   * that overlaps its span (the blocked time is paused). Start is left as given;
   * channels with no blackout windows impose no constraint.
   */
  #blackout(): SettlementTask[] {
    const before = this.changes.length;
    const channelById = new Map<string, SettlementChannel>();
    for (const c of this.settlementChannels) channelById.set(c.docId, c);

    this.updatedTask = this.updatedTask.map((task) => {
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

    if (this.changes.length > before) this.explanation.push("blackout windows");
    return this.updatedTask;
  }

  /**
   * Market hours. From each channel's operatingHours we know when it is closed.
   * For every task, if its end falls in a closed period the end is moved up by
   * exactly the time that spilled past the close (relocated to the next open).
   * The start is left as given; only the end moves.
   */
  #marketHours(): SettlementTask[] {
    const before = this.changes.length;
    const channelById = new Map<string, SettlementChannel>();
    for (const c of this.settlementChannels) channelById.set(c.docId, c);

    this.updatedTask = this.updatedTask.map((task) => {
      const channel = channelById.get(task.data.settlementChannelId);
      const hours = channel?.data.operatingHours ?? [];
      if (hours.length === 0) return task; // no operating-hours constraint to apply

      const newEnd = pushEndPastClosures(task.data.endDate, hours);
      if (parseUTC(newEnd).toMillis() === parseUTC(task.data.endDate).toMillis()) {
        return task; // end already lands within operating hours
      }

      this.changes.push({
        taskId: task.docId,
        taskReference: task.data.taskReference,
        originalStartDate: task.data.startDate,
        originalEndDate: task.data.endDate,
        newStartDate: task.data.startDate, // start unchanged; only the end moves
        newEndDate: newEnd,
        delayMinutes: minutesBetween(parseUTC(task.data.endDate), parseUTC(newEnd)),
        triggeredBy: ["operatingHours"],
        reason: `End moved to ${newEnd}: processing pauses while ${channel?.data.name ?? "the channel"} is closed.`,
      });
      return { ...task, data: { ...task.data, endDate: newEnd } };
    });

    if (this.changes.length > before) this.explanation.push("operating hours");
    return this.updatedTask;
  }

  /**
   * Dependency resolution. For each task, every upstream dependency must finish
   * first, so we push the task's start forward to the latest dependency end and
   * shift the whole [start, end] block by that delta (preserving the span the
   * earlier passes set). Dependencies are resolved on demand via DFS; `passed`
   * tracks ids already resolved. (Cycles are rejected before this runs.)
   */
  #dependencies(): SettlementTask[] {
    const before = this.changes.length;
    const tasks = this.updatedTask;
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

    if (this.changes.length > before) this.explanation.push("dependencies");
    return this.updatedTask;
  }

  /**
   * Channel-conflict resolution. A channel runs one task at a time, so we group
   * placed intervals by `channelId + taskType`: each key holds the [start, end]
   * tuples already occupying that lane. Tasks are placed earliest-first; when one
   * overlaps an existing interval it is moved upward (start jumps to the
   * conflicting task's end) and re-checked, preserving its span, until it fits.
   */
  #conflicts(): SettlementTask[] {
    const before = this.changes.length;
    const tasks = this.updatedTask;
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

    if (this.changes.length > before) this.explanation.push("channel conflicts");
    return this.updatedTask;
  }
}
