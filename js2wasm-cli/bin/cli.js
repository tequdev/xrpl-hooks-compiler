#!/usr/bin/env node

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { main } = require("../dist/npm");

async function run() {
  await main();
}

run();