const fs=require('node:fs'),path=require('node:path'),{spawnSync}=require('node:child_process');
const {VERSIONS}=require('./inject.cjs'),root=path.resolve(__dirname,'../..'),folder=path.join(root,'.qa/physics-vendors');
fs.mkdirSync(folder,{recursive:true});
// Dependencies belong to the ignored experiment folder, never the production app.
const args=['install','--prefix',folder,'--no-audit','--no-fund','--save-exact','matter-js@'+VERSIONS.matter,'@dimforge/rapier2d-compat@'+VERSIONS.rapier];
const npmCli=path.join(path.dirname(process.execPath),'node_modules/npm/bin/npm-cli.js');
if(process.platform==='win32'&&!fs.existsSync(npmCli))throw Error('Run this setup with a Node installation that includes npm.');
const result=process.platform==='win32'
  ?spawnSync(process.execPath,[npmCli,...args],{cwd:root,stdio:'inherit'})
  :spawnSync('npm',args,{cwd:root,stdio:'inherit'});
if(result.error)throw result.error;process.exitCode=result.status??1;
