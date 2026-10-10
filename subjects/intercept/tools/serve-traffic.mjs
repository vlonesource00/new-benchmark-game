import { createServer } from 'node:http';
import { createReadStream,existsSync,statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const args=process.argv.slice(2),i=args.indexOf('--port'),port=i<0?4180:Number(args[i+1]),dir=fileURLToPath(new URL('../results/',import.meta.url));
if(!(Number.isInteger(port)&&port>0&&port<65536))throw Error('Invalid port');
createServer((request,response)=>{
 let name;try{name=decodeURIComponent(new URL(request.url,'http://localhost').pathname.slice(1));}catch{response.writeHead(400);return response.end();}
 if(!['GET','HEAD'].includes(request.method)){response.writeHead(405);return response.end();}
 if(!name)name='traffic-intercept-train-7.html';
 if(!/^[a-zA-Z0-9_-]+\.(html|json|csv)$/.test(name)||!existsSync(dir+name)||!statSync(dir+name).isFile()){response.writeHead(404);return response.end('Run the traffic matrix to generate this report.');}
 response.writeHead(200,{'Content-Type':name.endsWith('.html')?'text/html; charset=utf-8':name.endsWith('.json')?'application/json':'text/csv; charset=utf-8','Cache-Control':'no-store'});
 if(request.method==='HEAD')return response.end();createReadStream(dir+name).pipe(response);
}).listen(port,'127.0.0.1',()=>console.log(`Traffic replay: http://127.0.0.1:${port}/`));
