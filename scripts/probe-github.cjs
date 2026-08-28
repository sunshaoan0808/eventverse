const dns = require('node:dns');
const net = require('node:net');
const fs = require('node:fs');

(async () => {
  const servers = ['223.5.5.5', '119.29.29.29', '8.8.8.8', '1.1.1.1'];
  let ips = [];
  for (const s of servers) {
    dns.setServers([s]);
    try {
      ips = await new Promise((res, rej) => dns.resolve4('github.com', (e, a) => e ? rej(e) : res(a)));
      console.log(`via ${s}:`, ips.join(','));
      if (ips.length) break;
    } catch (e) { console.log(`via ${s}: FAIL ${e.code ?? e.message}`); }
  }
  if (!ips.length) { console.log('all DNS failed'); process.exit(1); }
  const good = [];
  for (const ip of ips) {
    const r = await new Promise(res => {
      const s = net.connect(443, ip, () => { s.destroy(); res('OK'); });
      s.setTimeout(6000, () => { s.destroy(); res('TIMEOUT'); });
      s.on('error', e => { res('ERR:' + e.code); });
    });
    console.log('TCP 443', ip, r);
    if (r === 'OK') good.push(ip);
  }
  console.log('GOOD_IPS=' + good.join(','));
})();
