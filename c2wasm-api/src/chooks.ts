import fastify from 'fastify';
import fs from 'fs';
import { mkdirSync, writeFileSync, existsSync, openSync, closeSync, readFileSync, renameSync, rmSync, unlinkSync } from "fs";
import { deflateSync } from "zlib";
import { execSync } from "child_process";
import { z } from 'zod';
import fastifyCors from 'fastify-cors';
import fastifyWebSocket from 'fastify-websocket';

const server = fastify();

server.register(fastifyCors, {
  // put your options here
  origin: '*'
})
server.register(fastifyWebSocket);

// Compilation code
const llvmDir = process.cwd() + "/clang/wasi-sdk";
const tempDir = "/tmp";
const sysroot = llvmDir + "/share/wasi-sysroot";

export interface ResponseData {
  success: boolean;
  message: string;
  output: string;
  tasks: Task[];
}

export interface Task {
  name: string;
  file?: string;
  success?: boolean;
  console?: string;
  output?: string;
}

const requestBodySchema = z.object({
  output: z.enum(['wasm']),
  files: z.array(z.object({
    type: z.string(),
    name: z.string(),
    options: z.string().optional(),
    src: z.string()
  })),
  link_options: z.string().optional(),
  compress: z.boolean().optional(),
  strip: z.boolean().optional()
});

type RequestBody = z.infer<typeof requestBodySchema>;

// Input: JSON in the following format
// {
//     output: "wasm",
//     files: [
//         {
//             type: "c",
//             name: "file.c",
//             options: "-O3 -std=c99",
//             src: "#include..."
//         }
//     ],
//     link_options: "--import-memory"
// }
// Output: JSON in the following format
// {
//     success: true,
//     message: "Success",
//     output: "AGFzbQE.... =",
//     tasks: [
//         {
//             name: "building wasm",
//             success: true,
//             console: ""
//         }
//     ]
// }

function sanitize_shell_output<T>(out: T): T {
  return out; // FIXME
}

function shell_exec(cmd: string, cwd: string) {
  const out = openSync(cwd + '/out.log', 'w');
  let error = '';
  try {
    execSync(cmd, { cwd, stdio: [null, out, out], });
  } catch (ex: unknown) {
    if (ex instanceof Error) {
      error = ex?.message;
    }
  } finally {
    closeSync(out);
  }
  const result = readFileSync(cwd + '/out.log').toString() || error;
  return result;
}

function get_optimization_options(options: string) {
  const optimization_options = [
    /* default '-O0' not included */ '-O1', '-O2', '-O3', '-O4', '-Os'
  ];

  let safe_options = '';
  for (let o of optimization_options) {
    if (options.includes(o)) {
      safe_options += ' ' + o;
    }
  }

  return safe_options;
}

function get_clang_options(options: string) {
  const clang_flags = `--sysroot=${sysroot} -xc -I/app/clang/includes -fdiagnostics-print-source-range-info -Werror=implicit-function-declaration`;
  const miscellaneous_options = [
    '-ffast-math', '-fno-inline', '-std=c99', '-std=c89'
  ];

  let safe_options = '';
  for (let o of miscellaneous_options) {
    if (options.includes(o)) {
      safe_options += ' ' + o;
    } else if (o.includes('-std=') && options.toLowerCase().includes(o)) {
      safe_options += ' ' + o;
    }
  }

  return clang_flags + safe_options;
}

function get_lld_options(options: string) {
  // --sysroot=${sysroot} is already included in compiler options
  const clang_flags = `--no-standard-libraries -nostartfiles -Wl,--allow-undefined,--no-entry,--export-all`;
  if (!options) {
    return clang_flags;
  }
  const available_options = ['--import-memory', '-g'];
  let safe_options = '';
  for (let o of available_options) {
    if (options.includes(o)) {
      safe_options += ' -Wl,' + o;
    }
  }
  return clang_flags + safe_options;
}

function serialize_file_data(filename: string, compress: boolean) {
  let content = readFileSync(filename);
  if (compress) {
    content = deflateSync(content);
  }
  return content.toString("base64");
}

function validate_filename(name: string) {
  if (!/^[A-Za-z0-9_-]+[.][A-Za-z0-9]{1,4}$/.test(name)) {
    return false;
  }
  const parts = name.split(/\//g);
  for (let p of parts) {
    if (p == '.' || p == '..') {
      return false;
    }
  }
  return parts;
}

function link_c_files(source_files: string[], compile_options: string, link_options: string, cwd: string, output: string, result_obj: Task) {
  const files = source_files.join(' ');
  const clang = llvmDir + '/bin/clang';
  const cmd = clang + ' ' + get_clang_options(compile_options) + ' ' + get_lld_options(link_options) + ' ' + files + ' -o ' + output;
  const out = shell_exec(cmd, cwd);
  result_obj.console = sanitize_shell_output(out);
  if (!existsSync(output)) {
    result_obj.success = false;
    return false;
  }
  result_obj.success = true;
  return true;
}

function optimize_wasm(cwd: string, inplace: string, opt_options: string, result_obj: Task) {
  const unopt = cwd + '/unopt.wasm';
  const cmd = 'wasm-opt ' + opt_options + ' -o ' + inplace + ' ' + unopt;
  const out = openSync(cwd + '/opt.log', 'w');
  let error = '';
  let success = true;
  try {
    renameSync(inplace, unopt);
    execSync(cmd, { cwd, stdio: [null, out, out], });
  } catch (ex: unknown) {
    success = false;
    if (ex instanceof Error) {
      error = ex?.message;
    }
  } finally {
    closeSync(out);
  }
  const out_msg = readFileSync(cwd + '/opt.log').toString() || error;
  result_obj.console = sanitize_shell_output(out_msg);
  result_obj.success = success;
  return success;
}

function clean_wasm(cwd: string, inplace: string, result_obj: Task) {
  const cmd = 'hook-cleaner ' + inplace;
  const out = openSync(cwd + '/cleanout.log', 'w');
  let error = '';
  let success = true;
  try {
    execSync(cmd, { cwd, stdio: [null, out, out], });
  } catch (ex: unknown) {
    success = false;
    if (ex instanceof Error) {
      error = ex?.message;
    }
  } finally {
    closeSync(out);
  }
  const out_msg = readFileSync(cwd + '/cleanout.log').toString() || error;
  result_obj.console = sanitize_shell_output(out_msg);
  result_obj.success = success;
  return success;
}

export function build_project(project: RequestBody, base: string) {
  const output = project.output;
  const compress = project.compress;
  const strip = project.strip;
  let build_result: ResponseData = {
    success: false,
    message: '',
    output: '',
    tasks: [],
  };
  const dir = base + '.$';
  const result = base + '.wasm';

  const complete = (success: boolean, message: string) => {
    rmSync(dir, { recursive: true });
    if (existsSync(result)) {
      unlinkSync(result);
    }

    build_result.success = success;
    build_result.message = message;
    return build_result;
  };

  if (output != 'wasm') {
    return complete(false, 'Invalid output type ' + output);
  }

  build_result.tasks = [];
  const files = project.files;
  if (!files.length) {
    return complete(false, 'No source files');
  }

  if (!existsSync(dir)) {
    mkdirSync(dir);
  }

  const sources = [];
  let options;
  for (let file of files) {
    const name = file.name;
    if (!validate_filename(name)) {
      return complete(false, 'Invalid filename ' + name);
    }
    const fileName = dir + '/' + name;
    sources.push(fileName);
    if (!options) {
      options = file.options;
    } else {
      if (file.options && (file.options != options)) {
        return complete(false, 'Per-file compilation options not supported');
      }
    }

    const src = file.src;
    if (!src) {
      return complete(false, 'Source file ' + name + ' is empty');
    }

    writeFileSync(fileName, src);
  }
  const link_options = project.link_options;
  const link_result_obj = {
    name: 'building wasm'
  };
  build_result.tasks.push(link_result_obj);
  if (!link_c_files(sources, options || '', link_options || '', dir, result, link_result_obj)) {
    return complete(false, 'Build error');
  }

  const opt_options = get_optimization_options(options || '');
  if (opt_options) {
    const opt_obj = {
      name: 'optimizing wasm'
    };
    build_result.tasks.push(opt_obj);
    if (!optimize_wasm(dir, result, opt_options, opt_obj)) {
      return complete(false, 'Optimization error');
    }
  }

  if (strip) {
    const clean_obj = {
      name: 'cleaning wasm'
    };
    build_result.tasks.push(clean_obj);
    if (!clean_wasm(dir, result, clean_obj)) {
      return complete(false, 'Post-build error');
    }
  }

  build_result.output = serialize_file_data(result, compress || false);

  return complete(true, 'Success');
}
// END Compile code