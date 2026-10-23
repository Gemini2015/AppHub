#!/usr/bin/env node
/**
 * AppHub 一键本地验收脚本。
 *
 * 依次执行各包的 test / typecheck、桌面端构建，可选 Electron E2E，
 * 汇总结果并以非零退出码报告失败（供 CI / Lead 最终验收使用）。
 *
 * 用法：
 *   node scripts/verify.mjs                # 测试 + typecheck + desktop build
 *   node scripts/verify.mjs --e2e          # 额外执行 Playwright Electron E2E（会先 build）
 *   node scripts/verify.mjs --no-build     # 跳过 desktop build
 *   node scripts/verify.mjs --only=test,typecheck   # 只跑指定类别
 *   node scripts/verify.mjs --bail         # 首个失败后停止
 *   node scripts/verify.mjs --list         # 只列出将执行的步骤
 *
 * 环境变量：
 *   APPHUB_VERIFY_NO_COLOR=1  禁用颜色
 *   CI=1                      CI 下禁用颜色 + 默认启用 bail
 *
 * 注意：本脚本会从子进程环境中删除 ELECTRON_RUN_AS_NODE。
 * 某些桌面宿主环境或 CI runner 会注入该变量，导致 Electron 退化为
 * 纯 Node 运行，E2E 会以 "Process failed to launch!" 失败。
 */

import { spawnSync } from 'node:child_process';
import { existsSync, promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const IS_WINDOWS = process.platform === 'win32';
const USE_COLOR =
  process.stdout.isTTY && !process.env.NO_COLOR && process.env.APPHUB_VERIFY_NO_COLOR !== '1' && !process.env.CI;

const COLOR = {
  reset: '\u001b[0m',
  bold: '\u001b[1m',
  dim: '\u001b[2m',
  red: '\u001b[31m',
  green: '\u001b[32m',
  yellow: '\u001b[33m',
  cyan: '\u001b[36m',
  magenta: '\u001b[35m',
};

function paint(text, color) {
  return USE_COLOR ? `${COLOR[color]}${text}${COLOR.reset}` : text;
}

// ---------------------------------------------------------------------------
// 参数解析
// ---------------------------------------------------------------------------

const ALL_KINDS = ['test', 'typecheck', 'build', 'e2e'];

function parseArgs(argv) {
  const options = { e2e: false, build: true, bail: Boolean(process.env.CI), only: null, list: false, help: false };
  for (const arg of argv) {
    if (arg === '--e2e') options.e2e = true;
    else if (arg === '--no-build') options.build = false;
    else if (arg === '--bail') options.bail = true;
    else if (arg === '--list') options.list = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg.startsWith('--only=')) {
      const kinds = arg.slice('--only='.length).split(',').map((value) => value.trim()).filter(Boolean);
      const invalid = kinds.filter((kind) => !ALL_KINDS.includes(kind));
      if (invalid.length > 0) {
        console.error(`未知的 --only 取值：${invalid.join(', ')}（可选：${ALL_KINDS.join(', ')}）`);
        process.exit(2);
      }
      options.only = new Set(kinds);
    } else if (arg === '--no-color') {
      process.env.APPHUB_VERIFY_NO_COLOR = '1';
    } else {
      console.error(`未知参数：${arg}（使用 --help 查看用法）`);
      process.exit(2);
    }
  }
  if (options.e2e) options.build = true;
  return options;
}

function printHelp() {
  console.log(`
AppHub 一键验收脚本

用法：
  node scripts/verify.mjs [选项]

选项：
  --e2e                 额外执行 Electron E2E（Playwright，需要 desktop build）
  --no-build            跳过 desktop build
  --only=<kinds>        只执行指定类别，逗号分隔：test,typecheck,build,e2e
  --bail                首个失败后停止（CI=1 时默认开启）
  --list                只列出步骤，不执行
  --no-color            禁用彩色输出
  -h, --help            显示帮助

示例：
  node scripts/verify.mjs                     # 本地验收（测试 + 类型检查 + 构建）
  node scripts/verify.mjs --e2e               # 完整验收（含 Electron E2E）
  node scripts/verify.mjs --only=core         # 只跑核心包相关（按包名过滤，见 --list）
`);
}

// ---------------------------------------------------------------------------
// 工作区发现
// ---------------------------------------------------------------------------

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, 'utf8'));
}

async function discoverPackages() {
  const workspaceGroups = [
    { dir: path.join(ROOT_DIR, 'packages'), type: 'package' },
    { dir: path.join(ROOT_DIR, 'apps'), type: 'app' },
  ];
  const packages = [];
  for (const group of workspaceGroups) {
    let entries = [];
    try {
      entries = await fs.readdir(group.dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const dir = path.join(group.dir, entry.name);
      const manifestPath = path.join(dir, 'package.json');
      if (!existsSync(manifestPath)) continue;
      const manifest = await readJson(manifestPath);
      packages.push({ dir, name: manifest.name, scripts: manifest.scripts ?? {}, kind: group.type });
    }
  }
  // 跨包集成测试包（workspace 根下的 tests/）
  const testsManifestPath = path.join(ROOT_DIR, 'tests', 'package.json');
  if (existsSync(testsManifestPath)) {
    const manifest = await readJson(testsManifestPath);
    packages.push({ dir: path.join(ROOT_DIR, 'tests'), name: manifest.name, scripts: manifest.scripts ?? {}, kind: 'tests' });
  }
  // 稳定顺序：协议 → 存储 → 核心 → testkit → 集成 → 桌面端
  const priority = ['@apphub/protocol', '@apphub/storage', '@apphub/core', '@apphub/testkit', '@apphub/tests', '@apphub/desktop'];
  return packages.sort((a, b) => {
    const ia = priority.indexOf(a.name);
    const ib = priority.indexOf(b.name);
    return (ia === -1 ? 999 : ia) - (ib === -1 ? 999 : ib) || a.name.localeCompare(b.name);
  });
}

function filterByOnly(steps, only) {
  if (!only) return steps;
  return steps.filter((step) => only.has(step.kind));
}

// ---------------------------------------------------------------------------
// pnpm 调用
// ---------------------------------------------------------------------------

const PNPM_BIN = process.env.npm_execpath && /\.(c?js|mjs)$/.test(process.env.npm_execpath) ? process.execPath : null;

function buildPnpmCommand(args) {
  if (PNPM_BIN) return { command: PNPM_BIN, args: [process.env.npm_execpath, ...args], shell: false };
  // Windows 上 .cmd 必须经 shell 启动（Node 18.20.2+ 的安全限制）
  return { command: 'pnpm', args, shell: IS_WINDOWS };
}

/** 子进程环境：删除会让 Electron 退化成 Node 的宿主变量。 */
function buildChildEnv() {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  env.APPHUB_VERIFY = '1';
  return env;
}

function runStep(step) {
  const { command, args, shell } = buildPnpmCommand(step.pnpmArgs);
  const startedAt = Date.now();
  const result = spawnSync(command, args, {
    cwd: ROOT_DIR,
    stdio: 'inherit',
    env: buildChildEnv(),
    shell,
  });
  const durationMs = Date.now() - startedAt;
  if (result.error) {
    return { status: 'fail', durationMs, error: result.error };
  }
  return { status: result.status === 0 ? 'pass' : 'fail', durationMs, exitCode: result.status };
}

function formatDuration(ms) {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }

  const packages = await discoverPackages();
  const steps = [];
  const missingScripts = [];

  for (const pkg of packages) {
    if (pkg.scripts.test) {
      steps.push({
        kind: 'test',
        package: pkg.name,
        title: `test      ${pkg.name}`,
        pnpmArgs: ['--filter', pkg.name, 'test'],
      });
    } else {
      missingScripts.push(`${pkg.name} 没有 test 脚本（跳过）`);
    }
  }

  for (const pkg of packages) {
    if (pkg.scripts.typecheck) {
      steps.push({
        kind: 'typecheck',
        package: pkg.name,
        title: `typecheck ${pkg.name}`,
        pnpmArgs: ['--filter', pkg.name, 'typecheck'],
      });
    } else {
      missingScripts.push(`${pkg.name} 没有 typecheck 脚本（跳过）`);
    }
  }

  const desktop = packages.find((pkg) => pkg.name === '@apphub/desktop');
  if (desktop?.scripts.build) {
    steps.push({
      kind: 'build',
      package: '@apphub/desktop',
      title: 'build     @apphub/desktop',
      pnpmArgs: ['--filter', '@apphub/desktop', 'build'],
    });
  }
  if (desktop?.scripts['test:e2e']) {
    steps.push({
      kind: 'e2e',
      package: '@apphub/desktop',
      title: 'e2e       @apphub/desktop',
      pnpmArgs: ['--filter', '@apphub/desktop', 'test:e2e'],
    });
  }

  let selected = filterByOnly(steps, options.only);
  if (!options.build) selected = selected.filter((step) => step.kind !== 'build');
  if (!options.e2e) selected = selected.filter((step) => step.kind !== 'e2e');
  if (options.e2e && !selected.some((step) => step.kind === 'build') && options.build) {
    // --e2e 时确保 build 在 E2E 之前（即使 --only 未包含 build）
    const buildStep = steps.find((step) => step.kind === 'build');
    if (buildStep) selected = [buildStep, ...selected.filter((step) => step.kind !== 'build')];
  }

  const header = [
    '',
    paint('AppHub 验收（verify.mjs）', 'bold'),
    `  目录：${ROOT_DIR}`,
    `  Node：${process.version}  平台：${process.platform}/${process.arch}`,
    `  时间：${new Date().toLocaleString('zh-CN', { hour12: false })}`,
    `  步骤：${selected.length} 个${options.only ? `（--only=${[...options.only].join(',')}）` : ''}`,
    '',
  ];
  console.log(header.join('\n'));

  if (missingScripts.length > 0) {
    console.log(paint(`提示：${missingScripts.join('；')}`, 'dim'));
    console.log('');
  }

  if (options.list) {
    for (const step of selected) console.log(`  - [${step.kind}] ${step.title}`);
    console.log('');
    return;
  }

  const results = [];
  const startedAt = Date.now();
  let aborted = false;

  for (const step of selected) {
    if (aborted) {
      results.push({ step, status: 'skipped', durationMs: 0 });
      continue;
    }
    console.log(paint(`\n──────── ${step.title} ────────`, 'cyan'));
    const result = runStep(step);
    results.push({ step, ...result });
    if (result.status === 'fail') {
      console.log(paint(`✗ ${step.title} 失败`, 'red'));
      if (options.bail) aborted = true;
    }
  }

  const totalMs = Date.now() - startedAt;
  const passed = results.filter((entry) => entry.status === 'pass');
  const failed = results.filter((entry) => entry.status === 'fail');
  const skipped = results.filter((entry) => entry.status === 'skipped');

  console.log(paint('\n════════════════ 验收汇总 ════════════════', 'bold'));
  for (const entry of results) {
    const icon = entry.status === 'pass' ? paint('✓', 'green') : entry.status === 'fail' ? paint('✗', 'red') : paint('-', 'yellow');
    const duration = entry.status === 'skipped' ? '未运行' : formatDuration(entry.durationMs);
    console.log(`  ${icon} ${entry.step.title.padEnd(38)} ${duration}`);
    if (entry.error) console.log(paint(`      启动失败：${entry.error.message}`, 'red'));
  }
  console.log(
    paint(
      `\n合计 ${results.length} 步：${passed.length} 通过，${failed.length} 失败，${skipped.length} 未运行；总耗时 ${formatDuration(totalMs)}`,
      'bold',
    ),
  );

  if (failed.length > 0) {
    console.log(paint('\n结果：FAIL（存在失败步骤，见上方输出）', 'red'));
    process.exitCode = 1;
  } else if (skipped.length > 0) {
    console.log(paint('\n结果：PASS（有步骤未运行，通常由 --bail 导致）', 'yellow'));
  } else {
    console.log(paint('\n结果：PASS', 'green'));
  }

  if (options.e2e && failed.length === 0 && selected.some((step) => step.kind === 'e2e')) {
    console.log(paint(`E2E 报告：apps/desktop/e2e/.tmp/playwright-report/index.html`, 'dim'));
  }
}

await main().catch((error) => {
  console.error(paint(`\nverify.mjs 执行异常：${error instanceof Error ? error.stack ?? error.message : String(error)}`, 'red'));
  process.exitCode = 1;
});
