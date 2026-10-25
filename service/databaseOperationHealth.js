// Generated from twinkle-api/helpers/databaseOperationHealth.ts.
// Refresh with node twinkle-api/scripts/sync-database-health.cjs.
"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.databaseOperationHealth = exports.DATABASE_HEALTH_WRITER_PROCESSES = exports.DATABASE_HEALTH_TODAY_RESERVE_BYTES = exports.DATABASE_HEALTH_STOP_FREE_DISK_BYTES = exports.DATABASE_HEALTH_CORE_ONLY_FREE_DISK_BYTES = exports.DATABASE_HEALTH_MAX_DIRECTORY_BYTES = exports.DATABASE_HEALTH_CORE_ONLY_DAY_BYTES = exports.DATABASE_HEALTH_MAX_DAY_BYTES = exports.DATABASE_HEALTH_MAX_LINE_BYTES = exports.LATENCY_BUCKETS_MS = void 0;
exports.createDatabaseOperationHealth = createDatabaseOperationHealth;
exports.composeDatabaseHealthWindow = composeDatabaseHealthWindow;
exports.fitDatabaseHealthLine = fitDatabaseHealthLine;
exports.createDatabaseHealthWriter = createDatabaseHealthWriter;
const promises_1 = __importDefault(require("node:fs/promises"));
const node_path_1 = __importDefault(require("node:path"));
const node_os_1 = __importDefault(require("node:os"));
const node_crypto_1 = require("node:crypto");
// Shared wire format with zero-twinkle/service/databaseOperationHealth.js.
// Fixed buckets keep per-operation work and memory constant, at any traffic
// level. No SQL, parameters, member identifiers, or unbounded labels enter it.
exports.LATENCY_BUCKETS_MS = [5, 20, 50, 100, 250, 500, 1000, 5000, null];
// Keep the standalone reader's limits in sync (covered by the writer tests).
// Five processes each write two <=8 KiB windows per minute: <=112.5 MiB/day.
// The previous 32 MiB host-wide cap exhausted before the end of a normal day.
// A writer sample carries every fixed histogram; 10-19 the roadmap stall
// counter took it to 8,203 bytes and every sample was dropped. With every
// counter at 11 digits a sample is ~15 KB; a test keeps that under 75% of
// this cap so a new metric fails CI, and fitDatabaseHealthLine degrades an
// oversized sample instead of dropping it. A second test keeps a day of
// extreme writer and reader windows from five processes inside the day cap.
exports.DATABASE_HEALTH_MAX_LINE_BYTES = 24 * 1024;
// Sized so a full day of extreme samples from every writer process stays
// under the degrade share (a test asserts it). Realistic days use ~70 MB.
exports.DATABASE_HEALTH_MAX_DAY_BYTES = 256 * 1024 * 1024;
// Once less than this much of today's budget is left, new windows keep only
// their core metrics. It holds a whole day of extreme core-only windows from
// every writer process (~44 MB), so a day that degrades never runs out.
exports.DATABASE_HEALTH_CORE_ONLY_DAY_BYTES = 48 * 1024 * 1024;
// Disk protection (twinkle-07, 10-19): the API and cron directories share the
// primary's root disk, and a full disk would hurt the API itself, which is
// worse than losing telemetry. Each directory keeps at most 1 GiB across its
// retained days (today gets what the older days leave); below 2 GiB free,
// windows are written core-only, and below 1 GiB free nothing is written.
exports.DATABASE_HEALTH_MAX_DIRECTORY_BYTES = 1024 * 1024 * 1024;
exports.DATABASE_HEALTH_CORE_ONLY_FREE_DISK_BYTES = 2 * 1024 * 1024 * 1024;
exports.DATABASE_HEALTH_STOP_FREE_DISK_BYTES = 1024 * 1024 * 1024;
// Today always keeps this much of the directory budget: when older days use
// more, the oldest are deleted first (a whole day of extreme core-only windows
// from every writer process is ~44 MB, so today can always write).
exports.DATABASE_HEALTH_TODAY_RESERVE_BYTES = 64 * 1024 * 1024;
// (The reserve is larger than DATABASE_HEALTH_CORE_ONLY_DAY_BYTES, so even a
// squeezed day writes full windows first and keeps a core-only day after.)
// Processes that load the database pool and so write samples: the API
// cluster primary and its 2 workers (WEB_CONCURRENCY=2), the build-generation,
// content-image-optimizer and town-sim workers, plus up to 2 provisional API
// workers during a deploy handoff. The day-budget test uses this count.
exports.DATABASE_HEALTH_WRITER_PROCESSES = 8;
function emptyNamedQueries() {
    return Object.fromEntries([
        'noteworthyComments',
        'xpAllTime',
        'wordMasterMonth',
        'wordMasterYear',
        'latestBoardMessages',
        'latestOmokBoardMessages',
        'wordMasterDodge',
        'reflectionChatHistory',
        'contributionLiveStates',
        'chatMessagePage',
        'chatTopicRange',
        'xpAcquisition',
        'wordMasterFeed',
        'wordMasterFeedDefinitions',
        'videoRecommendations'
    ].map((name) => [name, emptyApplicationMetric()]));
}
function emptyServiceMetrics() {
    return Object.fromEntries(['minecraftChunkBatch', 'speechAttempt', 'soundtrackRead', 'soundtrackWrite', 'soundtrackDecision', 'soundtrackGate', 'soundtrackRejected', 'leaderboardRanking', 'videoHistoryFilter', 'videoContinueFinish'].map(name => [name, emptyApplicationMetric()]));
}
function emptyProjectMetrics() {
    return Object.fromEntries([
        ['roadmapEvaluation', emptyApplicationMetric()],
        ['roadmapMissingEvidence', emptyApplicationMetric()],
        // A Build plan milestone stalled (roadmap.ts loop guard).
        ['roadmapStall', emptyApplicationMetric()],
        ...['preview', 'projectExport', 'assetReferenceScan', 'validation', 'rewardConfig'].flatMap((operation) => ['total', 'queue', 'worker'].map((stage) => [
            `${operation}:${stage}`,
            emptyApplicationMetric()
        ]))
    ]);
}
function emptyLumineApplyMetrics() {
    return Object.fromEntries([
        'rejected',
        'noDiff',
        'checkpointed',
        'deferred',
        'saveFailed',
        'retryReused',
        'invalidArguments'
    ].map((outcome) => [`lumineApply:${outcome}`, emptyApplicationMetric()]));
}
function emptyLumineNoOpMetrics() {
    return Object.fromEntries(['already_satisfied', 'blocked'].map((outcome) => [
        `lumineNoOp:${outcome}`,
        emptyApplicationMetric()
    ]));
}
function emptyResponseTextMetrics() {
    return Object.fromEntries(['structured', 'topLevel', 'stream', 'empty', 'toolOnly'].map((selection) => [`responseText:${selection}`, emptyApplicationMetric()]));
}
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
// Only the pool's acquire/query/transaction metrics can record database
// timeouts. Application and monitoring metrics never did, so they leave the
// two always-zero counters out (10-24: they were 2/7 of every worst-case
// sample and pushed the extreme day past the degrade share). The daily
// report reads a missing counter as zero, so older rows stay comparable.
function emptyApplicationMetric() {
    return {
        count: 0,
        failed: 0,
        durationMs: 0,
        maxMs: 0,
        buckets: exports.LATENCY_BUCKETS_MS.map(() => 0)
    };
}
function createDatabaseOperationHealth({ now = Date.now } = {}) {
    let transactionFailures = {};
    let namedQueries = emptyNamedQueries();
    let serviceMetrics = emptyServiceMetrics();
    let storyStyleValidation = emptyApplicationMetric();
    let projectMetrics = emptyProjectMetrics();
    let responseTextMetrics = emptyResponseTextMetrics();
    let lumineApplyMetrics = emptyLumineApplyMetrics();
    let lumineNoOpMetrics = emptyLumineNoOpMetrics();
    let monitoring = {
        heapSample: emptyApplicationMetric(),
        cpuProfileRotation: emptyApplicationMetric()
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
        observeService(operation, durationMs, failed = false) {
            const metric = serviceMetrics[operation];
            const ms = Number.isFinite(durationMs) ? Math.max(0, durationMs) : 0;
            metric.count++;
            metric.failed += Number(failed);
            metric.durationMs += ms;
            metric.maxMs = Math.max(metric.maxMs, ms);
            metric.buckets[exports.LATENCY_BUCKETS_MS.findIndex(upper => upper === null || ms <= upper)]++;
        },
        observeLumineNoOp(outcome) {
            const metric = lumineNoOpMetrics[`lumineNoOp:${outcome}`];
            metric.count++;
            metric.buckets[0]++;
        },
        async measureNamedQuery(operation, run) {
            const started = now();
            let failed = false;
            try {
                return await run();
            }
            catch (error) {
                failed = true;
                throw error;
            }
            finally {
                const ms = Math.max(0, now() - started);
                const metric = namedQueries[operation];
                metric.count++;
                metric.failed += Number(failed);
                metric.durationMs += ms;
                metric.maxMs = Math.max(metric.maxMs, ms);
                metric.buckets[exports.LATENCY_BUCKETS_MS.findIndex((upper) => upper === null || ms <= upper)]++;
            }
        },
        observeLumineApply(outcome) {
            const metric = lumineApplyMetrics[`lumineApply:${outcome}`];
            metric.count++;
            metric.buckets[0]++;
        },
        observeRoadmapEvaluation(durationMs, failed, missingReferenced) {
            const metric = projectMetrics['roadmapEvaluation'];
            const ms = Math.max(0, Number.isFinite(durationMs) ? durationMs : 0);
            metric.count++;
            metric.failed += Number(failed);
            metric.durationMs += ms;
            metric.maxMs = Math.max(metric.maxMs, ms);
            metric.buckets[exports.LATENCY_BUCKETS_MS.findIndex((upper) => upper === null || ms <= upper)]++;
            if (missingReferenced) {
                projectMetrics['roadmapMissingEvidence'].count++;
                projectMetrics['roadmapMissingEvidence'].buckets[0]++;
            }
        },
        observeRoadmapStall() {
            projectMetrics['roadmapStall'].count++;
            projectMetrics['roadmapStall'].buckets[0]++;
        },
        observeResponseText(selection) {
            const metric = responseTextMetrics[`responseText:${selection}`];
            metric.count++;
            metric.buckets[0]++;
        },
        observeProjectWork(operation, stage, durationMs, failed = false) {
            const metric = projectMetrics[`${operation}:${stage}`];
            const ms = Number.isFinite(durationMs) ? Math.max(0, durationMs) : 0;
            metric.count++;
            metric.failed += Number(failed);
            metric.durationMs += ms;
            metric.maxMs = Math.max(metric.maxMs, ms);
            metric.buckets[exports.LATENCY_BUCKETS_MS.findIndex((upper) => upper === null || ms <= upper)]++;
        },
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
        observeTransactionFailure(phase, kind) {
            const key = `${phase}:${kind}`;
            transactionFailures[key] = (transactionFailures[key] || 0) + 1;
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
                    transactionFailures,
                    monitoring,
                    monitoringStatus: { ...monitoringStatus },
                    applications: {
                        ...namedQueries,
                        ...serviceMetrics,
                        storyStyleValidation,
                        ...projectMetrics,
                        ...responseTextMetrics,
                        ...lumineApplyMetrics,
                        ...lumineNoOpMetrics
                    }
                }
                : {};
            if (route === 'writer') {
                transactionFailures = {};
                namedQueries = emptyNamedQueries();
                serviceMetrics = emptyServiceMetrics();
                storyStyleValidation = emptyApplicationMetric();
                projectMetrics = emptyProjectMetrics();
                responseTextMetrics = emptyResponseTextMetrics();
                lumineApplyMetrics = emptyLumineApplyMetrics();
                lumineNoOpMetrics = emptyLumineNoOpMetrics();
            }
            if (route === 'writer')
                monitoring = {
                    heapSample: emptyApplicationMetric(),
                    cpuProfileRotation: emptyApplicationMetric()
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
// Eight dated files per service/host remain after log clearing and process
// restarts, together at most DATABASE_HEALTH_MAX_DIRECTORY_BYTES, and nothing is
// written when the disk runs low. Drops, trims and read gaps are explicit in
// the daily report.
function isIdleMetric(metric) {
    return (metric &&
        !metric.count &&
        !metric.failed &&
        !metric.acquireTimeouts &&
        !metric.statementTimeouts);
}
// 10-19: one new counter pushed a writer sample past the line cap and every
// sample was dropped for hours. An oversized sample now degrades instead:
// first all-idle application histograms are left out (lossless: the daily
// report sums them as zero), then whole optional sections are replaced by a
// `trimmed` marker the report raises as attention. Only a sample whose core
// route metrics alone do not fit is dropped.
// One database-health window exactly as pool.ts writes it; the guard tests
// build their extreme samples through this too.
function composeDatabaseHealthWindow({ drained, diagnostics, pool, maintenance }) {
    return {
        kind: 'database-window',
        ...drained,
        ...(diagnostics ? { diagnostics } : {}),
        pool,
        maintenance
    };
}
// Optional sections, trimmed in this order; the route operations, pool and
// maintenance counters are the core every window keeps.
const DATABASE_HEALTH_OPTIONAL_SECTIONS = [
    'applications',
    'monitoring',
    'diagnostics'
];
function fitDatabaseHealthLine(sample, envelope, maxBytes = exports.DATABASE_HEALTH_MAX_LINE_BYTES, { coreOnly = false, reason = 'day_budget' } = {}) {
    const render = (body) => JSON.stringify({ ...body, ...envelope }) + '\n';
    const fits = (line) => Buffer.byteLength(line) <= maxBytes;
    let line = render(sample);
    const fullBytes = Buffer.byteLength(line);
    if (coreOnly) {
        const body = { ...sample };
        const trimmed = DATABASE_HEALTH_OPTIONAL_SECTIONS.filter((section) => body[section] !== undefined);
        for (const section of trimmed)
            delete body[section];
        delete body.idleApplicationsOmitted;
        line = render({ ...body, trimmed, trimReason: reason });
        return { line: fits(line) ? line : null, trimmed, fullBytes };
    }
    if (fits(line))
        return { line, trimmed: [], fullBytes };
    const body = { ...sample };
    if (body.applications && typeof body.applications === 'object') {
        const active = Object.entries(body.applications).filter(([, metric]) => !isIdleMetric(metric));
        body.idleApplicationsOmitted =
            Object.keys(body.applications).length - active.length;
        body.applications = Object.fromEntries(active);
        line = render(body);
        if (fits(line))
            return { line, trimmed: [], fullBytes };
    }
    const trimmed = [];
    for (const section of DATABASE_HEALTH_OPTIONAL_SECTIONS) {
        if (body[section] === undefined)
            continue;
        delete body[section];
        if (section === 'applications')
            delete body.idleApplicationsOmitted;
        trimmed.push(section);
        line = render({ ...body, trimmed });
        if (fits(line))
            return { line, trimmed, fullBytes };
    }
    return { line: null, trimmed, fullBytes };
}
function createDatabaseHealthWriter({ service = 'api', directory = node_path_1.default.resolve(process.env.TWINKLE_LOG_DIR || 'logs', 'database-health'), now = Date.now, warn = (message) => console.warn(message), freeDiskBytes = async (dir) => {
    const stats = await promises_1.default.statfs(dir);
    return Number(stats.bavail) * Number(stats.bsize);
} } = {}) {
    const processId = (0, node_crypto_1.randomUUID)();
    const startedAt = new Date(now()).toISOString();
    let pending = 0, dropped = 0, lastWarning = -Infinity, cleanedDay = '';
    let lastTrimWarning = -Infinity;
    // Bytes of the retained older days, measured at each day's cleanup.
    let olderDaysBytes = 0;
    let dayBudget = exports.DATABASE_HEALTH_MAX_DAY_BYTES;
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
            let reason = 'write_failed', bytes = 0, lineBytes = 0;
            try {
                await identity;
                const day = new Date(at).toISOString().slice(0, 10);
                await promises_1.default.mkdir(directory, { recursive: true, mode: 0o700 });
                if (cleanedDay !== day) {
                    const cutoff = new Date(at - 7 * 86400_000)
                        .toISOString()
                        .slice(0, 10);
                    olderDaysBytes = 0;
                    const older = [];
                    for (const name of await promises_1.default.readdir(directory)) {
                        const match = /^database-health-(\d{4}-\d{2}-\d{2})\.jsonl$/.exec(name);
                        if (match && match[1] < cutoff)
                            await promises_1.default.unlink(node_path_1.default.join(directory, name)).catch(() => { });
                        else if (match && match[1] !== day) {
                            const file = node_path_1.default.join(directory, name);
                            const size = await promises_1.default
                                .stat(file)
                                .then((stat) => stat.size)
                                .catch(() => 0);
                            older.push({ day: match[1], file, size });
                            olderDaysBytes += size;
                        }
                    }
                    // A few heavy days must not starve today down to nothing: delete
                    // the oldest days until today keeps its reserve.
                    older.sort((a, b) => a.day.localeCompare(b.day));
                    while (older.length &&
                        olderDaysBytes >
                            exports.DATABASE_HEALTH_MAX_DIRECTORY_BYTES -
                                exports.DATABASE_HEALTH_TODAY_RESERVE_BYTES) {
                        const oldest = older.shift();
                        // Another writer may have removed it already (ENOENT is fine);
                        // any other failure leaves the bytes counted.
                        const removed = await promises_1.default
                            .unlink(oldest.file)
                            .then(() => true)
                            .catch((error) => error?.code === 'ENOENT');
                        if (!removed)
                            continue;
                        olderDaysBytes -= oldest.size;
                        try {
                            warn('[database-health] removed an older day to keep today within the directory budget ' +
                                JSON.stringify({ day: oldest.day, bytes: oldest.size }));
                        }
                        catch {
                            /* diagnostics only */
                        }
                    }
                    cleanedDay = day;
                }
                const file = node_path_1.default.join(directory, `database-health-${day}.jsonl`);
                bytes = await promises_1.default
                    .stat(file)
                    .then((stat) => stat.size)
                    .catch((error) => {
                    if (error.code === 'ENOENT')
                        return 0;
                    throw error;
                });
                const envelope = {
                    protocol: 1,
                    service,
                    at: new Date(at).toISOString(),
                    host: node_os_1.default.hostname(),
                    processId,
                    pid: process.pid,
                    processStartedAt: startedAt,
                    revision,
                    dropped: previousDrops
                };
                let { line, trimmed, fullBytes } = fitDatabaseHealthLine(sample, envelope);
                // Today's budget is the day cap or what the older retained days
                // leave of the directory budget, whichever is smaller.
                dayBudget = Math.max(0, Math.min(exports.DATABASE_HEALTH_MAX_DAY_BYTES, exports.DATABASE_HEALTH_MAX_DIRECTORY_BYTES - olderDaysBytes));
                const freeBytes = await freeDiskBytes(directory).catch(() => null);
                if (freeBytes !== null && freeBytes < exports.DATABASE_HEALTH_STOP_FREE_DISK_BYTES) {
                    reason = 'disk_low';
                    throw new Error('database health storage limit');
                }
                // Near the budget or on a low disk, keep writing core-only windows
                // rather than reaching the limit and dropping everything.
                const diskLow = freeBytes !== null &&
                    freeBytes < exports.DATABASE_HEALTH_CORE_ONLY_FREE_DISK_BYTES;
                if (line &&
                    (diskLow ||
                        bytes + Buffer.byteLength(line) >
                            dayBudget - exports.DATABASE_HEALTH_CORE_ONLY_DAY_BYTES)) {
                    ({ line, trimmed, fullBytes } = fitDatabaseHealthLine(sample, envelope, exports.DATABASE_HEALTH_MAX_LINE_BYTES, { coreOnly: true, reason: diskLow ? 'disk_low' : 'day_budget' }));
                }
                if (!line) {
                    // Even the core route metrics do not fit: the only case that drops.
                    lineBytes = fullBytes;
                    reason = 'sample_byte_limit';
                    throw new Error('database health storage limit');
                }
                // At most hourly, like the drop warning; the daily report also
                // raises every trimmed window as telemetry_trimmed.
                if (trimmed.length && at - lastTrimWarning >= 3600_000) {
                    lastTrimWarning = at;
                    try {
                        warn(`[database-health] sample trimmed to fit ${exports.DATABASE_HEALTH_MAX_LINE_BYTES} bytes ` +
                            JSON.stringify({ sections: trimmed, sampleBytes: fullBytes }));
                    }
                    catch {
                        /* diagnostics only */
                    }
                }
                lineBytes = Buffer.byteLength(line);
                if (bytes + lineBytes > dayBudget) {
                    reason =
                        dayBudget < exports.DATABASE_HEALTH_MAX_DAY_BYTES
                            ? 'directory_byte_limit'
                            : 'daily_byte_limit';
                    throw new Error('database health storage limit');
                }
                await promises_1.default.appendFile(file, line, { mode: 0o600 });
                dropped -= previousDrops;
                return true;
            }
            catch {
                dropped++;
                if (at - lastWarning >= 3600_000) {
                    lastWarning = at;
                    try {
                        warn('[database-health] telemetry unavailable; daily review must check coverage ' +
                            JSON.stringify({ reason, fileBytes: bytes, sampleBytes: lineBytes, dropped }));
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
