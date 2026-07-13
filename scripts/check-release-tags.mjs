import { readFileSync } from 'node:fs'

const releases = {
  runtime: '.github/workflows/release-runtime.yml',
  desktop: '.github/workflows/release-desktop.yml',
  cloud: '.github/workflows/release-cloud.yml',
  admin: '.github/workflows/release-admin.yml',
  'runtime-client': '.github/workflows/release-runtime-client.yml',
}

for (const [component, file] of Object.entries(releases)) {
  const source = readFileSync(file, 'utf8')
  const expected = `tags: ["${component}-v*"]`
  if (!source.includes(expected)) throw new Error(`${file} must contain ${expected}`)
  for (const other of Object.keys(releases)) {
    if (other !== component && source.includes(`tags: ["${other}-v*"]`)) {
      throw new Error(`${file} also triggers ${other}`)
    }
  }
  if (/tags:\s*\["v\*"\]/.test(source)) throw new Error(`${file} still accepts the legacy v* tag`)
}
