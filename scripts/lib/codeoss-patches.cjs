/* SPDX-License-Identifier: GPL-3.0-or-later */
'use strict';

function replaceOne(source, expression, replacement, name) {
  const matches = [...source.matchAll(new RegExp(expression.source, 'g'))];
  if (matches.length !== 1)
    throw new Error(`Code-OSS ${name}: expected one anchor, found ${matches.length}`);
  return source.replace(expression, replacement);
}

/** Keep the upstream desktop services; change only the shell ownership and bootstrap. */
function patchDesktopMain(source) {
  let result = replaceOne(
    source,
    /this\._win=new ([\w$]+)\.BrowserWindow\(([\w$]+)\),([\w$]+)\("code\/didCreateCodeBrowserWindow"\)/,
    'this._win=globalThis.__cibypWorkbenchHost.createWindow($2,this),$3("code/didCreateCodeBrowserWindow")',
    'window factory',
  );
  result = replaceOne(
    result,
    /([\w$]+)=new ([\w$]+),\1\.main\(\)/,
    '$1=new $2,globalThis.__cibypWorkbenchHost.deferStart(()=> $1.main())',
    'deferred startup',
  );
  result = replaceOne(
    result,
    /[\w$]+\.setPath\("userData",([\w$]+)\)/,
    'globalThis.__cibypWorkbenchHost.setUserData($1)',
    'user data isolation',
  );
  result = replaceOne(
    result,
    /[\w$]+\.once\("ready",function\(/,
    'globalThis.__cibypWorkbenchHost.onReady(function(',
    'ready lifecycle',
  );
  result = replaceOne(
    result,
    /[\w$]+\.registerSchemesAsPrivileged\(/,
    'globalThis.__cibypWorkbenchHost.registerSchemes(',
    'protocol registration',
  );
  result = replaceOne(
    result,
    /[\w$]+\.join\([\w$]+\.homedir\(\),[\w$]+,"argv.json"\)/,
    'globalThis.__cibypWorkbenchHost.argvFile()',
    'startup configuration isolation',
  );
  result = result.replace(
    /[\w$]+\.enableSandbox\(\)/g,
    'globalThis.__cibypWorkbenchHost.enableSandbox()',
  );
  result = replaceOne(
    result,
    /process\.chdir\(([\w$]+)\.dirname\(process\.execPath\)\)/,
    'globalThis.__cibypWorkbenchHost.preserveWorkingDirectory()',
    'working directory isolation',
  );
  result = replaceOne(
    result,
    /const\{defaultSession:([\w$]+)\}=[\w$]+;/,
    'const $1=globalThis.__cibypWorkbenchHost.session();',
    'resource protocol session',
  );
  result = result.replace(/[\w$]+\.defaultSession/g, 'globalThis.__cibypWorkbenchHost.session()');
  result = replaceOne(
    result,
    /getWindowByWebContents\(([\w$]+)\)\{const ([\w$]+)=([\w$]+)\.fromWebContents\(\1\);if\(!\2\)return;/,
    'getWindowByWebContents($1){const $2=globalThis.__cibypWorkbenchHost.ownerFor($1)||$3.fromWebContents($1);if(!$2)return;',
    'embedded window lookup',
  );
  result = replaceOne(
    result,
    /updateConfiguration\(([\w$]+),([\w$]+)\)\{const ([\w$]+)=\(this\._config\?\?this\.pendingLoadConfig\)\?\.userEnv;/,
    'updateConfiguration($1,$2){globalThis.__cibypWorkbenchHost.scopeWindowEnvironment($1,this._win);const $3=(this._config??this.pendingLoadConfig)?.userEnv;',
    'extension bridge window ownership',
  );
  result = replaceOne(
    result,
    /updateSystemColorTheme\(\)\{if\([\w$]+\|\|this\.isAutoDetectColorScheme\(\)\)[\s\S]+?\}getColorScheme\(\)\{/,
    'updateSystemColorTheme(){}getColorScheme(){',
    'native theme ownership',
  );
  result = replaceOne(
    result,
    /this\.windowCounter===0&&\(![\w$]+\|\|this\._quitRequested\)&&this\.fireOnWillShutdown\(1\)/,
    'this.windowCounter===0&&this._quitRequested&&this.fireOnWillShutdown(1)',
    'embedded window close lifecycle',
  );
  result = replaceOne(
    result,
    /[\w$]+&&this\.windowCounter===0&&this\.fireOnWillShutdown\(1\)/,
    'this.windowCounter===0&&this.fireOnWillShutdown(1)',
    'outer application quit lifecycle',
  );
  // RequestStore cancels its timeout after a successful reply. Handle that rejection.
  result = replaceOne(
    result,
    /([\w$]+\(this\._timeout,[\w$]+\.token\)\.then\(\(\)=>[\w$]+\(`Request \$\{[\w$]+\} timed out \(\$\{this\._timeout\}ms\)`\))\)/,
    '$1,()=>{})',
    'PTY timeout cancellation',
  );
  return result.replaceAll('process.argv', 'globalThis.__cibypWorkbenchHost.argv()');
}

module.exports = { patchDesktopMain, replaceOne };

/** Apply managed appearance in memory, above workspace settings, without editing projects. */
function patchDesktopWorkbench(source) {
  return replaceOne(
    source,
    /async initialize\(([\w$]+)\)\{const ([\w$]+)=this\.environmentService\.extensionDevelopmentLocationURI,/,
    `async initialize($1){globalThis.__cibypApplyAppearance=async data=>{
      const current=this.configurationService.getValue("workbench.colorCustomizations")||{};
      const colors={...current,...data.colors};
      for(const [key,value] of Object.entries(colors))if(key.startsWith("[")&&value&&typeof value==="object"){
        colors[key]={...value,...data.colors};
      }
      for(const [key,value] of Object.entries({
        "workbench.colorCustomizations":colors,
        "window.autoDetectColorScheme":false,
        "window.autoDetectHighContrast":false,
        "workbench.colorTheme":data.dark?"Dark Modern":"Light Modern",
        "workbench.reduceMotion":data.animations?"auto":"on"
      }))await this.configurationService.updateValue(key,value,8);
    };if(globalThis.__cibypAppearance)await globalThis.__cibypApplyAppearance(globalThis.__cibypAppearance);
    const $2=this.environmentService.extensionDevelopmentLocationURI,`,
    'managed workbench appearance',
  );
}
module.exports.patchDesktopWorkbench = patchDesktopWorkbench;
