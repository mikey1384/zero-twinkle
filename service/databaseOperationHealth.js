// Generated from twinkle-api/helpers/databaseOperationHealth.ts.
// Refresh with node twinkle-api/scripts/sync-database-health.cjs.
"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.databaseOperationHealth = exports.LATENCY_BUCKETS_MS = void 0;
exports.createDatabaseOperationHealth = createDatabaseOperationHealth;
exports.createDatabaseHealthWriter = createDatabaseHealthWriter;
const promises_1 = __importDefault(require("node:fs/promises"));
const node_path_1 = __importDefault(require("node:path"));
const node_os_1 = __importDefault(require("node:os"));
const node_crypto_1 = require("node:crypto");
// Shared wire format with zero-twinkle/service/databaseOperationHealth.js.
// Fixed buckets keep per-operation work and memory constant, at any traffic
// level. No SQL, parameters, member identifiers, or unbounded labels enter it.
exports.LATENCY_BUCKETS_MS = [5, 20, 50, 100, 250, 500, 1000, 5000, null];
function emptyMetric() {
    return {
        count: 0,
        failed: 0,
        acquireTimeouts: 0,
        statementTimeouts: 0,
        durationMs: 0,
        maxMs: 0,
        buckets: exports.LATENCY_BUCKETS_MS.map(() => 0)
    };
}
function createDatabaseOperationHealth({ now = Date.now } = {}) {
    let storyStyleValidation = emptyMetric();
    let monitoring = {
        heapSample: emptyMetric(),
        cpuProfileRotation: emptyMetric()
    };
    const monitoringStatus = {
        heapSample: 'not_started',
        cpuProfileRotation: 'not_started'
    };
    const routes = new Map();
    const get = (route) => {
        let entry = routes.get(route);
        if (!entry) {
            entry = {
                since: now(),
                metrics: {
                    acquire: emptyMetric(),
                    query: emptyMetric(),
                    transaction: emptyMetric()
                }
            };
            routes.set(route, entry);
        }
        return entry;
    };
    get('reader');
    get('writer');
    return {
        observeStoryStyle(durationMs, failed = false) {
            const ms = Math.max(0, durationMs);
            storyStyleValidation.count++;
            storyStyleValidation.failed += Number(failed);
            storyStyleValidation.durationMs += ms;
            storyStyleValidation.maxMs = Math.max(storyStyleValidation.maxMs, ms);
            storyStyleValidation.buckets[exports.LATENCY_BUCKETS_MS.findIndex((upper) => upper === null || ms <= upper)]++;
        },
        monitoringState(operation, state) {
            monitoringStatus[operation] = state;
        },
        observeMonitoring(operation, durationMs, failed = false) {
            const metric = monitoring[operation];
            const ms = Math.max(0, durationMs);
            metric.count++;
            metric.failed += Number(failed);
            metric.durationMs += ms;
            metric.maxMs = Math.max(metric.maxMs, ms);
            metric.buckets[exports.LATENCY_BUCKETS_MS.findIndex((upper) => upper === null || ms <= upper)]++;
            monitoringStatus[operation] = failed ? 'unavailable' : 'ready';
        },
        observe(route, operation, durationMs, errorCode, failed = false) {
            const metric = get(route).metrics[operation];
            const ms = Math.max(0, Number.isFinite(durationMs) ? durationMs : 0);
            metric.count++;
            metric.failed += Number(failed);
            metric.acquireTimeouts += Number(errorCode === 'DB_ACQUIRE_TIMEOUT');
            metric.statementTimeouts += Number(errorCode === 'DB_STATEMENT_TIMEOUT');
            metric.durationMs += ms;
            metric.maxMs = Math.max(metric.maxMs, ms);
            metric.buckets[exports.LATENCY_BUCKETS_MS.findIndex((upper) => upper === null || ms <= upper)]++;
        },
        drain(route) {
            const entry = get(route);
            routes.delete(route);
            const until = now();
            routes.set(route, {
                since: until,
                metrics: {
                    acquire: emptyMetric(),
                    query: emptyMetric(),
                    transaction: emptyMetric()
                }
            });
            const monitorWindow = route === 'writer'
                ? {
                    monitoring,
                    monitoringStatus: { ...monitoringStatus },
                    applications: { storyStyleValidation }
                }
                : {};
            if (route === 'writer')
                storyStyleValidation = emptyMetric();
            if (route === 'writer')
                monitoring = {
                    heapSample: emptyMetric(),
                    cpuProfileRotation: emptyMetric()
                };
            return {
                route,
                from: new Date(entry.since).toISOString(),
                to: new Date(until).toISOString(),
                latencyBucketUpperMs: exports.LATENCY_BUCKETS_MS,
                operations: entry.metrics,
                ...monitorWindow
            };
        }
    };
}
exports.databaseOperationHealth = createDatabaseOperationHealth();
// Append only from the existing minute timers / completed cron slices, never
// on the request path. A stalled disk has at most four queued samples.
// Eight dated files, <=32 MiB each per service/host, remain after log clearing
// and process restarts. Drops and read gaps are explicit in the daily report.
function createDatabaseHealthWriter({ service = 'api', directory = node_path_1.default.resolve(process.env.TWINKLE_LOG_DIR || 'logs', 'database-health'), now = Date.now, warn = (message) => console.warn(message) } = {}) {
    const processId = (0, node_crypto_1.randomUUID)();
    const startedAt = new Date(now()).toISOString();
    let pending = 0, dropped = 0, lastWarning = -Infinity, cleanedDay = '';
    let tail = Promise.resolve(false);
    let revision = null;
    const identity = promises_1.default
        .readFile(node_path_1.default.resolve(__dirname, '../../.twinkle-runtime-artifact.json'), 'utf8')
        .then((raw) => {
        const value = JSON.parse(raw).commitSha;
        if (/^[a-f0-9]{40}$/.test(value))
            revision = value;
    })
        .catch(async () => {
        if (service !== 'cron')
            return;
        const head = (await promises_1.default.readFile(node_path_1.default.resolve('.git/HEAD'), 'utf8')).trim();
        const ref = /^ref: (refs\/[A-Za-z0-9_./-]+)$/.exec(head)?.[1];
        if (ref?.includes('..'))
            return;
        const value = ref
            ? (await promises_1.default.readFile(node_path_1.default.resolve('.git', ref), 'utf8')).trim()
            : head;
        if (/^[a-f0-9]{40}$/.test(value))
            revision = value;
    })
        .catch(() => { });
    return (sample) => {
        if (pending >= 4) {
            dropped++;
            return Promise.resolve(false);
        }
        pending++;
        const at = now();
        const write = async () => {
            const previousDrops = dropped;
            try {
                await identity;
                const day = new Date(at).toISOString().slice(0, 10);
                await promises_1.default.mkdir(directory, { recursive: true, mode: 0o700 });
                if (cleanedDay !== day) {
                    const cutoff = new Date(at - 7 * 86400_000)
                        .toISOString()
                        .slice(0, 10);
                    for (const name of await promises_1.default.readdir(directory)) {
                        const match = /^database-health-(\d{4}-\d{2}-\d{2})\.jsonl$/.exec(name);
                        if (match && match[1] < cutoff)
                            await promises_1.default.unlink(node_path_1.default.join(directory, name)).catch(() => { });
                    }
                    cleanedDay = day;
                }
                const file = node_path_1.default.join(directory, `database-health-${day}.jsonl`);
                const bytes = await promises_1.default
                    .stat(file)
                    .then((stat) => stat.size)
                    .catch((error) => {
                    if (error.code === 'ENOENT')
                        return 0;
                    throw error;
                });
                const line = JSON.stringify({
                    ...sample,
                    protocol: 1,
                    service,
                    at: new Date(at).toISOString(),
                    host: node_os_1.default.hostname(),
                    processId,
                    pid: process.pid,
                    processStartedAt: startedAt,
                    revision,
                    dropped: previousDrops
                }) + '\n';
                if (Buffer.byteLength(line) > 8192 ||
                    bytes + Buffer.byteLength(line) > 32 * 1024 * 1024)
                    throw new Error('database health storage limit');
                await promises_1.default.appendFile(file, line, { mode: 0o600 });
                dropped -= previousDrops;
                return true;
            }
            catch {
                dropped++;
                if (at - lastWarning >= 3600_000) {
                    lastWarning = at;
                    try {
                        warn('[database-health] telemetry unavailable; daily review must check coverage');
                    }
                    catch {
                        /* diagnostics only */
                    }
                }
                return false;
            }
            finally {
                pending--;
            }
        };
        tail = tail.then(write, write);
        return tail;
    };
}
