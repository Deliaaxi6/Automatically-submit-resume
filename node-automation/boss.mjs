import puppeteer from 'puppeteer-extra'
import StealthPlugin from 'puppeteer-extra-plugin-stealth'
import laodengPlugin from './ext/laodeng.mjs'
import { blockNavigation } from './ext/block-navigation.mjs'
import { sleep, sleepWithRandomDelay } from './ext/sleep.mjs'
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

const HOME_URL = 'https://www.zhipin.com/'
const LOGIN_URL = 'https://www.zhipin.com/web/user/'
const JOB_LIST_API = (u) => u.startsWith('https://www.zhipin.com/wapi/zpgeek/pc/recommend/job/list.json') ||
                             u.startsWith('https://www.zhipin.com/wapi/zpgeek/search/joblist.json')
const JOB_DETAIL_API = 'https://www.zhipin.com/wapi/zpgeek/job/detail.json'
const FRIEND_ADD_API = 'https://www.zhipin.com/wapi/zpgeek/friend/add.json'
const GET_USER_INFO = 'https://www.zhipin.com/wapi/zpuser/wap/getUserInfo.json'

function parseArgs() {
  const argv = process.argv.slice(2)
  const args = {}
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i]; const v = argv[i + 1]
    if (k === '--mode') { args.mode = v; i++ }
    else if (k === '--keyword') { args.keyword = v; i++ }
    else if (k === '--city') { args.city = v; i++ }
    else if (k === '--urls') { args.urls = v.replace(/;/g, ',').split(',').filter(Boolean); i++ }
    else if (k === '--max') { args.max = parseInt(v, 10); i++ }
    else if (k === '--cookies') { args.cookiesPath = v; i++ }
    else if (k === '--storage') { args.storagePath = v; i++ }
    else if (k === '--out') { args.out = v; i++ }
    else if (k === '--delay-min') { args.delayMin = parseFloat(v); i++ }
    else if (k === '--delay-max') { args.delayMax = parseFloat(v); i++ }
    else if (k === '--sf') { args.sf = v; i++ }
    else if (k === '--headless') { args.headless = true }
    else if (k === '--dry-run') { args.dryRun = true }
  }
  return args
}

function readCookies(cookiesPath) {
  if (!cookiesPath || !fs.existsSync(cookiesPath)) return []
  try { return JSON.parse(fs.readFileSync(cookiesPath, 'utf-8')) } catch (e) { return [] }
}

function readStorage(storagePath) {
  if (!storagePath || !fs.existsSync(storagePath)) return {}
  try { return JSON.parse(fs.readFileSync(storagePath, 'utf-8')) } catch (e) { return {} }
}

async function launch() {
  const profileDir = path.join(__dirname, 'chrome-profile-boss')
  fs.mkdirSync(profileDir, { recursive: true })
  return puppeteer.launch({
    headless: false,
    executablePath: CHROME_EXE,
    userDataDir: profileDir,
    pipe: true,
    ignoreHTTPSErrors: true,
    protocolTimeout: 20000,
    args: [
      '--disable-blink-features=AutomationControlled',
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--lang=zh-CN',
      '--window-size=1440,900',
    ],
    defaultViewport: { width: 1440, height: 860 },
  })
}

// 注入 localStorage 到 zhipin 域（参考项目：临时 page + 响应拦截）
async function injectStorage(browser, storageJson) {
  if (!storageJson || typeof storageJson !== 'object') return
  const page = await browser.newPage()
  await page.setRequestInterception(true)
  page.on('request', (r) => {
    r.respond({ status: 200, contentType: 'text/plain', body: ':)', headers: { 'Access-Control-Allow-Origin': '*' } })
  })
  try {
    await page.goto('https://www.zhipin.com/desktop/', { waitUntil: 'domcontentloaded', timeout: 10000 })
  } catch (e) {}
  try {
    await page.evaluate((kv) => {
      Object.keys(kv).forEach((k) => { try { localStorage.setItem(k, kv[k]) } catch (e) {} })
    }, storageJson)
    console.log('STORAGE_INJECTED')
  } catch (e) { console.log('STORAGE_INJECT_WARN:' + e.message.split('\n')[0]) }
  await page.close().catch(() => {})
}

// 验证登录：注入 cookie + 真实 API 校验。
// 优先用 Node 侧 fetch 直连（带完整 Cookie 头），不依赖浏览器主线程渲染，
// 避免 page.evaluate 协议超时被误判为"未登录"；evaluate 仅作兼容回退。
async function ensureLoggedIn(browser, page, cookies, storageJson) {
  try {
    await page.setCookie(...cookies.map((c) => ({ ...c, sameSite: c.sameSite && c.sameSite !== 'None' ? c.sameSite : 'unspecified' })))
  } catch (e) { console.log('SET_COOKIE_WARN:' + e.message.split('\n')[0]) }
  await injectStorage(browser, storageJson)
  console.log('COOKIE_SET_OK')

  // 首次尝试：Node 侧 fetch。cookie 缺失时返回 code -1（未登录），不阻塞页面。
  if (cookies.length) {
    try {
      const header = cookies.map((c) => c.name + '=' + c.value).join('; ')
      const ac = new AbortController()
      const to = setTimeout(() => ac.abort(), 15000)
      const r = await fetch(GET_USER_INFO, {
        headers: { cookie: header, referer: 'https://www.zhipin.com/', 'user-agent': navigatorUserAgent() },
        signal: ac.signal,
      })
      clearTimeout(to)
      const j = await r.json()
      const info = j && j.zpData ? j.zpData : {}
      const logged = j && j.code === 0
      console.log('USER_INFO_CHECK code=' + (j ? j.code : -1) + ' user=' + (info.name || '') + ' -> ' + (logged ? 'LOGIN_OK' : 'LOGIN_INVALID') + ' src=node_fetch')
      if (logged) return true
    } catch (e) {
      console.log('USER_INFO_CHECK_WARN:' + e.message.split('\n')[0] + ' src=node_fetch')
    }
  }

  // 回退：page.evaluate（强调稳妥，不用作主判据；超时按未登录处理）
  try {
    await page.goto(HOME_URL, { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {})
    await sleep(1500)
    const info = await page.evaluate(async (api) => {
      try {
        const r = await fetch(api, { credentials: 'include' })
        const j = await r.json()
        return { code: j && typeof j.code === 'number' ? j.code : -1, name: (j.zpData && j.zpData.name) || '' }
      } catch (e) { return { code: -1, name: '' } }
    }, GET_USER_INFO)
    const logged = info.code === 0
    console.log('USER_INFO_CHECK code=' + info.code + ' user=' + info.name + ' -> ' + (logged ? 'LOGIN_OK' : 'LOGIN_INVALID') + ' src=evaluate')
    return logged
  } catch (e) {
    console.log('USER_INFO_CHECK_WARN:' + e.message.split('\n')[0] + ' src=evaluate')
    return false
  }
}

function navigatorUserAgent() {
  return 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
}

function sleepBetween(delayMin, delayMax) {
  return sleep((delayMin + Math.random() * (delayMax - delayMin)) * 1000)
}

// 解析薪资字符串，返回最低月薪（元/月）
// "15-25K" → 15000，"15-20K·15薪" → 15000×15/12=18750，"面议" → 0
function parseMinSalary(salaryDesc) {
  if (!salaryDesc || salaryDesc === '面议') return 0
  const m = salaryDesc.match(/([\d.]+)\s*[-~]\s*([\d.]+)\s*[Kk万]/)
  if (!m) {
    const m2 = salaryDesc.match(/([\d.]+)\s*[Kk万]/)
    if (!m2) return 0
    let min = parseFloat(m2[1])
    if (/万/.test(salaryDesc)) min *= 10000
    else if (/[Kk]/.test(salaryDesc)) min *= 1000
    const bonus = salaryDesc.match(/(\d+)薪/)
    if (bonus) min = min * parseInt(bonus[1], 10) / 12
    return Math.round(min)
  }
  let min = parseFloat(m[1])
  if (/万/.test(salaryDesc)) min *= 10000
  else if (/[Kk]/.test(salaryDesc)) min *= 1000
  const bonus = salaryDesc.match(/(\d+)薪/)
  if (bonus) min = min * parseInt(bonus[1], 10) / 12
  return Math.round(min)
}

// 判断详情是否可“立即沟通”
async function canStartChat(page) {
  const btn = await page.evaluate(() => {
    const el = document.querySelector('.job-detail-box .op-btn.op-btn-chat')
    return el ? el.innerText.trim() : null
  })
  return btn === '立即沟通'
}

async function startChatAndConfirm(page) {
  const btn = await page.$('.job-detail-box .op-btn.op-btn-chat')
  if (!btn) return { ok: false, reason: 'no_chat_btn' }

  // 先注册 friend/add.json 响应监听，再点击，避免响应先于监听器到达导致漏判
  const friendRespPromise = page.waitForResponse(
    (r) => r.url().startsWith(FRIEND_ADD_API),
    { timeout: 9000 }
  )

  await btn.click()
  await sleep(1200)

  // 等待 friend/add.json 响应或对话框出现；解析 code，非 0 视为触顶/风控
  let added = false
  let capCode = null
  try {
    const resp = await friendRespPromise
    let code = null
    try {
      const body = await resp.json()
      code = body && typeof body.code === 'number' ? body.code : null
    } catch (e) {}
    added = true
    if (typeof code === 'number' && code !== 0) {
      capCode = code
      console.log('CAP_REACHED:code=' + code)
    }
  } catch (e) { /* 可能弹对话框 */ }

  // 关闭打招呼对话框
  try {
    const cancel = await page.$('.greet-boss-dialog .greet-boss-footer .cancel-btn')
    if (cancel) await cancel.click()
  } catch (e) {}

  // 处理“剩余沟通机会”确认弹窗
  try {
    const sure = await page.$('.chat-block-dialog .chat-block-footer .sure-btn')
    if (sure) await sure.click()
  } catch (e) {}

  if (capCode) return { ok: false, reason: 'cap_reached', code: capCode, added }
  return { ok: true, added }
}

async function handleDetail(page, job, results, dryRun, apiDetail) {
  let detail = job || {}
  // 优先使用 job/detail.json 响应数据（字段: jobName/salaryDesc/encryptId/brandName）
  if (apiDetail && (apiDetail.jobName || apiDetail.encryptId)) {
    detail = { ...detail, ...apiDetail }
  } else {
    // 从详情面板 DOM 读取职位名/薪资/公司
    try {
      const dom = await page.evaluate(() => {
        const q = (s) => { const el = document.querySelector(s); return el ? el.innerText.trim() : '' }
        let company = q('.boss-info-attr')
        if (company && company.includes('·')) company = company.split('·')[0].trim()
        return {
          jobName: q('.job-detail-box .job-name'),
          salaryDesc: q('.job-detail-box .job-salary'),
          brandName: company,
        }
      })
      detail = { ...detail, ...dom }
    } catch (e) {}
    if (!detail.jobName) {
      try {
        detail.jobName = await page.evaluate(() => {
          const el = document.querySelector('.job-detail-box h1, .job-detail-box .job-name')
          return el ? el.innerText.trim() : ''
        })
      } catch (e) {}
    }
  }

  const title = detail.jobName || detail.positionName || ''
  const company = detail.brandName || ''
  const salary = detail.salaryDesc || ''
  const detailUrl = detail.encryptId
    ? 'https://www.zhipin.com/job_detail/' + detail.encryptId + '.html'
    : (detail.url || (job && job.url) || '')

  if (dryRun) {
    results.preview++
    results.details.push({ title, company, salary, url: detailUrl, status: 'preview' })
    console.log('PREVIEW:' + title + ' @ ' + company + ' ' + salary)
    return { chat: false, preview: true }
  }

  const can = await canStartChat(page)
  if (!can) {
    results.skipped++
    results.details.push({ title, company: '', url: detailUrl, status: 'skipped_not_new' })
    return { chat: false }
  }

  const res = await startChatAndConfirm(page)
  if (res.ok) {
    results.success++
    results.details.push({ title, company, url: detailUrl, status: 'success' })
    console.log('APPLIED:' + title + ' @ ' + company)
  } else if (res.reason === 'cap_reached') {
    results.capReached = true
    results.failed++
    results.details.push({ title, company: '', url: detailUrl, status: 'cap_reached' })
    console.log('CAP_REACHED:' + title + ' @ ' + company + ' code=' + res.code)
    return { chat: false, capReached: true }
  } else {
    results.failed++
    results.details.push({ title, url: detailUrl, status: 'failed' })
  }
  return { chat: true }
}

async function modeSearch(page, args, results) {
  const SEARCH_BASE = 'https://www.zhipin.com/web/geek/jobs'
  const CITY_MAP = { '上海': '101020100', '北京': '101010100', '广州': '101280100', '深圳': '101280600', '杭州': '101210100' }

  // 构造搜索 URL
  // --sf 为纯数字（如 15000）时：不在 URL 传 salary，改为脚本内程序化过滤
  // --sf 为 Boss 薪资代码（如 1502）时：直接传 URL
  const params = new URLSearchParams()
  if (args.keyword) params.set('query', args.keyword)
  if (args.city) params.set('city', CITY_MAP[args.city] || args.city)
  const sfIsThreshold = args.sf && /^\d+$/.test(args.sf) && parseInt(args.sf, 10) >= 1000
  if (args.sf && !sfIsThreshold) params.set('salary', args.sf)

  const searchUrl = `${SEARCH_BASE}?${params.toString()}`
  console.log('SEARCH_URL:' + searchUrl)
  try {
    await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 45000 })
  } catch (e) {
    console.log('GOTO_WARN:' + e.message.split('\n')[0])
    try { await page.stopLoading() } catch (e2) {}
  }
  await sleep(4000)

  // 如果没有 sf 参数，保留原有搜索框输入逻辑
  if (args.keyword && !args.sf) {
    try {
      const box = await page.$('input.input[placeholder="搜索职位、公司"]') || await page.$('input.input')
      if (box) {
        await box.click()
        await box.type(args.keyword, { delay: 80 })
        await page.keyboard.press('Enter')
        await sleep(3000)
        console.log('SEARCH_KEYWORD:' + args.keyword)
      } else {
        console.log('NO_SEARCH_BOX')
      }
    } catch (e) { console.log('SEARCH_BOX_WARN:' + e.message.split('\n')[0]) }
  }

  // 列表保障：若列表为空，等待组件挂载；仍为空则模拟搜索框输入触发 joblist API
  let guaranteed = []
  try {
    guaranteed = await page.evaluate(() => document.querySelector('.page-jobs-main')?.__vue__?.jobList || [])
  } catch (e) { guaranteed = [] }
  if (!guaranteed.length) {
    for (let w = 0; w < 10; w++) {
      const mounted = await page.evaluate(() => !!document.querySelector('.page-jobs-main')).catch(() => false)
      if (mounted) break
      await sleep(2000)
    }
    console.log('MAIN_MOUNTED:' + await page.evaluate(() => !!document.querySelector('.page-jobs-main')).catch(() => false))
    try {
      guaranteed = await page.evaluate(() => document.querySelector('.page-jobs-main')?.__vue__?.jobList || [])
    } catch (e) { guaranteed = [] }
    if (!guaranteed.length && args.keyword) {
      try {
        const box = await page.$('input.input[placeholder="搜索职位、公司"]') || await page.$('input.input') || await page.$('input[placeholder]')
        if (box) {
          await box.click()
          await box.type(args.keyword, { delay: 60 })
          await page.keyboard.press('Enter')
          console.log('SEARCH_TRIGGERED:' + args.keyword)
        } else {
          console.log('NO_SEARCH_BOX')
        }
      } catch (e) { console.log('SEARCH_TRIGGER_WARN:' + e.message.split('\n')[0]) }
      await sleep(3000)
      for (let w = 0; w < 5 && !guaranteed.length; w++) {
        try {
          guaranteed = await page.evaluate(() => document.querySelector('.page-jobs-main')?.__vue__?.jobList || [])
        } catch (e) { guaranteed = [] }
        if (!guaranteed.length) await sleep(3000)
      }
    }
  }
  if (guaranteed.length) console.log('JOB_LIST_GUARANTEED:' + guaranteed.length)

  let applied = 0
  const max = args.max || 20
  let page_i = 0
  let prevLen = 0
  const visited = new Set()

  while (applied < max && page_i < 8) {
    page_i++
    // 收集当前页职位
    let jobList = []
    try {
      jobList = await page.evaluate(() => document.querySelector('.page-jobs-main')?.__vue__?.jobList || [])
    } catch (e) { jobList = [] }
    if (!jobList.length) jobList = await page.$$eval('ul.rec-job-list li.job-card-box', (els) => els.map((el) => ({ url: el.querySelector('a')?.href || '' })))
    console.log('JOB_LIST_VUE_LEN:' + jobList.length)

    for (const job of jobList) {
      if (applied >= max) break
      const jobId = job.encryptId || job.encryptJobId || job.url
      if (!jobId || visited.has(jobId)) continue
      visited.add(jobId)

      // 薪资阈值过滤（--sf 为数字阈值时生效）
      if (sfIsThreshold) {
        const jobSalary = job.salaryDesc || job.salary || ''
        if (jobSalary && parseMinSalary(jobSalary) < parseInt(args.sf, 10)) {
          console.log('SKIP_LOW_SALARY:' + (job.jobName || job.positionName || jobId) + ' ' + jobSalary)
          continue
        }
      }

      try {
        // 进入详情
        await page.evaluate((id) => {
          const list = document.querySelector('.page-jobs-main')?.__vue__?.jobList || []
          const idx = list.findIndex((j) => (j.encryptId || j.encryptJobId) === id)
          if (idx >= 0) {
            const items = document.querySelectorAll('ul.rec-job-list li.job-card-box')
            if (items[idx]) items[idx].click()
          }
        }, job.encryptId || job.encryptJobId)
        await sleep(900)
        let apiDetail = null
        try {
          const resp = await page.waitForResponse((r) => r.url().startsWith(JOB_DETAIL_API), { timeout: 8000 })
          const body = await resp.json()
          const zd = body && body.zpData
          if (zd) {
            apiDetail = {
              encryptId: (zd.jobInfo && zd.jobInfo.encryptId) || '',
              jobName: (zd.jobInfo && zd.jobInfo.jobName) || '',
              salaryDesc: (zd.jobInfo && zd.jobInfo.salaryDesc) || '',
              brandName: (zd.brandComInfo && zd.brandComInfo.brandName) || (zd.jobInfo && zd.jobInfo.brandName) || '',
            }
          }
        } catch (e) {}

        // 二次薪资过滤：apiDetail 返回后检查（Vue 列表可能无 salaryDesc）
        if (sfIsThreshold && apiDetail && apiDetail.salaryDesc) {
          if (parseMinSalary(apiDetail.salaryDesc) < parseInt(args.sf, 10)) {
            console.log('SKIP_LOW_SALARY:' + (apiDetail.jobName || jobId) + ' ' + apiDetail.salaryDesc)
            continue
          }
        }

        await handleDetail(page, job, results, args.dryRun, apiDetail)
        applied++
        if (results.capReached) {
          console.log('CAP_REACHED break @ applied=' + applied)
          break
        }
      } catch (e) {
        console.log('DETAIL_WARN:' + e.message.split('\n')[0])
      }
      await sleepBetween(args.delayMin, args.delayMax)
    }
    if (results.capReached) {
      console.log('CAP_REACHED stop search')
      break
    }

    // 滚动加载更多职位（Boss 无限滚动：滚到列表底部触发懒加载）
    try {
      await page.evaluate(() => {
        const sc = document.querySelector('.page-jobs-main')?.querySelector('.job-list-box')
        const el = sc || document.scrollingElement || document.documentElement
        el.scrollTop = el.scrollHeight
      })
    } catch (e) {}
    await sleep(1800)
    try {
      await page.mouse.wheel({ deltaY: 600 + Math.floor(400 * Math.random()) })
    } catch (e) {}
    await sleep(2000)

    // 若多轮滚动后职位列表无增长，则停止（避免死循环）
    let curLen = jobList.length
    try {
      curLen = await page.evaluate(() => (document.querySelector('.page-jobs-main')?.__vue__?.jobList || []).length)
    } catch (e) {}
    if (curLen <= prevLen) {
      console.log('NO_NEW_JOBS break @ len=' + curLen)
      break
    }
    prevLen = curLen
    console.log('SCROLL_NEXT page_len=' + curLen)
  }

  results.count = applied
}

async function modeUrls(page, args, results) {
  for (const url of args.urls || []) {
    if (url.trim().startsWith('#')) continue
    try {
      await page.goto(url.trim(), { waitUntil: 'domcontentloaded', timeout: 30000 })
      await sleepWithRandomDelay(2500)
      await handleDetail(page, { url: url.trim() }, results, args.dryRun)
    } catch (e) {
      results.failed++
      results.details.push({ url: url.trim(), status: 'error:' + e.message.split('\n')[0] })
    }
    await sleepBetween(args.delayMin, args.delayMax)
  }
  results.count = (args.urls || []).length
}

async function main() {
  const args = parseArgs()
  const cookies = readCookies(args.cookiesPath)
  const storageJson = readStorage(args.storagePath || (args.cookiesPath ? path.join(path.dirname(args.cookiesPath), 'boss-storage.json') : ''))
  const results = { success: 0, failed: 0, skipped: 0, preview: 0, count: 0, details: [], capReached: false }

  if (!fs.existsSync(CHROME_EXE)) {
    console.error('CHROME_NOT_FOUND:' + CHROME_EXE)
    process.exit(2)
  }
  if (!cookies.length) {
    console.error('NO_COOKIES: 请先完成登录 (node login.mjs)')
    process.exit(3)
  }

  const browser = await launch()
  const [page] = await browser.pages()
  await blockNavigation(page, (req) => !req.url().startsWith('https://www.zhipin.com'))

  const loggedIn = await ensureLoggedIn(browser, page, cookies, storageJson)
  if (!loggedIn) {
    console.error('LOGIN_INVALID: cookie 已失效，请重新登录')
    await browser.close()
    process.exit(4)
  }
  console.log('STATUS:logged_in')

  if (args.mode === 'urls') await modeUrls(page, args, results)
  else await modeSearch(page, args, results)

  // 输出结果 JSON（与 deliver_log 结构一致）
  if (args.out) {
    fs.mkdirSync(path.dirname(args.out), { recursive: true })
    fs.writeFileSync(args.out, JSON.stringify(results, null, 2))
  }
  console.log('RESULT:' + JSON.stringify(results))

  await sleep(1000)
  await browser.close()
}

main().catch((err) => {
  console.error('FATAL:' + (err.stack || err.message))
  try { process.exit(1) } catch (e) {}
})
