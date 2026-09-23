import puppeteer from 'puppeteer-extra'
import StealthPlugin from 'puppeteer-extra-plugin-stealth'
import laodengPlugin from './ext/laodeng.mjs'
import { blockNavigation } from './ext/block-navigation.mjs'
import { sleep } from './ext/sleep.mjs'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

puppeteer.use(StealthPlugin())
puppeteer.use(laodengPlugin())

const CHROME_EXE = process.env.CHROME_PATH ||
  (process.platform === 'darwin'
    ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
    : 'C:/Program Files/Google/Chrome/Application/chrome.exe')

const LOGIN_URL = 'https://www.zhipin.com/web/user/'
const HOME_URL = 'https://www.zhipin.com/'

function parseArgs() {
  const argv = process.argv.slice(2)
  const args = {}
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i]
    const v = argv[i + 1]
    if (k === '--timeout') { args.timeout = parseInt(v, 10) * 1000; i++ }
    else if (k === '--cookies') { args.cookiesPath = v; i++ }
    else if (k === '--headless') { args.headless = true }
  }
  return args
}

async function main() {
  const { timeout = 300 * 1000, cookiesPath, headless = false } = parseArgs()

  if (!fs.existsSync(CHROME_EXE)) {
    console.error('CHROME_NOT_FOUND:' + CHROME_EXE)
    process.exit(2)
  }

  const browser = await puppeteer.launch({
    headless,
    executablePath: CHROME_EXE,
    pipe: true,
    args: [
      '--disable-blink-features=AutomationControlled',
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--lang=zh-CN',
      '--window-size=1360,900',
    ],
    defaultViewport: { width: 1360, height: 860 },
  })

  const [page] = await browser.pages()

  let loginDone = false      // 登录成功
  let userClosed = false     // 用户关闭了浏览器窗口

  page.once('close', () => {
    userClosed = true
    console.log('BROWSER_CLOSED_BY_USER')
  })

  // 阻止导航离开 zhipin 域（防风控跳走 / 登录页被重定向）
  await blockNavigation(page, (req) => !req.url().startsWith('https://www.zhipin.com'))

  // 登录成功判定：监听 BOSS 后端登录 API 响应
  const loginSuccessWatcher = Promise.race([
    page.waitForResponse((r) => r.url().startsWith('https://www.zhipin.com/wapi/zppassport/qrcode/loginConfirm'), { timeout: 0 }),
    page.waitForResponse((r) => r.url().startsWith('https://www.zhipin.com/wapi/zppassport/qrcode/dispatcher'), { timeout: 0 }),
    page.waitForResponse((r) => r.url().startsWith('https://www.zhipin.com/wapi/zppassport/login/phoneV2'), { timeout: 0 }),
  ])

  // 打开登录页（停留等待扫码，不自动关闭）
  console.log('OPENING_LOGIN_PAGE:' + LOGIN_URL)
  console.log('STATUS:waiting_scan')
  try {
    await page.goto(LOGIN_URL, { waitUntil: 'networkidle2', timeout: 60000 })
  } catch (e) {
    // networkidle2 可能因持续请求触发，忽略，页面通常已加载
    console.log('GOTO_WARN:' + e.message.split('\n')[0])
  }

  // --- 等待登录成功 / 用户关窗 / 超时 ---
  const deadline = Date.now() + timeout
  while (!loginDone && !userClosed) {
    const remaining = deadline - Date.now()
    if (remaining <= 0) break

    // 兜底：URL 离开登录页(登录成功通常跳转) 视为登录成功
    try {
      const cur = page.url()
      if (!cur.includes('/web/user/') && cur !== LOGIN_URL && cur.startsWith('https://www.zhipin.com')) {
        loginDone = true
        console.log('LOGIN_DETECTED_BY_URL:' + cur)
        break
      }
    } catch (e) {}

    const result = await Promise.race([
      loginSuccessWatcher.then(() => 'success'),
      new Promise((resolve) => {
        const t = setInterval(() => {
          if (userClosed) { clearInterval(t); resolve('closed') }
        }, 200)
        // 兜底：若到此 while 已不满足，由外层 break
      }),
      sleep(remaining).then(() => 'timeout'),
    ])

    if (result === 'success') { loginDone = true; break }
    if (result === 'closed') break
  }

  if (loginDone) {
    await sleep(2000)
    // 导航回首页触发 getUserInfo 确认登录，顺便让 cookie 达到完整状态
    try {
      await page.goto(HOME_URL, { waitUntil: 'networkidle2', timeout: 30000 })
    } catch (e) { /* security-check 等，忽略 */ }
    await sleep(2000)

    const cookies = await page.cookies()
    if (cookiesPath) {
      fs.mkdirSync(path.dirname(cookiesPath), { recursive: true })
      fs.writeFileSync(cookiesPath, JSON.stringify(cookies, null, 2))
    }
    console.log('LOGIN_SUCCESS')
    console.log('COOKIES_WRITTEN:' + (cookiesPath || 'none'))

    // 同时保存 localStorage（BOSS 可能用其校验登录），写入同目录 boss-storage.json
    try {
      const storageJson = await page.evaluate(() => JSON.stringify(window.localStorage))
      const storagePath = cookiesPath
        ? path.join(path.dirname(cookiesPath), 'boss-storage.json')
        : path.join(__dirname, 'boss-storage.json')
      fs.mkdirSync(path.dirname(storagePath), { recursive: true })
      fs.writeFileSync(storagePath, storageJson, 'utf-8')
      console.log('STORAGE_WRITTEN:' + storagePath)
    } catch (e) {
      console.log('STORAGE_WARN:' + e.message.split('\n')[0])
    }

    // cookie 已入库，关闭浏览器
    await browser.close()
  } else {
    if (!userClosed) {
      await browser.close()
      console.log('LOGIN_TIMEOUT')
    } else {
      console.log('LOGIN_ABORTED_BY_USER')
    }
  }
}

main().catch((err) => {
  console.error('FATAL:' + (err.stack || err.message))
  try { process.exit(1) } catch (e) {}
})
