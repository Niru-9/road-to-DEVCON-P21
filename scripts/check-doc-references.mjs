// Two things are checked, because both are claims a reviewer will follow:
//
//   1. Every `src/**`, `agents/**` or `scripts/**` path written in backticks in the markdown docs
//      resolves to a real file in this repository. Docs that point at code which has been renamed
//      or moved are the most common way a document starts lying.
//   2. Every `path:NN` reference additionally resolves to a real, NON-BLANK line, so the pointer
//      is not just to the right file but to a line with something on it.
//
// Run after any edit that adds, renames or moves code.
//
// Exit code 0 = clean, 1 = problems.
import { existsSync, globSync, readFileSync, statSync } from 'node:fs'

const docs = ['README.md', 'action.md', ...globSync('docs/*.md').map(String)]

const CODE_ROOTS = ['src', 'scripts', 'agents', 'dev-registry']
const CODE_EXTENSIONS = ['.ts', '.tsx', '.mjs', '.js', '.json', '.css', '.html']

/** Markdown link targets, which is how the docs reference most files. */
const LINK_TARGET = /\]\(([^)\s]+?)\)/g
/** Backticked code paths, with an optional `:NN` line suffix. */
const CODE_PATH = new RegExp(
  '`((?:' + CODE_ROOTS.join('|') + ')(?:[/\\\\][\\w.-]+)+\\.(?:' + CODE_EXTENSIONS.map((e) => e.slice(1)).join('|') + '))(?::(\\d+))?`',
  'g',
)

const problems = []
let pathsChecked = 0
let linesChecked = 0

function isCodePath(target) {
  const clean = target.split('#')[0]
  return CODE_ROOTS.some((root) => clean === root || clean.startsWith(`${root}/`) || clean.startsWith(`${root}\\`))
}

function checkPath(doc, target, line) {
  const clean = target.split('#')[0]
  pathsChecked += 1

  if (!existsSync(clean)) {
    problems.push(`${doc}:${line}  ${target} — file does not exist`)
    return
  }
  if (!statSync(clean).isFile()) {
    problems.push(`${doc}:${line}  ${target} — is not a file`)
  }
}

function checkLine(doc, file, line) {
  linesChecked += 1
  if (!existsSync(file)) return

  const lines = readFileSync(file, 'utf8').split('\n')
  if (line > lines.length) {
    problems.push(`${doc}  ${file}:${line} — file has only ${lines.length} lines`)
    return
  }
  if (lines[line - 1].trim().length === 0) {
    problems.push(`${doc}  ${file}:${line} — blank line`)
  }
}

for (const doc of docs) {
  if (!existsSync(doc)) continue
  const text = readFileSync(doc, 'utf8')
  const lines = text.split(/\r?\n/)

  lines.forEach((text_, index) => {
    const lineNo = index + 1

    LINK_TARGET.lastIndex = 0
    let link
    while ((link = LINK_TARGET.exec(text_)) !== null) {
      const target = link[1]
      // Only repository-local targets; skip http(s), mailto and bare anchors.
      if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith('#')) continue
      if (!isCodePath(target)) continue
      // Walk up from docs/ for a doc-local reference.
      const resolved = existsSync(target) ? target : existsSync(`../${target}`) ? `../${target}` : target
      checkPath(doc, resolved.startsWith('..') ? target : resolved, lineNo)
    }

    CODE_PATH.lastIndex = 0
    let code
    while ((code = CODE_PATH.exec(text_)) !== null) {
      const [, file, lineText] = code
      const resolved = existsSync(file) ? file : existsSync(`../${file}`) ? `../${file}` : file
      checkPath(doc, resolved, lineNo)
      if (lineText !== undefined) checkLine(doc, resolved, Number(lineText))
    }
  })
}

console.log(
  `checked ${pathsChecked} code path(s) and ${linesChecked} file:line reference(s) across ${docs.length} doc file(s)`,
)

if (problems.length === 0) {
  console.log('PASS: every code path and every file:line reference in the docs resolves')
} else {
  console.log(`FAIL: ${problems.length} problem(s)`)
  for (const problem of problems) console.log(`  - ${problem}`)
  process.exitCode = 1
}