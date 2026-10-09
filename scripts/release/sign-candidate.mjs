#!/usr/bin/env node
// Owner-operated local signing only. Never invoke with a production key through an agent.
import { constants as fsConstants, openSync, closeSync, fstatSync, lstatSync, readSync, writeFileSync } from 'node:fs';
import { createHash, createPrivateKey, constants, sign, X509Certificate } from 'node:crypto';
import { parseArgs } from 'node:util';
import { join, resolve } from 'node:path';
import { parseManifest, verifyArtifact } from '../../dist/install/manifest.js';
import { terminalIo } from '../../dist/cli/io.js';
function read(path,maximum,privateFile=false) {
  const before=lstatSync(path);if(!before.isFile()||before.isSymbolicLink()||before.nlink!==1||before.size>maximum)throw new Error();
  const fd=openSync(path,fsConstants.O_RDONLY|fsConstants.O_NOFOLLOW|fsConstants.O_NONBLOCK);
  try {const st=fstatSync(fd);if(!st.isFile()||st.nlink!==1||st.size>maximum||st.ino!==before.ino||st.dev!==before.dev)throw new Error();
    if(privateFile&&(st.uid!==process.getuid()||(st.mode&0o077)))throw new Error();
    const buffer=Buffer.alloc(st.size+1);const count=readSync(fd,buffer,0,buffer.length,0);if(count!==st.size)throw new Error();return buffer.subarray(0,count);
  }finally{closeSync(fd);}
}
try {
  if(!process.stdin.isTTY||!process.stderr.isTTY||!process.getuid||process.getuid()===0)throw new Error();
  const {values}=parseArgs({options:{candidate:{type:'string'},'private-key':{type:'string'},certificate:{type:'string'},'source-sha':{type:'string'},'manifest-sha256':{type:'string'}}});
  if(!values.candidate||!values['private-key']||!values.certificate||!/^[0-9a-f]{40}$/.test(values['source-sha']??'')||!/^[0-9a-f]{64}$/.test(values['manifest-sha256']??''))throw new Error();
  const directory=resolve(values.candidate);const st=lstatSync(directory);if(!st.isDirectory()||st.isSymbolicLink()||st.uid!==process.getuid()||(st.mode&0o077))throw new Error();
  const manifest=read(join(directory,'manifest.tsv'),8192);const parsed=parseManifest(manifest);
  if(parsed.sourceSha!==values['source-sha']||parsed.version!=='0.2.0'||createHash('sha256').update(manifest).digest('hex')!==values['manifest-sha256'])throw new Error();
  for(const artifact of parsed.artifacts)verifyArtifact(artifact,read(join(directory,artifact.name),artifact.size));
  const certificate=new X509Certificate(read(resolve(values.certificate),16384));
  const pem=read(resolve(values['private-key']),16384,true);
  if(!pem.toString('ascii').startsWith('-----BEGIN ENCRYPTED PRIVATE KEY-----'))throw new Error();
  const passphrase=await terminalIo.prompt('Owner signing key passphrase: ',{hidden:true});
  const key=createPrivateKey({key:pem,passphrase});pem.fill(0);
  if(key.asymmetricKeyType!=='rsa'||key.asymmetricKeyDetails?.modulusLength!==3072||!certificate.checkPrivateKey(key))throw new Error();
  // Recheck the candidate after human input; never sign a substituted manifest.
  if(!read(join(directory,'manifest.tsv'),8192).equals(manifest))throw new Error();
  for(const artifact of parsed.artifacts)verifyArtifact(artifact,read(join(directory,artifact.name),artifact.size));
  const signature=sign('sha256',manifest,{key,padding:constants.RSA_PKCS1_PADDING});
  writeFileSync(join(directory,'signer.der'),certificate.raw,{flag:'wx',mode:0o600});
  writeFileSync(join(directory,'manifest.sig'),signature,{flag:'wx',mode:0o600});
  process.stdout.write(JSON.stringify({format_version:1,phase:'owner_signed',source_sha:parsed.sourceSha,manifest_sha256:values['manifest-sha256'],signer_sha256:createHash('sha256').update(certificate.raw).digest('hex')})+'\n');
}catch{process.stderr.write('{"format_version":1,"error_code":"owner_signing_failed"}\n');process.exitCode=1;}
