const net=require('node:net');
const host='play.simpfun.cn',port=32101,user=process.argv[2]||'CodexBot';
function vi(n){const a=[];do{let b=n&127;n=Math.floor(n/128);if(n)b|=128;a.push(b)}while(n);return Buffer.from(a)}
function packet(p){return Buffer.concat([vi(p.length),p])}
function str(s){const b=Buffer.from(s);return Buffer.concat([vi(b.length),b])}
const h=Buffer.from(host);const hs=packet(Buffer.concat([vi(0),vi(47),str(host),Buffer.from([port>>8,port&255]),vi(2)]));
const ls=packet(Buffer.concat([vi(0),str(user)]));
const s=net.createConnection({host,port},()=>{console.log('connected');s.write(hs);s.write(ls)});let d=Buffer.alloc(0);const t=setTimeout(()=>{console.log('timeout',d.toString('hex').slice(0,500));s.destroy()},10000);
function readvi(b,o){let v=0,i=0,x;do{if(o+i>=b.length)return; x=b[o+i++];v|=(x&127)<<((i-1)*7)}while(x&128);return [v,o+i]}
s.on('data',c=>{d=Buffer.concat([d,c]);while(true){const l=readvi(d,0);if(!l||d.length<l[1]+l[0])return;const end=l[1]+l[0],id=readvi(d,l[1]); console.log('packet',id?.[0], 'len',l[0],d.subarray(0,end).toString('hex').slice(0,500)); if(id?.[0]===0){let p=id[1];const sl=readvi(d,p);if(sl){const text=d.subarray(sl[1],sl[1]+sl[0]).toString();console.log('text',text)}} d=d.subarray(end)}});
s.on('error',e=>{clearTimeout(t);console.log('error',e.message)});s.on('close',()=>{clearTimeout(t);console.log('closed')});
