#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const root = __dirname;
const indexPath = path.join(root, 'index.html');
const readmePath = path.join(root, 'README.md');
const minifiedPattern = /(?:^|[.-])min\.js$/;
const extraSyntaxChecks = ['sw.js', 'smoke.js'];

function readText(file) {
  return fs.readFileSync(path.join(root, file), 'utf8');
}

function assertFile(file, context) {
  if (!fs.existsSync(path.join(root, file))) {
    throw new Error(`${context}: missing ${file}`);
  }
}

function unique(items) {
  return Array.from(new Set(items));
}

function scriptFilesFromIndex() {
  const html = readText('index.html');
  const scripts = [];
  const scriptRe = /<script\s+[^>]*src="([^"]+\.js)"[^>]*>/g;
  let match;
  while ((match = scriptRe.exec(html))) {
    scripts.push(match[1]);
  }
  return scripts;
}

function deploymentFilesFromReadme() {
  const readme = readText('README.md');
  const match = readme.match(/需要保留这些文件：[\s\S]*?```text\n([\s\S]*?)```/);
  if (!match) throw new Error('README deployment file list was not found');
  return match[1].split(/\r?\n/).map(line => line.trim()).filter(Boolean);
}

function runNodeCheck(files) {
  for (const file of files) {
    const result = spawnSync(process.execPath, ['--check', file], {
      cwd: root,
      encoding: 'utf8',
    });
    if (result.status !== 0) {
      const output = `${result.stdout || ''}${result.stderr || ''}`.trim();
      throw new Error(`node --check failed for ${file}${output ? `\n${output}` : ''}`);
    }
  }
}

function main() {
  assertFile('index.html', 'project root');
  assertFile('README.md', 'project root');

  const scripts = scriptFilesFromIndex();
  if (!scripts.length) throw new Error('index.html has no external script tags');
  scripts.forEach(file => assertFile(file, 'index.html script'));

  const deploymentFiles = deploymentFilesFromReadme();
  deploymentFiles.forEach(file => assertFile(file, 'README deployment list'));
  for (const file of scripts) {
    if (!deploymentFiles.includes(file)) {
      throw new Error(`README deployment list does not include index script ${file}`);
    }
  }

  const syntaxFiles = unique(scripts.concat(extraSyntaxChecks))
    .filter(file => file.endsWith('.js') && !minifiedPattern.test(file));
  runNodeCheck(syntaxFiles);

  console.log(`Smoke OK: ${scripts.length} scripts present, ${syntaxFiles.length} JS files syntax-checked.`);
}

try {
  main();
} catch (error) {
  console.error(`Smoke failed: ${error.message}`);
  process.exit(1);
}
