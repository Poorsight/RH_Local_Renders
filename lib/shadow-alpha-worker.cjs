"use strict";

const { parentPort, workerData } = require("node:worker_threads");
const { prepareSubstrateShadow } = require("./post-process.cjs");

try {
  parentPort.postMessage({ ok: true, result: prepareSubstrateShadow(workerData.file, { config: workerData.config, productType: workerData.productType }) });
} catch (error) {
  parentPort.postMessage({ ok: false, error: error.stack || error.message });
}
