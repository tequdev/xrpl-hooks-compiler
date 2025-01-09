#!/usr/bin/env node

// Importing required modules
import { Command } from "commander";
import { buildFile } from "./build";
import { mkdir, statSync } from "fs";
import * as esbuild from "esbuild";

import * as fs from "fs";
import * as path from "path";

function validateExportContent(content: string): void {
  const words = content
    .split(",")
    .map((word) => word.trim())
    .filter((word) => word.length > 0);
  if (!words.includes("Hook")) {
    throw Error("Invalid export: Hook is required");
  }
  if (!words.every((word) => word === "Hook" || word === "Callback")) {
    throw Error("Invalid export: Only Hook and Callback are allowed");
  }
}

function clean(filePath: string, outputPath?: string): string {
  const tsCode = fs.readFileSync(filePath, "utf-8");
  const importPattern = /^\s*import\s+.*?;\s*$/gm;
  const exportPattern = /^\s*export\s*\{([^}]*)\};?\s*$/gm;
  const commentPattern = /^\s*\/\/.*$/gm;

  const match = exportPattern.exec(tsCode);
  if (!match) {
    throw Error("Invalid export: No export found");
  }
  const exportContent = match[1];
  validateExportContent(exportContent);

  let cleanedCode = tsCode.replace(importPattern, "");
  cleanedCode = cleanedCode.replace(exportPattern, "");
  cleanedCode = cleanedCode.replace(commentPattern, "");
  cleanedCode = cleanedCode.trim();
  if (outputPath) {
    fs.writeFileSync(outputPath, cleanedCode, "utf-8");
  }
  return cleanedCode;
}

export async function main() {
  // Creating a new command
  const program = new Command();

  // Adding an argument for the directory path
  program.argument("<inPath>", "input path (dir/file)");
  program.argument("<outDir>", "output directory");

  // Parsing the command line arguments
  program.parse(process.argv);

  // Getting the directory path from the arguments
  const inPath = program.args[0];
  const outDir = program.args[1] || "build";

  // Checking if directory path is provided
  if (!inPath) {
    console.error("Input path is required.");
    process.exit(1);
  }

  // Checking if directory path is provided
  if (!outDir) {
    console.error("Output directory path is required.");
    process.exit(1);
  }

  try {
    const outStat = statSync(outDir);
    if (!outStat.isDirectory()) {
      console.error("Output path must be a directory.");
      process.exit(1);
    }
  } catch (error: any) {
    mkdir(outDir, async () => console.log(`Created directory: ${outDir}`));
  }

  if (path.extname(inPath) === ".ts") {
    const file = inPath.split("/").pop();
    const filename = file?.split(".ts")[0];
    const newPath = inPath.replace(file as string, `dist/${filename}.js`);
    console.log(inPath);

    await esbuild.build({
      entryPoints: [inPath],
      outfile: newPath,
      bundle: true,
      format: "esm",
    });
    clean(newPath, newPath);
    await buildFile(newPath, outDir);
    return;
  }

  const dirStat = statSync(inPath);
  if (dirStat.isDirectory()) {
    throw Error("JS2Wasm Can ONLY build files");
  } else {
    await buildFile(inPath, outDir);
  }
}
