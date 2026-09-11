/**
 * Master Test Runner for Race Condition Test Suite
 *
 * This runner executes every race condition test under scenarios/ and
 * generates comprehensive reports. Supports both sequential and parallel
 * execution. Categories 01-06 are simulated (in-memory); 07-09 drive the
 * real API and need a seeded DB + running server (see #837 and the chaos
 * runbook, docs/enterprise/50-operations/07-chaos-test-runbook.md).
 *
 * Usage:
 *   npx tsx tests/typescript/race-conditions/master-runner.ts [mode]
 *
 * Modes:
 *   sequential - Run tests one by one (default, ~17-23 minutes)
 *   parallel   - Run categories in parallel via Task agents (~6-8 minutes)
 */

import { spawn } from "child_process";
import { promises as fs } from "fs";
import path from "path";

interface TestFile {
  category: string;
  name: string;
  path: string;
}

interface TestResult {
  testFile: string;
  passed: boolean;
  duration: number;
  exitCode: number;
  output?: string;
  error?: string;
}

interface CategorySummary {
  category: string;
  totalTests: number;
  passedTests: number;
  failedTests: number;
  duration: number;
  tests: TestResult[];
}

async function discoverTests(
  filterCategory?: string,
  filterTest?: string,
): Promise<TestFile[]> {
  const scenariosDir = path.join(
    process.cwd(),
    "tests/typescript/race-conditions/scenarios",
  );
  const tests: TestFile[] = [];

  const categories = await fs.readdir(scenariosDir);

  for (const category of categories) {
    // Filter by category if specified
    if (filterCategory && category !== filterCategory) {
      continue;
    }

    const categoryPath = path.join(scenariosDir, category);
    const stat = await fs.stat(categoryPath);

    if (stat.isDirectory()) {
      const files = await fs.readdir(categoryPath);

      for (const file of files) {
        if (file.endsWith(".ts") && file.startsWith("test-")) {
          const testName = file.replace(".ts", "");

          // Filter by test name if specified
          if (filterTest && testName !== filterTest) {
            continue;
          }

          tests.push({
            category,
            name: testName,
            path: path.join(categoryPath, file),
          });
        }
      }
    }
  }

  return tests.sort((a, b) => a.category.localeCompare(b.category));
}

async function runTest(testFile: TestFile): Promise<TestResult> {
  const startTime = Date.now();

  return new Promise((resolve) => {
    console.log(`\n${"=".repeat(80)}`);
    console.log(`🧪 Running: ${testFile.category}/${testFile.name}`);
    console.log(`${"=".repeat(80)}\n`);

    const proc = spawn("npx", ["tsx", testFile.path], {
      stdio: "inherit",
      shell: true,
    });

    proc.on("close", (code) => {
      const duration = Date.now() - startTime;

      resolve({
        testFile: `${testFile.category}/${testFile.name}`,
        passed: code === 0,
        duration,
        exitCode: code || 0,
      });
    });

    proc.on("error", (error) => {
      const duration = Date.now() - startTime;

      resolve({
        testFile: `${testFile.category}/${testFile.name}`,
        passed: false,
        duration,
        exitCode: 1,
        error: error.message,
      });
    });
  });
}

async function runTestsSequentially(tests: TestFile[]): Promise<TestResult[]> {
  const results: TestResult[] = [];

  for (const test of tests) {
    const result = await runTest(test);
    results.push(result);
  }

  return results;
}

function groupByCategory(results: TestResult[]): CategorySummary[] {
  const categoryMap = new Map<string, TestResult[]>();

  results.forEach((result) => {
    const category = result.testFile.split("/")[0];
    if (!categoryMap.has(category)) {
      categoryMap.set(category, []);
    }
    categoryMap.get(category)!.push(result);
  });

  const summaries: CategorySummary[] = [];

  categoryMap.forEach((tests, category) => {
    const passed = tests.filter((t) => t.passed).length;
    const failed = tests.filter((t) => !t.passed).length;
    const duration = tests.reduce((sum, t) => sum + t.duration, 0);

    summaries.push({
      category,
      totalTests: tests.length,
      passedTests: passed,
      failedTests: failed,
      duration,
      tests,
    });
  });

  return summaries.sort((a, b) => a.category.localeCompare(b.category));
}

function generateMasterReport(
  categories: CategorySummary[],
  totalDuration: number,
  mode: string,
): string {
  const lines: string[] = [];

  const totalTests = categories.reduce((sum, c) => sum + c.totalTests, 0);
  const totalPassed = categories.reduce((sum, c) => sum + c.passedTests, 0);
  const totalFailed = categories.reduce((sum, c) => sum + c.failedTests, 0);

  lines.push("# Race Condition Test Suite - Master Report");
  lines.push("");
  lines.push(`**Date:** ${new Date().toLocaleString()}`);
  lines.push(`**Execution Mode:** ${mode}`);
  lines.push(
    `**Total Duration:** ${Math.floor(totalDuration / 1000 / 60)}m ${Math.floor((totalDuration / 1000) % 60)}s`,
  );
  lines.push("");

  lines.push("## Overall Summary");
  lines.push(`- **Total Tests:** ${totalTests}`);
  lines.push(`- **Passed:** ${totalPassed} ✅`);
  lines.push(`- **Failed:** ${totalFailed} ❌`);
  lines.push(
    `- **Success Rate:** ${Math.round((totalPassed / totalTests) * 100)}%`,
  );
  lines.push("");

  lines.push("## Category Breakdown");
  lines.push("");

  categories.forEach((category, index) => {
    const successRate = Math.round(
      (category.passedTests / category.totalTests) * 100,
    );
    const durationSec = (category.duration / 1000).toFixed(1);

    lines.push(
      `### ${index + 1}. ${category.category} (${category.passedTests}/${category.totalTests} passed, ${durationSec}s)`,
    );
    lines.push("");
    lines.push("| Test | Status | Duration |");
    lines.push("|------|--------|----------|");

    category.tests.forEach((test) => {
      const status = test.passed ? "✅ PASS" : "❌ FAIL";
      const duration = `${(test.duration / 1000).toFixed(1)}s`;
      const testName = test.testFile.split("/")[1];

      lines.push(`| ${testName} | ${status} | ${duration} |`);
    });

    lines.push("");
    lines.push(
      `**Category Success Rate:** ${successRate}% (${category.passedTests}/${category.totalTests})`,
    );
    lines.push("");
  });

  lines.push("## Final Verdict");
  lines.push("");

  if (totalFailed === 0) {
    lines.push("### ✅ ALL TESTS PASSED!");
    lines.push("");
    lines.push(
      `All ${totalTests} race condition tests passed successfully. The triple-layer protection (locks + validation + transactions) is working correctly across all scenarios.`,
    );
    lines.push("");
    lines.push("**Race condition fix verified!** ✨");
  } else {
    lines.push("### ⚠️ SOME TESTS FAILED");
    lines.push("");
    lines.push(
      `${totalFailed} out of ${totalTests} tests failed. Please review the failing tests:`,
    );
    lines.push("");

    categories.forEach((category) => {
      const failedTests = category.tests.filter((t) => !t.passed);
      if (failedTests.length > 0) {
        lines.push(`**${category.category}:**`);
        failedTests.forEach((test) => {
          lines.push(`- ${test.testFile.split("/")[1]}`);
          if (test.error) {
            lines.push(`  - Error: ${test.error}`);
          }
        });
        lines.push("");
      }
    });
  }

  return lines.join("\n");
}

async function main() {
  // Parse CLI arguments
  const args = process.argv.slice(2);
  let mode = "sequential";
  let filterCategory: string | undefined;
  let filterTest: string | undefined;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg === "parallel" || arg === "sequential") {
      mode = arg;
    } else if (arg.startsWith("--category=")) {
      filterCategory = arg.split("=")[1];
    } else if (arg === "--category" && args[i + 1]) {
      filterCategory = args[i + 1];
      i++;
    } else if (arg.startsWith("--test=")) {
      filterTest = arg.split("=")[1];
    } else if (arg === "--test" && args[i + 1]) {
      filterTest = args[i + 1];
      i++;
    }
  }

  if (mode !== "sequential" && mode !== "parallel") {
    console.error("❌ Invalid mode. Use 'sequential' or 'parallel'");
    process.exit(1);
  }

  console.log("\n" + "=".repeat(80));
  console.log("🚀 Race Condition Test Suite - Master Runner");
  console.log("=".repeat(80));
  console.log(`Mode: ${mode}`);
  if (filterCategory) console.log(`Filter: Category = ${filterCategory}`);
  if (filterTest) console.log(`Filter: Test = ${filterTest}`);
  console.log(`Date: ${new Date().toLocaleString()}`);
  console.log("=".repeat(80) + "\n");

  // Discover all tests
  console.log("📂 Discovering tests...");
  const tests = await discoverTests(filterCategory, filterTest);
  console.log(
    `✅ Found ${tests.length} tests across ${new Set(tests.map((t) => t.category)).size} categories\n`,
  );

  const masterStartTime = Date.now();
  let results: TestResult[] = [];

  if (mode === "sequential") {
    console.log(
      "⏳ Running tests sequentially (this will take 15-20 minutes)...\n",
    );
    results = await runTestsSequentially(tests);
  } else {
    console.log(
      "⚡ Parallel mode not yet implemented. Falling back to sequential...\n",
    );
    results = await runTestsSequentially(tests);
  }

  const totalDuration = Date.now() - masterStartTime;

  // Group results by category
  const categories = groupByCategory(results);

  // Generate and save report
  const report = generateMasterReport(categories, totalDuration, mode);

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const reportsDir = path.join(
    process.cwd(),
    "tests/typescript/race-conditions/results/reports",
  );
  const reportPath = path.join(reportsDir, `master-report-${timestamp}.md`);

  // results/ is gitignored run output — a fresh checkout doesn't have it,
  // and failing here after every scenario passed fails the whole run.
  await fs.mkdir(reportsDir, { recursive: true });
  await fs.writeFile(reportPath, report, "utf-8");

  // Print final summary
  console.log("\n" + "=".repeat(80));
  console.log("📊 FINAL SUMMARY");
  console.log("=".repeat(80) + "\n");

  const totalTests = categories.reduce((sum, c) => sum + c.totalTests, 0);
  const totalPassed = categories.reduce((sum, c) => sum + c.passedTests, 0);
  const totalFailed = categories.reduce((sum, c) => sum + c.failedTests, 0);

  console.log(`Total Tests: ${totalTests}`);
  console.log(`Passed: ${totalPassed} ✅`);
  console.log(`Failed: ${totalFailed} ❌`);
  console.log(`Success Rate: ${Math.round((totalPassed / totalTests) * 100)}%`);
  console.log(
    `Total Duration: ${Math.floor(totalDuration / 1000 / 60)}m ${Math.floor((totalDuration / 1000) % 60)}s`,
  );

  console.log(`\n📄 Master report saved: ${reportPath}\n`);

  console.log("=".repeat(80) + "\n");

  // Exit with appropriate code
  process.exit(totalFailed > 0 ? 1 : 0);
}

main().catch((error) => {
  console.error("\n❌ Master runner failed:");
  console.error(error);
  process.exit(1);
});
