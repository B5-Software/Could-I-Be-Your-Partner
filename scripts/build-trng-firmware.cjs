/* SPDX-License-Identifier: GPL-3.0-or-later */
'use strict';
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto');
const {spawnSync,execFileSync}=require('node:child_process');
const root=path.resolve(__dirname,'..'), project=path.join(root,'IoT-Firmware/CIBYP-TRNG');
const chips={esp32c3:'riscv32imac-unknown-none-elf',esp32c6:'riscv32imac-unknown-none-elf',esp32s31:'riscv32imafc-unknown-none-elf'};
const sha=(bytes)=>crypto.createHash('sha256').update(bytes).digest('hex');
function sources() {
  require('./build-trng-catalog.cjs').catalog(true);
  const files=['CMakeLists.txt','sdkconfig.defaults','sdkconfig.usb','partitions.csv','main/CMakeLists.txt','main/Kconfig.projbuild','main/port.c','main/network.c','main/network.h','main/tarot_art_digest.h','web/index.html','web/app.css','web/app.js','web/catalog.json','web/deck.json','web/question-seed-source.js','web/question-seed.js','web/question-seed.LICENSE','rust/Cargo.toml','rust/Cargo.lock','rust/core/Cargo.toml','rust/core/src/lib.rs','rust/core/src/catalog.rs','rust/ffi/Cargo.toml','rust/ffi/src/lib.rs'];
  return sha(files.map(file=>file+'\0'+fs.readFileSync(path.join(project,file))).join('\0'));
}
function run(binary,args,options={}) {const result=spawnSync(binary,args,{stdio:'inherit',windowsHide:true,...options});if(result.status!==0) throw Error('TRNG_BUILD_FAILED: '+path.basename(binary));}
function build(chip,consoleMode='uart') {
  require('./check-tarot-art.cjs').verify();
  require('./build-trng-webcrypto.cjs').bundle(true);
  if(!chips[chip]||!['uart','usb'].includes(consoleMode)) throw Error('Use esp32c3|esp32c6|esp32s31 and uart|usb');
  const idf=path.resolve(process.env.CIBYP_ESP_IDF||path.join(root,'.cache/esp-idf-v6.1'));
  const sourceDigest=sources();
  const python=process.env.CIBYP_IDF_PYTHON||path.join(root,'.cache/idf6.1-env',process.platform==='win32'?'Scripts/python.exe':'bin/python');
  if(!fs.existsSync(python)) throw Error('Create the IDF 6.1 Python environment first; see the firmware README');
  const revision=execFileSync('git',['-C',idf,'rev-parse','HEAD'],{encoding:'utf8',windowsHide:true}).trim();
  const tag=execFileSync('git',['-C',idf,'describe','--tags','--exact-match'],{encoding:'utf8',windowsHide:true}).trim();
  if(tag!=='v6.1') throw Error('TRNG_REQUIRES_PINNED_IDF_6_1');
  let env={...process.env,PYTHONUTF8:'1',ESP_IDF_VERSION:'6.1.0',IDF_PATH:idf,IDF_TOOLS_PATH:process.env.IDF_TOOLS_PATH||path.join(os.homedir(),'.espressif'),IDF_PYTHON_ENV_PATH:path.dirname(path.dirname(python))};
  // Use the SDK's pinned build tools. Debuggers/clangd are not needed to build
  // firmware and are deliberately not installed into the user's global SDK.
  const tools=JSON.parse(fs.readFileSync(path.join(idf,'tools/tools.json'),'utf8')).tools;
  const toolPaths=[];
  for(const name of ['riscv32-esp-elf','cmake','ninja','esp-rom-elfs']) {
    const tool=tools.find(item=>item.name===name),version=tool.versions.find(item=>item.status==='recommended').name;
    const base=path.join(env.IDF_TOOLS_PATH,'tools',name,version);
    for(const entry of tool.export_paths) {const location=path.join(base,...entry);if(!fs.existsSync(location))throw Error('Install IDF build tool '+name+' '+version);toolPaths.push(location);}
    if(name==='esp-rom-elfs')env.ESP_ROM_ELF_DIR=base;
  }
  const inheritedPath=env.PATH||env.Path||'';delete env.Path;
  env.PATH=[path.dirname(python),path.join(idf,'tools'),...toolPaths,inheritedPath].join(path.delimiter);
  const cargo=process.env.CIBYP_CARGO||'cargo';
  const rustOut=path.join(root,'.cache/trng-rust');
  run(cargo,['+1.99.1','build','--manifest-path',path.join(project,'rust/Cargo.toml'),'--locked','--release','--package','cibyp-trng-ffi','--target',chips[chip],'--target-dir',rustOut],{env});
  const library=path.join(rustOut,chips[chip],'release/libcibyp_trng_ffi.a');
  const output=path.join(root,'.cache/trng-build',chip+'-'+consoleMode);
  fs.mkdirSync(output,{recursive:true});
  const config=path.join(output,'sdkconfig');
  // This builder only produces the fixed, non-provisioning bundle profile.
  // Never reuse an edited or previously hardened generated sdkconfig.
  fs.rmSync(config,{force:true});
  const defaults=[path.join(project,'sdkconfig.defaults'),...(consoleMode==='usb'?[path.join(project,'sdkconfig.usb')]:[])].join(';');
  run(python,[path.join(idf,'tools/idf.py'),'-C',project,'-B',output,'-D','IDF_TARGET='+chip,'-D','SDKCONFIG='+config,'-D','SDKCONFIG_DEFAULTS='+defaults,'-D','CIBYP_RUST_LIBRARY='+library,'-D','CIBYP_TAROT_ARCHIVE='+path.join(root,'assets/trng-firmware/tarot-art.bin'),'build'],{env});
  const actual=fs.readFileSync(config,'utf8');
  if(/^CONFIG_(?:SECURE_BOOT|SECURE_FLASH_ENC_ENABLED|BOOTLOADER_APP_ANTI_ROLLBACK)=y$/m.test(actual))throw Error('BUNDLED_FIRMWARE_MUST_NOT_PROVISION_EFUSES');
  const args=JSON.parse(fs.readFileSync(path.join(output,'flasher_args.json'),'utf8'));
  if(sources()!==sourceDigest)throw Error('Firmware sources changed during build; rebuild before publishing');
  const base=path.join(root,'assets/trng-firmware'), destination=path.join(base,chip+'-'+consoleMode);
  fs.mkdirSync(destination,{recursive:true});
  const segments=Object.entries(args.flash_files).map(([address,file])=>{
    const bytes=fs.readFileSync(path.resolve(output,file)), name=path.basename(file);
    fs.writeFileSync(path.join(destination,name),bytes);
    return{file:chip+'-'+consoleMode+'/'+name,address:Number(address),size:bytes.length,sha256:sha(bytes)};
  });
  const manifestFile=path.join(base,'manifest.json');
  const manifest=fs.existsSync(manifestFile)?JSON.parse(fs.readFileSync(manifestFile,'utf8')):{version:1,firmwareVersion:'2.0.0',protocol:2,images:[]};
  const id=chip+'-'+consoleMode;
  manifest.images=manifest.images.filter(image=>image.id!==id);
  manifest.images.push({id,chip,console:consoleMode,profile:'development',walletEntropy:false,experimental:chip==='esp32s31',idf:{tag,revision},rust:'1.99.1',sourceSha256:sourceDigest,flashSize:'4MB',segments});
  manifest.images.sort((a,b)=>a.id.localeCompare(b.id));
  fs.writeFileSync(manifestFile,JSON.stringify(manifest,null,2)+'\n');
  console.log('TRNG image verified and bundled: '+id);
}
if(require.main===module)try{build(process.argv[2]||'esp32c6',process.argv[3]||'uart');}catch(error){console.error(error.message);process.exitCode=1;}
module.exports={sources,build};
