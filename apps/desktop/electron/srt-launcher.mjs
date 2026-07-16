import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const resourcesPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const cli = path.join(
  resourcesPath,
  'app.asar',
  'node_modules',
  '@anthropic-ai',
  'sandbox-runtime',
  'dist',
  'cli.js',
)

// Commander treats Electron as an app runtime and parses from argv[1].
// Remove this bootstrap path so only SRT options and the worker remain.
process.argv.splice(1, 1)
await import(pathToFileURL(cli).href)
