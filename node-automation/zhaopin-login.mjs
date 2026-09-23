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

const LOGIN_URL = 'https://passport.zhaopin.com/login'
const MY_URL = 'https://www.zhaopin.com/my/to498'

function parseArgs() {
  const argv = process.argv.slice(2)
  const args = {}
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i]; const v = argv[i + 1]
    if (k === '--timeout') { args.timeout = parseInt(v, 10) * 1000; i++ }
    else if (k === '--cookies') { args.cookiesPath = v; i++ }
    else if (k === '--headless') { args.headless = true }
  }
  return args
}

async function main() {
  const { timeout = 300 * 1000, cookiesPath } = parseArgs()

  if (!fs.existsSync(CHROME_EXE)) {
    console.error('CHROME_NOT_FOUND:' + CHROME_EXE)
    process.exit(2)
  }

  const browser = await puppeteer.launch({
    headless: false,
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

  let userClosed = false
  page.once('close', () => { userClosed = true; console.log('BROWSER_CLOSED_BY_USER') })

  await blockNavigation(page, (req) =>
    !req.url().startsWith('https://www.zhaopin.com') &&
    !req.url().startsWith('https://passport.zhaopin.com') &&
    !req.url().startsWith('https://i.zhaopin.com')
  )

  console.log('OPENING_LOGIN_PAGE:' + LOGIN_URL)
  console.log('STATUS:waiting_scan')
  try {
    await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 60000 })
  } catch (e) { console.log('GOTO_WARN:' + e.message.split('\n')[0]) }

  // 等待登录：循环检查 URL 是否离开 passport 域（登录成功后通常跳转到 zhaopin 主站）
  const deadline = Date.now() + timeout
  let loggedIn = false
  while (!loggedIn && !userClosed && Date.now() < deadline) {
    await sleep(2500)
    try {
      const url = page.url()
      const onPassport = url.includes('passport.zhaopin.com') || url.includes('/login')
      if (!onPassport) {
        // 离开登录页，导航到个人中心验证
        await sleep(1500)
        try {
          await page.goto(MY_URL, { waitUntil: 'domcontentloaded', timeout: 20000 })
        } catch (e) { console.log('MY_GOTO_WARN:' + e.message.split('\n')[0]) }
        await sleep(2500)
        const afterUrl = page.url()
        if (afterUrl.includes('/my/') || afterUrl.includes('i.zhaopin.com')) {
          loggedIn = true
          console.log('LOGGED_IN_URL:' + afterUrl)
        } else if (afterUrl.includes('passport') || afterUrl.includes('/login')) {
          // 仍要求登录，回到登录页
          try { await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 20000 }) } catch (e) {}
          console.log('STILL_NOT_LOGGED_IN')
        }
      }
    } catch (e) {
      console.log('CHECK_WARN:' + e.message.split('\n')[0])
    }
  }

  if (loggedIn) {
    await sleep(2000)
    const cookies = await page.cookies()
    if (cookiesPath) {
      fs.mkdirSync(path.dirname(cookiesPath), { recursive: true })
      fs.writeFileSync(cookiesPath, JSON.stringify(cookies, null, 2))
    }
    console.log('LOGIN_SUCCESS')
    console.log('COOKIES_WRITTEN:' + (cookiesPath || 'none'))
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
