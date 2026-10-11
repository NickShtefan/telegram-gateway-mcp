#!/usr/bin/env node
// Run only by the owner in a private TTY. This program never publishes a release.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { parseArgs } from 'node:util';
import { terminalIo } from '../../dist/cli/io.js';
import { parseManifest } from '../../dist/install/manifest.js';
import { encodeReleaseTar, encodeReleaseZip } from '../../dist/install/releasePackage.js';
import { runtimeEntry } from '../install/runtime-entry.mjs';
import { OWNER_PIN, readRegular, sha256, inspectCandidate, signCandidates } from './batch-sign.mjs';
import { TARGETS as targets, requireRun, manifestEvidence, draftArguments } from './plan.mjs';
const run=(args,binary=false)=>execFileSync('gh',args,{encoding:binary?undefined:'utf8',maxBuffer:binary?134217728:20000000,timeout:180000});
const api=endpoint=>JSON.parse(run(['api',endpoint]));
try {
 if(!process.stdin.isTTY||!process.stderr.isTTY||!process.getuid||process.getuid()===0)throw new Error('owner_tty_required');
 const {values}=parseArgs({options:{sha:{type:'string'},run:{type:'string'},repo:{type:'string',default:'NickShtefan/telegram-gateway-mcp'},tag:{type:'string',default:'v0.2.0'},output:{type:'string'},key:{type:'string',default:'/Users/nikolayshkolenko/Projects/KEYS/tg-mcp-signing/owner-signing-key.pem'},certificate:{type:'string',default:'/Users/nikolayshkolenko/Projects/KEYS/tg-mcp-signing/owner-signing-certificate.pem'}}});
 if(!/^[0-9a-f]{40}$/.test(values.sha??'')||!/^\d+$/.test(values.run??'')||!/^[-A-Za-z0-9_.]+\/[-A-Za-z0-9_.]+$/.test(values.repo)||!/^v0\.2\.0(?:-[A-Za-z0-9.]+)?$/.test(values.tag))throw new Error('invalid_release_plan');
 const source=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim();if(source!==values.sha||execFileSync('git',['status','--porcelain'],{encoding:'utf8'}).trim())throw new Error('frozen_clean_checkout_required');
 const base=`repos/${values.repo}`,ci=api(`${base}/actions/runs/${values.run}`);
 requireRun(ci,source);
 const jobs=api(`${base}/actions/runs/${values.run}/jobs?per_page=100`);if(jobs.total_count!==jobs.jobs.length||jobs.jobs.some(j=>j.conclusion!=='success'))throw new Error('ci_jobs_incomplete');
 const artifacts=api(`${base}/actions/runs/${values.run}/artifacts?per_page=100`);if(artifacts.total_count!==artifacts.artifacts.length)throw new Error('artifact_listing_incomplete');
 // An existing draft/tag is not silently replaced. Resolve annotated tags too.
 let existing=null;try{existing=api(`${base}/releases/tags/${values.tag}`)}catch(e){if(!String(e.stderr??'').includes('404'))throw e}if(existing)throw new Error('release_already_exists');
 let tag=null;try{tag=api(`${base}/git/ref/tags/${values.tag}`)}catch(e){if(!String(e.stderr??'').includes('404'))throw e}
 if(tag){let object=tag.object;for(let i=0;object.type==='tag'&&i<4;i++)object=api(`${base}/git/tags/${object.sha}`).object;if(object.type!=='commit'||object.sha!==source)throw new Error('tag_source_mismatch')}
 const root=values.output?resolve(values.output):mkdtempSync(join(tmpdir(),'tg-mcp-draft-'));if(values.output)mkdirSync(root,{mode:0o700});
 const candidates=[];
 for(const [runner,platform,architecture,label] of targets){
  const found=artifacts.artifacts.filter(a=>a.name===`unsigned-${runner}-${source}`&&!a.expired);if(found.length!==1||!/^sha256:[0-9a-f]{64}$/.test(found[0].digest??''))throw new Error('candidate_artifact_missing');
  const job=jobs.jobs.find(j=>j.name===`unsigned-candidates (${runner})`);if(!job)throw new Error('candidate_job_missing');
  const logs=run(['api',`${base}/actions/jobs/${job.id}/logs`]);
  const manifestSha256=manifestEvidence(logs,source);
  const zip=run(['api',`${base}/actions/artifacts/${found[0].id}/zip`],true);if(sha256(zip)!==found[0].digest.slice(7))throw new Error('ci_artifact_digest_mismatch');
  const archive=join(root,runner+'.zip');writeFileSync(archive,zip,{flag:'wx',mode:0o600});
  const directory=join(root,label);mkdirSync(directory,{mode:0o700});
  for(const [name,max] of [['manifest.tsv',8192],['node'+(platform==='win32'?'.exe':''),134217728],['installer.mjs',1048576],['manifest.mjs',1048576],['archive.mjs',1048576],['application.tar.gz',134217728],['NODE_LICENSE',1048576]])writeFileSync(join(directory,name),runtimeEntry(archive,name,max,true),{flag:'wx',mode:0o600});
  const candidate={directory,platform,architecture,label,manifestSha256};inspectCandidate(candidate,source);candidates.push(candidate);
 }
 terminalIo.err('All five CI manifests and payloads verified. Stop agents/capture before entering your signing passphrase.');
 await signCandidates(candidates,{sourceSha:source,certificatePath:resolve(values.certificate),keyPath:resolve(values.key),prompt:terminalIo.prompt,signerPin:OWNER_PIN});
 const assets=[];
 for(const candidate of candidates){const manifest=parseManifest(readRegular(join(candidate.directory,'manifest.tsv'),8192));const names=['manifest.tsv','manifest.sig','signer.der',...manifest.artifacts.map(a=>a.name)];const files=new Map(names.map(name=>[name,readRegular(join(candidate.directory,name),134217728)]));
  const windows=candidate.platform==='win32';const file=join(root,`telegram-mcp-gateway-0.2.0-${candidate.label}.${windows?'zip':'tar.gz'}`);writeFileSync(file,windows?encodeReleaseZip(files):encodeReleaseTar(files),{flag:'wx',mode:0o600});assets.push(file);
 }
 for(const name of ['bootstrap-posix.sh','bootstrap-windows.ps1']){const path=join(root,name);writeFileSync(path,readFileSync('scripts/install/'+name),{flag:'wx',mode:0o600});assets.push(path)}
 const checksums=join(root,'SHA256SUMS');writeFileSync(checksums,assets.map(path=>`${sha256(readRegular(path,134217728))}  ${path.split('/').at(-1)}\n`).join(''),{flag:'wx',mode:0o600});assets.push(checksums);
 const notes=join(root,'RELEASE-NOTES.md');writeFileSync(notes,`# Private installer qualification\n\nSource: \`${source}\`. CI run: ${values.run}. All five candidates were verified against CI manifest hashes and owner-signed.\n\nNo user signing, Node/npm or source build is required. Follow the README Installation section. Download bootstrap from immutable source: https://github.com/${values.repo}/blob/${source}/scripts/install/ . Authenticate that source independently; release assets alone are not an independent bootstrap trust root.\n\nBootstrap SHA-256 values:\n\n\`\`\`text\n${assets.filter(p=>p.endsWith('.sh')||p.endsWith('.ps1')).map(p=>`${sha256(readFileSync(p))}  ${p.split('/').at(-1)}`).join('\n')}\n\`\`\`\n\nThis is a draft. Publishing, repository visibility and npm are separate owner decisions.\n`,{flag:'wx',mode:0o600});
 run(draftArguments({tag:values.tag,repo:values.repo,sha:source,notes,assets}));
 terminalIo.out(JSON.stringify({format_version:1,phase:'draft_release_created',source_sha:source,tag:values.tag,output:root,published:false}));
}catch{process.stderr.write('{"format_version":1,"error_code":"draft_release_failed","published":false}\n');process.exitCode=1;}
