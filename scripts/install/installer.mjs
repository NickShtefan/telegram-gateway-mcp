#!/usr/bin/env node
// Invoked only from an authenticated candidate. No service activation in this entry.
import { constants, openSync, closeSync, fstatSync, readSync, mkdirSync, lstatSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { verifyManifest, verifyArtifact, ArtifactError } from './manifest.mjs';
import { decodeApplicationArchive, extractApplicationArchive, ArchiveError } from './archive.mjs';
const root = dirname(fileURLToPath(import.meta.url));
function read(name, max) {
  const fd = openSync(join(root, name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || st.nlink !== 1 || st.size > max || (st.mode & 0o022) !== 0) throw new Error('invalid_file');
    const buffer = Buffer.alloc(st.size + 1);
    const count = readSync(fd, buffer, 0, buffer.length, 0);
    if (count !== st.size) throw new Error('invalid_file');
    return buffer.subarray(0, count);
  } finally { closeSync(fd); }
}
try {
  const { values } = parseArgs({ options: {
    version: { type: 'string' }, 'source-sha': { type: 'string' }, 'signer-sha256': { type: 'string' },
    extract: { type: 'boolean', default: false }, 'verify-extracted': { type: 'boolean', default: false },
  } });
  const policy = { version: values.version, sourceSha: values['source-sha'], signerSha256: values['signer-sha256'], platform: process.platform, architecture: process.arch };
  const manifest = verifyManifest(read('manifest.tsv', 8192), read('manifest.sig', 384), read('signer.der', 16384), policy);
  if (process.versions.node !== manifest.nodeVersion) throw new Error('runtime_mismatch');
  let application;
  for (const artifact of manifest.artifacts) {
    const bytes = read(artifact.name, artifact.size); verifyArtifact(artifact, bytes);
    if (artifact.role === 'application') application = bytes;
  }
  if (!application) throw new Error('missing_application');
  const files = decodeApplicationArchive(application);
  if (values['verify-extracted']) {
    const expected=new Map(files.map(file=>['application/'+file.path,file.data]));
    function inspect(directory) {
      for(const name of readdirSync(join(root,directory))) {
        const path=directory+'/'+name;const stat=lstatSync(join(root,path));
        if(stat.isSymbolicLink())throw new Error('invalid_extracted');
        if(stat.isDirectory()){if(![...expected.keys()].some(file=>file.startsWith(path+'/')))throw new Error('invalid_extracted');inspect(path)}
        else {const bytes=expected.get(path);if(!bytes||!read(path,bytes.length).equals(bytes))throw new Error('invalid_extracted');expected.delete(path)}
      }
    }
    inspect('application');if(expected.size!==0)throw new Error('invalid_extracted');
  }
  if (values.extract) {
    const target = join(root, 'application'); mkdirSync(target, { mode: 0o700 });
    await extractApplicationArchive(application, target);
  }
  process.stdout.write(JSON.stringify({ format_version: 1, phase: values.extract ? 'candidate_prepared' : 'candidate_verified',
    version: manifest.version, source_sha: manifest.sourceSha, platform: manifest.platform, architecture: manifest.architecture,
    node_version: manifest.nodeVersion, application_files: files.length, installed: false }) + '\n');
} catch (err) {
  const code = err instanceof ArtifactError ? err.code : err instanceof ArchiveError ? 'unsafe_archive' : 'candidate_failed';
  process.stderr.write(JSON.stringify({ format_version: 1, error_code: code }) + '\n'); process.exitCode = 1;
}
