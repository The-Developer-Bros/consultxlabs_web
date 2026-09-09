// Artifacts. Every run must leave a machine-readable record and something a
// human can open, because #874 is closed by pasting numbers into an issue and
// a terminal scrollback is not evidence.
//
// The HTML is generated here rather than pulled from a jslib URL on purpose: a
// remote import would make the workflow depend on a third-party host being up
// at the exact moment a launch gate is being run, and the report is a table.

import { SUMMARY_PATH } from "./config.js";
import { summarize } from "./thresholds.js";

function ms(value) {
  if (value === null || value === undefined) return "—";
  return `${Math.round(value)} ms`;
}

function row(label, trend) {
  if (!trend) {
    return `<tr><td>${label}</td><td colspan="5" class="muted">not exercised</td></tr>`;
  }
  return `<tr><td>${label}</td><td>${trend.count}</td><td>${ms(trend.p50)}</td><td>${ms(trend.p95)}</td><td>${ms(trend.p99)}</td><td>${ms(trend.max)}</td></tr>`;
}

function verdictOf(summary) {
  return summary.thresholdsBreached.length === 0 ? "PASS" : "FAIL";
}

export function htmlReport(summary) {
  const verdict = verdictOf(summary);
  const o = summary.outcomes;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<title>Load gate — scenario ${summary.scenario}</title>
<style>
 body{font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;margin:2rem auto;max-width:60rem;color:#111}
 h1{font-size:1.4rem;margin-bottom:.25rem} .sub{color:#666;margin-top:0}
 table{border-collapse:collapse;width:100%;margin:1rem 0}
 th,td{border:1px solid #ddd;padding:.4rem .6rem;text-align:left}
 th{background:#f6f6f6;font-weight:600}
 .muted{color:#888} .pass{color:#0a6b2d;font-weight:700} .fail{color:#a11;font-weight:700}
 code{background:#f2f2f2;padding:.1rem .3rem;border-radius:3px}
</style></head><body>
<h1>Load gate — scenario ${summary.scenario} — <span class="${verdict === "PASS" ? "pass" : "fail"}">${verdict}</span></h1>
<p class="sub">${summary.baseUrl} · peak ${summary.peakVus} VUs · ${summary.duration} · max ${summary.vusMax} VUs · ${summary.totalRequests} requests · ${summary.startedAt}</p>

<h2>Latency by write path</h2>
<table><thead><tr><th>Path</th><th>n</th><th>p50</th><th>p95</th><th>p99</th><th>max</th></tr></thead><tbody>
${row("checkout", summary.latency.checkout)}
${row("allocate", summary.latency.allocate)}
${row("cancel", summary.latency.cancel)}
${row("reschedule", summary.latency.reschedule)}
${row("reschedule/respond", summary.latency.respond)}
${row("reads (browse)", summary.latency.read)}
${row("all requests", summary.latency.overall)}
</tbody></table>

<h2>Outcomes</h2>
<table><thead><tr><th>Outcome</th><th>Count</th><th>Reading</th></tr></thead><tbody>
<tr><td>winners (2xx)</td><td>${o.winners}</td><td>bookings the run created</td></tr>
<tr><td>conflicts (409)</td><td>${o.conflicts409}</td><td>PASS — a guard refused a losing racer</td></tr>
<tr><td>busy (409 + retryAfter)</td><td>${o.busy409}</td><td>PASS — typed lock contention, client may auto-retry</td></tr>
<tr><td>serialization conflicts (P2034)</td><td>${o.p2034Conflicts}</td><td>retry budget exhausted; the launch metric</td></tr>
<tr><td>sold out</td><td>${o.soldOut}</td><td>PASS — optimistic capacity pre-check answered first</td></tr>
<tr><td>rate limited (429)</td><td>${o.rateLimited429}</td><td>the run hit a limiter, not the booking path</td></tr>
<tr><td>lock unavailable (503)</td><td>${o.lockUnavailable503}</td><td>FAIL — Redis was unreachable; locks failed closed</td></tr>
<tr><td>timeouts (502/504/0)</td><td>${o.timeouts504}</td><td>FAIL — outlived the ~26 s function ceiling</td></tr>
<tr><td>server errors (other 5xx)</td><td>${o.serverErrors5xx}</td><td>FAIL — unhandled path</td></tr>
<tr><td>client errors (4xx total)</td><td>${o.clientErrors4xx}</td><td>context for the rows above</td></tr>
<tr><td>unexpected (401/403/404/405/422)</td><td>${o.unexpected4xx}</td><td>FAIL — the request never reached the guard under test</td></tr>
</tbody></table>

<h2>Rates</h2>
<table><tbody>
<tr><th>5xx rate (excluding typed 503)</th><td>${(summary.rates.serverErrorRate * 100).toFixed(2)}%</td></tr>
<tr><th>timeout rate</th><td>${(summary.rates.timeoutRate * 100).toFixed(2)}%</td></tr>
<tr><th>k6 checks passing</th><td>${(summary.rates.checksPassRate * 100).toFixed(2)}%</td></tr>
</tbody></table>

<h2>Thresholds breached</h2>
${
  summary.thresholdsBreached.length === 0
    ? "<p>None. Every encoded gate held.</p>"
    : `<ul>${summary.thresholdsBreached.map((name) => `<li><code>${name}</code></li>`).join("")}</ul>`
}
<p class="sub">Record these numbers on issue #874 using the table in
docs/enterprise/50-operations/08-load-gate-runbook.md, then run the cleanup
script. The target shares the production database.</p>
</body></html>`;
}

/** The single handleSummary return every script in this directory uses. */
export function summaryOutputs(data) {
  const summary = summarize(data);
  const html = SUMMARY_PATH.replace(/\.json$/, "") + ".html";
  const outputs = {
    stdout: JSON.stringify(summary, null, 2),
  };
  outputs[SUMMARY_PATH] = JSON.stringify(summary, null, 2);
  outputs[html] = htmlReport(summary);
  return outputs;
}
