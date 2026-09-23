const path = require('path');
const root = __dirname;
function tryReq(name) { try { require(name); return 'OK'; } catch(e){ return 'FAIL: '+e.message.split('\n')[0]; } }
console.log('puppeteer', tryReq('puppeteer'));
console.log('puppeteer-core', tryReq('puppeteer-core'));
console.log('puppeteer-extra', tryReq('puppeteer-extra'));
console.log('puppeteer-extra-plugin-stealth', tryReq('puppeteer-extra-plugin-stealth'));
console.log('laodeng', tryReq('./ext/laodeng.js'));
