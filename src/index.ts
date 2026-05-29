import { ReflowService } from "./reflow/reflow.services.js";
import { UnsatisfiableScheduleError } from "./reflow/types.js";
import { scenarios } from "./scenarios.js";

/**
 * Entry point: runs each sample scenario through the reflow service and prints
 * the resulting schedule, the list of changes, and why each change happened.
 *
 *   npm run dev     (run from source with tsx)
 *   npm run build && npm start
 */
function main(): void {
  const service = new ReflowService();

  for (const scenario of scenarios) {
    console.log("\n" + "═".repeat(72));
    console.log(`SCENARIO: ${scenario.name}`);
    console.log(scenario.description);
    console.log("─".repeat(72));

    try {
      const result = service.reflow(scenario.input);

      console.log(`Explanation: ${result.explanation}`);
      console.log("\nFinal schedule:");
      for (const t of result.updatedTasks) {
        console.log(
          `  ${t.docId.padEnd(7)} ${t.data.taskType.padEnd(14)} ${t.data.startDate} → ${t.data.endDate}`,
        );
      }

      if (result.changes.length > 0) {
        console.log("\nChanges:");
        for (const c of result.changes) {
          console.log(
            `  ${c.taskId.padEnd(7)} [${c.triggeredBy.join(", ")}] +${c.delayMinutes}m — ${c.reason}`,
          );
        }
      }

      if (scenario.expectError) {
        console.log("\n⚠️  Expected this scenario to be rejected, but it succeeded.");
      }
    } catch (err) {
      if (err instanceof UnsatisfiableScheduleError) {
        console.log(`Rejected (no valid schedule): ${err.message}`);
        console.log(`Violated constraints: ${err.violatedConstraints.join(", ")}`);
      } else {
        throw err;
      }
    }
  }

  console.log("\n" + "═".repeat(72));
}

main();
