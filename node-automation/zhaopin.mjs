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
const SEARCH_URL = 'https://sou.zhaopin.com/?kw={keyword}&jl={city}'

const APPLY_SELECTORS = [
  'button.a-button.a--bordered.a--filled',
  '.btn-jobapply',
  '.apply-btn',
  "[data-type='apply']",
  'button.apply',
  '.btn-pos-apply',
  '.btn-apply',
]

const APPLY_CONFIRM_SELECTORS = [
  '.deliver-greeting-modal__btn--primary',
  '.apply-dialog .btn-confirm',
  '.modal .btn-primary',
  'button.confirm',
  '.dialog-footer .btn-sure',
]

const APPLY_SUBMIT_SELECTORS = [
  '.apply-dialog .btn-submit',
  '.modal .btn-submit',
  "button[type='submit']",
]

function parseArgs() {
  const argv = process.argv.slice(2)
  const args = {}
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i]; const v = argv[i + 1]
    if (k === '--mode') { args.mode = v; i++ }
    else if (k === '--keyword') { args.keyword = v; i++ }
    else if (k === '--city') { args.city = v; i++ }
    else if (k === '--sf') { args.sf = v; i++ }
    else if (k === '--sl') { args.sl = v; i++ }
    else if (k === '--urls') { args.urls = v.replace(/;/g, ',').split(',').filter(Boolean); i++ }
    else if (k === '--max') { args.max = parseInt(v, 10); i++ }
    else if (k === '--cookies') { args.cookiesPath = v; i++ }
    else if (k === '--out') { args.out = v; i++ }
    else if (k === '--delay-min') { args.delayMin = parseFloat(v); i++ }
    else if (k === '--delay-max') { args.delayMax = parseFloat(v); i++ }
    else if (k === '--headless') { args.headless = true }
    else if (k === '--dry-run') { args.dryRun = true }
  }
  return args
}

function readCookies(p) {
  if (!p || !fs.existsSync(p)) return []
  try { return JSON.parse(fs.readFileSync(p, 'utf-8')) } catch (e) { return [] }
}

// 校验登录：访问个人中心，确认落在个人中心域名且 cookie 包含登录凭证，且页面未提示登录
async function ensureLoggedIn(page, cookies) {
  try {
    await page.setCookie(...cookies.map((c) => ({ ...c, sameSite: c.sameSite === 'None' || !c.sameSite ? 'unspecified' : c.sameSite })))
  } catch (e) { console.log('SET_COOKIE_WARN:' + e.message.split('\n')[0]) }
  // 登录凭证：缺少关键 cookie 直接判定未登录
  const names = new Set((cookies || []).map((c) => c.name))
  const hasCred = ['at', 'HMACCOUNT', 'smidV2', 'x-zp-client-id'].some((n) => names.has(n))
  for (let attempt = 0; attempt < 3; attempt++) {
    try { await page.goto('https://www.zhaopin.com/my/to498', { waitUntil: 'domcontentloaded', timeout: 25000 }) } catch (e) { console.log('MY_WARN:' + e.message.split('\n')[0]) }
    await sleep(3000)
    const url = page.url()
    const ok = url.includes('/my/') || url.includes('i.zhaopin.com')
    // 兜底：落在个人中心但页面出现"登录/扫码"提示语则视为未登录
    let loginPrompt = false
    if (ok) {
      try {
        loginPrompt = await page.evaluate(() => /登录|扫码登录|手机号登录|请登录/.test(document.body.innerText.slice(0, 3000)))
      } catch (e) { loginPrompt = false }
    }
    const valid = ok && !loginPrompt && hasCred
    console.log('LOGIN_CHECK_URL:' + url.slice(0, 90) + ' -> ' + (valid ? 'OK' : 'FAIL') + ' attempt=' + attempt + ' hasCred=' + hasCred + ' prompt=' + loginPrompt)
    if (valid) return true
    await sleep(1500)
  }
  return false
}

function sleepBetween(min, max) {
  const lo = isFinite(min) ? min : 2
  const hi = (isFinite(max) ? max : 4)
  return sleep((lo + Math.random() * Math.max(0, hi - lo)) * 1000)
}

// 读取当前页职位列表（新分栏页 .job-card，旧页 .joblist-box__item）
async function readJobList(page) {
  const url = page.url()
  const isNewPage = url.includes('/jobs') || url.includes('www.zhaopin.com/jobs')
  for (let attempt = 0; attempt < 4; attempt++) {
    let list = []
    let rawCount = 0
    try {
      if (isNewPage) {
        // 滚动触发懒加载，尽量多加载职位卡片
        let lastHeight = 0
        for (let s = 0; s < 8; s++) {
          const before = await page.evaluate(() => document.body.scrollHeight)
          await page.evaluate(() => window.scrollBy(0, window.innerHeight * 2))
          await sleep(600)
          const after = await page.evaluate(() => document.body.scrollHeight)
          lastHeight = after
          if (after === before) break
        }
        // 回到顶部，首屏卡片文本渲染完整，便于解析
        await page.evaluate(() => window.scrollTo(0, 0))
        await sleep(1500)
        const raw = await page.evaluate(() => {
          const items = Array.from(document.querySelectorAll('.job-card'))
          return {
            count: items.length,
            items: items.map((el) => ({
              title: (el.querySelector('.job-card__title-main .vue-clamp__text')?.innerText ||
          el.querySelector('.vue-clamp__text')?.innerText ||
          el.querySelector('.job-card__title-main, .job-card__title-clamp')?.innerText || '').replace(/\s+/g, ' ').trim(),
              company: (el.querySelector('.job-card__company-name')?.innerText || '').replace(/\s+/g, ' ').trim(),
              salary: (el.querySelector('.job-card__salary')?.innerText || '').replace(/\s+/g, ' ').trim(),
              location: (el.querySelector('.job-card__location')?.innerText || '').replace(/\s+/g, ' ').trim(),
              url: '',
            }))
          }
        })
        rawCount = raw.count
        // 有卡片即保留（必要时 title 重试填充）
        list = raw.items.filter((x) => x.title || x.company || x.salary)
        if (raw.count > 0 && list.length === 0) {
          // 卡片存在但文本未渲染，再等一轮重新取
          console.log('CARDS_PENDING_TEXT:' + raw.count)
          await sleep(2000)
          continue
        }
      } else {
        const raw = await page.evaluate(() => {
          const items = Array.from(document.querySelectorAll('.joblist-box__item'))
          return {
            count: items.length,
            items: items.map((el) => {
              const a = el.querySelector('a.jobinfo__name')
              const comp = el.querySelector('a.companyinfo__name')
              const salary = el.querySelector('.jobinfo__salary')
              return { title: a ? a.innerText.trim() : '', company: comp ? comp.innerText.trim() : '', salary: salary ? salary.innerText.trim() : '', url: a ? (a.href || '') : '' }
            })
          }
        })
        rawCount = raw.count
        list = raw.items.filter((x) => x.title || x.url)
      }
      console.log('RAW_ITEMS=' + rawCount + ' PARSED=' + list.length + ' attempt=' + attempt + ' newPage=' + isNewPage + ' url=' + url.slice(0, 70))
    } catch (e) { console.log('READ_ERR:' + e.message.split('\n')[0]) }
    if (list.length > 0) return list
    await sleep(2500)
  }
  return []
}

async function modeSearch(page, args, results) {
  let url = SEARCH_URL.replace('{keyword}', encodeURIComponent(args.keyword)).replace('{city}', encodeURIComponent(args.city || ''))
  if (args.sl) url += '&sl=' + encodeURIComponent(args.sl)
  else if (args.sf) url += '&sf=' + encodeURIComponent(args.sf)
  console.log('SEARCH_URL:' + url)
  try { await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 }) } catch (e) { console.log('GOTO_WARN:' + e.message.split('\n')[0]) }
  await sleep(3000)

  let jobs = await readJobList(page)
  console.log('FOUND_JOBS:' + jobs.length)
  const max = args.max || 20

  for (let i = 0; i < jobs.length && i < max; i++) {
    const job = Object.assign({ index: i }, jobs[i])
    await applyOne(page, job, results, args)
    await sleepBetween(args.delayMin, args.delayMax)
  }
  results.count = Math.min(jobs.length, max)
}

async function modeUrls(page, args, results) {
  for (const url of args.urls || []) {
    if (url.trim().startsWith('#')) continue
    try { await page.goto(url.trim(), { waitUntil: 'domcontentloaded', timeout: 30000 }) } catch (e) { console.log('GOTO_WARN:' + e.message.split('\n')[0]) }
    await sleepWithRandomDelay(2500)
    await applyOne(page, { url: url.trim() }, results, args)
    await sleepBetween(args.delayMin, args.delayMax)
  }
  results.count = (args.urls || []).length
}

async function applyOne(page, job, results, args) {
  const isNewPage = page.url().includes('/jobs')
  if (isNewPage) {
    try {
      await Promise.race([
        applyNewPage(page, job, results, args),
        new Promise((_, rej) => setTimeout(() => rej(new Error('apply timeout')), 60000)),
      ])
    } catch (e) {
      results.failed++
      results.details.push({ title: job.title || '', company: job.company || '', status: 'error' })
      console.log('APPLY_TIMEOUT:' + (job.title || '') + ' ' + e.message.split('\n')[0])
    }
    return
  }
  await applyLegacy(page, job, results, args)
}

async function applyNewPage(page, job, results, args) {
  // 新分栏页：点左侧卡片标题 -> 右侧详情同步 -> 点"立即投递"
  const clicked = await selectNewPageCard(page, job)
  if (!clicked) {
    results.skipped++
    results.details.push({ title: job.title || '', company: job.company || '', status: 'no_card_selected' })
    console.log('NO_CARD_SELECT:' + (job.title || ''))
    return
  }
  await sleep(2500)
  const applyBtn = await findNewApplyBtn(page)
  if (args.dryRun) {
    if (applyBtn) {
      const txt = (await page.$$eval('button.job-detail-summary__apply, .btn-jobapply, .apply-btn', (els) => els[0]?.innerText.trim().slice(0, 30) || '')).slice(0, 30)
      results.preview++
      results.details.push({ title: job.title || '', company: job.company || '', status: 'preview', hasApplyBtn: true, applyText: txt })
      console.log('PREVIEW:' + (job.title || '') + ' | btn=[' + txt + ']')
    } else {
      results.skipped++
      results.details.push({ title: job.title || '', company: job.company || '', status: 'no_apply_btn' })
      console.log('NO_APPLY_BTN:' + (job.title || ''))
    }
    return
  }
  if (!applyBtn) {
    results.skipped++
    results.details.push({ title: job.title || '', company: job.company || '', status: 'no_apply_btn' })
    return
  }
  try {
    await clickElByMouse(page, applyBtn)
    await sleep(4000)// 新页点"立即投递"后直接触发 application API（默认城市/简历），
    // 成功标志：出现"已向对方发送简历/打招呼语"文案或投递完成的提示
    const ok = await page.evaluate(() => {
      const t = document.body.innerText || ''
      return /已向对方发送|发送成功|投递成功|已投递/.test(t)
    })
    if (ok) {
      results.success++
      results.details.push({ title: job.title || '', company: job.company || '', status: 'success' })
      console.log('APPLIED:' + (job.title || ''))
    } else {
      results.failed++
      results.details.push({ title: job.title || '', company: job.company || '', status: 'error' })
      console.log('APPLY_NO_CONFIRM:' + (job.title || ''))
    }
  } catch (e) {
    results.failed++
    results.details.push({ title: job.title || '', company: job.company || '', status: 'error' })
    console.log('APPLY_ERROR:' + (job.title || '') + ' ' + e.message.split('\n')[0])
  }
}

async function applyLegacy(page, job, results, args) {
  if (args.dryRun) {
    if (job.url) {
      try { await page.goto(job.url, { waitUntil: 'domcontentloaded', timeout: 30000 }) } catch (e) { console.log('JOB_GOTO_WARN:' + e.message.split('\n')[0]) }
      await sleep(3000)
    }
    const btn = await findApplyBtn(page)
    if (btn) {
      const txt = (await page.$$eval('.btn-jobapply, .apply-btn, button.a-button.a--bordered.a--filled', (els) => els[0]?.innerText.trim().slice(0, 30) || '')).slice(0, 30)
      results.preview++
      results.details.push({ title: job.title || '', company: job.company || '', url: job.url || '', status: 'preview', hasApplyBtn: true, applyText: txt })
      console.log('PREVIEW:' + (job.title || '') + ' | btn=[' + txt + '] page=' + page.url().slice(0, 70))
    } else {
      results.skipped++
      results.details.push({ title: job.title || '', url: job.url || '', status: 'no_apply_btn', page: page.url().slice(0, 70) })
      console.log('NO_APPLY_BTN:' + (job.title || ''))
    }
    return
  }

  if (job.url) {
    try { await page.goto(job.url, { waitUntil: 'domcontentloaded', timeout: 30000 }) } catch (e) { console.log('JOB_GOTO_WARN:' + e.message.split('\n')[0]) }
    await sleep(3000)
  }

  const btn = await findApplyBtn(page)
  if (!btn) {
    results.skipped++
    results.details.push({ title: job.title || '', url: job.url || '', status: 'no_apply_btn' })
    return
  }
  try {
    await clickElByMouse(page, btn)
    await sleep(2500)
    await clickAny(page, APPLY_CONFIRM_SELECTORS)
    await sleep(1500)
    await clickAny(page, APPLY_SUBMIT_SELECTORS)
    await sleep(1500)
    results.success++
    results.details.push({ title: job.title || '', company: job.company || '', url: job.url || '', status: 'success' })
    console.log('APPLIED:' + (job.title || ''))
  } catch (e) {
    results.failed++
    results.details.push({ title: job.title || '', url: job.url || '', status: 'error' })
    console.log('APPLY_ERROR:' + (job.title || '') + ' ' + e.message.split('\n')[0])
  }
}

// 新分栏页：点击第 index 张左侧卡片标题，使右侧详情同步
async function selectNewPageCard(page, job) {
  try {
    return await Promise.race([
      selectNewPageCardInner(page, job),
      new Promise((res) => setTimeout(() => res(false), 30000)),
    ])
  } catch (e) { console.log('CARD_SELECT_ERR:' + e.message.split('\n')[0]); return false }
}

async function selectNewPageCardInner(page, job) {
  const cards = await page.$$('.job-card')
  if (typeof job.index === 'number' && cards[job.index]) {
    const title = await cards[job.index].$('.job-card__title-main')
    if (title) {
      try {
        // 纯数据参数滚动（数字索引），避免 ElementHandle 进 evaluate
        await page.evaluate((i) => {
          const el = document.querySelectorAll('.job-card__title-main')[i]
          if (el) el.scrollIntoView({ block: 'center' })
        }, job.index)
        await sleep(400)
        if (await clickElByMouse(page, title)) return true
      } catch (e) { console.log('CARD_CLICK_ERR:' + e.message.split('\n')[0]) }
    }
  }
  // 标题匹配兜底（$$eval 纯选择器 + 数据）：优先精确匹配，其次前缀匹配，防止投错职位
  const titles = await page.$$('.job-card__title-main')
  const candidateIdx = []
  for (let i = 0; i < titles.length; i++) {
    const t = await page.$$eval('.job-card__title-main', (els, n) => (els[n]?.innerText || '').replace(/\s+/g, ' ').trim(), i)
    if (t && job.title) {
      const a = t, b = job.title
      if (a === b) candidateIdx.push({ i, score: 3 })
      else if (a.includes(b) || b.includes(a)) candidateIdx.push({ i, score: 2 })
      else if (b.length > 8 && (a.startsWith(b.slice(0, 8)) || b.startsWith(a.slice(0, 8)))) candidateIdx.push({ i, score: 1 })
    }
  }
  // 最高分出现平局（多个候选同样相似）时拒绝点击，避免误投
  if (candidateIdx.length) {
    candidateIdx.sort((x, y) => y.score - x.score)
    const top = candidateIdx[0].score
    const topOnes = candidateIdx.filter((c) => c.score === top)
    if (topOnes.length !== 1) return false
    const i = topOnes[0].i
    try {
      await page.evaluate((n) => {
        const el = document.querySelectorAll('.job-card__title-main')[n]
        if (el) el.scrollIntoView({ block: 'center' })
      }, i)
      await sleep(400)
      if (await clickElByMouse(page, titles[i])) return true
    } catch (e) { return false }
  }
  return false
}

async function findNewApplyBtn(page) {
  const sel = 'button.job-detail-summary__apply'
  try { const el = await page.$(sel); if (el) return el } catch (e) {}
  return findApplyBtn(page)
}

// 纯 DOM/Input 域点击：boundingBox + page.mouse，绕过带 ElementHandle 的 evaluate 挂点
async function clickElByMouse(page, el) {
  try {
    const b = await el.boundingBox()
    if (!b) return false
    await page.mouse.click(b.x + b.width / 2, b.y + b.height / 2)
    return true
  } catch (e) { return false }
}

async function findApplyBtn(page) {
  for (const sel of APPLY_SELECTORS) {
    try { const el = await page.$(sel); if (el) return el } catch (e) {}
  }
  return null
}

async function clickAny(page, selectors) {
  for (const sel of selectors) {
    try { const el = await page.$(sel); if (el) { await clickElByMouse(page, el); return true } } catch (e) {}
  }
  return false
}

async function main() {
  const args = parseArgs()
  const cookies = readCookies(args.cookiesPath)
  const results = { success: 0, failed: 0, skipped: 0, preview: 0, count: 0, details: [] }

  if (!fs.existsSync(CHROME_EXE)) { console.error('CHROME_NOT_FOUND'); process.exit(2) }
  if (!cookies.length) { console.error('NO_COOKIES'); process.exit(3) }

  const profileDir = path.join(__dirname, 'chrome-profile-zhaopin')
  fs.mkdirSync(profileDir, { recursive: true })
  const browser = await puppeteer.launch({ headless: args.headless || false, executablePath: CHROME_EXE, userDataDir: profileDir, pipe: true, ignoreHTTPSErrors: true, protocolTimeout: 20000,
    args: ['--disable-blink-features=AutomationControlled','--no-sandbox','--disable-dev-shm-usage','--lang=zh-CN','--window-size=1440,900'],
    defaultViewport: { width: 1440, height: 860 } })
  const [page] = await browser.pages()
  await blockNavigation(page, (req) =>
    !req.url().startsWith('https://www.zhaopin.com') &&
    !req.url().startsWith('https://sou.zhaopin.com') &&
    !req.url().startsWith('https://passport.zhaopin.com') &&
    !req.url().startsWith('https://i.zhaopin.com')
  )

  const loggedIn = await ensureLoggedIn(page, cookies)
  if (!loggedIn) { console.error('LOGIN_INVALID'); await browser.close(); process.exit(4) }
  console.log('STATUS:logged_in')

  if (args.mode === 'urls') await modeUrls(page, args, results)
  else await modeSearch(page, args, results)

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
