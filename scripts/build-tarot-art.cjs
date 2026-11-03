/* SPDX-License-Identifier: GPL-3.0-or-later */
'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const sharp=require('sharp');
const root=path.resolve(__dirname,'..'),folder=path.join(root,'artwork/tarot');
const PARTITION_SIZE=0x1e0000,DATA_OFFSET=4096,ENTRY_SIZE=48,MAX_CARD=22400;
const hash=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
function write(file,bytes) {fs.mkdirSync(path.dirname(file),{recursive:true});if(!fs.existsSync(file)||!fs.readFileSync(file).equals(Buffer.from(bytes)))fs.writeFileSync(file,bytes);}
async function build({preview=false}={}) {
  const jobs=JSON.parse(fs.readFileSync(path.join(folder,'prompts.json'),'utf8')).jobs;
  const missing=jobs.filter(job=>!fs.existsSync(path.join(folder,'originals',job.file)));
  if(missing.length&&!preview)throw Error('TAROT_ART_INCOMPLETE: '+missing.map(job=>job.id).join(','));
  const desktop=path.join(root,'src/renderer/assets/tarot'),firmware=path.join(root,'IoT-Firmware/CIBYP-TRNG/web/cards');
  const entries=[];
  for(const job of jobs) {
    const original=path.join(folder,'originals',job.file);if(!fs.existsSync(original))continue;
    const stat=fs.statSync(original);if(stat.size>16*1024*1024)throw Error('TAROT_ORIGINAL_TOO_LARGE: '+job.id);
    const source=fs.readFileSync(original),meta=await sharp(source).metadata();
    if(meta.width*3!==meta.height*2||meta.width<512||meta.height<768)throw Error('TAROT_ASPECT_OR_SIZE: '+job.id);
    const full=await sharp(source).resize(512,768,{fit:'cover'}).webp({quality:82,effort:6}).toBuffer();
    let small,quality=68;
    for(;quality>=36;quality-=4) {small=await sharp(source).resize(224,336,{fit:'cover'}).webp({quality,effort:6}).toBuffer();if(small.length<=MAX_CARD)break;}
    if(small.length>MAX_CARD)throw Error('TAROT_CARD_BUDGET_EXCEEDED: '+job.id);
    const name=String(job.id).padStart(2,'0')+'.webp';write(path.join(desktop,name),full);write(path.join(firmware,name),small);
    entries.push({id:job.id,name:job.name,nameEn:job.nameEn,file:name,sourceSha256:hash(source),desktop:{width:512,height:768,bytes:full.length,sha256:hash(full)},firmware:{width:224,height:336,quality,bytes:small.length,sha256:hash(small)}});
  }
  const version=hash(Buffer.from(entries.map(entry=>entry.id+':'+entry.firmware.sha256).join('\n')));
  const manifest={version:1,deckId:version,complete:missing.length===0,images:entries};
  write(path.join(desktop,'manifest.json'),JSON.stringify(manifest,null,2)+'\n');
  write(path.join(root,'IoT-Firmware/CIBYP-TRNG/web/deck.json'),JSON.stringify({version:1,deckId:version,complete:missing.length===0,images:entries.map(entry=>({id:entry.id,file:entry.file,sha256:entry.firmware.sha256}))})+'\n');
  if(missing.length)return {preview:true,images:entries.length,missing:missing.map(job=>job.id)};
  const archive=Buffer.alloc(PARTITION_SIZE,0xff);archive.write('CIBYPTA1',0,'ascii');archive.writeUInt32LE(78,8);archive.writeUInt32LE(DATA_OFFSET,12);archive.fill(0,16,DATA_OFFSET);
  let offset=DATA_OFFSET;
  for(const entry of entries) {
    const index=64+entry.id*ENTRY_SIZE,bytes=fs.readFileSync(path.join(firmware,entry.file));
    if(offset+bytes.length>archive.length)throw Error('TAROT_ARCHIVE_BUDGET_EXCEEDED');
    archive.writeUInt16LE(entry.id,index);archive.writeUInt16LE(224,index+2);archive.writeUInt16LE(336,index+4);archive.writeUInt16LE(1,index+6);
    archive.writeUInt32LE(offset,index+8);archive.writeUInt32LE(bytes.length,index+12);Buffer.from(entry.firmware.sha256,'hex').copy(archive,index+16);bytes.copy(archive,offset);offset=(offset+bytes.length+3)&~3;
  }
  crypto.createHash('sha256').update(archive.subarray(64,64+78*ENTRY_SIZE)).digest().copy(archive,16);
  const digest=hash(archive);
  write(path.join(root,'assets/trng-firmware/tarot-art.bin'),archive);
  write(path.join(root,'IoT-Firmware/CIBYP-TRNG/main/tarot_art_digest.h'),'/* Generated from all 78 original illustrations. */\n#pragma once\nstatic const unsigned char CIBYP_TAROT_ART_SHA256[32]={'+Array.from(Buffer.from(digest,'hex')).map(v=>'0x'+v.toString(16).padStart(2,'0')).join(',')+'};\n');
  write(path.join(folder,'manifest.json'),JSON.stringify({...manifest,archive:{file:'assets/trng-firmware/tarot-art.bin',bytes:archive.length,usedBytes:offset,sha256:digest}},null,2)+'\n');
  return {images:entries.length,desktopBytes:entries.reduce((sum,e)=>sum+e.desktop.bytes,0),firmwareBytes:offset,partitionBytes:archive.length,sha256:digest};
}
if(require.main===module)build({preview:process.argv.includes('--preview')}).then(result=>console.log(JSON.stringify(result))).catch(error=>{console.error(error.message);process.exitCode=1;});
module.exports={build,PARTITION_SIZE,DATA_OFFSET,ENTRY_SIZE,MAX_CARD};
