// Importing required modules
import axios from "axios";
import fs from "fs";
import path from "path";
import { decodeBinary } from "./decodeBinary";
import * as esbuild from "esbuild";
import "dotenv/config";

enum ConsoleColor {
  Red = "\x1b[31m",
  Green = "\x1b[32m",
  Yellow = "\x1b[33m",
  Blue = "\x1b[34m",
  Magenta = "\x1b[35m",
  Cyan = "\x1b[36m",
  White = "\x1b[37m",
  Reset = "\x1b[0m",
}

interface Task {
  name: string;
  console: string;
  success: boolean;
}

interface BuildResult {
  success: boolean;
  message: string;
  output: string;
  tasks: Task[];
}

export async function buildDir(dirPath: string, outDir: string): Promise<void> {
  // Reading all files in the directory tree
  let fileObjects: any[];
  try {
    fileObjects = readFiles(dirPath);
  } catch (error: any) {
    console.error(`Error reading files: ${error}`);
    process.exit(1);
  }

  // Building wasm for each file object
  await Promise.all(
    fileObjects.map(async (fileObject) => {
      try {
        await buildWasm(fileObject, outDir);
      } catch (error) {
        console.error(`Error building wasm: ${error}`);
        process.exit(1);
      }
    })
  ).catch((error) => {
    console.error(`Error building wasm: ${error}`);
    process.exit(1);
  });
}

export async function buildFile(
  dirPath: string,
  outDir: string
): Promise<void> {
  if (!dirPath.includes(".js") && !dirPath.includes(".ts")) {
    throw Error("Invalid file type. must be .js or .ts file");
  }

  let path = dirPath;

  if (dirPath.includes(".ts")) {
    path = await compileTs(dirPath);
  }

  const fileContent = fs.readFileSync(path, "utf-8");
  const filename = path.split("/").pop();
  const filetype = filename?.split(".").pop();
  const fileObject = {
    type: filetype,
    name: filename,
    options: "-O3",
    src: fileContent,
  };
  try {
    await buildWasm(fileObject, outDir);
  } catch (error) {
    console.error(`Error building wasm: ${error}`);
    process.exit(1);
  }
}

// Function to read all files in a directory tree
export function readFiles(dirPath: string): any[] {
  const files: any[] = [];
  const fileNames = fs.readdirSync(dirPath);
  for (const fileName of fileNames) {
    const filePath = path.join(dirPath, fileName);
    const fileStat = fs.statSync(filePath);
    if (fileStat.isDirectory()) {
      files.push(...readFiles(filePath));
    } else if (path.extname(fileName) === ".js") {
      const fileContent = fs.readFileSync(filePath, "utf-8");
      files.push({
        type: "js",
        name: fileName,
        options: "-O3",
        src: fileContent,
      });
    } else if (path.extname(fileName) === ".ts") {
      const fileContent = fs.readFileSync(filePath, "utf-8");
      files.push({
        type: "ts",
        name: fileName,
        options: "-O3",
        src: fileContent,
      });
    }
  }
  return files;
}

function parseBuildResult(result: BuildResult): string {
  const errorConsole: string[] = [];

  result.tasks.forEach((task) => {
    if (!task.success) {
      errorConsole.push(task.console);
    }
  });

  if (errorConsole.length > 0) {
    return errorConsole.join("\n");
  }

  return "";
}

async function saveFileOrError(
  outDir: string,
  filename: string,
  result: BuildResult
): Promise<void> {
  if (!result.success) {
    fs.writeFileSync(
      path.join(outDir + "/" + filename + ".log"),
      parseBuildResult(result)
    );
    console.error(parseBuildResult(result));
    throw Error(result.message);
  } else {
    const binary = await decodeBinary(result.output);
    console.log(
      `Built Wasm: ${outDir}/${filename}.bc ${ConsoleColor.Blue}%s${ConsoleColor.Reset}`,
      `${binary.byteLength}b`
    );
    fs.writeFileSync(
      path.join(outDir + "/" + filename + ".bc"),
      Buffer.from(Buffer.from(binary).toString(), "hex")
    );
  }
}

export async function buildWasm(fileObject: any, outDir: string) {
  const filename = fileObject.name.split(".")[0];
  // Sending API call to endpoint
  const body = JSON.stringify({
    output: "bc",
    compress: true,
    strip: true,
    files: [fileObject],
  });
  try {
    const response = await axios.post(
      `${process.env.JS2WASM_CLI_HOST}/api/build/js`,
      body,
      {
        headers: {
          "Content-Type": "application/json",
        },
      }
    );
    // Saving response to file
    const responseData = response.data;
    const success = responseData.success === true;
    const message = responseData.message;
    const output = success ? responseData.output : "";
    const tasks = responseData.tasks.map((task: Task) => {
      return {
        name: task.name,
        console: task.console,
        success: task.success === true,
      } as Task;
    });

    // Creating result object
    const result = {
      success,
      message,
      output,
      tasks,
    } as BuildResult;
    fs.mkdir(outDir, async () => {
      await saveFileOrError(outDir, filename, result);
    });
  } catch (error: any) {
    console.log(`Error sending API call: ${error}`);
  }
}

function clean(filePath: string, outputPath?: string): string {
  const tsCode = fs.readFileSync(filePath, "utf-8");
  const importPattern = /^\s*import\s+.*?;\s*$/gm;
  const exportPattern = /^\s*export\s*\{[^}]*\};?\s*$/gm;
  const commentPattern = /^\s*\/\/.*$/gm;
  let cleanedCode = tsCode.replace(importPattern, "");
  cleanedCode = cleanedCode.replace(exportPattern, "");
  cleanedCode = cleanedCode.replace(commentPattern, "");
  cleanedCode = cleanedCode.trim();
  if (outputPath) {
    fs.writeFileSync(outputPath, cleanedCode, "utf-8");
  }
  return cleanedCode;
}

async function compileTs(tsFilePath: string) {
  const file = tsFilePath.split("/").pop();
  const filename = file?.split(".ts")[0];
  const newPath = tsFilePath.replace(file as string, `dist/${filename}.js`);

  await esbuild.build({
    entryPoints: [tsFilePath],
    outfile: newPath,
    bundle: true,
    format: "esm",
  });
  clean(newPath, newPath);
  return newPath;
}
