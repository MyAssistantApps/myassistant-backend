/**
 * Generates the provisioned Grafana dashboards (grafana/dashboards/*.json).
 * Edit here, then: node deploy/docker-vps/monitoring/grafana/build-dashboards.js
 */
const fs = require("fs");
const path = require("path");
const PROM = { type: "prometheus", uid: "prometheus" };
const LOKI = { type: "loki", uid: "loki" };
let id = 0;

function ts(title, targets, { unit = "short", w = 12, h = 8, stack = false, min, ds = PROM } = {}) {
  return {
    id: ++id, type: "timeseries", title, datasource: ds, gridPos: { w, h },
    fieldConfig: {
      defaults: { unit, min, custom: { lineWidth: 1, fillOpacity: stack ? 30 : 8, stacking: { mode: stack ? "normal" : "none" } } },
      overrides: [],
    },
    options: { legend: { displayMode: "list", placement: "bottom" }, tooltip: { mode: "multi" } },
    targets: targets.map(([expr, legendFormat], i) => ({ refId: String.fromCharCode(65 + i), expr, legendFormat, datasource: ds })),
  };
}
function stat(title, expr, { unit = "short", w = 4, h = 4, thresholds = [], decimals } = {}) {
  return {
    id: ++id, type: "stat", title, datasource: PROM, gridPos: { w, h },
    fieldConfig: {
      defaults: { unit, decimals, thresholds: { mode: "absolute", steps: [{ color: "green", value: null }, ...thresholds] } },
      overrides: [],
    },
    options: { reduceOptions: { calcs: ["lastNotNull"] }, colorMode: "background", graphMode: "area" },
    targets: [{ refId: "A", expr, datasource: PROM }],
  };
}
const row = (title) => ({ id: ++id, type: "row", title, collapsed: false, gridPos: { w: 24, h: 1 }, panels: [] });
const logs = (title, expr, h = 12) => ({
  id: ++id, type: "logs", title, datasource: LOKI, gridPos: { w: 24, h },
  options: { showTime: true, wrapLogMessage: true, sortOrder: "Descending", enableLogDetails: true },
  targets: [{ refId: "A", expr, datasource: LOKI }],
});

/** Lays panels out left to right, wrapping at 24 columns; rows span the width. */
function layout(panels) {
  let x = 0, y = 0, rowH = 0;
  for (const p of panels) {
    const { w, h } = p.gridPos;
    if (p.type === "row" || x + w > 24) { y += rowH; x = 0; rowH = 0; }
    p.gridPos = { x, y, w, h };
    if (p.type === "row") { y += h; continue; }
    x += w;
    rowH = Math.max(rowH, h);
  }
  return panels;
}
function dashboard(uid, title, panels) {
  return {
    uid, title, tags: ["myassistant"], timezone: "browser", schemaVersion: 39, version: 1, refresh: "30s",
    time: { from: "now-6h", to: "now" }, editable: false, panels: layout(panels), templating: { list: [] },
  };
}

const J = 'job="backend"';
const RATE = `sum(rate(http_request_duration_seconds_count{${J}}[5m]))`;
const q = (p, by = "") => `histogram_quantile(${p}, sum by (le${by}) (rate(http_request_duration_seconds_bucket{${J}}[5m])))`;
const up = [{ color: "red", value: 0 }, { color: "green", value: 1 }];

const overview = dashboard("myassistant-overview", "MyAssistant — Overview", [
  row("Health"),
  stat("Backend up", `up{${J}}`, { thresholds: up }),
  stat("Database up", "pg_up", { thresholds: up }),
  stat("Requests / s", RATE, { decimals: 1 }),
  stat("5xx share", `sum(rate(http_request_duration_seconds_count{${J},status_code=~"5.."}[5m])) / clamp_min(${RATE}, 0.001)`,
    { unit: "percentunit", thresholds: [{ color: "orange", value: 0.01 }, { color: "red", value: 0.05 }] }),
  stat("p95 latency", q(0.95), { unit: "s", thresholds: [{ color: "orange", value: 0.5 }, { color: "red", value: 2 }] }),
  stat("AI spend today", "myassistant_ai_spend_today_usd",
    { unit: "currencyUSD", decimals: 2, thresholds: [{ color: "orange", value: 20 }, { color: "red", value: 35 }] }),
  {
    id: ++id, type: "alertlist", title: "Firing alerts", gridPos: { w: 24, h: 5 },
    options: { showOptions: "current", maxItems: 20, stateFilter: { firing: true, pending: true }, alertInstanceLabelFilter: "" },
  },
  row("API"),
  ts("Requests / s by route", [[`topk(10, sum by (path) (rate(http_request_duration_seconds_count{${J}}[5m])))`, "{{path}}"]], { unit: "reqps" }),
  ts("Latency", [[q(0.5), "p50"], [q(0.95), "p95"], [q(0.99), "p99"]], { unit: "s" }),
  ts("Responses by status", [[`sum by (status_code) (rate(http_request_duration_seconds_count{${J}}[5m]))`, "{{status_code}}"]], { unit: "reqps", stack: true }),
  ts("Slowest routes (p95)", [[`topk(8, ${q(0.95, ", path")})`, "{{path}}"]], { unit: "s" }),
  row("Node.js process"),
  ts("CPU (cores)", [[`rate(process_cpu_seconds_total{${J}}[2m])`, "backend"]], { min: 0 }),
  ts("Event-loop lag", [[`nodejs_eventloop_lag_p99_seconds{${J}}`, "p99"], [`nodejs_eventloop_lag_mean_seconds{${J}}`, "mean"]], { unit: "s" }),
  ts("Memory", [[`process_resident_memory_bytes{${J}}`, "RSS"], [`nodejs_heap_size_used_bytes{${J}}`, "heap used"]], { unit: "bytes" }),
  ts("GC time / s", [[`sum by (kind) (rate(nodejs_gc_duration_seconds_sum{${J}}[5m]))`, "{{kind}}"]], { unit: "s" }),
  row("Database & background work"),
  ts("Pool connections", [["myassistant_pg_pool_total", "open"], ["myassistant_pg_pool_idle", "idle"], ["myassistant_pg_pool_waiting", "waiting"]], { w: 8 }),
  ts("Postgres activity", [['sum(pg_stat_activity_count{datname="myassistant"})', "connections"],
    ['rate(pg_stat_database_xact_commit{datname="myassistant"}[5m])', "commits / s"]], { w: 8 }),
  ts("Database size", [['pg_database_size_bytes{datname="myassistant"}', "size"]], { unit: "bytes", w: 8 }),
  ts("Job queue", [['myassistant_jobs{status="pending"}', "pending"], ['myassistant_jobs{status="running"}', "running"]]),
  ts("Jobs finished / h", [["sum by (status) (increase(myassistant_jobs_total[1h]))", "{{status}}"]]),
]);

const fsRoot = 'mountpoint="/",fstype!~"tmpfs|overlay"';
const host = dashboard("myassistant-host", "MyAssistant — Host & containers", [
  row("Host"),
  stat("CPU used", '100 * (1 - avg(rate(node_cpu_seconds_total{mode="idle"}[5m])))',
    { unit: "percent", thresholds: [{ color: "orange", value: 70 }, { color: "red", value: 85 }] }),
  stat("Memory used", "100 * (1 - node_memory_MemAvailable_bytes / node_memory_MemTotal_bytes)",
    { unit: "percent", thresholds: [{ color: "orange", value: 75 }, { color: "red", value: 90 }] }),
  stat("Disk used /", `100 * (1 - node_filesystem_avail_bytes{${fsRoot}} / node_filesystem_size_bytes{${fsRoot}})`,
    { unit: "percent", thresholds: [{ color: "orange", value: 75 }, { color: "red", value: 85 }] }),
  stat("Load (1m)", "node_load1", { decimals: 2 }),
  stat("CPU cores", 'count(count by (cpu) (node_cpu_seconds_total{mode="idle"}))'),
  stat("Uptime", "time() - node_boot_time_seconds", { unit: "s" }),
  ts("CPU by mode", [['sum by (mode) (rate(node_cpu_seconds_total{mode!="idle"}[5m]))', "{{mode}}"]], { stack: true }),
  ts("Memory", [["node_memory_MemTotal_bytes - node_memory_MemAvailable_bytes", "used"], ["node_memory_MemAvailable_bytes", "available"]], { unit: "bytes", stack: true }),
  ts("Network", [['sum(rate(node_network_receive_bytes_total{device!~"lo|veth.*|docker.*|br-.*"}[5m]))', "in"],
    ['sum(rate(node_network_transmit_bytes_total{device!~"lo|veth.*|docker.*|br-.*"}[5m]))', "out"]], { unit: "Bps" }),
  ts("Disk I/O", [["sum(rate(node_disk_read_bytes_total[5m]))", "read"], ["sum(rate(node_disk_written_bytes_total[5m]))", "write"]], { unit: "Bps" }),
  row("Containers"),
  ts("CPU by container (cores)", [['sum by (name) (rate(container_cpu_usage_seconds_total{name=~".+"}[5m]))', "{{name}}"]]),
  ts("Memory by container", [['sum by (name) (container_memory_working_set_bytes{name=~".+"})', "{{name}}"]], { unit: "bytes" }),
]);

const logsDash = dashboard("myassistant-logs", "MyAssistant — Logs", [
  ts("Backend error lines / min", [['sum(count_over_time({service="backend"} |~ "(?i)error" [1m]))', "errors"]], { w: 24, h: 6, ds: LOKI }),
  logs("Backend errors and warnings", '{service="backend", level=~"error|warn"}'),
  logs("All backend logs", '{service="backend"}'),
  logs("Caddy and Postgres", '{service=~"caddy|postgres"}', 8),
]);

const out = path.join(__dirname, "dashboards");
fs.mkdirSync(out, { recursive: true });
for (const d of [overview, host, logsDash]) {
  fs.writeFileSync(path.join(out, `${d.uid}.json`), JSON.stringify(d, null, 2) + "\n");
}
console.log("wrote", fs.readdirSync(out).join(", "));
