"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { PNG } = require("pngjs");

const HIST_SIZE = 256 * 256;
const args = Object.fromEntries(process.argv.slice(2).map((value, index, all) => value.startsWith("--") ? [value.slice(2), all[index + 1] && !all[index + 1].startsWith("--") ? all[index + 1] : true] : null).filter(Boolean));
const sourceRoot = path.resolve(String(args.source || "")), referenceRoot = path.resolve(String(args.reference || ""));
const sampleStep = Math.max(1, Math.round(Number(args.step) || 4));
if (!fs.existsSync(sourceRoot) || !fs.existsSync(referenceRoot)) {
  console.error("Usage: node scripts/calibrate-shadow-lut.cjs --source <new batch> --reference <reference batch> [--step 4] [--output report.json]");
  process.exit(2);
}

const rawRoot = root => path.join(root, "raw");
const cameraFor = file => path.basename(file).match(/_(TQB|TQ|FH|F|P)_/i)?.[1]?.toUpperCase() || "GLOBAL";
const luma = (data, index) => Math.max(0, Math.min(255, Math.round(data[index] * 0.2126 + data[index + 1] * 0.7152 + data[index + 2] * 0.0722)));
const alphaAt = (image, globalY, x) => {
  const localY = globalY - Math.floor((5000 - image.height) / 2);
  return localY >= 0 && localY < image.height && x >= 0 && x < image.width ? image.data[(localY * image.width + x) * 4 + 3] : 0;
};
const lumaAt = (image, globalY, x) => {
  const localY = globalY - Math.floor((5000 - image.height) / 2);
  return localY >= 0 && localY < image.height && x >= 0 && x < image.width ? luma(image.data, (localY * image.width + x) * 4) : 0;
};
const addHistogram = (target, source, sign = 1) => {
  for (let index = 0; index < HIST_SIZE; index += 1) target[index] += source[index] * sign;
  return target;
};

function pairedFiles() {
  const pairs = [];
  for (const model of fs.readdirSync(rawRoot(sourceRoot))) {
    const sourceFolder = path.join(rawRoot(sourceRoot), model), referenceFolder = path.join(rawRoot(referenceRoot), model);
    if (!fs.statSync(sourceFolder).isDirectory() || !fs.existsSync(referenceFolder)) continue;
    for (const name of fs.readdirSync(sourceFolder).filter(file => /_Shadow\.png$/i.test(file))) {
      const source = path.join(sourceFolder, `${name}.substrate-rgb.bak`), reference = path.join(referenceFolder, name);
      if (fs.existsSync(source) && fs.existsSync(reference)) pairs.push({ model, camera: cameraFor(name), source, reference });
    }
  }
  return pairs;
}

function histogramFor(pair) {
  const source = PNG.sync.read(fs.readFileSync(pair.source)), reference = PNG.sync.read(fs.readFileSync(pair.reference));
  if (source.width !== reference.width) throw new Error(`Widths differ for ${pair.model}/${pair.camera}`);
  const sourceTop = Math.floor((5000 - source.height) / 2), referenceTop = Math.floor((5000 - reference.height) / 2);
  const histogram = new Float64Array(HIST_SIZE), start = Math.min(sourceTop, referenceTop);
  const end = Math.max(sourceTop + source.height, referenceTop + reference.height);
  for (let y = Math.max(0, start); y < Math.min(5000, end); y += sampleStep) for (let x = 0; x < source.width; x += sampleStep) {
    const input = lumaAt(source, y, x), expected = alphaAt(reference, y, x);
    if (input || expected) histogram[(input << 8) | expected] += 1;
  }
  return histogram;
}

function conditionalTargets(histogram, statistic) {
  const values = new Float64Array(256), weights = new Float64Array(256);
  for (let input = 1; input < 256; input += 1) {
    let count = 0, weighted = 0;
    for (let expected = 0; expected < 256; expected += 1) {
      const amount = histogram[(input << 8) | expected]; count += amount; weighted += amount * expected;
    }
    weights[input] = count;
    if (!count) continue;
    if (statistic === "mean") values[input] = weighted / count;
    else {
      let accumulated = 0;
      for (let expected = 0; expected < 256; expected += 1) {
        accumulated += histogram[(input << 8) | expected];
        if (accumulated >= count / 2) { values[input] = expected; break; }
      }
    }
  }
  return { values, weights };
}

// Weighted pool-adjacent-violators regression keeps the LUT monotonic: a stronger hidden
// signal can never become a weaker output merely because one training image was noisy.
function isotonicLut(histogram, statistic) {
  const { values, weights } = conditionalTargets(histogram, statistic), blocks = [];
  for (let input = 1; input < 256; input += 1) {
    if (!weights[input]) continue;
    blocks.push({ start: input, end: input, weight: weights[input], value: values[input] });
    while (blocks.length > 1 && blocks.at(-2).value > blocks.at(-1).value) {
      const right = blocks.pop(), left = blocks.pop(), weight = left.weight + right.weight;
      blocks.push({ start: left.start, end: right.end, weight, value: (left.value * left.weight + right.value * right.weight) / weight });
    }
  }
  const lut = new Uint8Array(256); lut[0] = 0;
  if (!blocks.length) return lut;
  for (const block of blocks) for (let input = block.start; input <= block.end; input += 1) lut[input] = Math.round(block.value);
  let previous = 0;
  for (let input = 1; input < 256; input += 1) {
    if (weights[input]) { previous = lut[input]; continue; }
    const next = blocks.find(block => block.start > input);
    if (!next) lut[input] = previous;
    else {
      const prior = [...blocks].reverse().find(block => block.end < input), lowX = prior?.end || 0, lowY = prior?.value || 0;
      lut[input] = Math.round(lowY + (next.value - lowY) * ((input - lowX) / (next.start - lowX)));
    }
  }
  return lut;
}

function evaluate(histogram, lut) {
  let count = 0, absolute = 0, squared = 0, predicted = 0, expectedTotal = 0;
  for (let input = 0; input < 256; input += 1) for (let expected = 0; expected < 256; expected += 1) {
    const amount = histogram[(input << 8) | expected]; if (!amount) continue;
    const output = lut[input]; if (!output && !expected) continue;
    const difference = output - expected;
    count += amount; absolute += amount * Math.abs(difference); squared += amount * difference * difference;
    predicted += amount * output; expectedTotal += amount * expected;
  }
  return { count, mae: absolute / count, rmse: Math.sqrt(squared / count), meanRatio: predicted / expectedTotal };
}

const pairs = pairedFiles();
if (!pairs.length) throw new Error("No high-resolution Shadow RGB backups could be paired with references");
const records = [];
for (let index = 0; index < pairs.length; index += 1) {
  const pair = pairs[index], histogram = histogramFor(pair); records.push({ ...pair, histogram });
  process.stderr.write(`sampled ${index + 1}/${pairs.length} ${pair.model}/${pair.camera}\n`);
}
const cameras = [...new Set(records.map(record => record.camera))].sort(), statistics = ["median", "mean"], candidates = {};
for (const statistic of statistics) {
  const folds = [];
  for (const heldOut of records) {
    const training = new Float64Array(HIST_SIZE);
    for (const record of records) if (record.camera === heldOut.camera && record.model !== heldOut.model) addHistogram(training, record.histogram);
    folds.push({ model: heldOut.model, camera: heldOut.camera, ...evaluate(heldOut.histogram, isotonicLut(training, statistic)) });
  }
  const count = folds.reduce((sum, fold) => sum + fold.count, 0);
  candidates[statistic] = {
    crossValidation: {
      mae: folds.reduce((sum, fold) => sum + fold.mae * fold.count, 0) / count,
      rmse: Math.sqrt(folds.reduce((sum, fold) => sum + fold.rmse * fold.rmse * fold.count, 0) / count),
      cameras: Object.fromEntries(cameras.map(camera => {
        const rows = folds.filter(fold => fold.camera === camera), cameraCount = rows.reduce((sum, row) => sum + row.count, 0);
        return [camera, { mae: rows.reduce((sum, row) => sum + row.mae * row.count, 0) / cameraCount, meanRatio: rows.reduce((sum, row) => sum + row.meanRatio * row.count, 0) / cameraCount }];
      }))
    },
    curves: Object.fromEntries(cameras.map(camera => {
      const histogram = new Float64Array(HIST_SIZE);
      records.filter(record => record.camera === camera).forEach(record => addHistogram(histogram, record.histogram));
      return [camera, [...isotonicLut(histogram, statistic)]];
    }))
  };
}
const winner = Object.entries(candidates).sort((left, right) => left[1].crossValidation.mae - right[1].crossValidation.mae)[0][0];
const report = { version: 1, generatedAt: new Date().toISOString(), sourceRoot, referenceRoot, sampleStep, pairs: pairs.length, winner, candidates };
const encoded = `${JSON.stringify(report, null, 2)}\n`;
if (args.output) { const output = path.resolve(String(args.output)); fs.mkdirSync(path.dirname(output), { recursive: true }); fs.writeFileSync(output, encoded); console.log(output); }
else console.log(encoded);
