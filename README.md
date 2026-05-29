LINK LOOM VIDEO:
https://www.loom.com/share/2321ae8b9d2a48d58e604318c8f22fa7

# Settlement Schedule Reflow

A TypeScript reflow engine for a financial-operations platform. When disruptions
occur (late fund transfers, channel maintenance, regulatory blackouts, dependency
delays), it reschedules settlement tasks into a **valid** schedule that respects:

- **Dependencies** — every upstream task finishes before a downstream task starts (with cycle detection).
- **Channel conflicts** — one task at a time per channel.
- **Market hours** — processing only inside a channel's operating windows; it pauses outside them and resumes at the next open.
- **Regulatory blackout windows** — no processing during maintenance/blackout periods.

## Requirements

- **Node.js 20+** and npm.

> If Node is installed via [nvm](https://github.com/nvm-sh/nvm) and isn't on your
> PATH, run `nvm use` (or `source ~/.nvm/nvm.sh`) first.

## Setup

```bash
npm install
```

## Running the sample scenarios

The app ships with ten scenarios (`src/scenarios.ts`). Run them all and print
the resulting schedule, the changes, and why each change happened:

```bash
npm run dev          # run from source via tsx (no build step)
# or
npm run build && npm start
```

Single-constraint scenarios:

1. **Delay Cascade** — a delayed fund transfer pushes its dependent disbursement and reconciliation later.
2. **Market Hours Spillover** — a task running past the 16:00 close pauses overnight and finishes the next morning.
3. **Blackout Window** — a task overlapping a Fedwire maintenance window has the blocked time paused.
4. **Channel Conflict** — three competing tasks on one channel are serialized.
5. **Impossible Schedule** — a circular dependency is detected and rejected.

Combined-constraint scenarios (pairs of events):

6. **Delay Cascade + Channel Conflict** — two transfers wait on one margin check, then collide on the channel.
7. **Blackout + Market Hours** — a blackout near the close pushes a task past 16:00, so it also spills overnight.
8. **Dependencies + Market Hours** — a chain cascades while an unrelated late task spills past the close.
9. **Channel Conflict + Market Hours** — two transfers are serialized while a separate late task pauses overnight.
10. **Blackout + Channel Conflict** — a transfer stretched across a blackout forces a second one to wait behind it.

## Running the tests

```bash
npm test
```

Jest covers dependency cycles, channel conflicts, market hours, and blackout windows.

## Using the service

```ts
import { ReflowService } from "./reflow/reflow.services.js";

const service = new ReflowService();
const result = service.reflow({
  settlementTasks,      // tasks to reschedule
  settlementChannels,   // channels with operating hours + blackout windows
  tradeOrders,          // trade orders (sequencing + context)
});

result.updatedTasks;    // the new schedule (tasks with updated start/end)
result.changes;         // what moved, by how much, and which constraint caused it
result.explanation;     // which modifiers were applied
```

A circular dependency (or any unschedulable input) throws
`UnsatisfiableScheduleError`, which carries the offending `taskId` and the
`violatedConstraints`.

### Input shapes

All documents share `{ docId, docType, data }`:

- **settlementTask** — `taskReference`, `tradeOrderId`, `settlementChannelId`, `startDate`, `endDate`, `durationMinutes`, `isRegulatoryHold`, `dependsOnTaskIds[]`, `taskType`.
- **settlementChannel** — `name`, `operatingHours[]` (`{ dayOfWeek 0–6, startHour, endHour }`), `blackoutWindows[]` (`{ startDate, endDate, reason? }`).
- **tradeOrder** — `tradeOrderNumber`, `instrumentId`, `quantity`, `settlementDate`.

All dates are ISO 8601 in **UTC**; operating hours are interpreted in UTC.

## Algorithm

`reflow` runs ordered passes, each reading and rewriting the working schedule:

1. **Order by trade orders** — arrange tasks in their trade-order sequence.
2. **Blackout windows** — extend a task's end past any blackout its processing overlaps (run first, because moving dates changes how later passes see the task).
3. **Market hours** — move an end that lands in a closed period forward to the next open, by exactly the spilled time.
4. **Dependencies** — push each task to start after all its upstream tasks finish (DFS, with cycle detection up front).
5. **Channel conflicts** — place tasks earliest-first per `channel + taskType` lane; bump overlaps forward until they fit.

## Project structure

```
src/
├── index.ts                  # entry point — runs the 5 scenarios
├── scenarios.ts              # sample data (5 scenarios)
├── reflow/
│   ├── reflow.services.ts    # ReflowService — the pipeline
│   ├── constraint-checker.ts
│   └── types.ts              # shared types
├── utils/
│   ├── date-utils.ts         # Luxon-based operating-hours / blackout helpers
│   └── dependency-graph.ts   # dependency graph + cycle detection
└── tests/                    # Jest test suites
```

## Known limitations / next steps (`@upgrade`)

- **`isRegulatoryHold`** tasks are not yet pinned — they can still be moved by the passes.
- Passes run sequentially; a shift in a later pass isn't re-checked against earlier constraints (a fixpoint loop would close this).
- Channel conflicts are keyed by `channel + taskType`; switch to channel-only for strict "one task per channel".
- Optimization metrics (total delay, utilization, SLA-breach detection) are typed but not yet computed.
