import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const root=fileURLToPath(new URL('../',import.meta.url));
const vite=fileURLToPath(new URL('../node_modules/vite/bin/vite.js',import.meta.url));
const build=spawn(process.execPath,[vite,'build'],{cwd:root,stdio:'inherit'});
build.on('exit',code=>{
  if(code!==0){process.exitCode=code||1;return;}
  const server=spawn(process.execPath,[vite,'preview','--host','127.0.0.1','--port','4173','--strictPort'],{cwd:root,stdio:'inherit'});
  console.log('AI showcase: http://127.0.0.1:4173/?showcase=1');
  console.log('Private phone access after Tailscale login: tailscale serve --bg 4173');
  server.on('exit',code=>process.exitCode=code||0);
});
