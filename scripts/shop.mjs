#!/usr/bin/env node
// Quản lý quán dành cho nhà cung cấp: tạo quán, xem danh sách, gia hạn, dùng thử, đình chỉ, đặt lại mật khẩu quản lý.
// Dùng khoá bí mật (service role) nên CHỈ chạy trên máy của anh, không đưa lên GitHub.
//
// Chuẩn bị (1 lần): tạo file `.env` cạnh package.json, 2 dòng:
//   SUPABASE_URL=https://abcd1234.supabase.co
//   SUPABASE_SERVICE_KEY=<khoá bí mật sb_secret_... hoặc service_role>
//   APP_URL=https://<tên>.github.io/dongkhach/      (tuỳ chọn: để lệnh create in sẵn link riêng cho quán)
// Dùng:
//   node scripts/shop.mjs create --name "Bánh Mì Cô Ba" [--username admin] [--password ...] [--phone ...] [--trial-days 14 | --paid-months 1]
//   node scripts/shop.mjs list
//   node scripts/shop.mjs renew --slug banhmicoba --months 1
//   node scripts/shop.mjs trial --slug banhmicoba --days 7
//   node scripts/shop.mjs suspend --slug banhmicoba
//   node scripts/shop.mjs resume --slug banhmicoba
//   node scripts/shop.mjs reset-password --slug banhmicoba [--username admin] [--password ...]
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const DAY = 86400_000;
// Giữ giống supabase/functions/shop-signup/handler.ts (test kiểm tra hai bên giống nhau)
export const RESERVED = ['admin', 'administrator', 'root', 'api', 'app', 'www', 'support', 'help', 'test', 'demo', 'system', 'supabase', 'null', 'undefined'];
const WEAK = ['123456', '1234567', '12345678', '123456789', '654321', 'password', 'matkhau', 'abc123', 'qwerty', '000000', '111111'];
export function pwProblem(pw) {
  if (typeof pw !== 'string' || pw.length < 6) return 'Mật khẩu ít nhất 6 ký tự.';
  if (pw.length > 72) return 'Mật khẩu quá dài (tối đa 72 ký tự).';
  if (/^(.)\1+$/.test(pw) || WEAK.includes(pw.toLowerCase())) return 'Mật khẩu quá dễ đoán, đặt khó hơn nhé.';
  return '';
}
export function slugify(name) {
  return String(name).normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/gi, 'd').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 24);
}
// Mật khẩu ngẫu nhiên, bỏ các ký tự dễ nhầm (0 O 1 l I) để đọc qua điện thoại không sai
export function genPassword(len = 10, randInt = (n) => crypto.randomInt(n)) {
  const cs = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let p = ''; for (let i = 0; i < len; i++) p += cs[randInt(cs.length)];
  return p;
}
// Cộng tháng theo lịch, ngày 31 + 1 tháng = ngày cuối của tháng sau (giống Postgres)
export function addMonths(ms, n) {
  const d = new Date(ms), day = d.getUTCDate();
  d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() + n);
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, last));
  return d.getTime();
}
const fail = (m) => { throw new Error(m); };
const iso = (ms) => new Date(ms).toISOString();
const posInt = (v, what) => { const n = Number(v); if (!Number.isInteger(n) || n < 1 || n > 600) fail(`${what} phải là số nguyên từ 1 đến 600.`); return n; };

async function findShop(sb, slug) {
  if (!slug) fail('Thiếu --slug (mã quán).');
  const { data, error } = await sb.from('shops').select('*').eq('slug', String(slug).trim().toLowerCase()).maybeSingle();
  if (error) fail('Lỗi đọc dữ liệu: ' + error.message);
  if (!data) fail(`Không có quán nào mã "${slug}". Xem danh sách: node scripts/shop.mjs list`);
  return data;
}
async function must(p, msg) { const { error } = await p; if (error) fail(`${msg}: ${error.message}`); }

// Trạng thái hiển thị (tính cả hết hạn)
export function describe(shop, now = Date.now()) {
  if (shop.status === 'suspended') return 'ĐÌNH CHỈ';
  if (shop.status === 'trial') {
    if (!shop.trial_ends_at) return 'dùng thử';
    const t = Date.parse(shop.trial_ends_at);
    return t < now ? `HẾT HẠN dùng thử (${shop.trial_ends_at.slice(0, 10)})` : `dùng thử đến ${shop.trial_ends_at.slice(0, 10)}`;
  }
  if (!shop.paid_until) return 'trả phí, không hết hạn';
  const t = Date.parse(shop.paid_until);
  return t < now ? `HẾT HẠN gói (${shop.paid_until.slice(0, 10)})` : `trả phí đến ${shop.paid_until.slice(0, 10)}`;
}

export async function createShop(sb, o) {
  const now = (o.now ?? Date.now)();
  const randInt = o.randInt ?? ((n) => crypto.randomInt(n));
  const name = String(o.name ?? '').replace(/\s+/g, ' ').trim();
  if (!name || name.length > 100) fail('Nhập tên quán (--name, tối đa 100 ký tự).');
  const username = String(o.username ?? 'admin').trim().toLowerCase();
  if (!/^[a-z0-9._-]{3,}$/.test(username)) fail('Tên đăng nhập: ít nhất 3 ký tự, không dấu, không cách.');
  const generated = !o.password;
  const password = o.password || genPassword(10, randInt);
  const pe = pwProblem(password); if (pe) fail(pe);
  const phone = String(o.phone ?? '').trim().slice(0, 40), email = String(o.email ?? '').trim().slice(0, 200);
  if (o.paidMonths != null && o.trialDays != null) fail('Chọn một trong hai: --trial-days hoặc --paid-months.');
  const paid = o.paidMonths != null ? posInt(o.paidMonths, '--paid-months') : null;
  const trialDays = paid ? null : posInt(o.trialDays ?? 14, '--trial-days');
  const emailSuffix = o.emailSuffix ?? 'app';
  const shopRow = paid
    ? { status: 'active', paid_until: iso(addMonths(now, paid)) }
    : { status: 'trial', trial_ends_at: iso(now + trialDays * DAY) };

  // 1. Mã quán
  const rd = (n) => String(randInt(10 ** n)).padStart(n, '0');
  let slug = '';
  if (o.slug) {
    slug = String(o.slug).trim().toLowerCase();
    if (!/^[a-z0-9]{3,30}$/.test(slug)) fail('Mã quán (--slug): 3–30 ký tự, chỉ chữ thường không dấu và số.');
    if (RESERVED.includes(slug)) fail(`Mã quán "${slug}" là từ khoá hệ thống, chọn mã khác.`);
  }
  const created = {};
  try {
    let shop = null;
    const base = slugify(name);
    for (let i = 0; i < 6 && !shop; i++) {
      let cand;
      if (o.slug) { if (i > 0) break; cand = slug; }
      else {
        cand = base.length >= 3 ? base : 'quan' + base + rd(3);
        if (i > 0) cand = (base.length >= 3 ? base : 'quan' + base).slice(0, 25) + rd(3);
        if (RESERVED.includes(cand)) cand = cand + rd(3);
      }
      const { data: ex } = await sb.from('shops').select('id').eq('slug', cand).maybeSingle();
      if (ex) { if (o.slug) fail(`Mã quán "${cand}" đã có người dùng.`); continue; }
      const { data: made, error } = await sb.from('shops').insert({ name, slug: cand, contact_phone: phone, contact_email: email, ...shopRow }).select('id,slug').maybeSingle();
      if (error) { if (error.code === '23505' && !o.slug) continue; fail('Không tạo được quán: ' + error.message); }
      shop = made; slug = cand;
    }
    if (!shop) fail('Chưa tạo được mã quán, thử thêm --slug để tự đặt.');
    created.shopId = shop.id;

    // 2. Tài khoản quản lý đầu tiên
    const loginEmail = `${username}@${slug}.${emailSuffix}`;
    const { data: u, error: cerr } = await sb.auth.admin.createUser({ email: loginEmail, password, email_confirm: true, user_metadata: { username } });
    if (cerr || !u?.user) fail('Không tạo được tài khoản: ' + (cerr?.message ?? ''));
    created.userId = u.user.id;
    await must(sb.from('profiles').insert({ id: u.user.id, shop_id: shop.id, username, name: 'Quản lý', role: 'admin', active: true, perms: {}, updated_by: 'shop-cli' }), 'Không lưu được hồ sơ');

    // 3. Thông tin cửa hàng mặc định (in trên bill)
    await must(sb.from('settings').insert({ shop_id: shop.id, key: 'shop', data: { name, address: '', phone, thanks: 'Cảm ơn quý khách!\nChúc quý khách một ngày vui vẻ!', cutoff: '17:00' } }), 'Không lưu được thông tin quán');
    return { slug, name, username, password, generated, loginEmail, status: shopRow.status, expires: shopRow.paid_until ?? shopRow.trial_ends_at };
  } catch (e) {
    // Xoá QUÁN trước (kéo theo hồ sơ/dữ liệu), rồi mới xoá tài khoản đăng nhập: làm ngược lại thì luật "luôn còn 1 quản lý" chặn việc xoá.
    if (created.shopId) { try { await sb.from('shops').delete().eq('id', created.shopId); } catch (_) { /* bỏ qua */ } }
    if (created.userId) { try { await sb.auth.admin.deleteUser(created.userId); } catch (_) { /* bỏ qua */ } }
    throw e;
  }
}

export async function listShops(sb) {
  const { data, error } = await sb.from('shops').select('*').order('created_at', { ascending: false });
  if (error) fail('Lỗi đọc dữ liệu: ' + error.message);
  return data ?? [];
}

// Bán / gia hạn gói: tính từ ngày hết hạn hiện tại nếu còn hạn, ngược lại từ hôm nay
export async function renewShop(sb, { slug, months, now = Date.now }) {
  const n = posInt(months, '--months'); const t = now();
  const shop = await findShop(sb, slug);
  const cur = shop.status === 'active' && shop.paid_until ? Date.parse(shop.paid_until) : 0;
  const paid_until = iso(addMonths(Math.max(t, cur), n));
  await must(sb.from('shops').update({ status: 'active', paid_until }).eq('id', shop.id), 'Không gia hạn được');
  return { slug: shop.slug, paid_until };
}
export async function trialShop(sb, { slug, days, now = Date.now }) {
  const n = posInt(days, '--days'); const shop = await findShop(sb, slug);
  const trial_ends_at = iso(now() + n * DAY);
  // Đưa về dùng thử thì bỏ hạn trả phí cũ (quán không còn ở gói trả phí)
  await must(sb.from('shops').update({ status: 'trial', trial_ends_at, paid_until: null }).eq('id', shop.id), 'Không cập nhật được');
  return { slug: shop.slug, trial_ends_at };
}
export async function suspendShop(sb, { slug }) {
  const shop = await findShop(sb, slug);
  await must(sb.from('shops').update({ status: 'suspended' }).eq('id', shop.id), 'Không đình chỉ được');
  return { slug: shop.slug };
}
// Mở lại: về đúng trạng thái trước đó (có hạn trả phí -> active, chỉ có hạn dùng thử -> trial, không có gì -> active)
export async function resumeShop(sb, { slug }) {
  const shop = await findShop(sb, slug);
  const status = !shop.paid_until && shop.trial_ends_at ? 'trial' : 'active';
  await must(sb.from('shops').update({ status }).eq('id', shop.id), 'Không mở lại được');
  return { slug: shop.slug, status, shop: { ...shop, status } };
}
export async function resetPassword(sb, { slug, username = 'admin', password, randInt }) {
  const shop = await findShop(sb, slug);
  const un = String(username).trim().toLowerCase();
  const { data: prof, error } = await sb.from('profiles').select('id').eq('shop_id', shop.id).eq('username', un).maybeSingle();
  if (error) fail('Lỗi đọc dữ liệu: ' + error.message);
  if (!prof) fail(`Quán "${shop.slug}" không có tài khoản "${un}".`);
  const generated = !password; const pw = password || genPassword(10, randInt);
  const pe = pwProblem(pw); if (pe) fail(pe);
  const { error: uerr } = await sb.auth.admin.updateUserById(prof.id, { password: pw });
  if (uerr) fail('Không đổi được mật khẩu: ' + uerr.message);
  return { slug: shop.slug, username: un, password: pw, generated };
}

/* ---------------- dòng lệnh ---------------- */
function loadEnv(file) {
  const out = {};
  if (!fs.existsSync(file)) return out;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/); if (!m || line.trim().startsWith('#')) continue;
    out[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
  return out;
}
const HELP = `Quản lý quán — các lệnh:
  create          --name "Tên quán" [--username admin] [--password ...] [--phone ...] [--email ...] [--slug mãquán]
                  [--trial-days 14 | --paid-months 1]
  list
  renew           --slug <mã quán> --months <số tháng>      (bán / gia hạn gói)
  trial           --slug <mã quán> --days <số ngày>         (cho dùng thử thêm)
  suspend         --slug <mã quán>                          (khoá hẳn)
  resume          --slug <mã quán>                          (mở lại)
  reset-password  --slug <mã quán> [--username admin] [--password ...]
Cần file .env có SUPABASE_URL và SUPABASE_SERVICE_KEY (xem hướng dẫn).`;

export async function main(argv, { cwd = process.cwd(), log = console.log, sbFactory } = {}) {
  const cmd = argv[0];
  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') { log(HELP); return 0; }
  const { values: v } = parseArgs({ args: argv.slice(1), options: {
    name: { type: 'string' }, username: { type: 'string' }, password: { type: 'string' }, phone: { type: 'string' }, email: { type: 'string' }, slug: { type: 'string' },
    'trial-days': { type: 'string' }, 'paid-months': { type: 'string' }, months: { type: 'string' }, days: { type: 'string' },
  } });
  const env = { ...loadEnv(path.join(cwd, '.env')), ...process.env };
  const url = env.SUPABASE_URL, key = env.SUPABASE_SERVICE_KEY;
  if (!sbFactory && (!url || !key || /YOUR[-_]/i.test(url + key))) { log('Thiếu SUPABASE_URL / SUPABASE_SERVICE_KEY. Tạo file .env cạnh package.json (xem đầu file scripts/shop.mjs).'); return 1; }
  if (!sbFactory && !/^https:\/\/[a-z0-9-]+\.supabase\.co\/?$/.test(url)) { log('SUPABASE_URL không đúng dạng https://abcd1234.supabase.co'); return 1; }
  const emailSuffix = env.LOGIN_EMAIL_SUFFIX || 'app';
  const appUrl = /^https?:\/\//.test(env.APP_URL || '') ? env.APP_URL.trim() : '';
  try {
    const sb = sbFactory ? sbFactory() : (await import('@supabase/supabase-js')).createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
    if (cmd === 'create') {
      const r = await createShop(sb, { name: v.name, username: v.username, password: v.password, phone: v.phone, email: v.email, slug: v.slug, trialDays: v['trial-days'], paidMonths: v['paid-months'], emailSuffix });
      log(`\nĐã tạo quán "${r.name}"\n  Mã quán      : ${r.slug}\n  Tên đăng nhập: ${r.username}\n  Mật khẩu     : ${r.password}${r.generated ? '   (tự sinh, bảo khách đổi ngay ở Cài đặt)' : ''}\n  Gói          : ${r.status === 'active' ? 'trả phí' : 'dùng thử'} đến ${r.expires.slice(0, 10)}\n\n${appUrl ? `Link gửi khách (đã điền sẵn mã quán): ${appUrl.replace(/[?#].*$/, '').replace(/\/?$/, '/')}?quan=${r.slug}\n` : ''}Gửi cho khách: link app + tên đăng nhập + mật khẩu${appUrl ? '' : ' + mã quán (thêm APP_URL=<địa chỉ web app> vào .env để lệnh tự in link có sẵn mã quán)'}.`);
    } else if (cmd === 'list') {
      const rows = await listShops(sb);
      if (!rows.length) log('Chưa có quán nào.');
      for (const s of rows) log(`${s.slug.padEnd(26)} ${s.name.padEnd(30).slice(0, 30)} ${describe(s).padEnd(34)} ${s.contact_phone || ''}`);
      if (rows.length) log(`\nTổng ${rows.length} quán.`);
    } else if (cmd === 'renew') { const r = await renewShop(sb, { slug: v.slug, months: v.months }); log(`Quán ${r.slug}: gói trả phí đến ${r.paid_until.slice(0, 10)}.`);
    } else if (cmd === 'trial') { const r = await trialShop(sb, { slug: v.slug, days: v.days }); log(`Quán ${r.slug}: dùng thử đến ${r.trial_ends_at.slice(0, 10)}.`);
    } else if (cmd === 'suspend') { const r = await suspendShop(sb, { slug: v.slug }); log(`Quán ${r.slug}: đã ĐÌNH CHỈ (nhân viên không đăng nhập được).`);
    } else if (cmd === 'resume') { const r = await resumeShop(sb, { slug: v.slug }); log(`Quán ${r.slug}: đã mở lại — ${describe(r.shop)}.`);
    } else if (cmd === 'reset-password') {
      const r = await resetPassword(sb, { slug: v.slug, username: v.username, password: v.password });
      log(`Quán ${r.slug}, tài khoản ${r.username}: mật khẩu mới là ${r.password}${r.generated ? ' (tự sinh)' : ''}`);
    } else { log(`Không có lệnh "${cmd}".\n\n${HELP}`); return 1; }
    return 0;
  } catch (e) { log('Lỗi: ' + e.message); return 1; }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  // cwd = thư mục chứa package.json (đứng ở đâu chạy cũng tìm đúng .env)
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  process.exit(await main(process.argv.slice(2), { cwd: fs.existsSync(path.join(process.cwd(), '.env')) ? process.cwd() : root }));
}
