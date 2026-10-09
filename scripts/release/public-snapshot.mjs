// Prepare an audited file-only snapshot. Never copy Git history or create/push another repository.
import { lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { parseArgs } from 'node:util';
import { execFileSync } from 'node:child_process';
try {
  const {values}=parseArgs({options:{output:{type:'string'},'allow-dirty-fixture':{type:'boolean',default:false}}});if(!values.output)throw new Error();
  const root=resolve('.');const output=resolve(values.output);if(output===root||output.startsWith(join(root,'.git')))throw new Error();
  const sha=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8',timeout:5000}).trim();
  if(!values['allow-dirty-fixture']&&execFileSync('git',['status','--porcelain','--untracked-files=normal'],{encoding:'utf8',timeout:5000}).trim())throw new Error();
  const selection=JSON.parse(readFileSync('docs/public-transfer-manifest.json','utf8'));const rows=[];const destinations=new Set();
  for(const entry of selection.files){
    for(const path of [entry.source,entry.destination])if(!/^[A-Za-z0-9_@./+-]+$/.test(path)||path.split('/').some(part=>!part||part==='.'||part==='..'))throw new Error();
    if(destinations.has(entry.destination.toLowerCase())||/(^|\/)(\.git|\.env|session\.key|data|exports)(\/|$)|\.(sqlite|db|session|pem|key)$/i.test(entry.destination))throw new Error();destinations.add(entry.destination.toLowerCase());
    const source=resolve(entry.source);if(!source.startsWith(root+'/'))throw new Error();
    const st=lstatSync(source);if(!st.isFile()||st.isSymbolicLink()||st.nlink!==1||st.size>1048576)throw new Error();
    const bytes=readFileSync(source);const text=bytes.toString('utf8');
    if(/-----BEGIN (?:ENCRYPTED |RSA |EC )?PRIVATE KEY-----\r?\n[A-Za-z0-9+/=]{32,}|(?:github_pat_|ghp_|sk-proj-)[A-Za-z0-9_-]{16,}/.test(text))throw new Error();
    rows.push({source:entry.source,path:entry.destination,bytes,sha256:createHash('sha256').update(bytes).digest('hex')});
  }
  if(!destinations.has('license')||!destinations.has('agents.md')||!destinations.has('package.json'))throw new Error();
  mkdirSync(output,{mode:0o700});
  for(const row of rows){const target=join(output,row.path);mkdirSync(dirname(target),{recursive:true,mode:0o700});writeFileSync(target,row.bytes,{flag:'wx',mode:0o600});}
  writeFileSync(join(output,'SNAPSHOT.json'),JSON.stringify({format_version:1,source_sha:sha,qualified:false,fixture:values['allow-dirty-fixture'],files:rows.map(({source,path,sha256})=>({source,path,sha256}))},null,2)+'\n',{flag:'wx',mode:0o600});
  process.stdout.write(JSON.stringify({format_version:1,phase:'snapshot_prepared',source_sha:sha,files:rows.length,qualified:false,fixture:values['allow-dirty-fixture']})+'\n');
}catch{process.stderr.write('{"format_version":1,"error_code":"public_snapshot_failed"}\n');process.exitCode=1;}
